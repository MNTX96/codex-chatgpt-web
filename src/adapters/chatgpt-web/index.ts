import { imageFactoryReconciler } from "./image-factory/reconcile";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, getConfigDir, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  readLauncherImageFactoryConfig,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker, chatGptBrowserCapacityAvailable, type BrowserTurn } from "./browser-worker";
import type { ChatGptGenerationPriority } from "./concurrency";
import {
  chatGptTurnUserRevisionHistory,
  contentText,
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
  hasCurrentChatGptEnvironmentContext,
  hasRawChatGptEnvironmentContext,
  isChatGptCompactionContinuation,
  priorChatGptAbortedTurnIds,
} from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import { resolveOutputArtifactTarget } from "./artifacts/artifact-target";
import { writeArtifactManifest } from "./artifacts/artifact-manifest";
import type { OutputArtifact, OutputArtifactTarget, OutputImageCaptureResult } from "./artifacts/types";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";
import { ImageFactoryService } from "./image-factory/service";
import { ImageFactoryStore, imageKey } from "./image-factory/state";
import { IMAGE_FACTORY_INSTRUCTIONS_VERSION } from "./image-factory/instructions";
import { IMAGE_FACTORY_TIMEOUTS, type ImageFactoryOperation, type ImageJobCandidateError, type ImageJobSubmission } from "./image-factory/contracts";
import { resolveImageFactoryModelPolicy } from "./image-factory/model-policy";
import { imageFactoryContinuationPrompt, imageFactoryInitialPrompt } from "./image-factory/prompt-template";
import { verifiedImageFactoryConversationUrl } from "./image-factory/project-navigation";
import { ChatGptFollowUpChannel, type ChatGptFollowUpRequest } from "./follow-up";

function verifiedImageConversationUrl(value: string | undefined, projectId: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.hash) return undefined;
    const projectConversation = url.pathname.startsWith(`/g/${projectId}`)
      && /\/c\/[A-Za-z0-9_-]{8,128}(?:\/|$)/.test(url.pathname);
    const webConversation = /^\/c\/WEB:[A-Za-z0-9_-]{8,128}(?:\/|$)/.test(url.pathname);
    if (!projectConversation && !webConversation) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function imageFactoryResumePlan(
  operation: ImageFactoryOperation,
  hasConversation: boolean,
  conversationUrl: string | undefined,
  projectId: string,
  attempt: number,
): {
  prepareResume: boolean;
  requireRetainedConversation: boolean;
  resumeConversationUrl?: string;
} {
  const prepareResume = hasConversation || attempt > 1;
  const resumeConversationUrl = prepareResume
    ? verifiedImageFactoryConversationUrl(conversationUrl, projectId)
    : undefined;
  return {
    prepareResume,
    // A first generate may safely start a fresh project conversation after a launcher restart
    // when old state only remembers the project page. beginTurn() will still reuse an in-memory
    // retained tab when one exists. Edits and compensation attempts must fail closed instead of
    // silently changing conversations because they depend on exact prior-card provenance.
    requireRetainedConversation: attempt > 1 || operation === "edit" || resumeConversationUrl !== undefined,
    ...(resumeConversationUrl ? { resumeConversationUrl } : {}),
  };
}

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace);
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function followUpRevisionText(content: unknown): string {
  if (typeof content === "string") return contentText(content).trim();
  if (!Array.isArray(content)) throw new Error("ChatGPT follow-up instruction content is invalid");
  const normalized: CodexContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error("ChatGPT follow-up instruction content is invalid");
    }
    const value = part as Record<string, unknown>;
    if (value.type === "input_text" && typeof value.text === "string") {
      normalized.push({ type: "text", text: value.text });
      continue;
    }
    throw new ChatGptWebAdapterError("Codex follow-up steering currently supports text instructions only", {
      status: 409,
      errorType: "invalid_request_error",
      code: "follow_up_content_unsupported",
      retryable: false,
    });
  }
  const text = contentText(normalized).trim();
  if (!text) throw new Error("ChatGPT follow-up instruction is empty");
  return text;
}

