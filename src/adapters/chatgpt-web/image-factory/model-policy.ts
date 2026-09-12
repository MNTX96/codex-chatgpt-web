import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../model";

export type ImageFactoryReasoning = "medium" | "high" | "xhigh" | "max";

export interface ImageFactoryModelPolicy {
  modelId: typeof CHATGPT_WEB_MODEL_ID | typeof CHATGPT_WEB_LUNA_MODEL_ID;
  reasoning: ImageFactoryReasoning;
}

/**
 * Image Factory always uses ChatGPT's latest automatic model route and never submits with
 * Instant/low reasoning. A higher configured default is preserved when the account supports it.
 */
export function resolveImageFactoryModelPolicy(
  capabilities: ChatGptWebCapabilities,
  configuredReasoning?: string,
): ImageFactoryModelPolicy {
  if (!capabilities.solAvailable) {
    // Luna exposes Think as its medium mode. This is the strongest non-Instant route available on
    // Luna-only accounts and keeps Image Factory's minimum-thinking contract intact.
    return { modelId: CHATGPT_WEB_LUNA_MODEL_ID, reasoning: "medium" };
  }

  if (configuredReasoning === "max" && capabilities.proAvailable) {
    return { modelId: CHATGPT_WEB_MODEL_ID, reasoning: "max" };
  }
  if (configuredReasoning === "xhigh" && capabilities.proAvailable) {
    return { modelId: CHATGPT_WEB_MODEL_ID, reasoning: "xhigh" };
  }
  if (configuredReasoning === "high") {
    return { modelId: CHATGPT_WEB_MODEL_ID, reasoning: "high" };
  }

  return { modelId: CHATGPT_WEB_MODEL_ID, reasoning: "medium" };
}
