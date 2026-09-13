import type { Locator, Page } from "playwright-core";
import { writeArtifactManifest } from "../artifact-manifest";
import { persistOutputImage } from "../artifact-store";
import type { OutputArtifactTarget, OutputImageCaptureResult } from "../types";
import { detectOutputImages } from "./image-detector";
import { downloadOutputImage } from "./image-downloader";
import { sniffImageMime } from "./image-sniffer";
import type { LauncherImageDownloadOwner } from "./download-transaction";
import { ImageTransferDeadline, ImageTransferError, imageTransferLog, redactImageTransferError } from "../../image-transfer";

async function stableOutputImages(
  responseTurn: Locator,
  abortSignal: AbortSignal | undefined,
  settleMs: number,
  deadlineAt: number,
) {
  let stableSince = 0;
  let previous = "";
  let latest = await detectOutputImages(responseTurn);
  for (;;) {
    abortSignal?.throwIfAborted();
    const signature = JSON.stringify(latest.map(candidate => [
      candidate.cardId ?? candidate.key,
      candidate.fileIdentity ?? "",
      candidate.readiness,
      candidate.width ?? 0,
      candidate.height ?? 0,
    ]));
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= settleMs) {
      return latest;
    }
    if (Date.now() >= deadlineAt) return latest;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, 200);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        reject(abortSignal?.reason ?? new DOMException("Image capture aborted", "AbortError"));
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) onAbort();
    });
    latest = await detectOutputImages(responseTurn);
  }
}

export class OutputImageAdapter {
  observe(responseTurn: Locator) { return detectOutputImages(responseTurn); }

  async captureFinal(options: {
    page: Page;
    responseTurn: Locator;
    assistantTurnId: string;
    traceId: string;
    executionKey: string;
    target: OutputArtifactTarget;
    abortSignal?: AbortSignal;
    launcherOwner?: LauncherImageDownloadOwner;
    maxArtifacts?: number;
    existingTotalBytes?: number;
    writeManifest?: boolean;
    excludeCandidateKeys?: string[];
  }): Promise<OutputImageCaptureResult> {
    const jobDeadlineAt = Date.now() + 240_000;
    const log = imageTransferLog(options.traceId, options.target.metadata?.jobId);
    log("capture_started", { assistantTurnId: options.assistantTurnId });
    const candidates = await stableOutputImages(
      options.responseTurn,
      options.abortSignal,
      2_000,
      Math.min(jobDeadlineAt, Date.now() + 10_000),
    );
    const artifactLimit = Math.min(options.maxArtifacts ?? options.target.maxArtifacts, options.target.maxArtifacts);
    const excluded = new Set(options.excludeCandidateKeys ?? []);
    const selected = candidates.filter(candidate => !excluded.has(candidate.key)).slice(0, artifactLimit);
    const artifacts = []; const failures: Array<{ candidateKey: string; code: string }> = [];
    let totalBytes = options.existingTotalBytes ?? 0;
    for (const candidate of selected) {
      const budget = new ImageTransferDeadline(Math.min(Date.now() + 60_000, jobDeadlineAt), options.abortSignal);
      try {
        const maxBytes = Math.min(options.target.maxBytesPerArtifact, options.target.maxTotalBytes - totalBytes);
        let bytes: Buffer | undefined;
        let failure: unknown;
        // Only pre-click transient binding failures can retry. Never replay a download or prompt.
        for (let attempt = 0; attempt < 2 && !bytes; attempt += 1) {
          try {
            const fresh = attempt === 0 ? candidate : (await budget.observe(detectOutputImages(options.responseTurn))).find(value => value.key === candidate.key) ?? candidate;
            bytes = await downloadOutputImage({ page: options.page, responseTurn: options.responseTurn, candidate: fresh, maxBytes,
              abortSignal: options.abortSignal, budget, launcherOwner: options.launcherOwner, log });
          } catch (error) {
            failure = error;
            budget.remaining();
            if (!(error instanceof ImageTransferError) || !error.retryable || attempt === 1) throw error;
            log("capture_binding_retry", { candidateKey: candidate.key, attempt: attempt + 1, error: redactImageTransferError(error) });
            await budget.pause(350);
          }
        }
        if (!bytes) throw failure;
        budget.remaining();
        const mimeType = sniffImageMime(bytes);
        if (!mimeType) throw new ImageTransferError("invalid_image_mime", "validate");
        log("image_validated", { candidateKey: candidate.key, mimeType, byteLength: bytes.length });
        totalBytes += bytes.length;
        const assistantTurnId = candidate.assistantTurnId ?? options.assistantTurnId;
        artifacts.push(persistOutputImage({
          bytes,
          target: options.target,
          assistantTurnId,
          candidateKey: candidate.key,
          mimeType,
          source: {
            cardId: candidate.cardId,
            fileIdentity: candidate.fileIdentity,
            submissionId: options.target.metadata?.submissionId,
            imageSessionId: options.target.metadata?.imageSessionId,
            projectId: options.target.metadata?.projectId,
            conversationUrl: options.target.metadata?.conversationUrl,
            jobId: options.target.metadata?.jobId,
          },
        }));
        log("artifact_saved", { candidateKey: candidate.key, byteLength: bytes.length });
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        const code = error instanceof ImageTransferError ? error.code : "image_capture_failed";
        log("capture_failed", { candidateKey: candidate.key, code, error: redactImageTransferError(error) });
        failures.push({ candidateKey: candidate.key, code });
      } finally { budget.dispose(); }
    }
    if (candidates.length === 0) failures.push({ candidateKey: "capture", code: "generated_image_disappeared" });
    const excessCandidateKeys = candidates.slice(artifactLimit).map(candidate => candidate.key);
    const manifestPath = artifacts.length > 0 && options.writeManifest !== false
      ? writeArtifactManifest({ executionKey: options.executionKey, traceId: options.traceId, assistantTurnId: options.assistantTurnId, target: options.target, artifacts, failures })
      : undefined;
    return {
      artifacts,
      manifestPath,
      failures,
      candidateKeys: candidates.map(candidate => candidate.key),
      excessCandidateKeys,
      detectedCandidates: candidates.length,
      ignoredCandidates: excessCandidateKeys.length,
    };
  }
}
