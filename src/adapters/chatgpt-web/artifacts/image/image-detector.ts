import type { Locator } from "playwright-core";
import type { OutputImageCandidate } from "../types";

export const CHATGPT_GENERATED_IMAGE_CARD_SELECTOR = '[id^="image-"][class*="imagegen-image"]';

/** Finds only ChatGPT's image-generation cards within the assistant turn bound by the worker. */
export async function detectOutputImages(responseTurn: Locator): Promise<OutputImageCandidate[]> {
  const detected = await responseTurn.evaluate((responseElement, cardSelector) => {
    const cardElements = Array.from(responseElement.querySelectorAll(cardSelector));
    const fileIdentity = (source: string): string | undefined => {
      const matchIdentity = (value: string | null | undefined) => value?.match(/^file[-_][A-Za-z0-9_-]+$/)?.[0];
      try {
        const url = new URL(source, location.href);
        const queryIdentity = matchIdentity(url.searchParams.get("file_id")) ?? matchIdentity(url.searchParams.get("id"));
        if (queryIdentity) return queryIdentity;
        return url.pathname.match(/(?:^|\/)(file[-_][A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
      } catch {
        return source.match(/(?:^|[^A-Za-z0-9_-])(file[-_][A-Za-z0-9_-]+)(?:$|[^A-Za-z0-9_-])/)?.[1];
      }
    };
    const visible = (element: Element) => {
      if (typeof element.getBoundingClientRect !== "function" || typeof getComputedStyle !== "function") return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element.isConnected && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const imageArea = (image: HTMLImageElement) => {
      const rect = image.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const attributeIdentity = (element: Element | undefined) => !element ? undefined : [
      element.getAttribute("data-file-id"),
      element.getAttribute("data-image-id"),
    ].map(value => value?.match(/^file[-_][A-Za-z0-9_-]+$/)?.[0]).find(Boolean);
    const imageIdentity = (image: HTMLImageElement | undefined) => !image ? undefined
      : fileIdentity(image.currentSrc || image.src) ?? attributeIdentity(image);
    return cardElements.flatMap((element, index) => {
      const card = element as HTMLElement;
      // The image card and response actions can be committed before Electron's hidden view
      // hydrates/lazy-loads the preview source. Card presence is still generated-image evidence;
      // keep source/readiness separate so completion can hand the card to the capture stage.
      const images = Array.from(card.querySelectorAll<HTMLImageElement>("img"));
      const opener = card.querySelector<HTMLElement>('[aria-label="Edit image"]');
      const labelledIds = (opener?.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const labelledImages = labelledIds.flatMap(labelId => {
        const labelled = document.getElementById(labelId);
        if (!labelled || !card.contains(labelled)) return [];
        if (labelled instanceof HTMLImageElement) return [labelled];
        return Array.from(labelled.querySelectorAll<HTMLImageElement>("img"));
      });
      const generatedAltImages = images.filter(candidate => /^Generated image(?::|$)/i.test(candidate.alt.trim()));
      const visualImages = images.filter(visible);
      const image = labelledImages.find(visible)
        ?? generatedAltImages.filter(visible).sort((left, right) => imageArea(right) - imageArea(left))[0]
        ?? visualImages.sort((left, right) => imageArea(right) - imageArea(left))[0]
        ?? labelledImages[0]
        ?? generatedAltImages[0]
        ?? images[0];
      const source = image ? (image.currentSrc || image.src) : "";
      const identitySources = [
        source,
        image?.getAttribute("data-image-id") ?? "",
        image?.getAttribute("data-file-id") ?? "",
        card.getAttribute("data-image-id") ?? "",
        card.getAttribute("data-file-id") ?? "",
        ...Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]")).map(anchor => anchor.href),
      ].filter(Boolean);
      const identity = identitySources.map(fileIdentity).find(Boolean);
      const downloadAction = Array.from(card.querySelectorAll<HTMLElement>("button, a")).some(control => {
        const label = [control.getAttribute("aria-label"), control.getAttribute("title"), control.textContent]
          .filter(Boolean).join(" ");
        return /\bdownload\b|original/i.test(label);
      });
      const downloadableHrefs = Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .filter(anchor => anchor.hasAttribute("download") || /\bdownload\b|original/i.test([
          anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.textContent,
        ].filter(Boolean).join(" ")))
        .map(anchor => anchor.href)
        .filter(href => /^https:\/\//i.test(href));
      const assistantTurnId = card.closest<HTMLElement>("[data-turn-id]")?.getAttribute("data-turn-id") ?? undefined;
      const candidate = (
        candidateIdentity: string | undefined,
        candidateImage: HTMLImageElement | undefined,
        fallbackKey: string,
        transientGalleryOrdinal?: number,
      ) => {
        const candidateSource = candidateImage ? (candidateImage.currentSrc || candidateImage.src) : "";
        const originalHref = candidateIdentity
          ? downloadableHrefs.find(href => fileIdentity(href) === candidateIdentity)
          : downloadableHrefs.length === 1 ? downloadableHrefs[0] : undefined;
        return {
          key: candidateIdentity ?? fallbackKey,
          cardId: card.id || undefined,
          ...(candidateIdentity ? { fileIdentity: candidateIdentity } : {}),
          ...(transientGalleryOrdinal !== undefined ? { transientGalleryOrdinal } : {}),
          assistantTurnId,
          imageSrc: candidateSource || undefined,
          ...(originalHref ? { originalHref } : {}),
          ...(downloadAction ? { downloadAction: true } : {}),
          width: candidateImage?.naturalWidth || undefined,
          height: candidateImage?.naturalHeight || undefined,
          readiness: candidateSource && candidateImage?.complete && candidateImage.naturalWidth > 0
            ? "ready" as const
            : candidateSource && candidateImage?.complete ? "error" as const : "loading" as const,
        };
      };

      // Current ChatGPT multi-image responses render one large selected preview plus one button
      // per gallery output inside the same image-* card. Each button can contain several
      // presentation <img> nodes, but all nodes for one output resolve to the same stable file id.
      // Treat those controls as output evidence and dedupe by file id; never count raw <img> tags.
      const primaryControl = image?.closest<HTMLElement>('button, [role="button"]');
      const galleryControls = Array.from(card.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .filter(control => control !== primaryControl)
        .filter(control => {
          const controlImages = Array.from(control.querySelectorAll<HTMLImageElement>("img"));
          if (controlImages.length === 0) return false;
          return controlImages.some(controlImage => /^Generated image(?::|$)/i.test(controlImage.alt.trim())
            || Boolean(imageIdentity(controlImage)))
            || Boolean(attributeIdentity(control));
        });
      const controlEntries = galleryControls.map((control, galleryOrdinal) => {
        const controlImages = Array.from(control.querySelectorAll<HTMLImageElement>("img"));
        const identities = new Set<string>();
        const directIdentity = attributeIdentity(control);
        if (directIdentity) identities.add(directIdentity);
        for (const controlImage of controlImages) {
          const value = imageIdentity(controlImage);
          if (value) identities.add(value);
        }
        for (const anchor of control.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          const value = fileIdentity(anchor.href) ?? attributeIdentity(anchor);
          if (value) identities.add(value);
        }
        const candidateIdentity = identities.size === 1 ? [...identities][0] : undefined;
        const matchingImages = candidateIdentity
          ? controlImages.filter(controlImage => imageIdentity(controlImage) === candidateIdentity)
          : controlImages;
        const representativeImage = matchingImages.filter(visible)
          .sort((left, right) => imageArea(right) - imageArea(left))[0]
          ?? matchingImages[0];
        return { candidateIdentity, representativeImage, galleryOrdinal };
      });
      if (controlEntries.length > 0) {
        // A distinct gallery control is output evidence even before its nested thumbnails expose a
        // file_* identity. Keep a transient ordinal only long enough to select that control; the
        // viewer resolves the selected large preview to a stable identity before persistence.
        const galleryCandidates = controlEntries.map(entry => candidate(
          entry.candidateIdentity,
          entry.representativeImage
            ?? (entry.candidateIdentity && imageIdentity(image) === entry.candidateIdentity ? image : undefined),
          entry.candidateIdentity ?? `gallery-pending:${card.id || index}:${entry.galleryOrdinal}`,
          entry.galleryOrdinal,
        ));
        if (galleryCandidates.length > 0) return galleryCandidates;
      }

      // Older/single-image renderers expose only one generated-image card. Stable file identity is
      // preferred; the card id remains a compatibility fallback until the preview hydrates.
      return [candidate(identity, image, (identity ?? card.id) || `image-card-${index}`)];
    });
  }, CHATGPT_GENERATED_IMAGE_CARD_SELECTOR) as OutputImageCandidate[];
  const seen = new Set<string>();
  return detected.filter(candidate => {
    const identity = candidate.fileIdentity ?? candidate.key;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
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
