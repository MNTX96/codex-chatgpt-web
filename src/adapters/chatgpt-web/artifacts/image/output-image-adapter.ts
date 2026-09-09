import type { Locator, Page } from "playwright-core";
import { writeArtifactManifest } from "../artifact-manifest";
import { persistOutputImage } from "../artifact-store";
import type { OutputArtifactTarget, OutputImageCaptureResult } from "../types";
import { detectOutputImages } from "./image-detector";
import { downloadOutputImage } from "./image-downloader";
import { sniffImageMime } from "./image-sniffer";

export class OutputImageAdapter {
  observe(responseTurn: Locator) { return detectOutputImages(responseTurn); }

  async captureFinal(options: { page: Page; responseTurn: Locator; assistantTurnId: string; traceId: string; executionKey: string; target: OutputArtifactTarget; abortSignal?: AbortSignal }): Promise<OutputImageCaptureResult> {
    const candidates = await detectOutputImages(options.responseTurn);
    const artifacts = []; const failures: Array<{ candidateKey: string; code: string }> = [];
    let totalBytes = 0;
    for (const candidate of candidates.slice(0, options.target.maxArtifacts)) {
      try {
        if (candidate.readiness !== "ready") throw new Error("image_not_ready");
        const maxBytes = Math.min(options.target.maxBytesPerArtifact, options.target.maxTotalBytes - totalBytes);
        let bytes: Buffer | undefined;
        let failure: unknown;
        // Signed asset URLs may expire between final render and the authenticated fetch. Refresh
        // the same bound card once; never replay the model prompt to obtain another image.
        for (let attempt = 0; attempt < 2 && !bytes; attempt += 1) {
          try {
            const fresh = attempt === 0 ? candidate : (await detectOutputImages(options.responseTurn)).find(value => value.key === candidate.key) ?? candidate;
            bytes = await downloadOutputImage({ page: options.page, responseTurn: options.responseTurn, candidate: fresh, maxBytes, abortSignal: options.abortSignal });
          } catch (error) { failure = error; }
        }
        if (!bytes) throw failure;
        const mimeType = sniffImageMime(bytes);
        if (!mimeType) throw new Error("invalid_image_mime");
        totalBytes += bytes.length;
        artifacts.push(persistOutputImage({ bytes, target: options.target, assistantTurnId: options.assistantTurnId, candidateKey: candidate.key, mimeType }));
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        failures.push({ candidateKey: candidate.key, code: error instanceof Error ? error.message.replace(/[^a-z0-9_]/gi, "_").slice(0, 80) : "capture_failed" });
      }
    }
    for (const candidate of candidates.slice(options.target.maxArtifacts)) failures.push({ candidateKey: candidate.key, code: "artifact_limit_exceeded" });
    if (candidates.length === 0) failures.push({ candidateKey: "capture", code: "generated_image_disappeared" });
    const manifestPath = artifacts.length > 0 ? writeArtifactManifest({ executionKey: options.executionKey, traceId: options.traceId, assistantTurnId: options.assistantTurnId, target: options.target, artifacts, failures }) : undefined;
    return { artifacts, manifestPath, failures, detectedCandidates: candidates.length, ignoredCandidates: Math.max(0, candidates.length - options.target.maxArtifacts) };
  }
}
