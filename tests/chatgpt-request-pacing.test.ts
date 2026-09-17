import { expect, test } from "bun:test";
import {
  ChatGptRequestPacer,
  DEFAULT_CHATGPT_PACING_INTERVALS_MS,
  retryAfterDelayMs,
} from "../src/chatgpt-request-pacing";

test("uses the minimum account pacing policy for production traffic", () => {
  expect(DEFAULT_CHATGPT_PACING_INTERVALS_MS).toEqual({
    browser_tab: 1_500,
    browser_navigation: 3_000,
    browser_reload: 5_000,
    browser_submit: 15_000,
    native_api: 15_000,
  });
});

test("paces concurrent ChatGPT actions through one process-wide schedule", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const pacer = new ChatGptRequestPacer({
    intervalsMs: {
      browser_tab: 100,
      browser_navigation: 100,
      browser_reload: 100,
      browser_submit: 100,
      native_api: 100,
    },
    jitterMs: 0,
    now: () => now,
    random: () => 0,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });

  await Promise.all([
    pacer.wait("native_api"),
    pacer.wait("browser_submit"),
    pacer.wait("browser_navigation"),
  ]);

  expect(sleeps).toEqual([0, 100, 100]);
  expect(now).toBe(200);
});

test("429 cooldown blocks later work and preserves spacing after recovery", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const pacer = new ChatGptRequestPacer({
    intervalsMs: { native_api: 100, browser_submit: 100 },
    jitterMs: 0,
    rateLimitCooldownMinMs: 600,
    rateLimitCooldownMaxMs: 600,
    now: () => now,
    random: () => 0,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });

  await pacer.wait("native_api");
  const cooldown = pacer.noteRateLimit(900);
  expect(cooldown).toEqual({ cooldownMs: 900, until: 900 });

  await pacer.wait("browser_submit");
  await pacer.wait("native_api");

  expect(sleeps).toEqual([0, 900, 100]);
  expect(now).toBe(1_000);
});

test("Retry-After supports both seconds and HTTP dates", () => {
  expect(retryAfterDelayMs("12", 1_000)).toBe(12_000);
  expect(retryAfterDelayMs("Thu, 01 Jan 1970 00:00:11 GMT", 1_000)).toBe(10_000);
  expect(retryAfterDelayMs("invalid", 1_000)).toBe(0);
});
