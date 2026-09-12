import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright-core";
import type { OutputImageCandidate } from "../types";
import { ImageTransferDeadline, ImageTransferError, type ImageTransferLog } from "../../image-transfer";
import { CHATGPT_GENERATED_IMAGE_CARD_SELECTOR } from "./image-detector";

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
      const matchIdentity = (value: string | null | undefined) => value?.match(/^file[-_][\w-]+$/)?.[0];
      try {
        const url = new URL(source);
        if (url.protocol !== "https:") return undefined;
        const key = matchIdentity(url.searchParams.get("file_id")) ?? matchIdentity(url.searchParams.get("id"));
        return key ?? url.pathname.match(/(?:^|\/)(file[-_][\w-]+)(?:\/|$)/)?.[1];
      } catch { return undefined; }
    };
    const attributeIdentity = (element: Element) => {
      const values = [element.getAttribute("data-file-id"), element.getAttribute("data-image-id")];
      return values.map(value => value?.match(/^file[-_][\w-]+$/)?.[0]).find(Boolean);
    };
    const identity = candidate.fileIdentity ?? (candidate.imageSrc && fileIdentity(candidate.imageSrc));
    const matches = (image: HTMLImageElement) => {
      const source = image.currentSrc || image.src;
      if (source && source === candidate.imageSrc) return true;
      return !!identity && (identity === fileIdentity(source) || identity === attributeIdentity(image));
    };
    const selectionMatches = (root: HTMLElement, image: HTMLImageElement) => {
      if (!identity) return false;
      const source = image.currentSrc || image.src;
      const currentIdentity = fileIdentity(source) ?? attributeIdentity(image);
      // A known-but-different source is positive evidence that the viewer moved to another image.
      if (currentIdentity) return currentIdentity === identity;
      const mainLabel = image.getAttribute("alt")?.replace(/\s+/g, " ").trim().toLowerCase();
      if (!mainLabel) return false;
      for (const control of root.querySelectorAll<HTMLElement>('button, [role="button"]')) {
        if (!visible(control)) continue;
        const hasIdentity = [...control.querySelectorAll<HTMLImageElement>("img")].some(thumbnail => {
          const thumbnailSource = thumbnail.currentSrc || thumbnail.src;
          return identity === fileIdentity(thumbnailSource) || identity === attributeIdentity(thumbnail);
        });
        if (!hasIdentity) continue;
        const controlLabel = [control.getAttribute("aria-label"), control.getAttribute("title")]
          .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
        if (controlLabel && (controlLabel.startsWith(mainLabel) || mainLabel.startsWith(controlLabel))) return true;
      }
      return false;
    };
    const candidates = [...document.querySelectorAll<HTMLElement>(selectors)].filter(visible).filter(root => {
      const images = [...root.querySelectorAll<HTMLImageElement>("img")].filter(visible);
      const area = (image: HTMLImageElement) => { const rect = image.getBoundingClientRect(); return rect.width * rect.height; };
      const largest = Math.max(0, ...images.map(area));
      const mainImages = images.filter(image => area(image) === largest);
      // A thumbnail for the requested image is not evidence that the viewer selected it.
      const knownKeys = [candidate.key, candidate.cardId, candidate.fileIdentity].filter(Boolean);
      return mainImages.length === 1 && (matches(mainImages[0]!)
        || selectionMatches(root, mainImages[0]!)
        || knownKeys.includes(root.getAttribute("data-image-id") ?? "")
        || knownKeys.includes(mainImages[0]!.getAttribute("data-image-id") ?? ""));
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
  const visibleViewers = page.locator(VIEWERS);
  for (let index = 0, count = Math.min(await budget.observe(visibleViewers.count()), 10); index < count; index += 1) {
    const current = visibleViewers.nth(index);
    if (!await budget.observe(current.isVisible())) continue;
    const close = current.getByRole("button", { name: /^(close|đóng)(\b|$)/i });
    if (await budget.observe(close.count()) !== 1) {
      throw new ImageTransferError("image_viewer_wrong_image", "open_viewer");
    }
    await close.click({ timeout: Math.min(5_000, budget.remaining()), signal: budget.signal });
  }
  if (!candidate.fileIdentity && candidate.transientGalleryOrdinal !== undefined) {
    const transientToken = randomUUID();
    const transientSelector = `[data-codex-image-gallery-transient=${quoted(transientToken)}]`;
    const binding = await budget.observe(responseTurn.evaluate((root, args) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return element.isConnected && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const enabled = (element: HTMLElement) => {
        if (element.getAttribute("aria-disabled") === "true") return false;
        return !("disabled" in element && Boolean((element as HTMLButtonElement).disabled));
      };
      const fileIdentity = (source: string): string | undefined => {
        const matchIdentity = (value: string | null | undefined) => value?.match(/^file[-_][\w-]+$/)?.[0];
        try {
          const url = new URL(source, location.href);
          return matchIdentity(url.searchParams.get("file_id"))
            ?? matchIdentity(url.searchParams.get("id"))
            ?? url.pathname.match(/(?:^|\/)(file[-_][\w-]+)(?:\/|$)/)?.[1];
        } catch { return undefined; }
      };
      const attributeIdentity = (element: Element) => [element.getAttribute("data-file-id"), element.getAttribute("data-image-id")]
        .map(value => value?.match(/^file[-_][\w-]+$/)?.[0]).find(Boolean);
      const imageIdentity = (image: HTMLImageElement) => fileIdentity(image.currentSrc || image.src) ?? attributeIdentity(image);
      const imageArea = (image: HTMLImageElement) => {
        const rect = image.getBoundingClientRect(); return rect.width * rect.height;
      };
      const primaryImage = (card: HTMLElement) => {
        const images = [...card.querySelectorAll<HTMLImageElement>("img")];
        const opener = card.querySelector<HTMLElement>('[aria-label="Edit image"]');
        const labelledIds = (opener?.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
        const labelledImages = labelledIds.flatMap(labelId => {
          const labelled = document.getElementById(labelId);
          if (!labelled || !card.contains(labelled)) return [];
          if (labelled instanceof HTMLImageElement) return [labelled];
          return [...labelled.querySelectorAll<HTMLImageElement>("img")];
        });
        const generated = images.filter(image => /^Generated image(?::|$)/i.test(image.alt.trim()));
        const visibleGenerated = generated.filter(visible).sort((left, right) => imageArea(right) - imageArea(left));
        const visual = images.filter(visible).sort((left, right) => imageArea(right) - imageArea(left));
        return labelledImages.find(visible) ?? visibleGenerated[0] ?? visual[0]
          ?? labelledImages[0] ?? generated[0] ?? images[0];
      };
      for (const element of root.querySelectorAll<HTMLElement>("[data-codex-image-gallery-transient]")) {
        if (element.getAttribute("data-codex-image-gallery-transient") === args.token) {
          element.removeAttribute("data-codex-image-gallery-transient");
        }
      }
      const cards = [...root.querySelectorAll<HTMLElement>(args.cardSelector)].filter(visible);
      const matchingCards = args.cardId ? cards.filter(card => card.id === args.cardId) : cards;
      if (matchingCards.length !== 1) return { state: matchingCards.length === 0 ? "missing" : "ambiguous", controlCount: 0 };
      const card = matchingCards[0]!;
      const primary = primaryImage(card);
      const primaryControl = primary?.closest<HTMLElement>('button, [role="button"]');
      const galleryControls = [...card.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter(control => control !== primaryControl && visible(control) && enabled(control))
        .filter(control => {
          const images = [...control.querySelectorAll<HTMLImageElement>("img")];
          if (images.length === 0) return false;
          return images.some(image => /^Generated image(?::|$)/i.test(image.alt.trim()) || Boolean(imageIdentity(image)))
            || Boolean(attributeIdentity(control));
        });
      const target = galleryControls[args.ordinal];
      if (!target) return { state: "missing", controlCount: galleryControls.length };
      target.setAttribute("data-codex-image-gallery-transient", args.token);
      return { state: "bound", controlCount: galleryControls.length };
    }, {
      token: transientToken,
      ordinal: candidate.transientGalleryOrdinal,
      cardId: candidate.cardId,
      cardSelector: CHATGPT_GENERATED_IMAGE_CARD_SELECTOR,
    }));
    if (binding.state !== "bound") {
      throw new ImageTransferError(
        binding.state === "ambiguous" ? "image_gallery_control_ambiguous" : "image_gallery_control_missing",
        "open_viewer",
        { retryable: binding.state === "missing" },
      );
    }
    const transientControl = responseTurn.locator(transientSelector);
    if (await budget.observe(transientControl.count()) !== 1) {
      throw new ImageTransferError("image_gallery_control_ambiguous", "open_viewer");
    }
    await transientControl.scrollIntoViewIfNeeded({ timeout: Math.min(5_000, budget.remaining()) });
    await transientControl.click({ timeout: Math.min(10_000, budget.remaining()), signal: budget.signal });
    log("gallery_image_selected", { candidateKey: candidate.key });
    await transientControl.evaluateAll(elements => elements.forEach(element => element.removeAttribute("data-codex-image-gallery-transient"))).catch(() => {});

    const resolveUntil = Math.min(budget.deadlineAt, Date.now() + 5_000);
    let resolved: { identity: string; source?: string; width?: number; height?: number; readiness: OutputImageCandidate["readiness"] } | undefined;
    while (Date.now() < resolveUntil && !resolved) {
      resolved = await budget.observe(responseTurn.evaluate((root, args) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
          return element.isConnected && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const fileIdentity = (source: string): string | undefined => {
          const matchIdentity = (value: string | null | undefined) => value?.match(/^file[-_][\w-]+$/)?.[0];
          try {
            const url = new URL(source, location.href);
            return matchIdentity(url.searchParams.get("file_id"))
              ?? matchIdentity(url.searchParams.get("id"))
              ?? url.pathname.match(/(?:^|\/)(file[-_][\w-]+)(?:\/|$)/)?.[1];
          } catch { return undefined; }
        };
        const attributeIdentity = (element: Element) => [element.getAttribute("data-file-id"), element.getAttribute("data-image-id")]
          .map(value => value?.match(/^file[-_][\w-]+$/)?.[0]).find(Boolean);
        const imageArea = (image: HTMLImageElement) => {
          const rect = image.getBoundingClientRect(); return rect.width * rect.height;
        };
        const cards = [...root.querySelectorAll<HTMLElement>(args.cardSelector)].filter(visible);
        const card = args.cardId ? cards.find(candidateCard => candidateCard.id === args.cardId) : cards[0];
        if (!card) return undefined;
        const images = [...card.querySelectorAll<HTMLImageElement>("img")];
        const opener = card.querySelector<HTMLElement>('[aria-label="Edit image"]');
        const labelledIds = (opener?.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
        const labelledImages = labelledIds.flatMap(labelId => {
          const labelled = document.getElementById(labelId);
          if (!labelled || !card.contains(labelled)) return [];
          if (labelled instanceof HTMLImageElement) return [labelled];
          return [...labelled.querySelectorAll<HTMLImageElement>("img")];
        });
        const generated = images.filter(image => /^Generated image(?::|$)/i.test(image.alt.trim()));
        const visibleGenerated = generated.filter(visible).sort((left, right) => imageArea(right) - imageArea(left));
        const visual = images.filter(visible).sort((left, right) => imageArea(right) - imageArea(left));
        const image = labelledImages.find(visible) ?? visibleGenerated[0] ?? visual[0]
          ?? labelledImages[0] ?? generated[0] ?? images[0];
        if (!image) return undefined;
        const source = image.currentSrc || image.src;
        const identity = fileIdentity(source) ?? attributeIdentity(image) ?? attributeIdentity(card);
        if (!identity) return undefined;
        return {
          identity,
          ...(source ? { source } : {}),
          width: image.naturalWidth || undefined,
          height: image.naturalHeight || undefined,
          readiness: source && image.complete && image.naturalWidth > 0
            ? "ready" as const
            : source && image.complete ? "error" as const : "loading" as const,
        };
      }, { cardId: candidate.cardId, cardSelector: CHATGPT_GENERATED_IMAGE_CARD_SELECTOR }));
      if (!resolved) await budget.pause();
    }
    if (!resolved) {
      throw new ImageTransferError("image_gallery_identity_unresolved", "open_viewer", { retryable: true });
    }
    candidate.fileIdentity = resolved.identity;
    candidate.key = resolved.identity;
    candidate.imageSrc = resolved.source;
    candidate.width = resolved.width;
    candidate.height = resolved.height;
    candidate.readiness = resolved.readiness;
    delete candidate.transientGalleryOrdinal;
    log("gallery_identity_resolved", { candidateKey: candidate.key });
  }
  const responseToken = randomUUID();
  const editSelector = `[data-codex-image-edit-target=${quoted(responseToken)}]`;
  const gallerySelector = `[data-codex-image-gallery-target=${quoted(responseToken)}]`;
  const bindResponseTarget = async (): Promise<"selected" | "selectable" | "missing" | "ambiguous"> => budget.observe(responseTurn.evaluate((root, args) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return element.isConnected && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const enabled = (element: HTMLElement) => {
      if (element.getAttribute("aria-disabled") === "true") return false;
      return !("disabled" in element && Boolean((element as HTMLButtonElement).disabled));
    };
    const fileIdentity = (source: string): string | undefined => {
      const matchIdentity = (value: string | null | undefined) => value?.match(/^file[-_][\w-]+$/)?.[0];
      try {
        const url = new URL(source, location.href);
        return matchIdentity(url.searchParams.get("file_id"))
          ?? matchIdentity(url.searchParams.get("id"))
          ?? url.pathname.match(/(?:^|\/)(file[-_][\w-]+)(?:\/|$)/)?.[1];
      } catch { return undefined; }
    };
    const attributeIdentity = (element: Element) => [element.getAttribute("data-file-id"), element.getAttribute("data-image-id")]
      .map(value => value?.match(/^file[-_][\w-]+$/)?.[0]).find(Boolean);
    const imageArea = (image: HTMLImageElement) => {
      const rect = image.getBoundingClientRect(); return rect.width * rect.height;
    };
    const primaryImage = (card: HTMLElement) => {
      const images = [...card.querySelectorAll<HTMLImageElement>("img")];
      const opener = card.querySelector<HTMLElement>('[aria-label="Edit image"]');
      const labelledIds = (opener?.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const labelledImages = labelledIds.flatMap(labelId => {
        const labelled = document.getElementById(labelId);
        if (!labelled || !card.contains(labelled)) return [];
        if (labelled instanceof HTMLImageElement) return [labelled];
        return [...labelled.querySelectorAll<HTMLImageElement>("img")];
      });
      const generated = images.filter(image => /^Generated image(?::|$)/i.test(image.alt.trim()));
      const visibleGenerated = generated.filter(visible).sort((left, right) => imageArea(right) - imageArea(left));
      const visual = images.filter(visible).sort((left, right) => imageArea(right) - imageArea(left));
      return labelledImages.find(visible) ?? visibleGenerated[0] ?? visual[0]
        ?? labelledImages[0] ?? generated[0] ?? images[0];
    };
    for (const element of root.querySelectorAll<HTMLElement>("[data-codex-image-edit-target], [data-codex-image-gallery-target]")) {
      if (element.getAttribute("data-codex-image-edit-target") === args.token) element.removeAttribute("data-codex-image-edit-target");
      if (element.getAttribute("data-codex-image-gallery-target") === args.token) element.removeAttribute("data-codex-image-gallery-target");
    }
    const identity = args.candidate.fileIdentity
      ?? (args.candidate.imageSrc ? fileIdentity(args.candidate.imageSrc) : undefined);
    const fallbackCardId = args.candidate.cardId ?? args.candidate.key;
    const cards = [...root.querySelectorAll<HTMLElement>(args.cardSelector)].filter(visible);
    const cardShowsCandidate = (card: HTMLElement) => {
      const image = primaryImage(card);
      if (identity) {
        if (!image) return false;
        const source = image.currentSrc || image.src;
        return identity === fileIdentity(source)
          || identity === attributeIdentity(image)
          || identity === attributeIdentity(card);
      }
      if (args.candidate.imageSrc && image && (image.currentSrc || image.src) === args.candidate.imageSrc) return true;
      return Boolean(fallbackCardId) && card.id === fallbackCardId;
    };
    const candidateCards = fallbackCardId
      ? cards.filter(card => card.id === fallbackCardId || cardShowsCandidate(card))
      : cards.filter(cardShowsCandidate);
    const selectedCards = candidateCards.filter(cardShowsCandidate);
    const editControls = [...new Set(selectedCards.flatMap(card => [...card.querySelectorAll<HTMLElement>('[aria-label="Edit image"]')]))]
      .filter(control => visible(control) && enabled(control));
    if (editControls.length === 1) {
      editControls[0]!.setAttribute("data-codex-image-edit-target", args.token);
      return "selected";
    }
    if (editControls.length > 1) return "ambiguous";
    const controlHasIdentity = (control: HTMLElement) => {
      if (!identity) return false;
      if (attributeIdentity(control) === identity) return true;
      if ([...control.querySelectorAll<HTMLImageElement>("img")].some(image => {
        const source = image.currentSrc || image.src;
        return fileIdentity(source) === identity || attributeIdentity(image) === identity;
      })) return true;
      return [...control.querySelectorAll<HTMLAnchorElement>("a[href]")].some(anchor => (
        fileIdentity(anchor.href) === identity || attributeIdentity(anchor) === identity
      ));
    };
    const galleryControls = [...new Set(candidateCards.flatMap(card => {
      const controls = [...card.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter(control => visible(control) && enabled(control) && controlHasIdentity(control));
      let current = card.parentElement;
      while (current && current !== root) {
        if (current.matches('button, [role="button"]') && visible(current) && enabled(current) && controlHasIdentity(current)) {
          controls.push(current);
          break;
        }
        current = current.parentElement;
      }
      return controls;
    }))];
    if (galleryControls.length === 1) {
      galleryControls[0]!.setAttribute("data-codex-image-gallery-target", args.token);
      return "selectable";
    }
    return candidateCards.length === 0 ? "missing" : "ambiguous";
  }, { candidate, token: responseToken, cardSelector: CHATGPT_GENERATED_IMAGE_CARD_SELECTOR }));
  let targetState = await bindResponseTarget();
  if (targetState === "missing") throw new ImageTransferError("image_card_unmounted", "bind", { retryable: true });
  if (targetState === "ambiguous") throw new ImageTransferError("image_edit_control_ambiguous", "open_viewer");
  if (targetState === "selectable") {
    const gallery = responseTurn.locator(gallerySelector);
    if (await budget.observe(gallery.count()) !== 1) throw new ImageTransferError("image_gallery_control_ambiguous", "open_viewer");
    await gallery.scrollIntoViewIfNeeded({ timeout: Math.min(5_000, budget.remaining()) });
    await gallery.click({ timeout: Math.min(10_000, budget.remaining()), signal: budget.signal });
    log("gallery_image_selected", { candidateKey: candidate.key });
    const selectedUntil = Math.min(budget.deadlineAt, Date.now() + 5_000);
    while (Date.now() < selectedUntil) {
      targetState = await bindResponseTarget();
      if (targetState === "selected") break;
      if (targetState === "missing") throw new ImageTransferError("image_card_unmounted", "bind", { retryable: true });
      if (targetState === "ambiguous") throw new ImageTransferError("image_edit_control_ambiguous", "open_viewer");
      await budget.pause();
    }
    if (targetState !== "selected") throw new ImageTransferError("image_gallery_selection_failed", "open_viewer", { retryable: true });
  }
  log("card_bound", { candidateKey: candidate.key });
  const target = responseTurn.locator(editSelector);
  if (await budget.observe(target.count()) !== 1) throw new ImageTransferError("image_edit_control_missing", "open_viewer", { retryable: true });
  await target.scrollIntoViewIfNeeded({ timeout: Math.min(5_000, budget.remaining()) });
  try {
    await target.click({ timeout: Math.min(10_000, budget.remaining()), signal: budget.signal });
    opened = true;
  } catch (cause) {
    // A click timeout does not prove that no input was dispatched; never replay it blindly.
    throw new ImageTransferError("image_viewer_activation_failed", "open_viewer", { cause });
  }
  const verifyUntil = Math.min(budget.deadlineAt, Date.now() + 10_000);
  while (Date.now() < verifyUntil) {
    if (await locate()) { log("viewer_verified", { candidateKey: candidate.key, reused: false }); return bound(); }
    await budget.pause();
  }
  throw new ImageTransferError("image_viewer_unverified", "verify_viewer");
}
