/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

export type ChatGptGenerationPriority = "normal" | "retry";

interface ChatGptGenerationWaiter {
  priority: ChatGptGenerationPriority;
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

export interface ChatGptGenerationCoordinatorOptions {
  /** Prevent a steady retry stream from starving brand-new turns forever. */
  maxConsecutiveRetryGrants?: number;
}

/**
 * Process-wide generation gate for one signed-in ChatGPT account.
 *
 * Browser tabs may be prepared concurrently, but only one queued turn can own the generation
 * permit. Retries normally jump ahead of new work; after a bounded retry burst, the oldest normal
 * waiter gets one grant before retry priority resumes.
 */
export class ChatGptGenerationCoordinator {
  private readonly maxConsecutiveRetryGrants: number;
  private readonly waiters: ChatGptGenerationWaiter[] = [];
  private active = false;
  private consecutiveRetryGrants = 0;

  constructor(options: ChatGptGenerationCoordinatorOptions = {}) {
    this.maxConsecutiveRetryGrants = Math.max(1, Math.floor(options.maxConsecutiveRetryGrants ?? 2));
  }

  get activeCount(): number {
    return this.active ? 1 : 0;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(priority: ChatGptGenerationPriority = "normal", signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: ChatGptGenerationWaiter = { priority, signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(signal.reason instanceof Error
            ? signal.reason
            : new DOMException("ChatGPT generation queue aborted", "AbortError"));
          this.dispatch();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.active) return;
    while (this.waiters.length > 0) {
      const index = this.nextWaiterIndex();
      const waiter = this.waiters.splice(index, 1)[0]!;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason instanceof Error
          ? waiter.signal.reason
          : new DOMException("ChatGPT generation queue aborted", "AbortError"));
        continue;
      }
      this.active = true;
      if (waiter.priority === "retry") this.consecutiveRetryGrants += 1;
      else this.consecutiveRetryGrants = 0;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = false;
        this.dispatch();
      });
      return;
    }
  }

  private nextWaiterIndex(): number {
    const retryIndex = this.waiters.findIndex(waiter => waiter.priority === "retry");
    const normalIndex = this.waiters.findIndex(waiter => waiter.priority === "normal");
    if (retryIndex < 0) return normalIndex;
    if (normalIndex < 0) return retryIndex;
    return this.consecutiveRetryGrants < this.maxConsecutiveRetryGrants ? retryIndex : normalIndex;
  }
}

export const chatGptGenerationCoordinator = new ChatGptGenerationCoordinator();

/** Lazy turn-owned lease so UI preparation can finish before the global generation gate is taken. */
export class ChatGptGenerationLease {
  private releasePermit?: () => void;
  private pendingAcquire?: Promise<void>;

  constructor(
    private readonly priority: ChatGptGenerationPriority = "normal",
    private readonly coordinator = chatGptGenerationCoordinator,
  ) {}

  get acquired(): boolean {
    return this.releasePermit !== undefined;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.releasePermit) return;
    if (!this.pendingAcquire) {
      const pending = this.coordinator.acquire(this.priority, signal).then(release => {
        try {
          signal?.throwIfAborted();
          this.releasePermit = release;
        } catch (error) {
          release();
          throw error;
        }
      });
      this.pendingAcquire = pending;
      void pending.finally(() => {
        if (this.pendingAcquire === pending) this.pendingAcquire = undefined;
      }).catch(() => {});
    }
    await this.pendingAcquire;
  }

  release(): void {
    const release = this.releasePermit;
    this.releasePermit = undefined;
    release?.();
  }
}
