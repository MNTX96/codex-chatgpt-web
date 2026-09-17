import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import { createProcessLineWriter } from "./process-line-writer";
import { createBrowserHelperPromptSelection } from "./browser-helper-prompt-selection";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { ChatGptMirroredTurnProgress } from "./turn-progress";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";
import type { OutputArtifactTarget, OutputImageSource } from "./artifacts/types";
import { verifiedImageFactoryConversationUrl } from "./image-factory/project-navigation";
import {
  assertChatGptFollowUpRequest,
  ChatGptFollowUpChannel,
  type ChatGptFollowUpRequest,
} from "./follow-up";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
  };
  turn: {
    traceId: string;
    generationPriority?: BrowserTurn["generationPriority"];
    imageReconcile?: BrowserTurn["imageReconcile"];
    modelId: string;
    reasoning?: string;
    capabilities: ChatGptWebCapabilities;
    nativeConnector?: boolean;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    resumeConversationUrl?: string;
    conversationKey?: string;
    surface?: "temporary" | "persistent";
    persistentProjectId?: string;
    persistentProjectName?: string;
    executionTarget?: BrowserTurn["executionTarget"];
    skipConnectorIdentity?: boolean;
    compaction?: boolean;
    captureLunaCheckpoint?: boolean;
    externalProgress?: boolean;
    outputArtifactTarget?: OutputArtifactTarget;
    outputArtifactExecutionKey?: string;
    outputArtifactLimit?: number;
    outputArtifactExistingTotalBytes?: number;
    outputArtifactWriteManifest?: boolean;
    requireOutputArtifact?: boolean;
    imageEditSource?: OutputImageSource;
    followUp?: boolean;
  };
}

interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage;
type InputMessage = RunMessage
  | MaintenanceMessage
  | { type: "prepared_selected_ack"; id: string; prepared: CompiledChatGptWebPrompt }
  | { type: "send_activation_ack"; id: string }
  | { type: "completion_fence_begin_ack"; id: string; requestId: number; revision: number | null }
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "follow_up"; id: string; request: ChatGptFollowUpRequest }
  | { type: "abort"; id: string; reason?: "compaction_handoff_accepted" }
  | { type: "shutdown" };

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown();
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): boolean => protocolOutput.write(JSON.stringify(message));

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
const turnProgress = new Map<string, ChatGptMirroredTurnProgress>();
const followUpChannels = new Map<string, ChatGptFollowUpChannel>();
const preparedSelections = new Map<string, ReturnType<typeof createBrowserHelperPromptSelection>>();
const sendActivationWaiters = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
}>();
const completionFenceBeginWaiters = new Map<string, {
  requestId: number;
  resolve: (revision: number | undefined) => void;
  reject: (error: Error) => void;
}>();
const completionFenceCommitWaiters = new Map<string, {
  requestId: number;
  resolve: (committed: boolean) => void;
  reject: (error: Error) => void;
}>();
let completionFenceRequestId = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function requestShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  let completeShutdown!: () => void;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    completeShutdown = resolveShutdown;
  });
  shuttingDown = true;
  protocolOutput.close();
  diagnosticOutput.close();
  for (const controller of abortControllers.values()) controller.abort();
  for (const channel of followUpChannels.values()) channel.close();
  followUpChannels.clear();
  for (const selection of preparedSelections.values()) selection.cancel();
  preparedSelections.clear();
  for (const waiter of sendActivationWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  sendActivationWaiters.clear();
  for (const waiter of completionFenceBeginWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceBeginWaiters.clear();
  for (const waiter of completionFenceCommitWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceCommitWaiters.clear();
  input.close();
  void closeChatGptBrowserWorkers().then(
    () => {
      completeShutdown();
      process.exit(0);
    },
    error => {
      diagnostic(`Browser helper shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      completeShutdown();
      process.exit(1);
    },
  );
  return shutdownPromise;
}

async function run(message: RunMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id) || message.id !== message.turn.traceId) {
    throw new Error("Browser helper turn identity is invalid");
  }
  if (abortControllers.has(message.id)) throw new Error(`Browser helper turn already exists: ${message.id}`);
  if (message.turn.generationPriority !== undefined
    && message.turn.generationPriority !== "normal"
    && message.turn.generationPriority !== "retry") {
    throw new Error("Browser helper generation priority is invalid");
  }
  if (message.turn.resumeAvailable !== undefined && typeof message.turn.resumeAvailable !== "boolean") {
    throw new Error("Browser helper resume availability is invalid");
  }
  if (message.turn.nativeConnector !== undefined && typeof message.turn.nativeConnector !== "boolean") {
    throw new Error("Browser helper native connector flag is invalid");
  }
  if (message.turn.skipConnectorIdentity !== undefined && typeof message.turn.skipConnectorIdentity !== "boolean") {
    throw new Error("Browser helper connector identity flag is invalid");
  }
  if (message.turn.retainConversation !== undefined && typeof message.turn.retainConversation !== "boolean") {
    throw new Error("Browser helper conversation retention flag is invalid");
  }
  if (message.turn.requireRetainedConversation !== undefined
    && typeof message.turn.requireRetainedConversation !== "boolean") {
    throw new Error("Browser helper retained-conversation requirement is invalid");
  }
  if (message.turn.resumeConversationUrl !== undefined) {
    const projectId = message.turn.persistentProjectId;
    if (typeof message.turn.resumeConversationUrl !== "string"
      || !message.turn.requireRetainedConversation
      || !message.turn.resumeAvailable
      || message.turn.surface !== "persistent"
      || message.turn.executionTarget?.output !== "image"
      || typeof projectId !== "string"
      || message.turn.executionTarget.projectId !== projectId
      || verifiedImageFactoryConversationUrl(message.turn.resumeConversationUrl, projectId) === undefined) {
      throw new Error("Browser helper retained Image Factory recovery URL is invalid");
    }
  }
  if (message.turn.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(message.turn.conversationKey)) {
    throw new Error("Browser helper conversation key is invalid");
  }
  if (message.turn.surface !== undefined && message.turn.surface !== "temporary" && message.turn.surface !== "persistent") {
    throw new Error("Browser helper chat surface is invalid");
  }
  if (message.turn.surface === "persistent"
    && (typeof message.turn.persistentProjectId !== "string" || !message.turn.persistentProjectId.trim())) {
    throw new Error("Browser helper persistent project id is invalid");
  }
  if (message.turn.persistentProjectName !== undefined && typeof message.turn.persistentProjectName !== "string") {
    throw new Error("Browser helper persistent project name is invalid");
  }
  if (message.turn.executionTarget?.output === "image"
    && (message.turn.executionTarget.surface !== "persistent"
      || message.turn.executionTarget.projectId !== message.turn.persistentProjectId
      || !message.turn.executionTarget.imageSessionId)) {
    throw new Error("Browser helper image execution target is invalid");
  }
  if (message.turn.executionTarget?.output === "text" && message.turn.executionTarget.surface !== "temporary") {
    throw new Error("Browser helper text execution target is invalid");
  }
  if (message.turn.compaction !== undefined && typeof message.turn.compaction !== "boolean") {
    throw new Error("Browser helper compaction flag is invalid");
  }
  if (message.turn.captureLunaCheckpoint !== undefined && typeof message.turn.captureLunaCheckpoint !== "boolean") {
    throw new Error("Browser helper Luna checkpoint flag is invalid");
  }
  if (message.turn.externalProgress !== undefined && typeof message.turn.externalProgress !== "boolean") {
    throw new Error("Browser helper external progress flag is invalid");
  }
  if (message.turn.followUp !== undefined && typeof message.turn.followUp !== "boolean") {
    throw new Error("Browser helper follow-up flag is invalid");
  }
  if (message.turn.followUp && (!message.turn.retainConversation || !message.turn.externalProgress)) {
    throw new Error("Browser helper follow-up requires a retained automatic tool turn");
  }
  const artifactTarget = message.turn.outputArtifactTarget;
  if (message.turn.requireOutputArtifact !== undefined && typeof message.turn.requireOutputArtifact !== "boolean") {
    throw new Error("Browser helper output artifact requirement is invalid");
  }
  if (artifactTarget && (!message.turn.outputArtifactExecutionKey || !/^[a-f0-9]{64}$/.test(message.turn.outputArtifactExecutionKey)
    || typeof artifactTarget.workspaceRoot !== "string" || typeof artifactTarget.outputDirectory !== "string"
    || !Array.isArray(artifactTarget.writableRoots) || artifactTarget.writableRoots.some(root => typeof root !== "string")
    || !Number.isSafeInteger(artifactTarget.maxArtifacts) || artifactTarget.maxArtifacts <= 0
    || !Number.isSafeInteger(artifactTarget.maxBytesPerArtifact) || artifactTarget.maxBytesPerArtifact <= 0
    || !Number.isSafeInteger(artifactTarget.maxTotalBytes) || artifactTarget.maxTotalBytes <= 0
    || !["required", "best-effort"].includes(artifactTarget.capturePolicy))) {
    throw new Error("Browser helper output artifact target is invalid");
  }
  if (message.turn.outputArtifactLimit !== undefined
    && (!Number.isSafeInteger(message.turn.outputArtifactLimit) || message.turn.outputArtifactLimit <= 0
      || !artifactTarget || message.turn.outputArtifactLimit > artifactTarget.maxArtifacts)) {
    throw new Error("Browser helper output artifact limit is invalid");
  }
  if (message.turn.outputArtifactExistingTotalBytes !== undefined
    && (!Number.isSafeInteger(message.turn.outputArtifactExistingTotalBytes)
      || message.turn.outputArtifactExistingTotalBytes < 0
      || !artifactTarget
      || message.turn.outputArtifactExistingTotalBytes > artifactTarget.maxTotalBytes)) {
    throw new Error("Browser helper existing output artifact byte count is invalid");
  }
  if (message.turn.outputArtifactWriteManifest !== undefined
    && typeof message.turn.outputArtifactWriteManifest !== "boolean") {
    throw new Error("Browser helper output artifact manifest flag is invalid");
  }
  const imageEditSource = message.turn.imageEditSource;
  if (imageEditSource && (
    message.turn.executionTarget?.output !== "image"
    || !message.turn.resumeAvailable
    || typeof imageEditSource.assistantTurnId !== "string" || !imageEditSource.assistantTurnId
    || typeof imageEditSource.candidateKey !== "string" || !imageEditSource.candidateKey
    || (typeof imageEditSource.cardId !== "string" && typeof imageEditSource.fileIdentity !== "string")
  )) {
    throw new Error("Browser helper image edit source is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      browserDiagnosticsPath: message.config.browserDiagnosticsPath,
      turnTimeoutMs: message.config.turnTimeoutMs,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  // The Codex MCP broker runs in the daemon process, so this mirror is the only way the worker can
  // observe that a turn is still executing while its ChatGPT DOM is unavailable. Trace ids are
  // derived deterministically and can repeat, so each run starts a fresh mirror rather than
  // inheriting revisions recorded for an earlier turn that happened to share the id.
  const progress = message.turn.externalProgress
    ? new ChatGptMirroredTurnProgress(revision => {
      if (!writeProtocol({ type: "event", id: message.id, event: "tool_batch_observed", revision })) {
        throw new Error("Browser helper could not acknowledge the observed Codex tool boundary");
      }
    })
    : undefined;
  if (progress) turnProgress.set(message.id, progress);
  const followUp = message.turn.followUp ? new ChatGptFollowUpChannel() : undefined;
  const releaseFollowUpEvents = followUp?.onEvent(event => {
    const written = writeProtocol({
      type: "event",
      id: message.id,
      event: "follow_up",
      phase: event.type,
      requestId: event.requestId,
      revision: event.revision,
      ...(event.type === "submitted" && event.conversationUrl
        ? { conversationUrl: event.conversationUrl }
        : {}),
      ...(event.type === "rejected" ? { message: event.message } : {}),
    });
    if (!written) throw new Error("Browser helper could not report follow-up lifecycle evidence");
  });
  if (followUp) followUpChannels.set(message.id, followUp);
  const promptSelection = createBrowserHelperPromptSelection();
  preparedSelections.set(message.id, promptSelection);
  const prepareSelected = async () => ({ ...await promptSelection.wait(), release: () => {} });
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    ...(message.turn.generationPriority ? { generationPriority: message.turn.generationPriority } : {}),
    modelId: message.turn.modelId,
    reasoning: message.turn.reasoning,
    capabilities: message.turn.capabilities,
    ...(message.turn.nativeConnector ? { nativeConnector: true } : {}),
    prepare: prepareSelected,
    ...(message.turn.resumeAvailable ? { prepareResume: prepareSelected } : {}),
    ...(message.turn.imageReconcile ? { imageReconcile: message.turn.imageReconcile } : {}),
    ...(message.turn.retainConversation ? { retainConversation: true } : {}),
    ...(message.turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    ...(message.turn.resumeConversationUrl ? { resumeConversationUrl: message.turn.resumeConversationUrl } : {}),
    ...(message.turn.conversationKey ? { conversationKey: message.turn.conversationKey } : {}),
    ...(message.turn.surface ? { surface: message.turn.surface } : {}),
    ...(message.turn.persistentProjectId ? { persistentProjectId: message.turn.persistentProjectId } : {}),
    ...(message.turn.persistentProjectName ? { persistentProjectName: message.turn.persistentProjectName } : {}),
    ...(message.turn.executionTarget ? { executionTarget: message.turn.executionTarget } : {}),
    ...(message.turn.skipConnectorIdentity ? { skipConnectorIdentity: true } : {}),
    abortSignal: abortController.signal,
    ...(message.turn.compaction ? { compaction: true } : {}),
    ...(artifactTarget ? {
      outputArtifactTarget: artifactTarget,
      outputArtifactExecutionKey: message.turn.outputArtifactExecutionKey!,
      ...(message.turn.outputArtifactLimit !== undefined ? { outputArtifactLimit: message.turn.outputArtifactLimit } : {}),
      ...(message.turn.outputArtifactExistingTotalBytes !== undefined
        ? { outputArtifactExistingTotalBytes: message.turn.outputArtifactExistingTotalBytes }
        : {}),
      ...(message.turn.outputArtifactWriteManifest !== undefined
        ? { outputArtifactWriteManifest: message.turn.outputArtifactWriteManifest }
        : {}),
      onOutputArtifact: artifact => {
        if (!writeProtocol({ type: "event", id: message.id, event: "output_artifact", artifact })) throw new Error("Browser helper could not report output artifact");
      },
      onOutputArtifactCapture: capture => {
        if (!writeProtocol({ type: "event", id: message.id, event: "output_artifact_capture", capture })) {
          throw new Error("Browser helper could not report output artifact capture summary");
        }
      },
    } : {}),
    ...(imageEditSource ? { imageEditSource } : {}),
    ...(message.turn.requireOutputArtifact ? { requireOutputArtifact: true } : {}),
    ...(followUp ? { followUp } : {}),
    ...(progress ? {
      externalProgress: progress,
      completionFence: {
        begin: () => new Promise<number | undefined>((resolve, reject) => {
          if (completionFenceBeginWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a begin result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceBeginWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeProtocol({ type: "event", id: message.id, event: "completion_fence_begin", requestId })) {
            completionFenceBeginWaiters.delete(message.id);
            reject(new Error("Browser helper could not begin the broker completion fence"));
          }
        }),
        commit: revision => new Promise<boolean>((resolve, reject) => {
          if (completionFenceCommitWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a commit result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceCommitWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeProtocol({ type: "event", id: message.id, event: "completion_fence_commit", requestId, revision })) {
            completionFenceCommitWaiters.delete(message.id);
            reject(new Error("Browser helper could not commit the broker completion fence"));
          }
        }),
      },
    } : {}),
    onHeartbeat: () => writeProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onPreparedSelected: reused => {
      if (!writeProtocol({ type: "event", id: message.id, event: "prepared_selected", reused })) {
        throw new Error("Browser helper could not request prompt selection");
      }
      return promptSelection.wait().then(() => undefined);
    },
    onSendActivated: () => new Promise<void>((resolve, reject) => {
      if (sendActivationWaiters.has(message.id)) {
        reject(new Error("Browser helper Send activation already awaits acknowledgement"));
        return;
      }
      sendActivationWaiters.set(message.id, { resolve, reject });
      if (!writeProtocol({ type: "event", id: message.id, event: "send_activated" })) {
        sendActivationWaiters.delete(message.id);
        reject(new Error("Browser helper could not request the Send activation boundary"));
      }
    }),
    onSubmitted: url => {
      // The target crossed IPC before Send. Update the helper's own copy before it captures files;
      // changing the daemon's target cannot update this process's artifact provenance.
      if (artifactTarget?.metadata?.output === "image" && artifactTarget.metadata.projectId) {
        const conversationUrl = verifiedImageFactoryConversationUrl(url, artifactTarget.metadata.projectId);
        if (conversationUrl) artifactTarget.metadata.conversationUrl = conversationUrl;
      }
      if (!writeProtocol({ type: "event", id: message.id, event: "submitted", ...(url ? { url } : {}) })) {
        throw new Error("Browser helper could not persist ChatGPT submission evidence");
      }
    },
    onMultipartStageAcknowledged: stageIndex => {
      if (!writeProtocol({ type: "event", id: message.id, event: "multipart_stage_acknowledged", stageIndex })) {
        throw new Error("Browser helper could not persist multipart acknowledgement evidence");
      }
    },
    onReasoningSummary: (text, continuation) => writeProtocol({
      type: "event",
      id: message.id,
      event: "reasoning",
      text,
      ...(continuation ? { continuation: true } : {}),
    }),
    onCommentary: (text, continuation) => writeProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
    onTextDelta: text => writeProtocol({ type: "event", id: message.id, event: "text", text }),
    ...(message.turn.captureLunaCheckpoint ? {
      captureLunaCheckpoint: true,
      onLunaCheckpoint: captured => writeProtocol({
        type: "event",
        id: message.id,
        event: "luna_checkpoint",
        ...captured,
      }),
    } : {}),
  };
  try {
    const text = await ChatGptBrowserWorker.forProvider(provider).run(turn);
    writeProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatGptWebAdapterError ? {
        status: error.status,
        errorType: error.errorType,
        code: error.code,
        retryable: error.retryable,
      } : {}),
    });
  } finally {
    releaseFollowUpEvents?.();
    followUp?.close(new DOMException("Browser helper turn ended", "AbortError"));
    followUpChannels.delete(message.id);
    preparedSelections.get(message.id)?.cancel();
    preparedSelections.delete(message.id);
    const sendWaiter = sendActivationWaiters.get(message.id);
    sendActivationWaiters.delete(message.id);
    sendWaiter?.reject(new DOMException("Browser helper turn ended before Send acknowledgement", "AbortError"));
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence commit", "AbortError"));
    abortControllers.delete(message.id);
    turnProgress.delete(message.id);
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  try {
    const selected = await maintenanceWorker(message).verifyConnector(message.id);
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function maintenanceWorker(message: MaintenanceMessage): ChatGptBrowserWorker {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper maintenance identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper maintenance config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: { appName, browserHost: "launcher", browserHostDescriptorPath },
  };
  return ChatGptBrowserWorker.forProvider(provider);
}

async function maintain(message: InspectMessage | SmokeMessage): Promise<void> {
  if (abortControllers.has(message.id)) throw new Error(`Browser helper maintenance operation already exists: ${message.id}`);
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  try {
    const worker = maintenanceWorker(message);
    const value = message.type === "inspect"
      ? await worker.inspectSession(message.detectCapabilities)
      : await worker.smokeTest(abortController.signal);
    writeProtocol({ type: "result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (shuttingDown) return;
  let message: InputMessage;
  try { message = JSON.parse(line) as InputMessage; }
  catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }
  if (message.type === "prepared_selected_ack") {
    const prepared = message.prepared;
    if (!prepared || typeof prepared.text !== "string" || !Array.isArray(prepared.images)) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper prompt selection is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    if (prepared.multipart !== undefined) {
      const multipart = prepared.multipart;
      if (!multipart || !Array.isArray(multipart.parts)
        || (multipart.parts.length !== 2 && multipart.parts.length !== 3)
        || multipart.parts.some(part => typeof part !== "string")
        || typeof multipart.commit !== "string") {
        writeProtocol({ type: "error", id: message.id, message: "Browser helper multipart prompt is invalid" });
        abortControllers.get(message.id)?.abort();
        return;
      }
    }
    const selection = preparedSelections.get(message.id);
    if (!selection) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending prompt selection" });
      return;
    }
    selection.select(prepared);
  } else if (message.type === "send_activation_ack") {
    const waiter = sendActivationWaiters.get(message.id);
    if (!waiter) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending Send activation" });
      return;
    }
    sendActivationWaiters.delete(message.id);
    waiter.resolve();
  } else if (message.type === "completion_fence_begin_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || (message.revision !== null && (!Number.isSafeInteger(message.revision) || message.revision < 0))) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper completion fence revision is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = completionFenceBeginWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceBeginWaiters.delete(message.id);
    waiter.resolve(message.revision ?? undefined);
  } else if (message.type === "completion_fence_commit_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || typeof message.committed !== "boolean") {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper completion fence result is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = completionFenceCommitWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceCommitWaiters.delete(message.id);
    waiter.resolve(message.committed);
  } else if (message.type === "progress") {
    // Progress is meaningful only for a turn this helper is currently running. Ignore every other
    // id so the mirror map remains owned by active turn lifecycles.
    if (!abortControllers.has(message.id)) return;
    const progress = turnProgress.get(message.id) ?? new ChatGptMirroredTurnProgress();
    turnProgress.set(message.id, progress);
    try {
      progress.apply(message.snapshot);
    } catch (error) {
      // Progress carries liveness and tool-boundary state, never response content. Invalid progress
      // cannot determine the outcome of the active ChatGPT turn, so it is logged and ignored.
      diagnostic(
        `[chatgpt-web] discarded an invalid MCP progress frame for ${message.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (message.type === "follow_up") {
    const channel = followUpChannels.get(message.id);
    try {
      assertChatGptFollowUpRequest(message.request);
    } catch (error) {
      writeProtocol({
        type: "error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!channel) {
      writeProtocol({
        type: "event",
        id: message.id,
        event: "follow_up",
        phase: "rejected",
        requestId: message.request.requestId,
        revision: message.request.revision,
        message: "Browser helper has no active retained follow-up channel",
      });
      return;
    }
    void channel.enqueue(message.request).catch(() => {
      // The channel emits a rejected lifecycle event for dispatch/timeout failures.
    });
  } else if (message.type === "abort") {
    followUpChannels.get(message.id)?.close(new DOMException("Browser helper turn aborted", "AbortError"));
    abortControllers.get(message.id)?.abort(message.reason === "compaction_handoff_accepted"
      ? new ChatGptCompactionHandoffAccepted()
      : undefined);
    preparedSelections.get(message.id)?.cancel();
    const waiter = sendActivationWaiters.get(message.id);
    sendActivationWaiters.delete(message.id);
    waiter?.reject(new DOMException("Browser helper turn aborted before Send acknowledgement", "AbortError"));
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn aborted before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn aborted before completion-fence commit", "AbortError"));
  }
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "inspect" || message.type === "smoke") {
    void maintain(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "run") {
    void run(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else {
    // Never treat an unrecognised frame as a run; unsupported protocol data fails explicitly.
    writeProtocol({
      type: "error",
      id: (message as { id?: string }).id ?? "unknown",
      message: `Browser helper received an unsupported message type: ${String((message as { type?: unknown }).type)}`,
    });
  }
});
input.on("close", () => {
  void requestShutdown();
});
process.once("SIGINT", () => {
  void requestShutdown();
});
process.once("SIGTERM", () => {
  void requestShutdown();
});

writeProtocol({
  type: "ready",
  features: [
    "progress",
    "tool-boundary-ack",
    "completion-fence",
    "multipart-stage-ack",
    "output-artifact-v1",
    "image-factory-v1",
    "image-factory-v2",
    "image-transfer-v1",
    "follow-up-v1",
  ],
});
