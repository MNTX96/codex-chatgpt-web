import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutputArtifactTarget } from "../src/adapters/chatgpt-web/artifacts/artifact-target";
import { persistOutputImage } from "../src/adapters/chatgpt-web/artifacts/artifact-store";
import { extensionForImageMime, sniffImageMime } from "../src/adapters/chatgpt-web/artifacts/image/image-sniffer";
import { writeArtifactManifest } from "../src/adapters/chatgpt-web/artifacts/artifact-manifest";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function environment(root: string): ChatGptTurnEnvironment {
  return { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [] };
}

test("sniffs supported image headers without trusting extensions", () => {
  expect(sniffImageMime(png)).toBe("image/png");
  expect(sniffImageMime(Buffer.from("<html>nope</html>"))).toBeUndefined();
  expect(extensionForImageMime("image/jpeg")).toBe("jpg");
});

test("persists generated images content-addressably with a redacted manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-artifact-"));
  try {
    const target = resolveOutputArtifactTarget(environment(root), "a".repeat(64), undefined)!;
    const first = persistOutputImage({ bytes: png, target, assistantTurnId: "assistant", candidateKey: "image-1", mimeType: "image/png" });
    const second = persistOutputImage({ bytes: png, target, assistantTurnId: "assistant", candidateKey: "image-1", mimeType: "image/png" });
    expect(first.absolutePath).toBe(second.absolutePath);
    expect(first.relativePath).toStartWith(".codex/chatgpt-web-artifacts/");
    expect(existsSync(first.absolutePath)).toBe(true);
    const manifest = writeArtifactManifest({ executionKey: "a".repeat(64), traceId: "trace", assistantTurnId: "assistant", target, artifacts: [first], failures: [] });
    expect(existsSync(join(root, manifest))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsafe output directories and symlinked artifact parents", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-artifact-"));
  try {
    expect(() => resolveOutputArtifactTarget(environment(root), "a".repeat(64), { directory: "../outside" })).toThrow();
    const target = resolveOutputArtifactTarget(environment(root), "a".repeat(64), undefined)!;
    mkdirSync(join(root, ".codex"), { recursive: true });
    symlinkSync(tmpdir(), join(root, ".codex", "chatgpt-web-artifacts"));
    expect(() => persistOutputImage({ bytes: png, target, assistantTurnId: "assistant", candidateKey: "image", mimeType: "image/png" })).toThrow("symlink");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
