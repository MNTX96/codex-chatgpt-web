import { expect, test } from "bun:test";
import { chatGptConversationResponseMetadata } from "../src/adapters/chatgpt-web/browser-network-diagnostics";

test("conversation diagnostics expose only model, effort, HTTP status and byte count", () => {
  const request={method:()=>"POST",postDataJSON:()=>({model:"gpt-6-pro",thinking_effort:"standard",messages:[{content:"PRIVATE-PROMPT"}],authorization:"SECRET"}),postDataBuffer:()=>Buffer.alloc(123)};
  const response={url:()=>"https://chatgpt.com/backend-api/f/conversation?token=PRIVATE-URL",status:()=>200,request:()=>request} as any;
  const result=chatGptConversationResponseMetadata(response);
  expect(result).toEqual({status:200,requestBytes:123,model:"gpt-6-pro",thinkingEffort:"standard",reasoningEffort:undefined});
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET/);
  response.url=()=>"https://example.com/backend-api/f/conversation";
  expect(chatGptConversationResponseMetadata(response)).toBeUndefined();
  response.url=()=>"https://chatgpt.com/backend-api/f/conversation";
  request.method=()=>"GET";
  expect(chatGptConversationResponseMetadata(response)).toBeUndefined();
});
