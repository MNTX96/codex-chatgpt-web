import { expect, test } from "bun:test";
import type { Page, Response } from "playwright-core";
import { observeChatGptConversationResponses } from "../src/adapters/chatgpt-web/browser-network-diagnostics";

function response(status: number, headers: Record<string, string> = {}): Response {
  return {
    url: () => "https://chatgpt.com/backend-api/f/conversation",
    status: () => status,
    headers: () => headers,
    request: () => ({
      method: () => "POST",
      postDataJSON: () => ({ model: "gpt-test" }),
      postDataBuffer: () => Buffer.from("{}"),
    }),
  } as unknown as Response;
}

test("a browser conversation HTTP 429 arms the shared rate-limit cooldown even without a modal", () => {
  let responseListener: ((value: Response) => void) | undefined;
  const page = {
    on: (event: string, listener: (value: Response) => void) => {
      if (event === "response") responseListener = listener;
    },
    off: () => {},
  } as unknown as Page;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    observeChatGptConversationResponses(page, "image-429-test");
    responseListener?.(response(429, { "retry-after": "75" }));
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings.some(line => (
    line.includes("conversation_rate_limit_cooldown")
    && line.includes('"cooldownMs":75000')
  ))).toBe(true);
});
