import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { VERSION } from "../../version";

export class ImageTransferError extends Error {
  constructor(readonly code: string, readonly stage: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(code, { cause: options?.cause });
    this.name = "ImageTransferError";
    this.retryable = options?.retryable === true;
  }
  readonly retryable: boolean;
}

/** Hash at module load so replacing the file does not relabel an already running helper. */
export const IMAGE_TRANSFER_RUNTIME = Object.freeze({
  version: VERSION,
  transferProtocol: 1,
  helperSha256: (() => {
    try { return createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"); }
    catch { return "unavailable"; }
  })(),
});

export function redactImageTransferError(error: unknown): { name: string; message: string; cause?: unknown } {
  const redact = (value: string) => value
    .replace(/(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, "[source redacted]")
    .replace(/\b(?:cookie|set-cookie|authorization)\s*[:=][^\r\n]*/gi, "[credential redacted]")
    .replace(/\b(?:token|signature|sig|key|secret)\s*[:=]\s*[^\s,;]+/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9+/_=-]{80,}/g, "[payload redacted]")
    .slice(0, 1_000);
  const result = { name: error instanceof Error ? error.name : "Error", message: redact(error instanceof Error ? error.message : String(error)) };
  return error instanceof Error && error.cause && error.cause !== error
    ? { ...result, cause: { name: error.cause instanceof Error ? error.cause.name : "Error", message: redact(error.cause instanceof Error ? error.cause.message : String(error.cause)) } }
    : result;
}

export type ImageTransferLog = (stage: string, fields?: Record<string, unknown>) => void;
export function imageTransferLog(traceId: string, jobId?: string): ImageTransferLog {
  return (stage, fields = {}) => console.info(`[chatgpt-web] image-transfer ${JSON.stringify({
    ...IMAGE_TRANSFER_RUNTIME, traceId, jobId, stage, ...fields,
  })}`);
}

/** One budget covers binding, clicks, download completion and validation. */
export class ImageTransferDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(readonly deadlineAt = Date.now() + 60_000, private readonly parent?: AbortSignal) {
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new ImageTransferError("image_transfer_timeout", "deadline")), Math.max(1, deadlineAt - Date.now()));
    this.timer.unref?.();
    parent?.addEventListener("abort", this.onAbort, { once: true });
    if (parent?.aborted) this.onAbort();
  }
  private readonly onAbort = () => this.controller.abort(this.parent?.reason);
  remaining(): number {
    this.signal.throwIfAborted();
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) throw new ImageTransferError("image_transfer_timeout", "deadline");
    return remaining;
  }
  /** Observations may outlive the race, but must never perform clicks or other delayed actions. */
  async observe<T>(operation: Promise<T>): Promise<T> {
    try { this.remaining(); }
    catch (error) {
      // The caller has already started the observation. Consume a late rejection even if
      // cancellation happened before we could install the race listener.
      void operation.catch(() => {});
      throw error;
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
    try { return await Promise.race([operation, aborted]); }
    finally { this.signal.removeEventListener("abort", onAbort); }
  }
  async pause(ms = 150): Promise<void> {
    try { await delay(Math.min(ms, this.remaining()), undefined, { signal: this.signal }); }
    catch (error) {
      // Node/Bun timer cancellation wraps signal.reason in a generic AbortError.
      // Keep the shared deadline's typed failure (or the caller's cancellation reason).
      this.remaining();
      throw error;
    }
    this.remaining();
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onAbort);
  }
}
