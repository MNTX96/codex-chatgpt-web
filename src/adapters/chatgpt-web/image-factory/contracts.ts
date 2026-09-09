import { z } from "zod";
import type { OutputImageArtifact } from "../artifacts/types";

export type ChatExecutionTarget =
  | { output: "text"; surface: "temporary" }
  | { output: "image"; surface: "persistent"; projectId: string; imageSessionId: string };

export const IMAGE_TOOL_NAMES = ["chatgpt_image_generate", "chatgpt_image_wait", "chatgpt_image_cancel"] as const;
export type ImageToolName = typeof IMAGE_TOOL_NAMES[number];
export const isImageTool = (name: string): name is ImageToolName => (IMAGE_TOOL_NAMES as readonly string[]).includes(name);

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const imageGenerateSchema = z.object({
  request_id: id,
  prompt: z.string().trim().min(1).max(100_000),
  reference_image_paths: z.array(z.string().min(1).max(4096)).max(10).optional(),
  image_session_id: id.optional(),
}).strict();
export const imageJobSchema = z.object({ job_id: id }).strict();
export type ImageGenerateInput = z.infer<typeof imageGenerateSchema>;
export type ImageJobPhase = "prepared" | "submitting" | "submitted" | "observing" | "downloading" | "terminal";
export interface ImageJobResult {
  jobId: string;
  imageSessionId: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  artifacts: OutputImageArtifact[];
  manifestPath?: string;
  text?: string;
  error?: { code: string; message: string };
}

export class ImageFactoryError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "ImageFactoryError"; }
}

export const IMAGE_FACTORY_TIMEOUTS = { setup: 150_000, generation: 600_000, download: 60_000, wait: 20_000, settle: 2_000 } as const;

/** Exact integration entrypoints, never prompt/description keyword matching. */
export const NATIVE_IMAGE_TOOLS = new Set([
  "image_gen__imagegen", "image_gen.imagegen", "image_gen_imagegen", "imagegen", "image_generation",
]);
export function assertWebImageToolRouting(name: string): void {
  if (NATIVE_IMAGE_TOOLS.has(name)) throw new ImageFactoryError("native_image_tool_disabled", "Use chatgpt_image_generate through codex_tool_call for ChatGPT Web image generation.");
}

const schemaFor = (name: ImageToolName) => z.toJSONSchema(name === "chatgpt_image_generate" ? imageGenerateSchema : imageJobSchema);
export function imageToolInventory() {
  return IMAGE_TOOL_NAMES.map(name => ({
    wire_name: name, name, namespace: null, kind: "function",
    description: name === "chatgpt_image_generate"
      ? "Generate or edit an actual image in ChatGPT Web Image Factory. Returns a job_id quickly. Reuse request_id only for retries of the same request. Pass image_session_id from an earlier result for follow-up edits; omit for a new image series. Reference paths must be readable workspace files. Poll chatgpt_image_wait until terminal; images and metadata are saved in the task workspace."
      : name === "chatgpt_image_wait"
        ? "Wait up to 20 seconds for an Image Factory job. A running result is not completion; poll again. Completed results contain local image paths and imageSessionId for later edits."
        : "Cancel an Image Factory job owned by this task. Does not delete ChatGPT history or completed artifacts.",
    parameters: schemaFor(name),
  }));
}

export const IMAGE_FACTORY_PROMPT_RULE = "For image generation or editing, use codex_tool_call with wire_name chatgpt_image_generate and the schema exposed by the bridge image-tool inventory. Keep request_id stable on retries. Poll chatgpt_image_wait while status is running. Use the returned imageSessionId as image_session_id for follow-up edits. Use reference_image_paths for local reference images. Do not call native Codex ImageGen. Your text/vision conversation remains Temporary Chat; the tool runs a separate Regular Chat in Image Factory. Never claim success before the tool returns saved artifact paths.";
