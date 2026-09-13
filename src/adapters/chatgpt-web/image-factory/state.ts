import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../../config";
import type { OutputImageSource } from "../artifacts/types";
import type { NativeBindingSpec } from "../native-authority";
import {
  ImageFactoryError,
  type ImageFactoryInput,
  type ImageFactoryOperation,
  type ImageJobPhase,
  type ImageJobResult,
  type ImageJobSubmission,
} from "./contracts";

export const imageKey = (...values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
export interface ImageSession {
  id: string;
  owner: string;
  accountKey?: string;
  projectId?: string;
  conversationUrl?: string;
  hasConversation?: boolean;
  actualMode?: string;
  artifacts?: Record<string, OutputImageSource>;
  updatedAt: number;
}
export interface StoredImageJob {
  nativeBinding?: NativeBindingSpec;
  key: string;
  owner: string;
  payloadHash: string;
  operation: ImageFactoryOperation;
  input: ImageFactoryInput;
  requestedCount: number;
  attemptCount: number;
  submissions: ImageJobSubmission[];
  sourceArtifactId?: string;
  phase: ImageJobPhase;
  result: ImageJobResult;
  updatedAt: number;
}

export function normalizeStoredImageJob(value: StoredImageJob): StoredImageJob {
  const legacy = value as StoredImageJob & {
    operation?: ImageFactoryOperation;
    requestedCount?: number;
    attemptCount?: number;
    submissions?: ImageJobSubmission[];
    input: ImageFactoryInput & { count?: number; source_artifact_id?: string };
    result: ImageJobResult & {
      requestedCount?: number;
      generatedCount?: number;
      downloadedCount?: number;
      attemptCount?: number;
    };
  };
  const requestedCount = legacy.requestedCount ?? legacy.input.count ?? 1;
  const artifacts = legacy.result.artifacts ?? [];
  legacy.operation ??= legacy.input.source_artifact_id ? "edit" : "generate";
  legacy.input.count ??= requestedCount;
  legacy.requestedCount = requestedCount;
  legacy.attemptCount ??= legacy.result.attemptCount ?? 0;
  legacy.submissions ??= legacy.result.submissions ?? [];
  legacy.sourceArtifactId ??= legacy.operation === "edit" ? legacy.input.source_artifact_id : undefined;
  legacy.result.requestedCount ??= requestedCount;
  legacy.result.generatedCount ??= artifacts.length;
  legacy.result.downloadedCount ??= artifacts.length;
  legacy.result.attemptCount ??= legacy.attemptCount;
  legacy.result.submissions ??= legacy.submissions;
  if (legacy.sourceArtifactId) legacy.result.sourceArtifactId ??= legacy.sourceArtifactId;
  return legacy;
}

/** App-owned metadata only. Browser cookies and short-lived asset URLs never enter this store. */
export class ImageFactoryStore {
  constructor(readonly directory: string) {
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) {
      throw new ImageFactoryError("image_state_invalid");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  read<T>(kind: "job" | "session" | "project", key: string): T | undefined {
    const path = this.path(kind, key);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000) throw new ImageFactoryError("image_state_invalid");
    const decoded = JSON.parse(readFileSync(path, "utf8"));
    if ((decoded?.version !== 1 && decoded?.version !== 2) || decoded.key !== key || decoded.kind !== kind || !decoded.value || typeof decoded.value !== "object") throw new ImageFactoryError("image_state_invalid");
    return decoded.value as T;
  }
  write(kind: "job" | "session" | "project", key: string, value: unknown): void {
    const path = this.path(kind, key);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ImageFactoryError("image_state_invalid");
    atomicWriteFile(path, JSON.stringify({ version: 2, kind, key, value }, null, 2) + "\n", { mode: 0o600 });
  }
  private path(kind: string, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new ImageFactoryError("image_state_key_invalid");
    return join(this.directory, `${kind}-${key}.json`);
  }
}
