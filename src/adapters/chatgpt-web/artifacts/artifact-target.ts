import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { ChatGptTurnEnvironment } from "../environment";
import type { OutputArtifactTarget } from "./types";

export const GENERATED_IMAGE_ARTIFACT_DEFAULTS = {
  mode: "workspace" as const,
  directory: ".codex/chatgpt-web-artifacts",
  capturePolicy: "required" as const,
  maxImagesPerTurn: 10,
  maxBytesPerImage: 20_000_000,
  maxTotalBytes: 50_000_000,
};

export function isPathInside(child: string, parent: string): boolean {
  const result = relative(resolve(parent), resolve(child));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

export function resolveOutputArtifactTarget(
  environment: ChatGptTurnEnvironment | undefined,
  executionKey: string,
  config: { mode?: "off" | "workspace"; directory?: string; capturePolicy?: "best-effort" | "required"; maxImagesPerTurn?: number; maxBytesPerImage?: number; maxTotalBytes?: number } | undefined,
): OutputArtifactTarget | undefined {
  const options = { ...GENERATED_IMAGE_ARTIFACT_DEFAULTS, ...config };
  if (options.mode === "off") return undefined;
  if (!environment || environment.sandboxPolicy.type === "readOnly") return undefined;
  const directory = options.directory;
  if (!directory || directory.includes("\0") || isAbsolute(directory) || win32.isAbsolute(directory)
    || directory.split(/[\\/]+/).some(part => part === ".." || !part)) throw new Error("ChatGPT generated image artifact directory must be a safe relative path");
  for (const value of [options.maxImagesPerTurn, options.maxBytesPerImage, options.maxTotalBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("ChatGPT generated image artifact limits must be positive integers");
  }
  const outputDirectory = resolve(environment.cwd, directory, executionKey);
  if (!environment.writableRoots.some(root => isPathInside(outputDirectory, root))) {
    throw new Error("ChatGPT generated image output is outside the trusted writable workspace");
  }
  return { workspaceRoot: resolve(environment.cwd), outputDirectory, writableRoots: environment.writableRoots.map(root => resolve(root)), maxArtifacts: options.maxImagesPerTurn, maxBytesPerArtifact: options.maxBytesPerImage, maxTotalBytes: options.maxTotalBytes, capturePolicy: options.capturePolicy };
}
