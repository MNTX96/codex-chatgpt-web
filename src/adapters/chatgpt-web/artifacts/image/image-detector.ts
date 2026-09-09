import type { Locator } from "playwright-core";
import type { OutputImageCandidate } from "../types";

/** Finds only ChatGPT's image-generation cards within the assistant turn bound by the worker. */
export async function detectOutputImages(responseTurn: Locator): Promise<OutputImageCandidate[]> {
  return await responseTurn.evaluate(root => {
    const cards = [...root.querySelectorAll<HTMLElement>(".group\\/imagegen-image[id^='image-']")];
    return cards.flatMap((card, index) => {
      const image = [...card.querySelectorAll<HTMLImageElement>("img")]
        .find(candidate => candidate.currentSrc || candidate.src);
      if (!image) return [];
      const key = card.id || `image-card-${index}`;
      const source = image.currentSrc || image.src;
      const downloadAction = [...card.querySelectorAll<HTMLElement>("button, a")].some(control => {
        const label = [control.getAttribute("aria-label"), control.getAttribute("title"), control.textContent]
          .filter(Boolean).join(" ");
        return /\bdownload\b|original/i.test(label);
      });
      const originalHref = [...card.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map(anchor => anchor.href)
        .find(href => /^https:\/\//i.test(href));
      return [{
        key,
        imageSrc: source || undefined,
        ...(originalHref ? { originalHref } : {}),
        ...(downloadAction ? { downloadAction: true } : {}),
        width: image.naturalWidth || undefined,
        height: image.naturalHeight || undefined,
        readiness: image.complete && image.naturalWidth > 0 ? "ready" : image.complete ? "error" : "loading",
      }];
    });
  });
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
