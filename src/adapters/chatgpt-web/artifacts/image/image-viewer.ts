import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright-core";
import type { OutputImageCandidate } from "../types";
import { ImageTransferDeadline, ImageTransferError, type ImageTransferLog } from "../../image-transfer";

const VIEWERS = '[role="dialog"], dialog, [data-testid="image-viewer"], [data-testid="image-lightbox"]';
const DOWNLOAD_LABEL = /\bdownload\b|\boriginal\b|\bsave\b|\bexport\b|tải xuống|ảnh gốc|lưu/i;
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function isImageSaveAction(descriptor: { label: string; download: boolean; aria: string | null }): boolean {
  if (descriptor.download) return true;
  const aria = descriptor.aria?.trim().toLowerCase();
  if (aria === "save" || aria === "lưu") return true;
  return DOWNLOAD_LABEL.test(descriptor.label);
}

export async function findImageDownloadControl(scope: Locator, budget: ImageTransferDeadline): Promise<Locator | undefined> {
  const controls = scope.locator('button, a, [role="button"], [role="menuitem"], [data-testid]');
  for (let index = 0, count = Math.min(await budget.observe(controls.count()), 100); index < count; index++) {
    budget.remaining();
    const control = controls.nth(index);
    if (!await budget.observe(control.isVisible())) continue;
    const descriptor = await budget.observe(control.evaluate(element => ({
      aria: element.getAttribute("aria-label"),
      label: [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" "),
      download: (element.tagName === "A" && element.hasAttribute("download"))
        || /download|save|export|original/i.test(element.getAttribute("data-testid") ?? ""),
    })));
    if (isImageSaveAction(descriptor)) return control;
  }
  return undefined;
}

export async function findViewerOriginal(scope: Locator, budget: ImageTransferDeadline): Promise<string | undefined> {
  return budget.observe(scope.evaluate(root => {
    const anchors = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")];
    return anchors.find(anchor => anchor.hasAttribute("download") || /\bdownload\b|\boriginal\b|tải xuống|ảnh gốc/i.test([
      anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.textContent,
    ].filter(Boolean).join(" ")))?.href;
  }));
}

/** Portal menus must be inside this viewer or explicitly controlled/labelled by its trigger. */
export async function findViewerDownloadMenu(page: Page, viewer: Locator, trigger: Locator, budget: ImageTransferDeadline): Promise<Locator | undefined> {
  const relation = await budget.observe(trigger.evaluate(element => ({
    controls: element.getAttribute("aria-controls"), id: element.id,
    expanded: element.getAttribute("aria-expanded"), popup: element.getAttribute("aria-haspopup"),
  })));
  if (relation.expanded !== "true" || !relation.popup || relation.popup === "false") return undefined;
  const scopes = [viewer.locator('[role="menu"], [data-radix-menu-content]')];
  for (const id of (relation.controls ?? "").split(/\s+/).filter(Boolean)) {
    scopes.push(page.locator(`[id=${quoted(id)}][role="menu"], [id=${quoted(id)}][data-radix-menu-content]`));
  }
  if (relation.id) scopes.push(page.locator(`[role="menu"][aria-labelledby~=${quoted(relation.id)}]`));
  for (const scope of scopes) {
    for (let i = 0, count = Math.min(await budget.observe(scope.count()), 10); i < count; i++) {
      if (!await budget.observe(scope.nth(i).isVisible())) continue;
      const action = await findImageDownloadControl(scope.nth(i), budget);
      if (action) return action;
    }
  }
  return undefined;
}

export interface BoundImageViewer { scope: Locator; assertCurrent(): Promise<void>; close(): Promise<void> }

