export type ChatGptPacedAction = "browser_tab" | "browser_navigation" | "browser_submit" | "native_api";

export interface ChatGptRequestPacingOptions {
  intervalsMs?: Partial<Record<ChatGptPacedAction, number>>;
  jitterMs?: number;
  rateLimitCooldownMinMs?: number;
  rateLimitCooldownMaxMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface ChatGptRateLimitCooldown {
  cooldownMs: number;
  until: number;
}

export const DEFAULT_CHATGPT_PACING_INTERVALS_MS: Readonly<Record<ChatGptPacedAction, number>> = Object.freeze({
  browser_tab: 1_500,
  browser_navigation: 1_250,
  browser_submit: 2_500,
  native_api: 750,
});
export const DEFAULT_CHATGPT_PACING_JITTER_MS = 350;
export const CHATGPT_RATE_LIMIT_COOLDOWN_MIN_MS = 60_000;
export const CHATGPT_RATE_LIMIT_COOLDOWN_MAX_MS = 120_000;

function boundedNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("ChatGPT request pacing aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Process-wide scheduler for actions that can produce ChatGPT account traffic.
 * Reservations happen before the first await, so concurrent callers cannot take the same slot.
 * If a 429 arrives while callers are queued, they re-reserve after the cooldown instead of
 * waking together and creating another burst.
 */
export class ChatGptRequestPacer {
  private readonly intervalsMs: Readonly<Record<ChatGptPacedAction, number>>;
  private readonly jitterMs: number;
  private readonly cooldownMinMs: number;
  private readonly cooldownMaxMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private lastSlotAt: number | undefined;
  private lastIntervalMs = 0;
  private cooldownUntil = 0;

  constructor(options: ChatGptRequestPacingOptions = {}) {
    this.intervalsMs = { ...DEFAULT_CHATGPT_PACING_INTERVALS_MS, ...options.intervalsMs };
    this.jitterMs = boundedNonNegative(options.jitterMs ?? DEFAULT_CHATGPT_PACING_JITTER_MS, DEFAULT_CHATGPT_PACING_JITTER_MS);
    this.cooldownMinMs = boundedNonNegative(
      options.rateLimitCooldownMinMs ?? CHATGPT_RATE_LIMIT_COOLDOWN_MIN_MS,
      CHATGPT_RATE_LIMIT_COOLDOWN_MIN_MS,
    );
    this.cooldownMaxMs = Math.max(
      this.cooldownMinMs,
      boundedNonNegative(
        options.rateLimitCooldownMaxMs ?? CHATGPT_RATE_LIMIT_COOLDOWN_MAX_MS,
        CHATGPT_RATE_LIMIT_COOLDOWN_MAX_MS,
      ),
    );
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async wait(action: ChatGptPacedAction, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let scheduledAt = this.reserve(action);
    for (;;) {
      await this.sleep(Math.max(0, scheduledAt - this.now()), signal);
      signal?.throwIfAborted();
      if (this.now() >= this.cooldownUntil) return;
      scheduledAt = this.reserve(action, this.cooldownUntil);
    }
  }

  noteRateLimit(retryAfterMs = 0): ChatGptRateLimitCooldown {
    const now = this.now();
    const sampledCooldown = this.cooldownMinMs
      + Math.floor(this.clampedRandom() * (this.cooldownMaxMs - this.cooldownMinMs + 1));
    const requestedCooldown = boundedNonNegative(retryAfterMs, 0);
    const until = Math.max(this.cooldownUntil, now + Math.max(sampledCooldown, requestedCooldown));
    this.cooldownUntil = until;
    return { cooldownMs: Math.max(0, until - now), until };
  }

  cooldownRemainingMs(now = this.now()): number {
    return Math.max(0, this.cooldownUntil - now);
  }

  reset(): void {
    this.lastSlotAt = undefined;
    this.lastIntervalMs = 0;
    this.cooldownUntil = 0;
  }

  private reserve(action: ChatGptPacedAction, notBefore = 0): number {
    const now = this.now();
    const interval = boundedNonNegative(this.intervalsMs[action], 0)
      + Math.floor(this.clampedRandom() * (this.jitterMs + 1));
    const pacedAfterPrevious = this.lastSlotAt === undefined
      ? now
      : this.lastSlotAt + Math.max(this.lastIntervalMs, interval);
    const scheduledAt = Math.max(now, pacedAfterPrevious, this.cooldownUntil, notBefore);
    this.lastSlotAt = scheduledAt;
    this.lastIntervalMs = interval;
    return scheduledAt;
  }

  private clampedRandom(): number {
    return Math.min(0.999999999, Math.max(0, this.random()));
  }
}

/** Parse Retry-After seconds or an HTTP-date into a delay. */
export function retryAfterDelayMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

const testPacingOptions: ChatGptRequestPacingOptions | undefined = process.env.NODE_ENV === "test"
  ? {
    intervalsMs: {
      browser_tab: 0,
      browser_navigation: 0,
      browser_submit: 0,
      native_api: 0,
    },
    jitterMs: 0,
    rateLimitCooldownMinMs: 0,
    rateLimitCooldownMaxMs: 0,
  }
  : undefined;

export const chatGptRequestPacer = new ChatGptRequestPacer(testPacingOptions);
