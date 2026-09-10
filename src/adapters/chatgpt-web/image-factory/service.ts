import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "../environment";
import { isPathInside, resolveOutputArtifactTarget } from "../artifacts/artifact-target";
import { sniffImageMime } from "../artifacts/image/image-sniffer";
import type { OutputArtifactTarget } from "../artifacts/types";
import type { ChatGptWebPromptImage } from "../prompt";
import { IMAGE_FACTORY_TIMEOUTS, ImageFactoryError, imageGenerateSchema, imageJobSchema, type ImageJobPhase, type ImageJobResult, type ImageToolName } from "./contracts";
import { ImageFactoryStore, imageKey, type ImageSession, type StoredImageJob } from "./state";

export interface ImageFactoryBrowserRequest {
  stateDirectory: string;
  session: ImageSession;
  jobId: string;
  jobKey: string;
  sourceTurnId: string;
}
export interface ImageFactoryBrowserUpdate {
  session: ImageSession;
  phase?: ImageJobPhase;
}
export interface ImageJobExecution {
  request: ImageFactoryBrowserRequest;
  prompt: string;
  images: ChatGptWebPromptImage[];
  target: OutputArtifactTarget;
  signal: AbortSignal;
  update: (value: ImageFactoryBrowserUpdate) => void;
}
export interface ImageFactoryParent {
  threadId: string;
  environment: ChatGptTurnEnvironment;
  signal: AbortSignal;
  activity: () => () => void;
}
interface LiveJob { job: StoredImageJob; abort: AbortController; done: Promise<void> }