export async function openBoundImageViewer(options: {
  page: Page; responseTurn: Locator; candidate: OutputImageCandidate;
  budget: ImageTransferDeadline; log: ImageTransferLog;
}): Promise<BoundImageViewer> {
  const { page, responseTurn, candidate, budget, log } = options;
  const token = randomUUID();
  const viewerSelector = `[data-codex-image-viewer=${quoted(token)}]`;
  const locate = async (): Promise<boolean> => budget.observe(page.evaluate(({ selectors, candidate, token }) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const fileIdentity = (source: string): string | undefined => {
      try {
        const url = new URL(source);
        if (url.protocol !== "https:") return undefined;
        const key = url.searchParams.get("file_id") ?? url.searchParams.get("id");
        return (key?.match(/^file-[\w-]+$/)?.[0]) ?? url.pathname.match(/(?:^|\/)(file-[\w-]+)(?:\/|$)/)?.[1];
      } catch { return undefined; }
    };
    const matches = (image: HTMLImageElement) => {
      const source = image.currentSrc || image.src;
      if (source && source === candidate.imageSrc) return true;
      const identity = candidate.imageSrc && fileIdentity(candidate.imageSrc);
      return !!identity && identity === fileIdentity(source);
    };
    const candidates = [...document.querySelectorAll<HTMLElement>(selectors)].filter(visible).filter(root => {
      const images = [...root.querySelectorAll<HTMLImageElement>("img")].filter(visible);
      const area = (image: HTMLImageElement) => { const rect = image.getBoundingClientRect(); return rect.width * rect.height; };
      const largest = Math.max(0, ...images.map(area));
      const mainImages = images.filter(image => area(image) === largest);
      // A thumbnail for the requested image is not evidence that the viewer selected it.
      return mainImages.length === 1 && (matches(mainImages[0]!)
        || root.getAttribute("data-image-id") === candidate.key
        || mainImages[0]!.getAttribute("data-image-id") === candidate.key);
    });
    const innermost = candidates.filter(root => !candidates.some(other => other !== root && root.contains(other)));
    if (innermost.length !== 1) return false;
    // React can hide an old dialog and mount a replacement without removing the old node.
    for (const root of document.querySelectorAll("[data-codex-image-viewer]")) {
      if (root.getAttribute("data-codex-image-viewer") === token) root.removeAttribute("data-codex-image-viewer");
    }
    innermost[0]!.setAttribute("data-codex-image-viewer", token);
    return true;
  }, { selectors: VIEWERS, candidate, token }));
  let opened = false;
  const bound = (): BoundImageViewer => ({
    scope: page.locator(viewerSelector),
    async assertCurrent() {
      if (!await locate()) throw new ImageTransferError("image_viewer_identity_changed", "verify_viewer");
    },
    async close() {
      const scope = page.locator(viewerSelector);
      try {
        if (opened && await scope.isVisible()) {
          const close = scope.getByRole("button", { name: /^(close|đóng)(\b|$)/i });
          if (await close.count() === 1) await close.click({ timeout: 2_000 });
        }
      } catch { log("viewer_cleanup_failed", { candidateKey: candidate.key }); }
      finally { await scope.evaluateAll(elements => elements.forEach(element => element.removeAttribute("data-codex-image-viewer"))).catch(() => {}); }
    },
  });
  if (await locate()) { log("viewer_verified", { candidateKey: candidate.key, reused: true }); return bound(); }
  const card = responseTurn.locator(`[id=${quoted(candidate.key)}]`);
  if (await budget.observe(card.count()) !== 1) {
    throw new ImageTransferError("image_card_unmounted", "bind", { retryable: true });
  }
  log("card_bound", { candidateKey: candidate.key });
  await card.scrollIntoViewIfNeeded({ timeout: Math.min(5_000, budget.remaining()) });
  const activation = await budget.observe(card.evaluate((root, { token, source }) => {
    const images = [...root.querySelectorAll<HTMLImageElement>("img")];
    const image = images.find(image => (image.currentSrc || image.src) === source) ?? (images.length === 1 ? images[0] : undefined);
    if (!image) return false;
    const rect = image.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!hit || !root.contains(hit)) return false;
    const label = (element: Element) => [element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" ");
    let target: Element = image.closest('button, a, [role="button"]') ?? image;
    if (hit !== image && !image.contains(hit)) {
      const control = hit.closest('button, a, [role="button"]') ?? hit;
      // An unlabelled overlay can own the image click. Never choose a toolbar action by order.
      if (label(control) && !/^(open|view|expand|mở|xem)(\b|\s)/i.test(label(control))) return false;
      target = control;
    }
    if (!root.contains(target) || /download|copy|share|edit|delete|tải|sửa|xóa/i.test(label(target))) return false;
    target.setAttribute("data-codex-image-activation", token);
    return true;
  }, { token, source: candidate.imageSrc }));
  if (!activation) throw new ImageTransferError("image_activation_obscured", "open_viewer", { retryable: true });
  const target = card.locator(`[data-codex-image-activation=${quoted(token)}]`);
  try {
    await target.click({ timeout: Math.min(10_000, budget.remaining()), signal: budget.signal });
    opened = true;
  } catch (cause) {
    // A click timeout does not prove that no input was dispatched; never replay it blindly.
    throw new ImageTransferError("image_viewer_activation_failed", "open_viewer", { cause });
  } finally {
    await target.evaluateAll(elements => elements.forEach(element => element.removeAttribute("data-codex-image-activation"))).catch(() => {});
  }
  const verifyUntil = Math.min(budget.deadlineAt, Date.now() + 10_000);
  while (Date.now() < verifyUntil) {
    if (await locate()) { log("viewer_verified", { candidateKey: candidate.key, reused: false }); return bound(); }
    await budget.pause();
  }
  throw new ImageTransferError("image_viewer_unverified", "verify_viewer");
}