function followUpRequest(
  parsed: CodexParsedRequest,
  instructionId: string,
): ChatGptFollowUpRequest {
  const revisions = chatGptTurnUserRevisionHistory(parsed);
  const latest = revisions.at(-1);
  if (!latest) throw new Error("ChatGPT follow-up requires a canonical user instruction");
  const nativeIdentity = extractChatGptTurnIdentity(parsed);
  const requestId = latest.itemId
    ?? nativeIdentity.turnId
    ?? createHash("sha256").update(instructionId).digest("hex");
  return {
    requestId,
    revision: revisions.length,
    instructionId,
    text: followUpRevisionText(latest.content),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function configuredImageFactoryProjectId(provider: CodexProviderConfig): string {
  const projectId = provider.chatgptWeb?.imageFactoryProjectId?.trim();
  if (!projectId) {
    throw new Error("Image Factory is not configured. Set project_id in Configuration → Image Factory.");
  }
  return projectId;
}

function requireImageFactoryProjectId(projectId: string | null | undefined): string {
  const normalized = projectId?.trim();
  if (!normalized) {
    throw new Error("Image Factory is not configured. Set project_id in Configuration → Image Factory.");
  }
  return normalized;
}

export async function resolveImageFactoryProjectId(provider: CodexProviderConfig): Promise<string> {
  return (await resolveImageFactoryProjectConfig(provider)).projectId;
}

export async function resolveImageFactoryProjectConfig(provider: CodexProviderConfig): Promise<{ projectId: string; projectName?: string }> {
  if (provider.chatgptWeb?.browserHost !== "launcher") return {
    projectId: configuredImageFactoryProjectId(provider),
    projectName: provider.chatgptWeb?.imageFactoryProjectName?.trim() || undefined,
  };
  const descriptorPath = provider.chatgptWeb.browserHostDescriptorPath?.trim();
  if (!descriptorPath) throw new Error("Launcher browser host descriptor path is missing");
  const config = await readLauncherImageFactoryConfig(descriptorPath);
  return { projectId: requireImageFactoryProjectId(config.projectId), projectName: config.projectName ?? undefined };
}

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const imageFactoryEnabled = !manualInteraction && configuredCapabilities.localToolsEnabled;
  const imageFactoryStore = imageFactoryEnabled
    ? new ImageFactoryStore(join(getConfigDir(), "runtime", "image-factory", executionNamespace))
    : undefined;
  const imageFactory = imageFactoryEnabled && imageFactoryStore
    ? ImageFactoryService.shared(imageFactoryStore.directory, executionNamespace, () => new ImageFactoryService(
      imageFactoryStore,
      executionNamespace,
      async options => {
        options.signal.throwIfAborted();
        const { projectId, projectName } = await resolveImageFactoryProjectConfig(provider);
        const conversationKey = imageKey(
          "conversation",
          executionNamespace,
          options.request.session.owner,
          options.request.session.id,
        );
        const previousProjectId = options.request.session.projectId?.trim();
        const projectChanged = previousProjectId
          ? previousProjectId !== projectId
          : options.request.session.hasConversation === true;
        if (projectChanged
          && options.request.session.hasConversation === true
          && provider.chatgptWeb?.browserHost === "launcher") {
          const descriptorPath = provider.chatgptWeb.browserHostDescriptorPath?.trim();
          if (!descriptorPath) throw new Error("Launcher browser host descriptor path is missing");
          await releaseLauncherRetainedConversation(descriptorPath, conversationKey);
        }
        const imageFactoryWorker = ChatGptBrowserWorker.forProvider({
          ...provider,
          chatgptWeb: {
            ...provider.chatgptWeb,
            appName: `${provider.chatgptWeb?.appName ?? "ChatGPT"} Image Factory ${imageKey(options.request.session.owner, options.request.session.id)}`,
            browserDiagnosticsPath: join(getConfigDir(), "diagnostics", "image-factory"),
          },
        });
        options.signal.throwIfAborted();
        let session = {
          ...options.request.session,
          owner: options.request.session.owner,
          projectId,
          ...(projectChanged ? { conversationUrl: undefined, hasConversation: false } : {}),
          updatedAt: Date.now(),
        };
        let submittedConversationUrl = session.conversationUrl;
        options.update({ session });
        const imageModelPolicy = resolveImageFactoryModelPolicy(
          configuredCapabilities,
          options.modelId,
          options.reasoning,
        );
        const imageModelId = imageModelPolicy.modelId;
        const imageCapabilities: ChatGptWebCapabilities = {
          ...configuredCapabilities,
          localToolsEnabled: false,
        };
        const artifacts: OutputArtifact[] = [];
        const artifactBindings = new Set<string>();
        const submissions: ImageJobSubmission[] = [];
        const candidateErrors: ImageJobCandidateError[] = [];
        const excessCandidateKeys: string[] = [];
        let generatedCount = 0;
        let attemptCount = 0;
        let lastText = "";
        let previousResponseCompletedAt: number | undefined;
        const childTarget: OutputArtifactTarget = {
          ...options.target,
          capturePolicy: "best-effort" as const,
          metadata: {
            output: "image" as const,
            surface: "persistent" as const,
            projectId,
            conversationUrl: submittedConversationUrl ?? `https://chatgpt.com/g/${projectId}/project`,
            actualMode: imageModelId,
            instructionsVersion: IMAGE_FACTORY_INSTRUCTIONS_VERSION,
            imageSessionId: session.id,
            jobId: options.request.jobId,
            sourceTurn: options.request.sourceTurnId,
          },
        };
        const currentResult = () => ({
          requestedCount: options.requestedCount,
          generatedCount,
          downloadedCount: artifacts.length,
          attemptCount,
          artifacts: [...artifacts],
          submissions: submissions.map(value => ({ ...value, candidateKeys: [...value.candidateKeys], excessCandidateKeys: [...value.excessCandidateKeys], failures: value.failures.map(failure => ({ ...failure })) })),
          ...(candidateErrors.length > 0 ? { candidateErrors: candidateErrors.map(error => ({ ...error })) } : {}),
        });
        const initialPrompt = imageFactoryInitialPrompt(options.operation, options.prompt, options.requestedCount);
        for (let attempt = 1; attempt <= options.maxSubmissions && generatedCount < options.requestedCount; attempt += 1) {
          options.signal.throwIfAborted();
          const remaining = options.requestedCount - generatedCount;
          const submissionId = imageKey("submission", options.request.jobId, attempt);
          const submission: ImageJobSubmission = {
            id: submissionId,
            attempt,
            requestedCount: remaining,
            generatedCount: 0,
            downloadedCount: 0,
            candidateKeys: [],
            excessCandidateKeys: [],
            failures: [],
            queuedAt: Date.now(),
          };
          submissions.push(submission);
          childTarget.metadata!.submissionId = submissionId;
          childTarget.metadata!.conversationUrl = submittedConversationUrl
            ?? `https://chatgpt.com/g/${projectId}/project`;
          if (attempt > 1 && previousResponseCompletedAt !== undefined) {
            const compensationRetryAt = previousResponseCompletedAt + 15_000;
            const waitMs = Math.max(0, compensationRetryAt - Date.now());
            if (waitMs > 0) {
              await withAbort(new Promise<void>(resolveWait => setTimeout(resolveWait, waitMs)), options.signal);
            }
          }
          const prompt = attempt === 1
            ? initialPrompt
            : imageFactoryContinuationPrompt(options.operation, initialPrompt, generatedCount, remaining);
          const promptImages = attempt === 1 ? options.images : [];
          const resumePlan = imageFactoryResumePlan(
            options.operation,
            session.hasConversation === true,
            session.conversationUrl,
            projectId,
            attempt,
          );
          let capture: OutputImageCaptureResult | undefined;
          try {
            const answer = await imageFactoryWorker.run({
              traceId: `image_${options.request.jobId.slice(0, 46)}_${attempt}`,
              generationPriority: attempt > 1 ? "retry" : "normal",
              modelId: imageModelId,
              reasoning: imageModelPolicy.reasoning,
              capabilities: imageCapabilities,
              surface: "persistent",
              persistentProjectId: projectId,
              persistentProjectName: projectName,
              executionTarget: {
                output: "image",
                surface: "persistent",
                projectId,
                imageSessionId: session.id,
              },
              skipConnectorIdentity: true,
              prepare: async () => ({ text: prompt, images: promptImages, release: () => {} }),
              ...(resumePlan.prepareResume ? { prepareResume: async () => ({ text: prompt, images: promptImages, release: () => {} }) } : {}),
              ...(resumePlan.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
              ...(resumePlan.resumeConversationUrl ? { resumeConversationUrl: resumePlan.resumeConversationUrl } : {}),
              retainConversation: true,
              conversationKey,
              abortSignal: options.signal,
              onSendActivated: () => {
                attemptCount = Math.max(attemptCount, attempt);
                submission.startedAt ??= Date.now();
                options.update({ session, phase: "submitting", result: currentResult() });
              },
              onSubmitted: url => {
                submittedConversationUrl = verifiedImageConversationUrl(url, projectId) ?? submittedConversationUrl;
                childTarget.metadata!.conversationUrl = submittedConversationUrl
                  ?? `https://chatgpt.com/g/${projectId}/project`;
                session = {
                  ...session,
                  hasConversation: true,
                  conversationUrl: submittedConversationUrl,
                  updatedAt: Date.now(),
                };
                options.update({ session, phase: "submitted", result: currentResult() });
              },
              onResponseVisible: assistantTurnId => {
                submission.assistantTurnId = assistantTurnId;
                session = {
                  ...session,
                  updatedAt: Date.now(),
                };
                options.update({ session, result: currentResult() });
              },
              onTextDelta: () => {},
              outputArtifactTarget: childTarget,
              outputArtifactExecutionKey: options.request.jobKey,
              outputArtifactLimit: remaining,
              outputArtifactExistingTotalBytes: artifacts.reduce((total, artifact) => total + artifact.byteLength, 0),
              outputArtifactWriteManifest: false,
              requireOutputArtifact: true,
              ...(options.operation === "edit" && options.sourceArtifact ? { imageEditSource: options.sourceArtifact } : {}),
              onOutputArtifact: artifact => {
                const binding = `${artifact.source.assistantTurnId}:${artifact.source.candidateKey}`;
                if (!artifactBindings.has(binding)) {
                  artifactBindings.add(binding);
                  artifacts.push(artifact);
                }
                options.update({ session, phase: "downloading", result: currentResult() });
              },
              onOutputArtifactCapture: value => {
                capture = value;
                submission.generatedCount = value.detectedCandidates;
                submission.downloadedCount = value.artifacts.length;
                submission.candidateKeys = [...value.candidateKeys];
                submission.excessCandidateKeys = [...value.excessCandidateKeys];
                submission.failures = value.failures.map(failure => ({ ...failure, attempt }));
                submission.completedAt = Date.now();
                generatedCount += value.detectedCandidates;
                candidateErrors.push(...submission.failures);
                excessCandidateKeys.push(...value.excessCandidateKeys);
                options.update({ session, phase: "downloading", result: currentResult() });
              },
              onOutputArtifactWarning: warning => {
                console.warn(`[chatgpt-web] image-factory capture warning job=${options.request.jobId.slice(0, 12)} attempt=${attempt}: ${warning}`);
              },
            });
            if (answer) lastText = answer;
            previousResponseCompletedAt = Date.now();
          } catch (error) {
            submission.completedAt ??= Date.now();
            if (!capture) {
              const failure = { candidateKey: submissionId, code: "image_submission_failed", attempt };
              submission.failures.push(failure);
              candidateErrors.push(failure);
              options.update({ session, result: currentResult() });
            }
            throw error;
          }
          if (!capture) {
            submission.completedAt = Date.now();
            options.update({ session, phase: "observing", result: currentResult() });
          }
        }
        const updatedSession = {
          ...session,
          hasConversation: session.hasConversation === true,
          actualMode: imageModelId,
          conversationUrl: submittedConversationUrl ?? session.conversationUrl,
          updatedAt: Date.now(),
        };
        session = updatedSession;
        const finalStatus = artifacts.length >= options.requestedCount
          ? "completed" as const
          : artifacts.length > 0
            ? "partial" as const
            : "failed" as const;
        const manifestPath = artifacts.length > 0
          ? writeArtifactManifest({
            executionKey: options.request.jobKey,
            traceId: `image_${options.request.jobId.slice(0, 56)}`,
            assistantTurnId: artifacts.at(-1)!.source.assistantTurnId,
            target: childTarget,
            artifacts,
            failures: candidateErrors,
            job: {
              operation: options.operation,
              requestedCount: options.requestedCount,
              generatedCount,
              downloadedCount: artifacts.length,
              attemptCount,
              ...(options.sourceArtifactId ? { sourceArtifactId: options.sourceArtifactId } : {}),
              submissions,
              excessCandidateKeys,
            },
          })
          : undefined;
        options.update({ session: updatedSession, phase: "downloading", result: { ...currentResult(), ...(manifestPath ? { manifestPath } : {}) } });
        return {
          status: finalStatus,
          requestedCount: options.requestedCount,
          generatedCount,
          downloadedCount: artifacts.length,
          attemptCount,
          artifacts,
          submissions,
          ...(candidateErrors.length > 0 ? { candidateErrors } : {}),
          ...(manifestPath ? { manifestPath } : {}),
          ...(lastText ? { text: lastText } : {}),
          ...(finalStatus !== "completed" ? {
            error: {
              code: generatedCount < options.requestedCount ? "image_count_shortfall" : "image_download_partial",
              message: generatedCount < options.requestedCount
                ? `Image Factory generated ${generatedCount}/${options.requestedCount} requested image cards after ${attemptCount} submission(s).`
                : `Image Factory generated enough image cards but saved ${artifacts.length}/${options.requestedCount} requested files.`,
            },
          } : {}),
        };
      },
      reservations => chatGptBrowserCapacityAvailable(reservations),
      {},
      imageFactoryReconciler(provider, executionNamespace),
    ))
    : undefined;
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: {
      onCompactionProgress?: () => void;
      onSendActivated?: () => void | Promise<void>;
      retryHistoryReductionLevel?: number;
      generationPriority?: ChatGptGenerationPriority;
    } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);

    const outputArtifactTarget = !parsed._compactionRequest && !manualRequest
      ? resolveOutputArtifactTarget(environment, chatGptTurnExecutionKey(parsed), provider.chatgptWeb?.generatedImageArtifacts)
      : undefined;
    const outputArtifactRequired = !parsed._compactionRequest && !manualRequest
      && (provider.chatgptWeb?.generatedImageArtifacts?.mode ?? "workspace") === "workspace"
      && (provider.chatgptWeb?.generatedImageArtifacts?.capturePolicy ?? "required") === "required";
    const outputArtifactLifecycle = outputArtifactTarget ? {
      outputArtifactTarget,
      outputArtifactExecutionKey: chatGptTurnExecutionKey(parsed),
      onOutputArtifact: (artifact: OutputArtifact) => trace.push({
        kind: "commentary",
        text: `Generated image saved to workspace:\n${artifact.relativePath}\nLocal path: ${artifact.absolutePath}`,
      }),
      onOutputArtifactWarning: (warning: string) => trace.push({ kind: "commentary", text: warning }),
    } : outputArtifactRequired ? { requireOutputArtifact: true } : {};
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const conversationKey = !parsed._compactionRequest
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(checkpointInput.parsed)
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest) => {
      if (manualRequest) return {};
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities)
        : undefined;
      return {
        captureLunaCheckpoint,
        imageFactory: Boolean(imageFactory && broker.bindImageTools),
        ...(hooks.retryHistoryReductionLevel
          ? { retryHistoryReductionLevel: hooks.retryHistoryReductionLevel }
          : {}),
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        () => {
          const retirement = new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    const submissionLifecycle = {
      onSendActivated: async () => {
        submission.phase = "send_activated" as const;
        await hooks.onSendActivated?.();
      },
      onSubmitted: () => {
        submission.phase = "accepted";
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: hooks.onCompactionProgress }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            activeToken,
            { manualControl: true },
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              { manualControl: true },
            )
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the `Codex Zero Risk` plugin and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          submission.phase = "accepted";
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for `Codex Zero Risk` to bind this turn through the selected ChatGPT connector.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> `Codex Zero Risk` is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        ...(hooks.generationPriority ? { generationPriority: hooks.generationPriority } : {}),
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...outputArtifactLifecycle,
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    const followUp = retainConversation && !parsed._compactionRequest
      ? new ChatGptFollowUpChannel()
      : undefined;
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      try {
        if (imageFactory && broker.bindImageTools) {
          broker.bindImageTools(turnToken, async (name, args) => {
            if (!structuredBroker?.holdImageActivity) {
              throw new Error("Image Factory requires the structured automatic turn broker");
            }
            const result = await imageFactory.call({
              threadId: identity.threadId ?? identity.turnId ?? traceId,
              modelId: parsed.modelId,
              reasoning: parsed.options.reasoning,
              environment,
              signal: browserAbort.signal,
              activity: () => structuredBroker.holdImageActivity!(turnToken),
            }, name, args);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          });
        }
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input),
        );
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(worker.run({
      traceId,
      ...(hooks.generationPriority ? { generationPriority: hooks.generationPriority } : {}),
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: () => prepareWith(checkpointInput.parsed),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      ...outputArtifactLifecycle,
      externalProgress,
      ...(followUp ? { followUp } : {}),
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      ...(followUp ? { followUp } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        followUp?.close(reason ?? Object.assign(new Error("ChatGPT browser turn cancelled"), { name: "AbortError" }));
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        const retryHistoryReductionLevel = chatGptWebTurnRetryPolicy.retryCountForLastError(
          retryKey,
          "upstream_server_error",
          "Something went wrong",
        );
        const generationPriority: ChatGptGenerationPriority = chatGptWebTurnRetryPolicy.retryCount(retryKey) > 0
          ? "retry"
          : "normal";
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools || (!manualRequest && provider.chatgptWeb?.generatedImageArtifacts?.mode !== "off")) {
          try {
            environment = environmentStore.resolve(parsed);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
              { errorType: error instanceof Error ? error.name : typeof error,
                rawEnvironment: hasRawChatGptEnvironmentContext(parsed),
                currentEnvironment: hasCurrentChatGptEnvironmentContext(parsed),
                acceptedCompactionContinuation: isChatGptCompactionContinuation(parsed) },
            );
            if (mode.localTools) throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary) {
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    `${handoffTraceId}_fallback`,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  const armHandoffDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => handoffDeadline.abort(handoffTimeoutError),
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  const runFreshCompactionFallback = async (reason: string): Promise<string> => {
                    console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // The fallback is a new bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      `${handoffTraceId}_fallback`,
                      turnCapabilities,
                      { onCompactionProgress: armHandoffDeadline },
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let preserveFinalResponse = false;
                  try {
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    source = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompactionFallback("source_unavailable_before_handoff");
                    }
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompactionFallback("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompactionFallback("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompactionFallback("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              // Preserve actionable pre-submission failures. A generic handoff error otherwise
              // hides an oversized record or stalled preparation and encourages identical retries.
              if (handoffError instanceof ChatGptWebAdapterError
                && ["context_length_exceeded", "prompt_preparation_timeout", "model_controls_unavailable", "multipart_context_unavailable"].includes(handoffError.code)) {
                emit({ type: "error", message: handoffError.message, status: handoffError.status,
                  errorType: handoffError.errorType, code: handoffError.code, retryable: false });
                return;
              }
              emit({
                type: "error",
                message: "ChatGPT did not complete the context handoff. Retry the task.",
                status: 409,
                errorType: "invalid_request_error",
                code: "compaction_handoff_failed",
                retryable: false,
              });
              return;
            }
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = new Set(priorChatGptAbortedTurnIds(parsed));
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const instructionLineage = chatGptInstructionLineage(parsed);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities, {
            retryHistoryReductionLevel,
            generationPriority,
          }),
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          instructionLineage,
        );
        const roundKey = chatGptTurnRoundKey(parsed);
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        try {
          await session.runExclusive(async () => {
            const currentInstruction = session.instructionIdentity();
            const successorFollowUp = currentInstruction !== undefined
              && currentInstruction !== instructionLineage.current;
            if (successorFollowUp && !instructionLineage.predecessors.has(currentInstruction)) {
              throw new ChatGptWebAdapterError("The retained ChatGPT conversation no longer owns this Codex instruction lineage", {
                status: 409,
                errorType: "invalid_request_error",
                code: "follow_up_lineage_conflict",
                retryable: false,
              });
            }
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled && successorFollowUp) {
              throw new ChatGptWebAdapterError("ChatGPT finished before the Codex follow-up could be submitted in the retained conversation", {
                status: 409,
                errorType: "invalid_request_error",
                code: "follow_up_same_chat_unavailable",
                retryable: false,
              });
            }
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                for (const message of results) {
                  await broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                  session.runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            if (successorFollowUp) {
              const channel = session.runtime.followUp;
              if (!channel || !session.conversationKey()) {
                throw new ChatGptWebAdapterError("This ChatGPT browser session cannot accept a same-conversation Codex follow-up", {
                  status: 409,
                  errorType: "invalid_request_error",
                  code: "follow_up_same_chat_unavailable",
                  retryable: false,
                });
              }
              const request = followUpRequest(parsed, instructionLineage.current);
              await withAbort(channel.enqueue(request), incoming.abortSignal);
              const terminal = await withAbort(channel.waitForTerminal(request), incoming.abortSignal);
              if (terminal.type === "rejected") {
                throw new ChatGptWebAdapterError(terminal.message, {
                  status: 409,
                  errorType: "invalid_request_error",
                  code: "follow_up_rejected",
                  retryable: false,
                });
              }
              session.advanceInstruction(instructionLineage.current);
              // The retained browser now belongs to the successor response. Any text/reasoning
              // buffered before verified follow-up submission belongs to the predecessor round.
              session.runtime.trace.reset();
              session.runtime.text.reset();
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (turnToken) await broker.revoke(turnToken);
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
