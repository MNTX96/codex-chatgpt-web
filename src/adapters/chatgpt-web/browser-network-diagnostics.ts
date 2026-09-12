import type { Page, Response } from "playwright-core";

const field = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;

/** Whitelist metadata only: never return request headers, prompts, attachments, or signed URLs. */
export function chatGptConversationResponseMetadata(response: Pick<Response,"url"|"status"|"request">) {
  const url = new URL(response.url());
  if (url.origin !== "https://chatgpt.com" || !["/backend-api/f/conversation","/backend-api/conversation"].includes(url.pathname)) return undefined;
  const request = response.request();
  if (request.method() !== "POST") return undefined;
  let body: Record<string,unknown> | undefined;
  try { body=request.postDataJSON() as Record<string,unknown> | undefined; } catch {}
  return {
    status:response.status(), requestBytes:request.postDataBuffer()?.byteLength,
    model:field(body?.model), thinkingEffort:field(body?.thinking_effort), reasoningEffort:field(body?.reasoning_effort),
  };
}

/** Observability must neither change the request nor become a reason for a browser turn to fail. */
export function observeChatGptConversationResponses(page: Page, traceId: string): () => void {
  if (typeof page.on !== "function") return () => {};
  const observe = (response: Response) => {
    try {
      const metadata=chatGptConversationResponseMetadata(response);
      if(metadata) console.info(`[chatgpt-web] conversation_response ${JSON.stringify({traceId,...metadata})}`);
    } catch {}
  };
  page.on("response",observe);
  return () => { try { page.off("response",observe); } catch {} };
}
