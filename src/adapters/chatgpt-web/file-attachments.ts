import type { Locator, Page } from "playwright-core";
import { ImageTransferDeadline, ImageTransferError, redactImageTransferError, type ImageTransferLog } from "./image-transfer";

export interface PromptAttachmentFile { name: string; mimeType: string; buffer: Buffer }
export interface AttachmentGuard { assertReady(signal?: AbortSignal): Promise<void> }
type AttachmentState = "missing" | "uploading" | "accepted" | "rejected";

const PROMPT_ATTACHMENT_TILE_SELECTOR = [
  '[role="group"][aria-label][data-upload-state]',
  '[role="group"][aria-label][data-status]',
  '[role="group"][aria-label]:has(img)',
].join(", ");

function promptAttachmentTiles(form: Locator): Locator {
  return form.locator(PROMPT_ATTACHMENT_TILE_SELECTOR).filter({ visible: true });
}

async function attachmentInventory(form: Locator, budget: ImageTransferDeadline): Promise<string[]> {
  return budget.observe(promptAttachmentTiles(form).evaluateAll(elements => elements.map(element => (
    element.getAttribute("aria-label")?.trim() ?? ""
  ))));
}

function exactAttachmentInventory(actual: string[], files: PromptAttachmentFile[]): boolean {
  if (actual.length !== files.length) return false;
  const expected = files.map(file => file.name).sort();
  return [...actual].sort().every((name, index) => name === expected[index]);
}

function emptyAttachmentGuard(form: Locator): AttachmentGuard {
  return {
    async assertReady(signal) {
      const check = new ImageTransferDeadline(Date.now() + 10_000, signal);
      try {
        const inventory = await attachmentInventory(form, check);
        if (inventory.length !== 0) {
          throw new ImageTransferError("stale_attachments_present", "before_send");
        }
        check.remaining();
      } finally { check.dispose(); }
    },
  };
}

/**
 * Remove attachment chips that belong to an earlier turn before the current turn can Send.
 * The cleanup is scoped to the active composer form and resolves the remove control structurally:
 * it never depends on localized labels such as "Remove attachment".
 */
export async function clearPromptAttachments(options: {
  form: Locator; abortSignal?: AbortSignal; log: ImageTransferLog;
}): Promise<AttachmentGuard> {
  const { form, log } = options;
  const budget = new ImageTransferDeadline(Date.now() + 10_000, options.abortSignal);
  let removed = 0;
  try {
    for (;;) {
      const tiles = promptAttachmentTiles(form);
      const before = await budget.observe(tiles.count());
      if (before === 0) break;
      if (removed === 0) log("stale_attachments_found", { attachmentCount: before });

      const tile = tiles.first();
      const controls = tile.locator('button, [role="button"]').filter({ visible: true });
      const removableIndexes = await budget.observe(controls.evaluateAll(elements => elements
        .map((element, index) => {
          const html = element as HTMLElement;
          const style = getComputedStyle(html);
          const visible = style.display !== "none" && style.visibility !== "hidden" && html.getClientRects().length > 0;
          const disabled = (html as HTMLButtonElement).disabled || html.getAttribute("aria-disabled") === "true";
          const opensPopup = html.hasAttribute("aria-haspopup") || html.getAttribute("aria-expanded") !== null;
          const ownsPreview = html.querySelector("img, video, canvas") !== null;
          return visible && !disabled && !opensPopup && !ownsPreview ? index : -1;
        })
        .filter(index => index >= 0)));
      if (removableIndexes.length !== 1) {
        throw new ImageTransferError(
          removableIndexes.length === 0
            ? "attachment_cleanup_control_missing"
            : "attachment_cleanup_control_ambiguous",
          "cleanup",
        );
      }

      await controls.nth(removableIndexes[0]!).click({
        timeout: Math.min(5_000, budget.remaining()),
        signal: budget.signal,
      });
      for (;;) {
        const after = await budget.observe(promptAttachmentTiles(form).count());
        if (after < before) break;
        await budget.pause();
      }
      removed += 1;
      log("stale_attachment_removed", { remainingAttachmentCount: before - 1 });
    }
    log("stale_attachments_cleared", { removedCount: removed });
  } catch (error) {
    log("stale_attachments_cleanup_failed", { error: redactImageTransferError(error) });
    throw error;
  } finally { budget.dispose(); }
  return emptyAttachmentGuard(form);
}

