import type { Locator, Page } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

export const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|太多要求|太多请求|リクエストが多すぎます/i })
  .filter({ hasText: /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const historyDialog = page.locator('[data-testid="modal-conversation-history-rate-limit"]').last();
  const dialog = await historyDialog.isVisible().catch(() => false)
    ? historyDialog
    : chatGptRateLimitDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return;

  const acknowledge = dialog.getByRole("button", { name: /^(Got it|知道了|了解)$/ }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter", { timeout: 1000 });
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate limit: too many requests, and the dialog could not be dismissed (${error instanceof Error ? error.message : String(error)}). Try again in a few minutes.`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
      );
    }
  }
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests. Try again in a few minutes.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
  );
}

/** Stop pending navigation as soon as ChatGPT displays a rate-limit modal. */
export async function withChatGptNavigationGuard<T>(
  page: Page,
  action: (signal: AbortSignal) => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  abortSignal?.throwIfAborted();
  await throwIfChatGptRateLimitDialog(page);
  const controller = new AbortController();
  const signal = abortSignal ? AbortSignal.any([controller.signal, abortSignal]) : controller.signal;
  const watch = async (dialog: Locator): Promise<never> => {
    await dialog.waitFor({ state: "visible", timeout: 60_000, signal });
    // Report first. The owner must cancel a pending click before dismissing its blocking modal.
    throw new ChatGptWebAdapterError(
      "ChatGPT rate limit: too many requests. Try again in a few minutes.",
      { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
    );
  };
  try {
    const result = await Promise.race([
      watch(page.locator('[data-testid="modal-conversation-history-rate-limit"]').last()),
      watch(chatGptRateLimitDialog(page)),
      action(signal),
    ]);
    await throwIfChatGptRateLimitDialog(page);
    return result;
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) {
      controller.abort();
      await throwIfChatGptRateLimitDialog(page).catch(() => {});
      throw error;
    }
    await throwIfChatGptRateLimitDialog(page);
    throw error;
  } finally {
    controller.abort();
  }
}
