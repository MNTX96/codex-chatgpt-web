import type { Locator } from "playwright-core";
import type { OutputImageCandidate } from "../types";

export const CHATGPT_GENERATED_IMAGE_CARD_SELECTOR = '[id^="image-"][class*="imagegen-image"]';

/** Finds only ChatGPT's image-generation cards within the assistant turn bound by the worker. */
export async function detectOutputImages(responseTurn: Locator): Promise<OutputImageCandidate[]> {
  return await responseTurn.evaluate((root, cardSelector) => {
    const cards = Array.from(root.querySelectorAll<HTMLElement>(cardSelector));
    return cards.flatMap((card, index) => {
      // The image card and response actions can be committed before Electron's hidden view
      // hydrates/lazy-loads the preview source. Card presence is still generated-image evidence;
      // keep source/readiness separate so completion can hand the card to the capture stage.
      const images = Array.from(card.querySelectorAll<HTMLImageElement>("img"));
      const image = images.find(candidate => candidate.currentSrc || candidate.src) ?? images[0];
      const key = card.id || `image-card-${index}`;
      const source = image ? (image.currentSrc || image.src) : "";
      const downloadAction = Array.from(card.querySelectorAll<HTMLElement>("button, a")).some(control => {
        const label = [control.getAttribute("aria-label"), control.getAttribute("title"), control.textContent]
          .filter(Boolean).join(" ");
        return /\bdownload\b|original/i.test(label);
      });
      const originalHref = Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .filter(anchor => anchor.hasAttribute("download") || /\bdownload\b|original/i.test([
          anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.textContent,
        ].filter(Boolean).join(" ")))
        .map(anchor => anchor.href)
        .find(href => /^https:\/\//i.test(href));
      return [{
        key,
        imageSrc: source || undefined,
        ...(originalHref ? { originalHref } : {}),
        ...(downloadAction ? { downloadAction: true } : {}),
        width: image?.naturalWidth || undefined,
        height: image?.naturalHeight || undefined,
        readiness: source && image?.complete && image.naturalWidth > 0
          ? "ready"
          : source && image?.complete ? "error" : "loading",
      }];
    });
  }, CHATGPT_GENERATED_IMAGE_CARD_SELECTOR);
}

/** A safe signature for completion detection. It intentionally never exposes source URLs. */
export async function outputImageSignature(responseTurn: Locator): Promise<string[]> {
  return (await detectOutputImages(responseTurn)).map(candidate => {
    // A non-reversible, in-memory fingerprint catches signed URL refreshes without putting the
    // URL into snapshots, diagnostics, IPC, or replay state.
    let hash = 2166136261;
    for (const char of candidate.imageSrc ?? "") hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${candidate.key}:${candidate.readiness}:${candidate.width ?? 0}x${candidate.height ?? 0}:${(hash >>> 0).toString(16)}`;
  }).sort();
}
