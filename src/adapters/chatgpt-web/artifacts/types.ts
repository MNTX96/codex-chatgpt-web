export type OutputImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface OutputImageSource {
  assistantTurnId: string;
  candidateKey: string;
  cardId?: string;
  fileIdentity?: string;
  submissionId?: string;
  imageSessionId?: string;
  projectId?: string;
  conversationUrl?: string;
  jobId?: string;
}

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
  source: OutputImageSource;
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
    submissionId?: string;
    sourceTurn?: string;
  };
}

export interface OutputImageCandidate {
  key: string;
  cardId?: string;
  fileIdentity?: string;
  assistantTurnId?: string;
  /**
   * Ephemeral zero-based gallery control ordinal used only while ChatGPT's thumbnails have not
   * hydrated a stable file identity. Successful capture must resolve this to fileIdentity before
   * the artifact source is persisted.
   */
  transientGalleryOrdinal?: number;
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
  candidateKeys: string[];
  excessCandidateKeys: string[];
  detectedCandidates: number;
  ignoredCandidates: number;
}
