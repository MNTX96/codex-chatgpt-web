import { Buffer } from "node:buffer";
import type { Locator, Page } from "playwright-core";
import type { OutputImageCandidate } from "../types";
import { ImageTransferDeadline, ImageTransferError, redactImageTransferError, type ImageTransferLog } from "../../image-transfer";
import { beginLauncherImageDownload, beginPlaywrightImageDownload, type LauncherImageDownloadOwner } from "./download-transaction";
import { findImageDownloadControl, findViewerDownloadMenu, findViewerOriginal, openBoundImageViewer } from "./image-viewer";

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

async function readOriginal(page: Page, source: string, maxBytes: number, budget: ImageTransferDeadline, log: ImageTransferLog): Promise<Buffer> {
  budget.remaining();
  if (source.startsWith("data:")) return dataUrlBytes(source, maxBytes);
  if (source.startsWith("blob:")) {
    assertSource(source.slice(5));
    const bytes = await budget.observe(page.evaluate(async ({ source, maxBytes, timeout }) => {
      const response = await fetch(source, { signal: AbortSignal.timeout(timeout) });
      if (!response.ok || !response.body) throw new Error("Generated image blob fetch failed");
      const reader = response.body.getReader(); const chunks: number[] = []; let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.length;
          if (total > maxBytes) throw new Error("Generated image exceeds size limit");
          for (const byte of next.value) chunks.push(byte);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return chunks;
    }, { source, maxBytes, timeout: budget.remaining() }));
    budget.remaining();
    return Buffer.from(bytes);
  }
  let url = assertSource(source);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await page.context().request.get(url.toString(), {
      timeout: Math.min(10_000, budget.remaining()), signal: budget.signal, maxRedirects: 0,
    });
    let failed = false;
    try {
      assertSource(response.url());
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        const location = response.headers()["location"];
        if (!location || redirect === 3) throw new ImageTransferError("image_original_redirect_limit", "original");
        url = assertSource(new URL(location, url).toString());
        continue;
      }
      if (!response.ok()) throw new ImageTransferError("image_original_unavailable", "original", { cause: new Error(`HTTP ${response.status()}`) });
      const contentLength = Number(response.headers()["content-length"] ?? 0);
      if (contentLength > maxBytes) throw new ImageTransferError("image_download_size_limit", "original");
      const bytes = await budget.observe(response.body());
      budget.remaining();
      if (bytes.length > maxBytes) throw new ImageTransferError("image_download_size_limit", "original");
      return bytes;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try { await response.dispose(); }
      catch (cause) {
        log("original_cleanup_failed", { error: redactImageTransferError(cause) });
        if (!failed) throw new ImageTransferError("image_original_cleanup_failed", "release", { cause });
      }
    }
  }
  throw new ImageTransferError("image_original_redirect_limit", "original");
}

export async function downloadOutputImage(options: {
  page: Page; responseTurn: Locator; candidate: OutputImageCandidate; maxBytes: number;
  abortSignal?: AbortSignal; budget?: ImageTransferDeadline; launcherOwner?: LauncherImageDownloadOwner; log?: ImageTransferLog;
}): Promise<Buffer> {
  const budget = options.budget ?? new ImageTransferDeadline(undefined, options.abortSignal);
  const log = options.log ?? (() => {});
  const { page, candidate, maxBytes } = options;
  const original = async (source: string) => {
    log("original_fetch", { candidateKey: candidate.key });
    try { return await readOriginal(page, source, maxBytes, budget, log); }
    catch (cause) {
      budget.remaining();
      if (!(cause instanceof ImageTransferError) || cause.code !== "image_original_unavailable") throw cause;
      log("original_unavailable", { candidateKey: candidate.key, error: redactImageTransferError(cause) });
      return undefined;
    }
  };
  try {
    budget.remaining();
    if (maxBytes < 1) throw new ImageTransferError("image_download_size_limit", "preflight");
    // Explicit original/download anchors only. The preview imageSrc is never a byte source.
    if (candidate.originalHref) { const bytes = await original(candidate.originalHref); if (bytes) return bytes; }
    const viewer = await openBoundImageViewer({ ...options, budget, log });
    try {
      const href = await findViewerOriginal(viewer.scope, budget);
      if (href) { const bytes = await original(href); if (bytes) return bytes; }
      let action: Locator | undefined;
      while (!action) {
        await viewer.assertCurrent();
        action = await findImageDownloadControl(viewer.scope, budget);
        if (!action) await budget.pause();
      }
      log("download_action_detected", { candidateKey: candidate.key });
      await viewer.assertCurrent();
      const transaction = options.launcherOwner
        ? await beginLauncherImageDownload({ page, owner: options.launcherOwner, candidateKey: candidate.key, maxBytes, budget, log })
        : beginPlaywrightImageDownload(page, maxBytes, budget);
      let failure: unknown;
      try {
        // Registration is asynchronous; the selected image must still match when input is sent.
        await viewer.assertCurrent();
        // Register before the click; both use the same deadline, even when actionability is slow.
        try {
          log("download_click_started", { candidateKey: candidate.key });
          await action.click({ timeout: budget.remaining(), signal: budget.signal });
          log("download_click_completed", { candidateKey: candidate.key });
        }
        catch (cause) {
          budget.remaining();
          if (await transaction.status() === "armed") throw new ImageTransferError("image_download_click_failed", "click", { cause });
          log("download_click_reconciled", { candidateKey: candidate.key, error: redactImageTransferError(cause) });
        }
        let menuActivated = false;
        let started = false;
        for (;;) {
          budget.remaining();
          const status = await transaction.status();
          if (status === "completed") {
            const bytes = await transaction.read();
            budget.remaining();
            log("bytes_received", { candidateKey: candidate.key, byteLength: bytes.length });
            return bytes;
          }
          if (status === "downloading") {
            if (!started) log("download_started", { candidateKey: candidate.key });
            started = true;
          } else if (!started && !menuActivated) {
            await viewer.assertCurrent();
            const menuAction = await findViewerDownloadMenu(page, viewer.scope, action, budget);
            if (menuAction && await transaction.status() === "armed") {
              menuActivated = true;
              await menuAction.click({ timeout: budget.remaining(), signal: budget.signal });
            }
          }
          await budget.pause();
        }
      } catch (error) { failure = error; throw error; }
      finally {
        try { await transaction.dispose(); log("download_released", { candidateKey: candidate.key }); }
        catch (cause) {
          log("download_cleanup_failed", { candidateKey: candidate.key, error: redactImageTransferError(cause) });
          if (!failure) throw new ImageTransferError("image_download_cleanup_failed", "release", { cause });
        }
      }
    } finally { await viewer.close(); }
  } catch (error) {
    // Browser and HTTP APIs may wrap an abort; the shared budget owns its cause.
    budget.remaining();
    throw error;
  } finally { if (!options.budget) budget.dispose(); }
}
