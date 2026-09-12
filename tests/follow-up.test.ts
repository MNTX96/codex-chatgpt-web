import { expect, test } from "bun:test";
import {
  ChatGptFollowUpChannel,
  type ChatGptFollowUpRequest,
} from "../src/adapters/chatgpt-web/follow-up";

function request(revision: number, requestId = `request-${revision}`): ChatGptFollowUpRequest {
  return {
    requestId,
    revision,
    instructionId: revision.toString(16).padStart(64, "0"),
    text: `follow-up ${revision}`,
  };
}

test("follow-up channel dispatches accepted requests FIFO", async () => {
  const channel = new ChatGptFollowUpChannel(1_000);
  const seen: number[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  channel.bind(async item => {
    seen.push(item.revision);
    if (item.revision === 1) await firstGate;
  });

  const first = channel.enqueue(request(1));
  const second = channel.enqueue(request(2));
  await Bun.sleep(0);
  expect(seen).toEqual([1]);

  releaseFirst();
  await Promise.all([first, second]);
  expect(seen).toEqual([1, 2]);
  expect(channel.latestAcceptedRevision()).toBe(2);
  expect(channel.recordEvent({ type: "submitted", requestId: "request-1", revision: 1 })).toBeTrue();
  expect(channel.recordEvent({ type: "submitted", requestId: "request-2", revision: 2 })).toBeTrue();
  expect(channel.hasUnsubmitted()).toBeFalse();
});

test("follow-up enqueue is idempotent but rejects an identity collision", async () => {
  const channel = new ChatGptFollowUpChannel(1_000);
  channel.bind(() => {});
  const item = request(3, "same-request");
  const first = channel.enqueue(item);
  const replay = channel.enqueue({ ...item });
  await Promise.all([first, replay]);
  expect(() => channel.enqueue({ ...item, text: "different" })).toThrow("identity conflicts");
  channel.recordEvent({ type: "submitted", requestId: item.requestId, revision: item.revision });
});

test("a terminal lifecycle event cannot strand the enqueue acknowledgement", async () => {
  const channel = new ChatGptFollowUpChannel(1_000);
  channel.bind(item => {
    expect(channel.recordEvent({
      type: "submitted",
      requestId: item.requestId,
      revision: item.revision,
      conversationUrl: "https://chatgpt.com/c/WEB:test",
    })).toBeTrue();
  });
  const item = request(4);
  await expect(channel.enqueue(item)).resolves.toBeUndefined();
  await expect(channel.waitForTerminal(item)).resolves.toMatchObject({ type: "submitted", revision: 4 });
});

test("follow-up lifecycle rejects stale events after terminal submission", async () => {
  const channel = new ChatGptFollowUpChannel(1_000);
  channel.bind(() => {});
  const item = request(5);
  await channel.enqueue(item);
  expect(channel.recordEvent({ type: "send_activated", requestId: item.requestId, revision: item.revision })).toBeTrue();
  expect(channel.recordEvent({ type: "submitted", requestId: item.requestId, revision: item.revision })).toBeTrue();
  expect(channel.recordEvent({ type: "send_activated", requestId: item.requestId, revision: item.revision })).toBeFalse();
  expect(channel.recordEvent({ type: "rejected", requestId: item.requestId, revision: item.revision, message: "late" })).toBeFalse();
  expect(channel.recordEvent({ type: "submitted", requestId: "unknown", revision: 99 })).toBeFalse();
});

test("follow-up timeout rejects both acceptance and terminal wait without a new-chat fallback", async () => {
  const channel = new ChatGptFollowUpChannel(15);
  const item = request(6);
  const accepted = channel.enqueue(item);
  const terminal = channel.waitForTerminal(item);
  await expect(accepted).rejects.toThrow("0.015 seconds");
  await expect(terminal).resolves.toMatchObject({ type: "rejected", revision: 6 });
  expect(channel.hasUnsubmitted()).toBeFalse();
});

test("closing a retained follow-up channel rejects every unsent request", async () => {
  const channel = new ChatGptFollowUpChannel(1_000);
  const first = request(7);
  const second = request(8);
  const firstAccepted = channel.enqueue(first);
  const secondAccepted = channel.enqueue(second);
  const firstTerminal = channel.waitForTerminal(first);
  const secondTerminal = channel.waitForTerminal(second);
  channel.close(new DOMException("explicit cancel", "AbortError"));

  await expect(firstAccepted).rejects.toThrow("explicit cancel");
  await expect(secondAccepted).rejects.toThrow("explicit cancel");
  await expect(firstTerminal).resolves.toMatchObject({ type: "rejected", message: "explicit cancel" });
  await expect(secondTerminal).resolves.toMatchObject({ type: "rejected", message: "explicit cancel" });
  expect(channel.hasUnsubmitted()).toBeFalse();
});
