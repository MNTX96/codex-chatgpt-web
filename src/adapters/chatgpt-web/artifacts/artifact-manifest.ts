import { join, relative } from "node:path";
import { atomicWriteArtifactJson } from "./artifact-store";
import type { OutputArtifact, OutputArtifactTarget } from "./types";

export interface ArtifactManifestJobSummary {
  operation: "generate" | "edit";
  requestedCount: number;
  generatedCount: number;
  downloadedCount: number;
  attemptCount: number;
  sourceArtifactId?: string;
  submissions?: unknown[];
  excessCandidateKeys?: string[];
}

export function writeArtifactManifest(options: {
  executionKey: string;
  traceId: string;
  assistantTurnId: string;
  target: OutputArtifactTarget;
  artifacts: OutputArtifact[];
  failures: Array<{ candidateKey: string; code: string; attempt?: number }>;
  job?: ArtifactManifestJobSummary;
}): string {
  const path = join(options.target.outputDirectory, "manifest.json");
  atomicWriteArtifactJson(path, `${JSON.stringify({
    version: options.job ? 2 : 1,
    executionKey: options.executionKey,
    traceId: options.traceId,
    assistantTurnId: options.assistantTurnId,
    capturedAt: new Date().toISOString(),
    ...(options.target.metadata ? { metadata: options.target.metadata } : {}),
    ...(options.job ? { job: options.job } : {}),
    artifacts: options.artifacts.map(({ absolutePath: _absolutePath, ...artifact }) => artifact),
    failures: options.failures,
  }, null, 2)}\n`, options.target);
  return relative(options.target.workspaceRoot, path).replaceAll("\\", "/");
}
