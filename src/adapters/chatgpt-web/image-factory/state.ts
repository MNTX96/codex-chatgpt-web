import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../../config";
import { ImageFactoryError, type ImageGenerateInput, type ImageJobPhase, type ImageJobResult } from "./contracts";

export const imageKey = (...values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
export interface ImageSession {
  id: string;
  owner: string;
  accountKey?: string;
  projectId?: string;
  conversationUrl?: string;
  hasConversation?: boolean;
  actualMode?: string;
  updatedAt: number;
}
export interface StoredImageJob {
  key: string;
  owner: string;
  payloadHash: string;
  input: ImageGenerateInput;
  phase: ImageJobPhase;
  result: ImageJobResult;
  updatedAt: number;
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
    if (decoded?.version !== 1 || decoded.key !== key || decoded.kind !== kind || !decoded.value || typeof decoded.value !== "object") throw new ImageFactoryError("image_state_invalid");
    return decoded.value as T;
  }
  write(kind: "job" | "session" | "project", key: string, value: unknown): void {
    const path = this.path(kind, key);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ImageFactoryError("image_state_invalid");
    atomicWriteFile(path, JSON.stringify({ version: 1, kind, key, value }, null, 2) + "\n", { mode: 0o600 });
  }
  private path(kind: string, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new ImageFactoryError("image_state_key_invalid");
    return join(this.directory, `${kind}-${key}.json`);
  }
}
