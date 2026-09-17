import { expect, test } from "bun:test";
import {
  ChatGptGenerationCoordinator,
  ChatGptGenerationLease,
  MAX_CHATGPT_BROWSER_TABS,
} from "../src/adapters/chatgpt-web/concurrency";

test("keeps five browser tabs available while serializing active generations", async () => {
  expect(MAX_CHATGPT_BROWSER_TABS).toBe(5);

  const coordinator = new ChatGptGenerationCoordinator();
  const firstRelease = await coordinator.acquire("normal");
  const second = coordinator.acquire("normal");

  await Promise.resolve();
  expect(coordinator.activeCount).toBe(1);
  expect(coordinator.queuedCount).toBe(1);

  firstRelease();
  const secondRelease = await second;
  expect(coordinator.activeCount).toBe(1);
  expect(coordinator.queuedCount).toBe(0);

  secondRelease();
  expect(coordinator.activeCount).toBe(0);
});

test("removes an aborted queued generation without blocking the next turn", async () => {
  const coordinator = new ChatGptGenerationCoordinator();
  const firstRelease = await coordinator.acquire("normal");
  const abortController = new AbortController();
  const queued = coordinator.acquire("normal", abortController.signal);
  const abortReason = new Error("cancel queued generation");

  abortController.abort(abortReason);
  await expect(queued).rejects.toBe(abortReason);
  expect(coordinator.queuedCount).toBe(0);

  firstRelease();
  const nextRelease = await coordinator.acquire("normal");
  expect(coordinator.activeCount).toBe(1);
  nextRelease();
  expect(coordinator.activeCount).toBe(0);
});

test("prioritizes retries queued behind an active generation", async () => {
  const coordinator = new ChatGptGenerationCoordinator();
  const activeRelease = await coordinator.acquire("normal");
  const order: string[] = [];

  const normal = coordinator.acquire("normal").then(release => {
    order.push("normal");
    release();
  });
  const retry = coordinator.acquire("retry").then(release => {
    order.push("retry");
    release();
  });

  activeRelease();
  await Promise.all([normal, retry]);
  expect(order).toEqual(["retry", "normal"]);
});

test("bounds retry priority so normal work cannot starve", async () => {
  const coordinator = new ChatGptGenerationCoordinator({ maxConsecutiveRetryGrants: 2 });
  const activeRelease = await coordinator.acquire("normal");
  const order: string[] = [];

  const run = (name: string, priority: "normal" | "retry") => coordinator.acquire(priority).then(release => {
    order.push(name);
    release();
  });

  const normal = run("normal", "normal");
  const retry1 = run("retry-1", "retry");
  const retry2 = run("retry-2", "retry");
  const retry3 = run("retry-3", "retry");

  activeRelease();
  await Promise.all([normal, retry1, retry2, retry3]);
  expect(order).toEqual(["retry-1", "retry-2", "normal", "retry-3"]);
});

test("generation lease releases idempotently after terminal cleanup", async () => {
  const coordinator = new ChatGptGenerationCoordinator();
  const first = new ChatGptGenerationLease("normal", coordinator);
  const second = new ChatGptGenerationLease("normal", coordinator);

  await first.acquire();
  const secondAcquire = second.acquire();
  await Promise.resolve();
  expect(coordinator.activeCount).toBe(1);
  expect(coordinator.queuedCount).toBe(1);

  first.release();
  first.release();
  await secondAcquire;
  expect(second.acquired).toBe(true);
  expect(coordinator.activeCount).toBe(1);

  second.release();
  expect(coordinator.activeCount).toBe(0);
});
