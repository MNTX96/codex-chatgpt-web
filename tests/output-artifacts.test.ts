import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutputArtifactTarget } from "../src/adapters/chatgpt-web/artifacts/artifact-target";
import { persistOutputImage } from "../src/adapters/chatgpt-web/artifacts/artifact-store";
import { extensionForImageMime, sniffImageMime } from "../src/adapters/chatgpt-web/artifacts/image/image-sniffer";
import { writeArtifactManifest } from "../src/adapters/chatgpt-web/artifacts/artifact-manifest";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { downloadOutputImage } from "../src/adapters/chatgpt-web/artifacts/image/image-downloader";
import { OutputImageAdapter } from "../src/adapters/chatgpt-web/artifacts/image/output-image-adapter";
import type { Locator, Page } from "playwright-core";

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

test("large blob chunks download without exceeding JavaScript argument limits", async () => {
  const payload = new Uint8Array(1_000_000).fill(42);
  const fetchImplementation = Object.assign(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(payload); controller.close(); },
  })), { preconnect: globalThis.fetch.preconnect });
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fetchImplementation);
  const responseTurn = { locator: () => ({ first: () => ({ count: async () => 0 }) }) } as unknown as Locator;
  const page = { evaluate: async (callback: (args: unknown) => unknown, args: unknown) => callback(args) } as unknown as Page;
  try {
    const bytes = await downloadOutputImage({ page, responseTurn,
      candidate: { key: "image-1", originalHref: "blob:https://chatgpt.com/example", readiness: "ready" }, maxBytes: payload.length });
    expect(bytes.equals(Buffer.from(payload))).toBeTrue();
    await expect(downloadOutputImage({ page, responseTurn,
      candidate: { key: "image-1", originalHref: "blob:https://chatgpt.com/example", readiness: "ready" }, maxBytes: payload.length - 1 })).rejects.toThrow("size limit");
  } finally { fetchMock.mockRestore(); }
});

test("cancelling capture before persistence cannot write a downloaded artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-artifact-abort-"));
  const controller = new AbortController();
  let bodyRead = false;
  let disposed = false;
  const target = resolveOutputArtifactTarget(environment(root), "a".repeat(64), undefined)!;
  const responseTurn = {
    evaluate: async () => [{ key: "image-1", originalHref: "https://chatgpt.com/original", readiness: "ready" }],
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
  } as unknown as Locator;
  const page = { context: () => ({ request: { get: async () => ({
    ok: () => true, status: () => 200, url: () => "https://chatgpt.com/original", headers: () => ({}),
    body: async () => { bodyRead = true; controller.abort(); return png; },
    dispose: async () => { disposed = true; },
  }) } }) } as unknown as Page;
  try {
    await expect(new OutputImageAdapter().captureFinal({ page, responseTurn, target,
      assistantTurnId: "assistant", executionKey: "a".repeat(64), traceId: "trace", abortSignal: controller.signal })).rejects.toThrow();
    expect(bodyRead).toBeTrue();
    expect(disposed).toBeTrue();
    expect(existsSync(target.outputDirectory)).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("original-response cleanup cannot replace the primary transfer failure", async () => {
  const failure = new Error("original body failed");
  const cleanupFailure = new Error("response disposal failed");
  const stages: string[] = [];
  const page = { context: () => ({ request: { get: async () => ({
    ok: () => true, status: () => 200, url: () => "https://chatgpt.com/original", headers: () => ({}),
    body: async () => { throw failure; }, dispose: async () => { throw cleanupFailure; },
  }) } }) } as unknown as Page;
  await expect(downloadOutputImage({ page, responseTurn: {} as Locator,
    candidate: { key: "image-1", originalHref: "https://chatgpt.com/original", readiness: "ready" },
    maxBytes: 1_000, log: stage => stages.push(stage),
  })).rejects.toBe(failure);
  expect(stages).toContain("original_cleanup_failed");
});
