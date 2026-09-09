import { Buffer } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import type { Download, Locator, Page } from "playwright-core";
import type { OutputImageCandidate } from "../types";

const MAX_TIMEOUT_MS = 30_000;

function assertSource(value: string): URL {
  const url = new URL(value);
  const allowedHost = url.hostname === "chatgpt.com"
    || url.hostname.endsWith(".chatgpt.com")
    || url.hostname === "openai.com"
    || url.hostname.endsWith(".openai.com")
    || url.hostname.endsWith(".oaiusercontent.com");
  if (url.username || url.password || url.protocol !== "https:" || !allowedHost) {
    throw new Error("Generated image source is not an allowed ChatGPT HTTPS URL");
  }
  return url;
}

function dataUrlBytes(value: string, maxBytes: number): Buffer {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s);
  if (!match || match[2].length % 4 !== 0 || Math.floor(match[2].length * 3 / 4) > maxBytes) throw new Error("Generated image data URL is invalid or too large");
  const result = Buffer.from(match[2], "base64");
  if (result.length > maxBytes) throw new Error("Generated image exceeds size limit");
  return result;
}

export async function downloadOutputImage(options: { page: Page; responseTurn: Locator; candidate: OutputImageCandidate; maxBytes: number; abortSignal?: AbortSignal }): Promise<Buffer> {
  if (options.abortSignal?.aborted) throw new DOMException("Generated image capture aborted", "AbortError");
  if (options.candidate.downloadAction) {
    const escapedKey = options.candidate.key.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const card = options.responseTurn.locator(`[id="${escapedKey}"]`).first();
    const action = (await card.getByRole("button", { name: /download|original/i }).count() > 0
      ? card.getByRole("button", { name: /download|original/i })
      : card.getByRole("link", { name: /download|original/i })).first();
    if (await action.count() === 0) throw new Error("Generated image download action disappeared");
    const downloadPromise = options.page.waitForEvent("download", { timeout: MAX_TIMEOUT_MS });
    let download: Download | undefined;
    try {
      await action.click({ timeout: MAX_TIMEOUT_MS, signal: options.abortSignal });
      download = await downloadPromise;
      const path = await download.path();
      if (!path) throw new Error("Generated image download has no local path");
      const stat = statSync(path);
      if (stat.size > options.maxBytes) throw new Error("Generated image exceeds size limit");
      const bytes = readFileSync(path);
      if (bytes.length > options.maxBytes) throw new Error("Generated image exceeds size limit");
      await download.delete().catch(() => {});
      return bytes;
    } catch (error) {
      await download?.cancel().catch(() => {});
      throw error;
    }
  }
  const source = options.candidate.originalHref;
  if (!source) throw new Error("Generated image has no retrievable source");
  if (source.startsWith("data:")) return dataUrlBytes(source, options.maxBytes);
  if (source.startsWith("blob:")) {
    const bytes = await options.page.evaluate(async ({ source, maxBytes }) => {
      const response = await fetch(source);
      if (!response.ok || !response.body) throw new Error("Generated image blob fetch failed");
      const reader = response.body.getReader(); const chunks: number[] = []; let total = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > maxBytes) throw new Error("Generated image exceeds size limit"); chunks.push(...next.value); }
      return chunks;
    }, { source, maxBytes: options.maxBytes });
    return Buffer.from(bytes);
  }
  const url = assertSource(source).toString();
  const response = await options.page.context().request.get(url, { timeout: MAX_TIMEOUT_MS, signal: options.abortSignal, maxRedirects: 3 });
  if (!response.ok()) throw new Error(`Generated image download returned HTTP ${response.status()}`);
  assertSource(response.url());
  const contentLength = Number(response.headers()["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) throw new Error("Generated image exceeds size limit");
  const bytes = await response.body();
  if (bytes.length > options.maxBytes) throw new Error("Generated image exceeds size limit");
  return bytes;
}
