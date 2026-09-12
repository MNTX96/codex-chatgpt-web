export const CHATGPT_FOLLOW_UP_QUEUE_TIMEOUT_MS = 600_000;

export interface ChatGptFollowUpRequest {
  requestId: string;
  revision: number;
  instructionId: string;
  text: string;
}

export type ChatGptFollowUpEvent =
  | { type: "queued"; requestId: string; revision: number }
  | { type: "send_activated"; requestId: string; revision: number }
  | { type: "submitted"; requestId: string; revision: number; conversationUrl?: string }
  | { type: "rejected"; requestId: string; revision: number; message: string };

type FollowUpConsumer = (request: ChatGptFollowUpRequest) => void | Promise<void>;
type FollowUpEventListener = (event: ChatGptFollowUpEvent) => void;

export type ChatGptFollowUpTerminalEvent = Extract<ChatGptFollowUpEvent, { type: "submitted" | "rejected" }>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface FollowUpEntry {
  request: ChatGptFollowUpRequest;
  accepted: Deferred<void>;
  terminal: Deferred<ChatGptFollowUpTerminalEvent>;
  timer: ReturnType<typeof setTimeout>;
  dispatching: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function chatGptFollowUpKey(request: Pick<ChatGptFollowUpRequest, "requestId" | "revision">): string {
  return JSON.stringify([request.requestId, request.revision]);
}

export function assertChatGptFollowUpRequest(request: ChatGptFollowUpRequest): void {
  if (!request.requestId || request.requestId.length > 256) throw new Error("ChatGPT follow-up request id is invalid");
  if (!Number.isSafeInteger(request.revision) || request.revision <= 0) throw new Error("ChatGPT follow-up revision is invalid");
  if (!/^[a-f0-9]{64}$/.test(request.instructionId)) throw new Error("ChatGPT follow-up instruction identity is invalid");
  if (!request.text.trim()) throw new Error("ChatGPT follow-up instruction is empty");
}

/**
 * One deferred producer/consumer bridge for a retained browser turn.
 *
 * The daemon creates the channel before the launcher helper is ready. The consumer is then bound
 * either by the in-process browser worker or by LauncherBrowserHelperClient. Enqueue resolves only
 * after that consumer accepted the request, so a session handoff never advances its canonical
 * instruction until the retained browser path owns the follow-up.
 */
export class ChatGptFollowUpChannel {
  private consumer?: FollowUpConsumer;
  private closedError?: Error;
  private readonly entries = new Map<string, FollowUpEntry>();
  private readonly queue: string[] = [];
  private readonly lifecycle = new Map<string, ChatGptFollowUpEvent>();
  private readonly listeners = new Set<FollowUpEventListener>();
  private pumping = false;
  private latestAccepted = 0;

  constructor(private readonly queueTimeoutMs = CHATGPT_FOLLOW_UP_QUEUE_TIMEOUT_MS) {
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0) {
      throw new Error("ChatGPT follow-up queue timeout is invalid");
    }
  }

  enqueue(request: ChatGptFollowUpRequest): Promise<void> {
    assertChatGptFollowUpRequest(request);
    if (this.closedError) return Promise.reject(this.closedError);
    const key = chatGptFollowUpKey(request);
    const existing = this.entries.get(key);
    if (existing) {
      this.assertSameRequest(existing.request, request);
      return existing.accepted.promise;
    }
    const accepted = deferred<void>();
    const terminal = deferred<ChatGptFollowUpTerminalEvent>();
    void terminal.promise.catch(() => {});
    const entry: FollowUpEntry = {
      request,
      accepted,
      terminal,
      dispatching: false,
      timer: setTimeout(() => this.expire(key), this.queueTimeoutMs),
    };
    entry.timer.unref?.();
    this.entries.set(key, entry);
    this.queue.push(key);
    this.applyEvent({ type: "queued", requestId: request.requestId, revision: request.revision });
    this.pump();
    return accepted.promise;
  }

  waitForTerminal(request: Pick<ChatGptFollowUpRequest, "requestId" | "revision">): Promise<ChatGptFollowUpTerminalEvent> {
    const key = chatGptFollowUpKey(request);
    const entry = this.entries.get(key);
    if (!entry) return Promise.reject(new Error("Unknown ChatGPT follow-up request"));
    const terminal = this.lifecycle.get(key);
    if (terminal?.type === "submitted" || terminal?.type === "rejected") return Promise.resolve(terminal);
    return entry.terminal.promise;
  }

  /** Browser/helper lifecycle evidence for requests accepted by this channel. */
  recordEvent(event: ChatGptFollowUpEvent): boolean {
    if (!event.requestId || !Number.isSafeInteger(event.revision) || event.revision <= 0) return false;
    if (!this.entries.has(chatGptFollowUpKey(event))) return false;
    return this.applyEvent(event);
  }

  onEvent(listener: FollowUpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  latestAcceptedRevision(): number {
    return this.latestAccepted;
  }

  hasUnsubmitted(): boolean {
    for (const [key] of this.entries) {
      const stage = this.lifecycle.get(key)?.type;
      if (stage !== "submitted" && stage !== "rejected") return true;
    }
    return false;
  }

  isTerminal(request: Pick<ChatGptFollowUpRequest, "requestId" | "revision">): boolean {
    const stage = this.lifecycle.get(chatGptFollowUpKey(request))?.type;
    return stage === "submitted" || stage === "rejected";
  }

  bind(consumer: FollowUpConsumer): () => void {
    if (this.consumer) throw new Error("ChatGPT follow-up channel already has a consumer");
    if (this.closedError) throw this.closedError;
    this.consumer = consumer;
    this.pump();
    return () => {
      if (this.consumer === consumer) this.consumer = undefined;
    };
  }

  close(error: Error = Object.assign(new Error("ChatGPT follow-up channel closed"), { name: "AbortError" })): void {
    if (this.closedError) return;
    this.closedError = error;
    this.consumer = undefined;
    for (const entry of this.entries.values()) {
      const stage = this.lifecycle.get(chatGptFollowUpKey(entry.request))?.type;
      if (stage === "submitted" || stage === "rejected") continue;
      entry.accepted.reject(error);
      this.applyEvent({
        type: "rejected",
        requestId: entry.request.requestId,
        revision: entry.request.revision,
        message: error.message,
      });
    }
    this.queue.length = 0;
  }

  private pump(): void {
    if (this.pumping || !this.consumer || this.closedError) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.consumer && !this.closedError && this.queue.length > 0) {
          const key = this.queue[0]!;
          const entry = this.entries.get(key);
          if (!entry || this.isTerminal(entry.request)) {
            this.queue.shift();
            continue;
          }
          entry.dispatching = true;
          try {
            await this.consumer(entry.request);
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            entry.accepted.reject(failure);
            this.applyEvent({
              type: "rejected",
              requestId: entry.request.requestId,
              revision: entry.request.revision,
              message: failure.message,
            });
          }
          this.queue.shift();
          entry.dispatching = false;
          if (!this.isTerminal(entry.request)) {
            this.latestAccepted = Math.max(this.latestAccepted, entry.request.revision);
            entry.accepted.resolve();
          }
        }
      } finally {
        this.pumping = false;
        if (this.consumer && !this.closedError && this.queue.length > 0) this.pump();
      }
    })();
  }

  private expire(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || this.isTerminal(entry.request)) return;
    const error = new Error(`ChatGPT follow-up was not submitted within ${this.queueTimeoutMs / 1000} seconds`);
    entry.accepted.reject(error);
    this.applyEvent({
      type: "rejected",
      requestId: entry.request.requestId,
      revision: entry.request.revision,
      message: error.message,
    });
  }

  private applyEvent(event: ChatGptFollowUpEvent): boolean {
    const key = chatGptFollowUpKey(event);
    const entry = this.entries.get(key);
    if (!entry) return false;
    const current = this.lifecycle.get(key);
    const rank = (value: ChatGptFollowUpEvent["type"] | undefined): number => {
      if (value === "queued") return 1;
      if (value === "send_activated") return 2;
      if (value === "submitted" || value === "rejected") return 3;
      return 0;
    };
    if (rank(event.type) < rank(current?.type) || rank(current?.type) === 3
      || (current?.type === event.type && event.type !== "submitted")) return false;
    this.lifecycle.set(key, event);
    if (event.type === "submitted" || event.type === "rejected") {
      clearTimeout(entry.timer);
      if (event.type === "submitted") entry.accepted.resolve();
      else entry.accepted.reject(new Error(event.message));
      entry.terminal.resolve(event);
    }
    for (const listener of this.listeners) listener(event);
    return true;
  }

  private assertSameRequest(existing: ChatGptFollowUpRequest, incoming: ChatGptFollowUpRequest): void {
    if (existing.instructionId !== incoming.instructionId || existing.text !== incoming.text) {
      throw new Error("ChatGPT follow-up request identity conflicts with an earlier revision");
    }
  }
}
