import type { Locator, Page } from "playwright-core";
import { writeArtifactManifest } from "../artifact-manifest";
import { persistOutputImage } from "../artifact-store";
import type { OutputArtifactTarget, OutputImageCaptureResult } from "../types";
import { detectOutputImages } from "./image-detector";
import { downloadOutputImage } from "./image-downloader";
import { sniffImageMime } from "./image-sniffer";
import type { LauncherImageDownloadOwner } from "./download-transaction";
import { ImageTransferDeadline, ImageTransferError, imageTransferLog, redactImageTransferError } from "../../image-transfer";

export class OutputImageAdapter {
  observe(responseTurn: Locator) { return detectOutputImages(responseTurn); }

  async captureFinal(options: { page: Page; responseTurn: Locator; assistantTurnId: string; traceId: string; executionKey: string; target: OutputArtifactTarget; abortSignal?: AbortSignal; launcherOwner?: LauncherImageDownloadOwner }): Promise<OutputImageCaptureResult> {
    const budget = new ImageTransferDeadline(undefined, options.abortSignal);
    const log = imageTransferLog(options.traceId, options.target.metadata?.jobId);
    log("capture_started", { assistantTurnId: options.assistantTurnId });
    try {
    const candidates = await budget.observe(detectOutputImages(options.responseTurn));
    const artifacts = []; const failures: Array<{ candidateKey: string; code: string }> = [];
    let totalBytes = 0;
    for (const candidate of candidates.slice(0, options.target.maxArtifacts)) {
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
        artifacts.push(persistOutputImage({ bytes, target: options.target, assistantTurnId: options.assistantTurnId, candidateKey: candidate.key, mimeType }));
        log("artifact_saved", { candidateKey: candidate.key, byteLength: bytes.length });
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        const code = error instanceof ImageTransferError ? error.code : "image_capture_failed";
        log("capture_failed", { candidateKey: candidate.key, code, error: redactImageTransferError(error) });
        failures.push({ candidateKey: candidate.key, code });
      }
    }
    for (const candidate of candidates.slice(options.target.maxArtifacts)) failures.push({ candidateKey: candidate.key, code: "artifact_limit_exceeded" });
    if (candidates.length === 0) failures.push({ candidateKey: "capture", code: "generated_image_disappeared" });
    const manifestPath = artifacts.length > 0 ? writeArtifactManifest({ executionKey: options.executionKey, traceId: options.traceId, assistantTurnId: options.assistantTurnId, target: options.target, artifacts, failures }) : undefined;
    return { artifacts, manifestPath, failures, detectedCandidates: candidates.length, ignoredCandidates: Math.max(0, candidates.length - options.target.maxArtifacts) };
    } finally { budget.dispose(); }
  }
}
