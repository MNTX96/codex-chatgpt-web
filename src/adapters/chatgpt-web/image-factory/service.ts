import { randomUUID } from "node:crypto";
import { ChatGptWebAdapterError } from "../adapter-error";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "../environment";
import { isPathInside, resolveOutputArtifactTarget } from "../artifacts/artifact-target";
import { sniffImageMime } from "../artifacts/image/image-sniffer";
import type { OutputArtifactTarget, OutputImageSource } from "../artifacts/types";
import type { ChatGptWebPromptImage } from "../prompt";
import {
  IMAGE_FACTORY_TIMEOUTS,
  ImageFactoryError,
  imageEditSchema,
  imageGenerateSchema,
  imageJobSchema,
  type ImageFactoryInput,
  type ImageFactoryOperation,
  type ImageJobPhase,
  type ImageJobResult,
  type ImageToolName,
} from "./contracts";
import { ImageFactoryStore, imageKey, normalizeStoredImageJob, type ImageSession, type StoredImageJob } from "./state";

export interface ImageFactoryBrowserRequest {
  stateDirectory: string;
  session: ImageSession;
  jobId: string;
  jobKey: string;
  sourceTurnId: string;
}
export interface ImageJobExecution {
  request: ImageFactoryBrowserRequest;
  operation: ImageFactoryOperation;
  requestedCount: number;
  sourceArtifactId?: string;
  sourceArtifact?: OutputImageSource;
  prompt: string;
  images: ChatGptWebPromptImage[];
  target: OutputArtifactTarget;
  signal: AbortSignal;
  deadlineAt: number;
  maxSubmissions: number;
  update: (value: ImageFactoryBrowserUpdate) => void;
}
export interface ImageFactoryBrowserUpdate {
  session: ImageSession;
  phase?: ImageJobPhase;
  result?: Partial<ImageJobResult>;
}
export interface ImageFactoryParent {
  threadId: string;
  environment: ChatGptTurnEnvironment;
  signal: AbortSignal;
  activity: () => () => void;
}
interface LiveJob { job: StoredImageJob; abort: AbortController; done: Promise<void> }
type ImageJobExecutionResult = Pick<ImageJobResult, "status" | "artifacts">
  & Partial<Omit<ImageJobResult, "jobId" | "imageSessionId" | "status" | "artifacts">>;

function normalizedPayloadHash(operation: ImageFactoryOperation, input: ImageFactoryInput): string {
  return imageKey({ operation, input });
}

function legacyGeneratePayloadHash(input: ImageFactoryInput): string | undefined {
  if (!("reference_image_paths" in input) || input.count !== 1) return undefined;
  const { count: _count, ...legacy } = input;
  return imageKey(legacy);
}

function normalizeTerminalResult(result: ImageJobResult): void {
  result.downloadedCount = result.artifacts.length;
  if (result.status === "cancelled") return;
  if (result.downloadedCount >= result.requestedCount) {
    result.status = "completed";
    result.error = undefined;
    return;
  }
  if (result.downloadedCount > 0) {
    result.status = "partial";
    return;
  }
  if (result.status !== "running") result.status = "failed";
}

