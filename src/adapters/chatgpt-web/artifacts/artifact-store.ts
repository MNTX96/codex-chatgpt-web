import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extensionForImageMime, imageDimensions } from "./image/image-sniffer";
import type { OutputArtifactTarget, OutputImageArtifact, OutputImageMime, OutputImageSource } from "./types";

function inside(child: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function assertSafeDirectory(directory: string, target: OutputArtifactTarget): void {
  if (!target.writableRoots.some(root => inside(directory, root))) throw new Error("Artifact path escapes writable roots");
  let current = resolve(directory);
  const stop = resolve(target.workspaceRoot);
  while (inside(current, stop)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Artifact path contains a symlink");
    if (current === stop) break;
    current = dirname(current);
  }
}

function atomicWrite(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, data); closeSync(fd); renameSync(temp, path); }
  catch (error) { try { closeSync(fd); } catch {} rmSync(temp, { force: true }); throw error; }
}

export function persistOutputImage(options: {
  bytes: Buffer;
  target: OutputArtifactTarget;
  assistantTurnId: string;
  candidateKey: string;
  mimeType: OutputImageMime;
  source?: Partial<OutputImageSource>;
}): OutputImageArtifact {
  const sha256 = createHash("sha256").update(options.bytes).digest("hex");
  const filename = `image-${sha256}.${extensionForImageMime(options.mimeType)}`;
  const absolutePath = join(options.target.outputDirectory, filename);
  assertSafeDirectory(options.target.outputDirectory, options.target);
  if (existsSync(absolutePath)) {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Existing artifact is not a regular file");
    const existing = readFileSync(absolutePath);
    const hash = createHash("sha256").update(existing).digest("hex");
    if (hash !== sha256 || existing.length !== options.bytes.length) throw new Error("Existing artifact hash mismatch");
  } else atomicWrite(absolutePath, options.bytes);
  const dimensions = imageDimensions(options.bytes, options.mimeType);
  return {
    kind: "generated_image", id: `img_${sha256}`, absolutePath,
    relativePath: relative(options.target.workspaceRoot, absolutePath).replaceAll("\\", "/"),
    mimeType: options.mimeType, byteLength: options.bytes.length, sha256,
    ...dimensions,
    source: {
      ...options.source,
      assistantTurnId: options.assistantTurnId,
      candidateKey: options.candidateKey,
    },
  };
}

export function atomicWriteArtifactJson(path: string, data: string, target: OutputArtifactTarget): void {
  assertSafeDirectory(dirname(path), target);
  atomicWrite(path, Buffer.from(data));
}
