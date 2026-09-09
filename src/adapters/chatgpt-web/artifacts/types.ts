export type OutputImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface OutputImageArtifact {
  kind: "generated_image";
  id: string;
  relativePath: string;
  absolutePath: string;
  mimeType: OutputImageMime;
  byteLength: number;
  sha256: string;
  width?: number;
  height?: number;
  source: { assistantTurnId: string; candidateKey: string };
}

export type OutputArtifact = OutputImageArtifact;

export interface OutputArtifactTarget {
  workspaceRoot: string;
  outputDirectory: string;
  writableRoots: string[];
  maxArtifacts: number;
  maxBytesPerArtifact: number;
  maxTotalBytes: number;
  capturePolicy: "best-effort" | "required";
  metadata?: {
    output: "image";
    surface: "temporary" | "persistent";
    projectId?: string;
    conversationUrl?: string;
    actualMode?: string;
    instructionsVersion?: number;
    imageSessionId?: string;
    jobId?: string;
    sourceTurn?: string;
  };
}

export interface OutputImageCandidate {
  key: string;
  /** A short-lived source; never persist or emit it. */
  imageSrc?: string;
  originalHref?: string;
  downloadAction?: boolean;
  width?: number;
  height?: number;
  readiness: "ready" | "loading" | "error";
}

export interface OutputImageCaptureResult {
  artifacts: OutputImageArtifact[];
  manifestPath?: string;
  failures: Array<{ candidateKey: string; code: string }>;
  detectedCandidates: number;
  ignoredCandidates: number;
}
