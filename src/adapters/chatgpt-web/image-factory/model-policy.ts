import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
} from "../model";

export type ImageFactoryReasoning = "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageFactoryModelPolicy {
  modelId: typeof CHATGPT_WEB_MODEL_ID | typeof CHATGPT_WEB_LUNA_MODEL_ID;
  reasoning: ImageFactoryReasoning;
}

/** Image Factory inherits the exact automatic ChatGPT model/effort selected by its parent turn. */
export function resolveImageFactoryModelPolicy(
  capabilities: ChatGptWebCapabilities,
  parentModelId: string,
  parentReasoning?: string,
): ImageFactoryModelPolicy {
  if (parentModelId !== CHATGPT_WEB_MODEL_ID && parentModelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`Image Factory cannot inherit unsupported parent model: ${parentModelId}`);
  }
  const mode = resolveChatGptWebModelMode(parentModelId, parentReasoning, capabilities);
  return { modelId: parentModelId, reasoning: mode.effort };
}
