import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CodexProviderConfig } from "../../../types";
import { ChatGptBrowserWorker } from "../browser-worker";
import { callNativeAuthority } from "../native-authority";
import { resolveOutputArtifactTarget } from "../artifacts/artifact-target";
import { writeArtifactManifest } from "../artifacts/artifact-manifest";
import type { OutputArtifact, OutputArtifactTarget, OutputImageCaptureResult } from "../artifacts/types";
import type { ImageFactoryParent } from "./service";
import { ImageFactoryError } from "./contracts";
import type { ImageSession, StoredImageJob } from "./state";
import { imageKey } from "./state";
import { verifiedImageFactoryConversationUrl } from "./project-navigation";

/** Reuse capture/download code on an already observed response. This path has no Send operation. */
export function nativeImageReconciler(provider: CodexProviderConfig) {
  return async (job: StoredImageJob, session: ImageSession, parent: ImageFactoryParent) => {
    if (!job.nativeBinding || !parent.nativeBinding || job.nativeBinding.threadId !== parent.threadId
      || job.nativeBinding.workspace !== parent.nativeBinding.workspace || !session.projectId) {
      throw new ImageFactoryError("image_submission_unknown", "Native reconciliation requires the original owner and registered submission.");
    }
    const inspected = await callNativeAuthority(job.nativeBinding.workspace, {
      operation: "inspect", request_sha256: job.nativeBinding.requestSha256, thread_id: parent.threadId,
    });
    const visible = inspected.receipts.findLast((receipt: any) => receipt.evidence?.assistant_turn_id && receipt.evidence?.user_turn_id);
    const submitted = inspected.receipts.find((receipt: any) => receipt.evidence?.conversation_url);
    const url = verifiedImageFactoryConversationUrl(submitted?.evidence.conversation_url ?? session.conversationUrl, session.projectId);
    if (!visible || !url) throw new ImageFactoryError("image_submission_unknown", "The original assistant turn is not yet proven; no prompt was sent.");
    const known = job.result.artifacts.filter(artifact => existsSync(artifact.absolutePath)
      && createHash("sha256").update(readFileSync(artifact.absolutePath)).digest("hex") === artifact.sha256);
    const key = imageKey("reconcile", job.key, known.map(artifact => artifact.sha256));
    const resolved = resolveOutputArtifactTarget(parent.environment, key, { capturePolicy: "required" });
    if (!resolved) throw new ImageFactoryError("image_workspace_unavailable");
    const target: OutputArtifactTarget = { ...resolved, maxArtifacts: job.requestedCount,
      metadata: { output: "image", surface: "persistent", projectId: session.projectId,
        conversationUrl: url, imageSessionId: session.id, jobId: job.result.jobId,
        sourceTurn: parent.threadId, actualMode: inspected.binding.payload.model } };
    const artifacts: OutputArtifact[] = [...known];
    let capture: OutputImageCaptureResult | undefined;
    const worker = ChatGptBrowserWorker.forProvider({ ...provider,
      chatgptWeb: { ...provider.chatgptWeb, appName: `${provider.chatgptWeb?.appName ?? "ChatGPT"} Image Factory Reconcile` } });
    const release = parent.activity();
    let text: string;
    try {
      text = await worker.run({
        traceId: `reconcile_${key.slice(0, 45)}`, nativeBinding: job.nativeBinding,
        nativeImageReconcile: { assistantTurnId: visible.evidence.assistant_turn_id,
          userTurnId: visible.evidence.user_turn_id, excludeCandidateKeys: known.map(artifact => artifact.source.candidateKey) },
        modelId: "gpt-5.6-sol", reasoning: inspected.binding.payload.reasoning_effort,
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: provider.chatgptWeb?.proAvailable === true },
        surface: "persistent", persistentProjectId: session.projectId,
        skipConnectorIdentity: true, requireRetainedConversation: true, resumeConversationUrl: url,
        conversationKey: imageKey("native-reconcile-conversation", session.owner, session.id),
        prepare: async () => ({ text: "", images: [], release: () => {} }),
        prepareResume: async () => ({ text: "", images: [], release: () => {} }),
        outputArtifactTarget: target, outputArtifactExecutionKey: key, outputArtifactLimit: job.requestedCount,
        outputArtifactWriteManifest: false, abortSignal: parent.signal, onTextDelta: () => {},
        onOutputArtifact: artifact => {
          if (!artifacts.some(existing => existing.source.assistantTurnId === artifact.source.assistantTurnId
            && existing.source.candidateKey === artifact.source.candidateKey)) artifacts.push(artifact);
        },
        onOutputArtifactCapture: result => { capture = result; },
      });
    } finally { release(); }
    if (!capture) throw new ImageFactoryError("image_submission_unknown");
    const manifestPath = writeArtifactManifest({ executionKey: key, traceId: `reconcile_${key.slice(0, 45)}`,
      assistantTurnId: visible.evidence.assistant_turn_id, target, artifacts, failures: capture.failures,
      job: { operation: job.operation, requestedCount: job.requestedCount, generatedCount: job.result.generatedCount,
        downloadedCount: artifacts.length, attemptCount: job.attemptCount, submissions: job.submissions } });
    session.conversationUrl = url;
    session.hasConversation = true;
    return { status: artifacts.length >= job.requestedCount ? "completed" as const : "partial" as const,
      artifacts, manifestPath, downloadedCount: artifacts.length, text,
      candidateErrors: capture.failures, attemptCount: job.attemptCount };
  };
}