function shortImageJobId(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 12)}…` : undefined;
}

function imageFactoryJobLog(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  console.info(`[chatgpt-web] image-factory.job ${event} ${JSON.stringify(fields)}`);
}

/** Jobs execute locally in the bridge, never as unknown outer Codex tool calls. */
export class ImageFactoryService {
  private static readonly sharedServices = new Map<string, ImageFactoryService>();

  static shared(directory: string, namespace: string, create: () => ImageFactoryService): ImageFactoryService {
    const key = imageKey(resolve(directory), namespace);
    let service = this.sharedServices.get(key);
    if (!service) {
      service = create();
      this.sharedServices.set(key, service);
    }
    return service;
  }

  private readonly live = new Map<string, LiveJob>();
  private capacityReservations = 0;
  constructor(
    readonly store: ImageFactoryStore,
    private readonly namespace: string,
    private readonly execute: (options: ImageJobExecution) => Promise<Omit<ImageJobResult, "jobId" | "imageSessionId">>,
    private readonly hasCapacity: (additionalReservations?: number) => boolean,
  ) {}

  async call(parent: ImageFactoryParent, name: ImageToolName, args: unknown): Promise<ImageJobResult> {
    if (parent.signal.aborted) throw new ImageFactoryError("image_parent_retired");
    if (!parent.threadId) throw new ImageFactoryError("image_task_identity_missing");
    const owner = imageKey(this.namespace, parent.threadId);
    if (name === "chatgpt_image_generate") return this.generate(parent, owner, args);
    const { job_id: jobId } = imageJobSchema.parse(args);
    const key = imageKey("job-id", owner, jobId);
    const stored = this.live.get(key)?.job ?? this.store.read<StoredImageJob>("job", key);
    if (!stored || stored.owner !== owner) throw new ImageFactoryError("image_job_unavailable");
    const live = this.live.get(key);
    imageFactoryJobLog("wait_or_cancel_requested", {
      tool: name,
      jobId: shortImageJobId(jobId),
      live: Boolean(live),
    });
    if (name === "chatgpt_image_cancel" && live) live.abort.abort(new ImageFactoryError("image_cancelled"));
    if (live) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([live.done, new Promise<void>(r => { timer = setTimeout(r, IMAGE_FACTORY_TIMEOUTS.wait); })]); }
      finally { if (timer) clearTimeout(timer); }
    } else if (stored.result.status === "running") {
      stored.result.status = "failed";
      stored.result.error = { code: "image_submission_unknown", message: "Runtime restarted before this image job settled. Inspect its Image Factory conversation before submitting a new request." };
      stored.phase = "terminal";
      this.store.write("job", key, stored);
    }
    return structuredClone(stored.result);
  }

  private generate(parent: ImageFactoryParent, owner: string, args: unknown): ImageJobResult {
    const input = imageGenerateSchema.parse(args);
    const jobId = imageKey(owner, input.request_id);
    const key = imageKey("job-id", owner, jobId);
    const payloadHash = imageKey(input);
    const existing = this.live.get(key)?.job ?? this.store.read<StoredImageJob>("job", key);
    if (existing) {
      if (existing.owner !== owner || existing.payloadHash !== payloadHash) throw new ImageFactoryError("idempotency_conflict");
      if (!this.live.has(key) && existing.result.status === "running") {
        existing.result.status = "failed";
        existing.result.error = { code: "image_submission_unknown", message: "Do not replay this prompt: submission must be reconciled in its existing conversation." };
        existing.phase = "terminal";
        this.store.write("job", key, existing);
      }
      imageFactoryJobLog("idempotent_replay", {
        jobId: shortImageJobId(existing.result.jobId),
        imageSessionId: shortImageJobId(existing.result.imageSessionId),
        status: existing.result.status,
        phase: existing.phase,
      });
      return structuredClone(existing.result);
    }
    const target = resolveOutputArtifactTarget(parent.environment, key, { capturePolicy: "required" });
    if (!target) throw new ImageFactoryError("image_workspace_unavailable", "Image generation requires a trusted writable workspace.");
    const images = (input.reference_image_paths ?? []).map((path, index) => readReferenceImage(path, index, parent.environment));
    if (!this.hasCapacity(this.capacityReservations)) throw new ImageFactoryError("image_capacity_exhausted", "All five ChatGPT browser slots are busy. Finish another browser turn before generating an image.");
    const sessionId = input.image_session_id ?? randomUUID();
    const sessionKey = imageKey(owner, sessionId);
    let session = this.store.read<ImageSession>("session", sessionKey);
    if (input.image_session_id && (!session || session.owner !== owner)) throw new ImageFactoryError("image_session_unavailable");
    if ([...this.live.values()].some(value => value.job.owner === owner && value.job.result.imageSessionId === sessionId)) throw new ImageFactoryError("image_session_busy");
    session ??= { id: sessionId, owner, updatedAt: Date.now() };
    const job: StoredImageJob = { key, owner, payloadHash, input, phase: "prepared", updatedAt: Date.now(), result: { jobId, imageSessionId: sessionId, status: "running", artifacts: [] } };
    const endActivity = parent.activity();
    try {
      parent.signal.throwIfAborted();
      this.store.write("session", sessionKey, session);
      this.store.write("job", key, job);
    } catch (error) {
      endActivity();
      throw error;
    }
    this.capacityReservations += 1;
    imageFactoryJobLog("accepted", {
      jobId: shortImageJobId(jobId),
      imageSessionId: shortImageJobId(sessionId),
      referenceImages: images.length,
      capacityReservations: this.capacityReservations,
    });
    const abort = new AbortController();
    const onParentAbort = () => abort.abort(parent.signal.reason);
    parent.signal.addEventListener("abort", onParentAbort, { once: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const save = () => { job.updatedAt = Date.now(); this.store.write("job", key, job); };
    deadline = setTimeout(() => abort.abort(new ImageFactoryError("image_setup_timeout")), IMAGE_FACTORY_TIMEOUTS.setup);
    imageFactoryJobLog("execution_started", {
      jobId: shortImageJobId(jobId),
      imageSessionId: shortImageJobId(sessionId),
      phase: job.phase,
    });
    const done = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted();
      const result = await this.execute({
        request: { stateDirectory: this.store.directory, session: session!, jobId, jobKey: key, sourceTurnId: parent.threadId },
        prompt: input.prompt, images, target, signal: abort.signal,
        update: update => {
          if (update.session.owner !== owner || update.session.id !== sessionId) throw new ImageFactoryError("image_session_identity_mismatch");
          if (session?.accountKey && session.accountKey !== update.session.accountKey) throw new ImageFactoryError("image_account_mismatch");
          session = update.session;
          this.store.write("session", sessionKey, session);
          if (update.phase) job.phase = update.phase;
          imageFactoryJobLog("phase_changed", {
            jobId: shortImageJobId(jobId),
            imageSessionId: shortImageJobId(sessionId),
            phase: job.phase,
          });
          if (update.phase === "submitted") {
            if (deadline) clearTimeout(deadline);
            deadline = setTimeout(() => abort.abort(new ImageFactoryError("image_generation_timeout")), IMAGE_FACTORY_TIMEOUTS.generation);
          }
          save();
        },
      });
      abort.signal.throwIfAborted();
      if (!result.artifacts.length && result.status === "completed") throw new ImageFactoryError("image_not_generated");
      Object.assign(job.result, result);
      imageFactoryJobLog("execution_completed", {
        jobId: shortImageJobId(jobId),
        imageSessionId: shortImageJobId(sessionId),
        status: result.status,
        artifacts: result.artifacts.length,
      });
    }).catch(error => {
      const reason = abort.signal.aborted ? abort.signal.reason : error;
      const timedOut = reason instanceof ImageFactoryError && reason.code.endsWith("_timeout");
      job.result.status = abort.signal.aborted && !timedOut ? "cancelled" : "failed";
      job.result.error = { code: reason instanceof ImageFactoryError ? reason.code : "image_generation_failed", message: reason instanceof ImageFactoryError ? reason.message : "Image Factory could not complete this job; no native image tool was called." };
      imageFactoryJobLog("execution_failed", {
        jobId: shortImageJobId(jobId),
        imageSessionId: shortImageJobId(sessionId),
        status: job.result.status,
        errorCode: job.result.error.code,
      });
    }).finally(() => {
      if (deadline) clearTimeout(deadline);
      parent.signal.removeEventListener("abort", onParentAbort);
      job.phase = "terminal";
      try { save(); } finally { this.live.delete(key); this.capacityReservations = Math.max(0, this.capacityReservations - 1); endActivity(); }
      imageFactoryJobLog("terminal", {
        jobId: shortImageJobId(jobId),
        imageSessionId: shortImageJobId(sessionId),
        status: job.result.status,
        phase: job.phase,
        capacityReservations: this.capacityReservations,
      });
    });
    this.live.set(key, { job, abort, done });
    // A journal failure remains observed even if the caller never polls again.
    void done.catch(() => {});
    return structuredClone(job.result);
  }
}

export function readReferenceImage(path: string, index: number, environment: ChatGptTurnEnvironment): ChatGptWebPromptImage {
  const absolute = isAbsolute(path) ? path : resolve(environment.cwd, path);
  const real = realpathSync(absolute);
  if (!environment.roots.some(root => isPathInside(real, realpathSync(root)))) throw new ImageFactoryError("image_reference_outside_workspace");
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.size > 20_000_000) throw new ImageFactoryError("image_reference_invalid");
  const bytes = readFileSync(real);
  if (bytes.length > 20_000_000) throw new ImageFactoryError("image_reference_invalid");
  const mime = sniffImageMime(bytes);
  if (!mime) throw new ImageFactoryError("image_reference_invalid");
  return { ref: `reference-${index + 1}`, imageUrl: `data:${mime};base64,${bytes.toString("base64")}` };
}
