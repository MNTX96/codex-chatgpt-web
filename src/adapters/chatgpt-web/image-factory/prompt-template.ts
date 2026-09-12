type ImageFactoryOperation = "generate" | "edit";

const SEPARATE_OUTPUT_GUARD = "Do NOT combine multiple requested images into a collage, grid, triptych, contact sheet, sprite sheet, or split-screen.";
const SEPARATE_CARD_MARKER = "One Image line must map to one standalone generated-image card/file.";

function assertImageCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) {
    throw new RangeError("Image Factory count must be an integer from 1 through 4.");
  }
}

function hasCanonicalSeparateImageShape(prompt: string, count: number): boolean {
  const escapedCount = String(count);
  if (!new RegExp(`(?:^|\\n)\\s*Create\\s+${escapedCount}\\s+separate\\s+images?\\s*[.!]?`, "i").test(prompt)) return false;
  for (let index = 1; index <= count; index += 1) {
    if (!new RegExp(`(?:^|\\n)\\s*Image\\s+${index}\\s*:`, "i").test(prompt)) return false;
  }
  return new RegExp(`Return\\s+(?:them|the\\s+results?)\\s+as\\s+${escapedCount}\\s+separate\\s+image\\s+outputs?`, "i").test(prompt);
}

function separateCardContract(count: number): string {
  return [
    SEPARATE_CARD_MARKER,
    `Produce exactly ${count} standalone generated-image cards/files, one for each Image 1 through Image ${count}.`,
    "Each card/file must contain only its own Image i request and must not include any other requested Image j on the same canvas.",
    `If the built-in image generator produces one card per invocation, invoke it ${count} times before finishing this response.`,
    SEPARATE_OUTPUT_GUARD,
  ].join(" ");
}

function ensureSeparateCardContract(prompt: string, count: number): string {
  if (count === 1 || prompt.includes(SEPARATE_CARD_MARKER)) return prompt;
  return `${prompt.trim()}\n${separateCardContract(count)}`;
}

function canonicalGeneratePrompt(prompt: string, count: number): string {
  if (count === 1) return prompt;
  if (hasCanonicalSeparateImageShape(prompt, count)) return ensureSeparateCardContract(prompt, count);
  const outputLines = Array.from({ length: count }, (_, index) =>
    `Image ${index + 1}: ${prompt.trim()}`,
  );
  return ensureSeparateCardContract([
    `Create ${count} separate images.`,
    ...outputLines,
    `Return them as ${count} separate image outputs in one response.`,
  ].join("\n"), count);
}

function canonicalEditPrompt(prompt: string, count: number): string {
  if (count === 1) return prompt;
  const outputLines = Array.from({ length: count }, (_, index) =>
    `Image ${index + 1}: Apply this edit independently to the original source image: ${prompt.trim()}`,
  );
  return ensureSeparateCardContract([
    `Create ${count} separate edited images.`,
    ...outputLines,
    "",
    "Shared edit:",
    prompt,
    "Every result must be edited directly from the original source image, not from another generated variant.",
    `Return them as ${count} separate image outputs in one response.`,
  ].join("\n"), count);
}

function extractImageDescriptions(prompt: string): Map<number, string> {
  const descriptions = new Map<number, string>();
  const matches = prompt.matchAll(
    /^\s*Image\s+(\d+)\s*:\s*([\s\S]*?)(?=^\s*Image\s+\d+\s*:|^\s*Shared\s+(?:constraints|request|edit)\s*:|^\s*Return\b|\z)/gim,
  );
  for (const match of matches) {
    const index = Number(match[1]);
    const description = match[2]?.trim();
    if (Number.isSafeInteger(index) && index > 0 && description) descriptions.set(index, description);
  }
  return descriptions;
}

function extractSharedContext(prompt: string): string | undefined {
  const match = prompt.match(
    /^\s*(Shared\s+(?:constraints|request|edit)\s*:[\s\S]*?)(?=^\s*Return\b|\z)/im,
  );
  return match?.[1]?.trim() || undefined;
}

export function imageFactoryInitialPrompt(operation: ImageFactoryOperation, prompt: string, count: number): string {
  assertImageCount(count);
  return operation === "edit" ? canonicalEditPrompt(prompt, count) : canonicalGeneratePrompt(prompt, count);
}

export function imageFactoryContinuationPrompt(
  operation: ImageFactoryOperation,
  initialPrompt: string,
  completedCount: number,
  remaining: number,
): string {
  assertImageCount(remaining);
  if (!Number.isSafeInteger(completedCount) || completedCount < 1 || completedCount + remaining > 4) {
    throw new RangeError("Image Factory continuation offset is invalid.");
  }
  const noun = remaining === 1 ? "image" : "images";
  const descriptions = extractImageDescriptions(initialPrompt);
  const sharedContext = extractSharedContext(initialPrompt);
  if (operation === "edit") {
    return ensureSeparateCardContract([
      `Create ${remaining} additional separate edited ${noun} to complete my previous request.`,
      ...Array.from({ length: remaining }, (_, index) =>
        `Image ${index + 1}: Apply the same requested edit directly to the original source image again and return one standalone edited image.`,
      ),
      ...(sharedContext ? ["", sharedContext] : []),
      `Return ${remaining === 1 ? "it" : "them"} as ${remaining} separate image output${remaining === 1 ? "" : "s"}.`,
    ].join("\n"), remaining);
  }
  const outputLines = Array.from({ length: remaining }, (_, index) => {
    const originalIndex = completedCount + index + 1;
    const description = descriptions.get(originalIndex);
    return description
      ? `Image ${index + 1}: Produce the originally requested Image ${originalIndex}: ${description}`
      : `Image ${index + 1}: Produce the next missing standalone image from my previous request, preserving its original subject, view, references, style, and requirements.`;
  });
  return ensureSeparateCardContract([
    `Create ${remaining} additional separate ${noun} to complete my previous request.`,
    ...outputLines,
    ...(sharedContext ? ["", sharedContext] : []),
    `Return ${remaining === 1 ? "it" : "them"} as ${remaining} separate image output${remaining === 1 ? "" : "s"}.`,
  ].join("\n"), remaining);
}

export const IMAGE_FACTORY_MULTI_IMAGE_PROMPT_TEMPLATE = `Create {N} separate images.
Image 1: {complete description for image 1}
Image 2: {complete description for image 2}
...
Image {N}: {complete description for image N}
Shared constraints: {references, identity, style, composition, quality, and other requirements that apply to every image}
Return them as {N} separate image outputs in one response.
One Image line must map to one standalone generated-image card/file. Produce exactly {N} standalone generated-image cards/files, one for each Image 1 through Image {N}. Each card/file must contain only its own Image i request and must not include any other requested Image j on the same canvas. If the built-in image generator produces one card per invocation, invoke it {N} times before finishing this response. Do NOT combine multiple requested images into a collage, grid, triptych, contact sheet, sprite sheet, or split-screen.`;