async function inspectAttachments(page: Page, form: Locator, files: PromptAttachmentFile[], budget: ImageTransferDeadline) {
  const rejected = await budget.observe(page.locator('[role="alert"]').evaluateAll(alerts => alerts.some(alert => {
    const style = getComputedStyle(alert);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const text = alert.textContent ?? "";
    return /upload|attach|file|image|tải|tệp|ảnh/i.test(text)
      && /fail|error|unable|cannot|couldn.t|too large|limit|unsupported|invalid|lỗi|không thể|quá lớn|giới hạn/i.test(text);
  })));
  const states = await Promise.all(files.map(async (file): Promise<AttachmentState> => {
    const group = form.getByRole("group", { name: file.name, exact: true });
    if (await budget.observe(group.count()) !== 1 || !await budget.observe(group.isVisible())) return "missing";
    return budget.observe(group.evaluate((root, image) => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const state = [root.getAttribute("data-state"), root.getAttribute("data-upload-state"), root.getAttribute("data-status")].join(" ");
      if (/error|failed|rejected/i.test(state) || root.getAttribute("aria-invalid") === "true"
        || [...root.querySelectorAll('[role="alert"], [data-state="error"], [data-upload-state="error"]')].some(visible)) return "rejected";
      if (/uploading|pending|loading|processing/i.test(state) || root.getAttribute("aria-busy") === "true"
        || [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-state="uploading"], [data-upload-state="uploading"], [data-testid*="upload-progress"], .animate-spin')].some(visible)) return "uploading";
      if (/complete|uploaded|success|ready/i.test(state)) return "accepted";
      const interactiveChip = [...root.querySelectorAll<HTMLButtonElement>('button, [role="button"]')].some(button => visible(button)
        && !button.disabled && button.getAttribute("aria-disabled") !== "true");
      const previewReady = [...root.querySelectorAll<HTMLImageElement>("img")].some(preview => visible(preview) && preview.complete && preview.naturalWidth > 0);
      // A usable chip is structural: removal labels vary with ChatGPT's UI language.
      // This fallback also requires no pending/error indicator, a loaded image preview,
      // and an enabled Send button for every reference across two observations below.
      return interactiveChip && (!image || previewReady) ? "accepted" : "uploading";
    }, file.mimeType.startsWith("image/")));
  }));
  const send = form.getByTestId("send-button");
  const sendEnabled = await budget.observe(send.count()) === 1
    && await budget.observe(send.isVisible()) && await budget.observe(send.isEnabled());
  const inventory = await attachmentInventory(form, budget);
  const exactInventory = exactAttachmentInventory(inventory, files);
  budget.remaining();
  return { states, sendEnabled, exactInventory, rejected: rejected || states.includes("rejected") };
}

export async function attachPromptFiles(options: {
  page: Page; form: Locator; files: PromptAttachmentFile[]; abortSignal?: AbortSignal; log: ImageTransferLog;
}): Promise<AttachmentGuard> {
  const { page, form, files, log } = options;
  const budget = new ImageTransferDeadline(undefined, options.abortSignal);
  log("attachments_started", { referenceCount: files.filter(file => file.mimeType.startsWith("image/")).length, attachmentCount: files.length });
  const report = (snapshot: Awaited<ReturnType<typeof inspectAttachments>>) => {
    snapshot.states.forEach((state, index) => log("attachment_state", { attachmentIndex: index, state }));
    log("attachments_send_condition", {
      sendEnabled: snapshot.sendEnabled,
      exactInventory: snapshot.exactInventory,
      rejected: snapshot.rejected,
    });
  };
  try {
    budget.remaining();
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: Math.min(20_000, budget.remaining()), signal: budget.signal });
    if (await budget.observe(input.count()) !== 1) throw new ImageTransferError("attachment_input_ambiguous", "upload");
    await input.setInputFiles(files, { timeout: budget.remaining(), signal: budget.signal });
    budget.remaining();
    let previous = "";
    let stableReady = 0;
    for (;;) {
      const snapshot = await inspectAttachments(page, form, files, budget);
      const key = JSON.stringify(snapshot);
      if (key !== previous) { report(snapshot); previous = key; }
      if (snapshot.rejected) throw new ImageTransferError("attachment_upload_rejected", "upload");
      stableReady = snapshot.sendEnabled && snapshot.exactInventory
        && snapshot.states.every(state => state === "accepted") ? stableReady + 1 : 0;
      if (stableReady >= 2) break;
      await budget.pause();
    }
    budget.remaining();
    log("attachments_accepted", { attachmentCount: files.length });
  } catch (error) {
    log("attachments_failed", { error: redactImageTransferError(error) });
    throw error;
  } finally { budget.dispose(); }
  return {
    async assertReady(signal) {
      const check = new ImageTransferDeadline(Date.now() + 10_000, signal);
      try {
        const snapshot = await inspectAttachments(page, form, files, check);
        report(snapshot);
        if (snapshot.rejected) throw new ImageTransferError("attachment_upload_rejected", "before_send");
        if (!snapshot.sendEnabled || !snapshot.exactInventory || snapshot.states.some(state => state !== "accepted")) {
          throw new ImageTransferError("attachments_not_ready", "before_send");
        }
        check.remaining();
      } finally { check.dispose(); }
    },
  };
}