function shortImageJobId(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 12)}…` : undefined;
}

function imageFactoryJobLog(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  console.info(`[chatgpt-web] image-factory.job ${event} ${JSON.stringify(fields)}`);
}

function safeExecutionFailureMessage(reason: unknown): string {
  if (!(reason instanceof Error)) {
    return "Image Factory could not complete this job; no native image tool was called.";
  }
  const name = reason.name?.trim() || "Error";
  const raw = reason.message?.trim();
  if (!raw) return `Image Factory execution failed: ${name}`;
  const redacted = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|cookie|token|access_token|refresh_token)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/(https:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1")
    .replace(/\s+/g, " ")
    .slice(0, 500);
  return `Image Factory execution failed: ${name}: ${redacted}`;
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
    private readonly execute: (options: ImageJobExecution) => Promise<ImageJobExecutionResult>,
    private readonly hasCapacity: (additionalReservations?: number) => boolean,
    private readonly executionPolicy: { maxSubmissions?: number } = {},
  ) {}

  async call(parent: ImageFactoryParent, name: ImageToolName, args: unknown): Promise<ImageJobResult> {
    if (parent.signal.aborted) throw new ImageFactoryError("image_parent_retired");
    if (!parent.threadId) throw new ImageFactoryError("image_task_identity_missing");
    const owner = imageKey(this.namespace, parent.threadId);
    if (name === "chatgpt_image_generate") return this.start(parent, owner, "generate", imageGenerateSchema.parse(args));
    if (name === "chatgpt_image_edit") return this.start(parent, owner, "edit", imageEditSchema.parse(args));
    const { job_id: jobId } = imageJobSchema.parse(args);
    const key = imageKey("job-id", owner, jobId);
    const rawStored = this.live.get(key)?.job ?? this.store.read<StoredImageJob>("job", key);
    const stored = rawStored ? normalizeStoredImageJob(rawStored) : undefined;
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

  private start(parent: ImageFactoryParent, owner: string, operation: ImageFactoryOperation, input: ImageFactoryInput): ImageJobResult {
    const jobId = imageKey(owner, input.request_id);
    const key = imageKey("job-id", owner, jobId);
    const payloadHash = normalizedPayloadHash(operation, input);
    const legacyPayloadHash = operation === "generate" ? legacyGeneratePayloadHash(input) : undefined;
    const rawExisting = this.live.get(key)?.job ?? this.store.read<StoredImageJob>("job", key);
    const existing = rawExisting ? normalizeStoredImageJob(rawExisting) : undefined;
    if (existing) {
      const payloadMatches = existing.payloadHash === payloadHash
        || (legacyPayloadHash !== undefined && existing.payloadHash === legacyPayloadHash);
      if (existing.owner !== owner || existing.operation !== operation || !payloadMatches) throw new ImageFactoryError("idempotency_conflict");
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
    const resolvedTarget = resolveOutputArtifactTarget(parent.environment, key, { capturePolicy: "required" });
    const target = resolvedTarget ? { ...resolvedTarget, maxArtifacts: input.count } : undefined;
    if (!target) throw new ImageFactoryError("image_workspace_unavailable", "Image generation requires a trusted writable workspace.");
    const images = operation === "generate" && "reference_image_paths" in input
      ? (input.reference_image_paths ?? []).map((path, index) => readReferenceImage(path, index, parent.environment))
      : [];
    if (!this.hasCapacity(this.capacityReservations)) throw new ImageFactoryError("image_capacity_exhausted", "All five ChatGPT browser slots are busy. Finish another browser turn before generating an image.");
    const sessionId = input.image_session_id ?? randomUUID();
    const sessionKey = imageKey(owner, sessionId);
    let session = this.store.read<ImageSession>("session", sessionKey);
    if (input.image_session_id && (!session || session.owner !== owner)) throw new ImageFactoryError("image_session_unavailable");
    if ([...this.live.values()].some(value => value.job.owner === owner && value.job.result.imageSessionId === sessionId)) throw new ImageFactoryError("image_session_busy");
    session ??= { id: sessionId, owner, updatedAt: Date.now() };
    const sourceArtifactId = operation === "edit" && "source_artifact_id" in input ? input.source_artifact_id : undefined;
    const sourceArtifact = sourceArtifactId ? session.artifacts?.[sourceArtifactId] : undefined;
    if (operation === "edit") {
      if (!session.hasConversation || !session.conversationUrl) throw new ImageFactoryError("image_edit_source_unavailable", "The image session has no retained Image Factory conversation.");
      if (!sourceArtifact
        || sourceArtifact.imageSessionId !== sessionId
        || !sourceArtifact.assistantTurnId
        || !sourceArtifact.candidateKey
        || (!sourceArtifact.cardId && !sourceArtifact.fileIdentity)) {
        throw new ImageFactoryError("image_edit_source_unavailable", "The source artifact has no usable Image Factory provenance.");
      }
    }
    const result: ImageJobResult = {
      jobId,
      imageSessionId: sessionId,
      status: "running",
      requestedCount: input.count,
      generatedCount: 0,
      downloadedCount: 0,
      attemptCount: 0,
      artifacts: [],
      submissions: [],
      ...(sourceArtifactId ? { sourceArtifactId } : {}),
    };
    const job: StoredImageJob = {
      key,
      owner,
      payloadHash,
      operation,
      input,
      requestedCount: input.count,
      attemptCount: 0,
      submissions: [],
      ...(sourceArtifactId ? { sourceArtifactId } : {}),
      phase: "prepared",
      updatedAt: Date.now(),
      result,
    };
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
      operation,
      requestedCount: input.count,
      capacityReservations: this.capacityReservations,
    });
    const abort = new AbortController();
    const onParentAbort = () => abort.abort(parent.signal.reason);
    parent.signal.addEventListener("abort", onParentAbort, { once: true });
    const maxSubmissions = Math.max(
      1,
      Math.min(
        IMAGE_FACTORY_TIMEOUTS.maxSubmissions,
        Number.isSafeInteger(this.executionPolicy.maxSubmissions)
          ? Number(this.executionPolicy.maxSubmissions)
          : IMAGE_FACTORY_TIMEOUTS.maxSubmissions,
      ),
    );
    const hardDeadlineAt = Date.now() + IMAGE_FACTORY_TIMEOUTS.job;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const jobDeadline = setTimeout(
      () => abort.abort(new ImageFactoryError("image_job_timeout")),
      Math.max(1, hardDeadlineAt - Date.now()),
    );
    jobDeadline.unref?.();
    const save = () => { job.updatedAt = Date.now(); this.store.write("job", key, job); };
    const clearPhaseDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
    };
    const armPhaseDeadline = (timeoutMs: number, code: string) => {
      clearPhaseDeadline();
      deadline = setTimeout(() => abort.abort(new ImageFactoryError(code)), timeoutMs);
      deadline.unref?.();
    };
    armPhaseDeadline(IMAGE_FACTORY_TIMEOUTS.setup, "image_setup_timeout");
    imageFactoryJobLog("execution_started", {
      jobId: shortImageJobId(jobId),
      imageSessionId: shortImageJobId(sessionId),
      phase: job.phase,
    });
    const done = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted();
      const executionResult = await this.execute({
        request: { stateDirectory: this.store.directory, session: session!, jobId, jobKey: key, sourceTurnId: parent.threadId },
        operation,
        requestedCount: input.count,
        ...(sourceArtifactId ? { sourceArtifactId } : {}),
        ...(sourceArtifact ? { sourceArtifact } : {}),
        prompt: input.prompt, images, target, signal: abort.signal,
        deadlineAt: hardDeadlineAt,
        maxSubmissions,
        update: update => {
          if (update.session.owner !== owner || update.session.id !== sessionId) throw new ImageFactoryError("image_session_identity_mismatch");
          if (session?.accountKey && session.accountKey !== update.session.accountKey) throw new ImageFactoryError("image_account_mismatch");
          session = update.session;
          this.store.write("session", sessionKey, session);
          if (update.phase) job.phase = update.phase;
          if (update.result) {
            Object.assign(job.result, update.result);
            job.result.downloadedCount = job.result.artifacts.length;
            job.attemptCount = job.result.attemptCount;
            job.submissions = job.result.submissions ?? job.submissions;
          }
          imageFactoryJobLog("phase_changed", {
            jobId: shortImageJobId(jobId),
            imageSessionId: shortImageJobId(sessionId),
            phase: job.phase,
          });
          if (update.phase === "submitted") {
            clearPhaseDeadline();
            deadline = setTimeout(() => abort.abort(new ImageFactoryError("image_generation_timeout")), IMAGE_FACTORY_TIMEOUTS.generation);
            deadline.unref?.();
          }
          save();
        },
      });
      Object.assign(job.result, executionResult);
      job.result.downloadedCount = job.result.artifacts.length;
      job.attemptCount = job.result.attemptCount;
      job.submissions = job.result.submissions ?? job.submissions;
      if (abort.signal.aborted && job.result.status === "running") abort.signal.throwIfAborted();
      normalizeTerminalResult(job.result);
      const settledSession = session!;
      settledSession.artifacts ??= {};
      for (const artifact of job.result.artifacts) {
        if (artifact.source.imageSessionId !== sessionId || !artifact.source.conversationUrl) continue;
        settledSession.artifacts[artifact.id] = artifact.source;
      }
      settledSession.updatedAt = Date.now();
      this.store.write("session", sessionKey, settledSession);
      imageFactoryJobLog("execution_completed", {
        jobId: shortImageJobId(jobId),
        imageSessionId: shortImageJobId(sessionId),
        status: job.result.status,
        artifacts: job.result.artifacts.length,
        generatedCount: job.result.generatedCount,
        attemptCount: job.result.attemptCount,
      });
    }).catch(error => {
      const reason = abort.signal.aborted ? abort.signal.reason : error;
      const rateLimited = reason instanceof ChatGptWebAdapterError && reason.status === 429;
      const timedOut = reason instanceof ImageFactoryError && reason.code.endsWith("_timeout");
      const safeFailureMessage = reason instanceof ImageFactoryError
        ? reason.message
        : safeExecutionFailureMessage(reason);
      job.result.downloadedCount = job.result.artifacts.length;
      job.result.status = abort.signal.aborted && !timedOut
        ? "cancelled"
        : job.result.downloadedCount > 0
          ? "partial"
          : "failed";
      job.result.error = {
        code: reason instanceof ImageFactoryError
          ? reason.code
          : rateLimited ? reason.code : "image_generation_failed",
        message: safeFailureMessage,
        ...(rateLimited ? { status: reason.status, errorType: reason.errorType, retryable: reason.retryable } : {}),
      };
      imageFactoryJobLog("execution_failed", {
        jobId: shortImageJobId(jobId),
        imageSessionId: shortImageJobId(sessionId),
        status: job.result.status,
        errorCode: job.result.error.code,
        errorName: reason instanceof Error ? reason.name : typeof reason,
        errorMessage: safeFailureMessage,
      });
    }).finally(() => {
      clearPhaseDeadline();
      clearTimeout(jobDeadline);
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
