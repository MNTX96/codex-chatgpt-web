import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { CDPSession, Download, Page } from "playwright-core";
import { readLauncherBrowserHostDescriptor, type LauncherBrowserHostDescriptor } from "../../../../launcher-browser-host";
import { ImageTransferDeadline, ImageTransferError, redactImageTransferError, type ImageTransferLog } from "../../image-transfer";

export const IMAGE_DOWNLOAD_FEATURE = "owned-image-download-v1";
export interface LauncherImageDownloadOwner {
  descriptorPath: string;
  traceId: string;
  helperPid: number;
  surfaceId: string;
  jobId: string;
}
export interface ImageDownloadTransaction {
  status(): Promise<"armed" | "downloading" | "completed">;
  read(): Promise<Buffer>;
  dispose(): Promise<void>;
}

export function assertLauncherImageDownloadSupport(descriptorPath: string): LauncherBrowserHostDescriptor {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (!descriptor.features?.includes(IMAGE_DOWNLOAD_FEATURE)) {
    throw new ImageTransferError("image_download_runtime_unavailable", "preflight");
  }
  return descriptor;
}

function readImageDownload(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ImageTransferError("image_download_file_invalid", "read");
  if (stat.size > maxBytes) throw new ImageTransferError("image_download_size_limit", "read");
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new ImageTransferError("image_download_size_limit", "read");
  return bytes;
}

/** No bytes, signed source URLs or user-selected paths cross the launcher control channel. */
export async function beginLauncherImageDownload(options: {
  page: Page; owner: LauncherImageDownloadOwner; candidateKey: string;
  maxBytes: number; budget: ImageTransferDeadline; log: ImageTransferLog;
}): Promise<ImageDownloadTransaction> {
  const descriptor = assertLauncherImageDownloadSupport(options.owner.descriptorPath);
  options.budget.remaining();
  const detach = async (session: CDPSession) => {
    const cleanup = new ImageTransferDeadline(Date.now() + 2_000);
    try { await cleanup.observe(session.detach()); }
    catch (cause) {
      options.log("download_target_cleanup_failed", { error: redactImageTransferError(cause) });
      throw new ImageTransferError("image_download_target_cleanup_failed", "release", { cause });
    } finally { cleanup.dispose(); }
  };
  const connecting = options.page.context().newCDPSession(options.page);
  let session: CDPSession;
  try { session = await options.budget.observe(connecting); }
  catch (error) {
    // Attaching is an observation, but a late session still needs to be detached.
    void connecting.then(detach).catch(() => {});
    throw error;
  }
  let targetId: string;
  let targetFailed = false;
  try { targetId = (await options.budget.observe(session.send("Target.getTargetInfo"))).targetInfo.targetId; }
  catch (error) { targetFailed = true; throw error; }
  finally {
    try { await detach(session); }
    catch (error) { if (!targetFailed) throw error; }
  }
  options.budget.remaining();
  if (descriptor.surfaceTargets[options.owner.surfaceId] !== targetId) {
    throw new ImageTransferError("image_download_owner_mismatch", "register");
  }
  const body = {
    traceId: options.owner.traceId, helperPid: options.owner.helperPid,
    surfaceId: options.owner.surfaceId, jobId: options.owner.jobId,
    targetId, candidateKey: options.candidateKey, transactionId: randomUUID(),
  };
  const request = async (action: "begin" | "status" | "release"): Promise<Record<string, unknown>> => {
    const cleanup = action === "release";
    const timeout = AbortSignal.timeout(cleanup ? 5_000 : Math.min(5_000, options.budget.remaining()));
    const response = await fetch(`${descriptor.control.endpoint}/v1/image-download/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...(action === "begin" ? { maxBytes: options.maxBytes, deadlineAt: options.budget.deadlineAt } : {}) }),
      signal: cleanup ? timeout : AbortSignal.any([timeout, options.budget.signal]),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || result.ok !== true) {
      const code = typeof result.code === "string" && /^image_download_[a-z_]+$/.test(result.code)
        ? result.code : "image_download_control_failed";
      throw new ImageTransferError(code, action);
    }
    return result;
  };
  let completedPath: string | undefined;
  const transaction: ImageDownloadTransaction = {
    async status() {
      const state = await request("status");
      if (state.transactionId !== body.transactionId) throw new ImageTransferError("image_download_owner_mismatch", "status");
      if (state.state === "failed") {
        throw new ImageTransferError(typeof state.code === "string" && /^image_download_[a-z_]+$/.test(state.code)
          ? state.code : "image_download_failed", "download");
      }
      if (state.state === "completed" && typeof state.path === "string") { completedPath = state.path; return "completed"; }
      if (state.state === "armed" || state.state === "downloading") return state.state;
      throw new ImageTransferError("image_download_control_invalid", "status");
    },
    async read() {
      options.budget.remaining();
      if (!completedPath) throw new ImageTransferError("image_download_not_completed", "read");
      return readImageDownload(completedPath, options.maxBytes);
    },
    async dispose() { await request("release"); },
  };
  try {
    await request("begin");
    options.log("download_registered", { candidateKey: options.candidateKey, transactionId: body.transactionId, owner: "launcher" });
    return transaction;
  } catch (error) {
    // A timed-out acknowledgement may still have armed the launcher; reconcile by the same ID.
    await transaction.dispose().catch(() => options.log("download_cleanup_failed", { transactionId: body.transactionId }));
    throw error;
  }
}

/** Managed Chromium fallback; Electron always uses the launcher-owned transaction above. */
export function beginPlaywrightImageDownload(page: Page, maxBytes: number, budget: ImageTransferDeadline): ImageDownloadTransaction {
  let download: Download | undefined;
  let state: "armed" | "downloading" | "completed" = "armed";
  let path: string | undefined;
  let failure: unknown;
  let settlement: Promise<void> = Promise.resolve();
  const listener = (value: Download) => {
    if (download) return;
    download = value;
    state = "downloading";
    settlement = value.path().then(value => {
      if (!value) throw new ImageTransferError("image_download_file_unavailable", "download");
      path = value; state = "completed";
    }).catch(error => { failure = error; });
  };
  page.on("download", listener);
  return {
    async status() { budget.remaining(); if (failure) throw failure; return state; },
    async read() { budget.remaining(); if (!path) throw new ImageTransferError("image_download_not_completed", "read"); return readImageDownload(path, maxBytes); },
    async dispose() {
      page.off("download", listener);
      if (download) {
        if (state !== "completed") await download.cancel();
        await settlement;
        await download.delete();
      }
    },
  };
}
