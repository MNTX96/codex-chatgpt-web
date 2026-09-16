import { z } from "zod";
import { createHash } from "node:crypto";
import type { OutputImageArtifact } from "../artifacts/types";
import { IMAGE_FACTORY_MULTI_IMAGE_PROMPT_TEMPLATE } from "./prompt-template";

export type ChatExecutionTarget =
  | { output: "text"; surface: "temporary" }
  | { output: "image"; surface: "persistent"; projectId: string; imageSessionId: string };

export const IMAGE_TOOL_NAMES = ["chatgpt_image_generate", "chatgpt_image_edit", "chatgpt_image_wait", "chatgpt_image_cancel", "chatgpt_image_reconcile"] as const;
export type ImageToolName = typeof IMAGE_TOOL_NAMES[number];
export const isImageTool = (name: string): name is ImageToolName => (IMAGE_TOOL_NAMES as readonly string[]).includes(name);

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const imageCount = z.number().int().min(1).max(4).default(1);
export const imageGenerateSchema = z.object({
  request_id: id,
  prompt: z.string().trim().min(1).max(100_000),
  reference_image_paths: z.array(z.string().min(1).max(4096)).max(10).optional(),
  image_session_id: id.optional(),
  count: imageCount,
}).strict();
export const imageEditSchema = z.object({
  request_id: id,
  image_session_id: id,
  source_artifact_id: id,
  prompt: z.string().trim().min(1).max(100_000),
  count: imageCount,
}).strict();
export const imageJobSchema = z.object({ job_id: id }).strict();
export type ImageGenerateInput = z.infer<typeof imageGenerateSchema>;
export type ImageEditInput = z.infer<typeof imageEditSchema>;
export type ImageFactoryInput = ImageGenerateInput | ImageEditInput;
export type ImageFactoryOperation = "generate" | "edit";
export type ImageJobPhase = "prepared" | "submitting" | "submitted" | "observing" | "downloading" | "terminal";
export interface ImageJobCandidateError {
  candidateKey: string;
  code: string;
  attempt?: number;
}
export interface ImageJobSubmission {
  id: string;
  attempt: number;
  requestedCount: number;
  generatedCount: number;
  downloadedCount: number;
  assistantTurnId?: string;
  candidateKeys: string[];
  excessCandidateKeys: string[];
  failures: ImageJobCandidateError[];
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
}
export interface ImageJobResult {
  jobId: string;
  imageSessionId: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  requestedCount: number;
  generatedCount: number;
  downloadedCount: number;
  attemptCount: number;
  artifacts: OutputImageArtifact[];
  candidateErrors?: ImageJobCandidateError[];
  submissions?: ImageJobSubmission[];
  sourceArtifactId?: string;
  manifestPath?: string;
  text?: string;
  error?: { code: string; message: string; status?: number; errorType?: string; retryable?: boolean };
}

export class ImageFactoryError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "ImageFactoryError"; }
}

export const IMAGE_FACTORY_TIMEOUTS = {
  setup: 150_000,
  generation: 600_000,
  download: 60_000,
  downloadJob: 240_000,
  job: 2_790_000,
  wait: 20_000,
  settle: 2_000,
  maxSubmissions: 4,
} as const;

/** Exact integration entrypoints, never prompt/description keyword matching. */
export const NATIVE_IMAGE_TOOLS = new Set([
  "image_gen__imagegen", "image_gen.imagegen", "image_gen_imagegen", "imagegen", "image_generation",
]);
export function assertWebImageToolRouting(name: string): void {
  if (NATIVE_IMAGE_TOOLS.has(name)) throw new ImageFactoryError("native_image_tool_disabled", "Use chatgpt_image_generate through codex_tool_call for ChatGPT Web image generation.");
}

const schemaFor = (name: ImageToolName) => z.toJSONSchema(
  name === "chatgpt_image_generate"
    ? imageGenerateSchema
    : name === "chatgpt_image_edit"
      ? imageEditSchema
      : imageJobSchema,
);
export function imageToolInventory() {
  return IMAGE_TOOL_NAMES.map(name => ({
    wire_name: name, name, namespace: null, kind: "function",
    description: name === "chatgpt_image_generate"
      ? `Generate 1-4 actual images in ChatGPT Web Image Factory. Set count to the exact number of separate images requested; values outside 1-4 are rejected. For count > 1, make prompt explicit with one concrete "Image i:" description per requested output so ChatGPT can generate all outputs in one response. Canonical shape:\n${IMAGE_FACTORY_MULTI_IMAGE_PROMPT_TEMPLATE}\nReturns a job_id quickly. Reuse request_id only for retries of the same request. Pass image_session_id only to continue the same generation conversation. Reference paths must be readable workspace files. Poll chatgpt_image_wait until terminal; images and metadata are saved in the task workspace.`
      : name === "chatgpt_image_edit"
        ? "Edit one previously saved Image Factory artifact into 1-4 variants in its existing ChatGPT conversation. source_artifact_id must be an artifact owned by image_session_id with stored provenance. Returns a job_id quickly; poll chatgpt_image_wait until terminal."
      : name === "chatgpt_image_wait"
        ? "Wait up to 20 seconds for an Image Factory job. A running result is not completion; poll again. Completed results contain local image paths and imageSessionId for later edits."
        : name === "chatgpt_image_reconcile"
          ? "Observe and re-download only already-created cards of this task's saved Image Factory job. Never sends a generation/edit prompt. Unknown submission identity remains an explicit blocker."
          : "Cancel an Image Factory job owned by this task. Does not delete ChatGPT history or completed artifacts.",
    parameters: schemaFor(name),
  }));
}

/** Hash the loaded public Image Factory schemas. */
export function imageToolSchemaHashes(): Record<string, string> {
  return Object.fromEntries(imageToolInventory().map(tool => [tool.name,
    createHash("sha256").update(JSON.stringify(tool.parameters)).digest("hex")]));
}

export const IMAGE_FACTORY_PROMPT_RULE = `For image generation, use codex_tool_call with wire_name chatgpt_image_generate and pass count exactly as requested (1-4; do not silently clamp larger requests). When count > 1, build prompt with exactly one concrete Image 1: through Image N: description and explicitly require N separate image outputs in one response; never ask for a collage, grid, triptych, contact sheet, sprite sheet, or split-screen unless the user requested that layout. Shared identity/reference/style constraints may be stated once after the per-image descriptions. For edits of a saved Image Factory artifact, use chatgpt_image_edit with image_session_id and source_artifact_id. Keep request_id stable on retries. Poll chatgpt_image_wait while status is running. Use reference_image_paths for local generation references. Do not call native Codex ImageGen. Your text/vision conversation remains Temporary Chat; the tools run a separate Regular Chat in Image Factory. Never claim success before the tool returns saved artifact paths.`;
