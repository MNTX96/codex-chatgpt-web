import { NATIVE_AUTHORITY_PROTOCOL, NativeBrowserAuthority, type NativeBindingSpec, type NativeImageReconcile } from "./native-authority";
import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { chatGptRateLimitDialog, throwIfChatGptRateLimitDialog, withChatGptNavigationGuard } from "./rate-limit";
import { observeChatGptConversationResponses } from "./browser-network-diagnostics";
export { throwIfChatGptRateLimitDialog } from "./rate-limit";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  DEV_CHATGPT_CONNECTOR_NAME,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { OutputImageAdapter } from "./artifacts/image/output-image-adapter";
import { assertLauncherImageDownloadSupport } from "./artifacts/image/download-transaction";
import { openBoundImageViewer } from "./artifacts/image/image-viewer";
import { attachPromptFiles, clearPromptAttachments, type AttachmentGuard } from "./file-attachments";
import { ImageTransferDeadline, imageTransferLog, type ImageTransferLog } from "./image-transfer";
import { CHATGPT_GENERATED_IMAGE_CARD_SELECTOR, detectOutputImages, outputImageSignature } from "./artifacts/image/image-detector";
import { sniffImageMime } from "./artifacts/image/image-sniffer";
import type { OutputArtifact, OutputArtifactTarget, OutputImageCaptureResult, OutputImageSource } from "./artifacts/types";
import {
  ChatGptMarkdownBuffer,
  ChatGptMarkdownConsistencyError,
  type ChatGptMarkdownSegment,
} from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  compiledChatGptWebMaxMessageChars,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  formatChatGptWebMultipartCommit,
  assertChatGptMultipartContextAvailable,
  formatChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
  type ChatGptWebPromptImage,
  type ChatGptWebMultipartStage,
} from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  assertPersistentChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
  activateChatGptEffortMenu,
  detectChatGptAccountCapabilities,
  parseChatGptEffortSliderState,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptRetainedConversationUnavailableError,
  chatGptStoppedThinkingError,
} from "./adapter-error";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  chatGptExternalProgressIsLive,
  chatGptExternalToolCallsAreInFlight,
} from "./turn-progress";
import type {
  ChatGptExternalTurnProgressSnapshot,
  ChatGptTurnProgressReader,
} from "./turn-progress";
import {
  ensureImageFactoryProject,
  type ImageFactoryProjectLog,
  type ImageFactoryProjectUi,
} from "./image-factory/project-manager";
import type { ImageFactoryStore } from "./image-factory/state";
import type { ChatExecutionTarget } from "./image-factory/contracts";
import type { ChatGptFollowUpChannel, ChatGptFollowUpRequest } from "./follow-up";
import {
  IMAGE_FACTORY_PROJECT_NAME,
  imageFactoryPageBelongsToProject,
  isImageFactoryProjectRow,
  openImageFactoryProject,
  prepareProjectDirectory,
  readProjectRowLabel,
  waitForImageFactoryConversationUrl,
} from "./image-factory/project-navigation";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();
let activeChatGptBrowserTurns = 0;

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
const CHATGPT_CREATE_IMAGE_MENU_TEXT = "Create image";
const CHATGPT_IMAGE_MENTION_QUERY = "@image";
const CHATGPT_CREATE_IMAGE_PILL_SELECTOR = [
  '[data-inline-selection-pill]',
  '[data-id="picture_v2"]',
  '[data-symbol="ecosystemMention"]',
  '[data-system-hint-type="picture_v2"]',
].join("");

/** Shared across provider workers so an Image Factory child cannot bypass the five-tab limit. */
export function chatGptBrowserCapacityAvailable(reservations = 0): boolean {
  return activeChatGptBrowserTurns + reservations < MAX_CHATGPT_BROWSER_TABS;
}

function shortImageFactoryId(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 12)}…` : undefined;
}

function imageFactoryPageLocation(page: Page): string | undefined {
  try {
    const url = new URL(page.url());
    if (url.protocol !== "https:" && url.protocol !== "http:") return url.protocol;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function imageFactoryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

function imageFactorySetupLog(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  console.info(`[chatgpt-web] image-factory.setup ${event} ${JSON.stringify(fields)}`);
}
/**
 * How long a staged Bigger Context part may take to produce its assistant turn. A staged part is two
 * orders of magnitude larger than an ordinary prompt and ChatGPT reads all of it before answering.
 * No MCP activity exists while that inert part is being ingested, so the response grace matches
 * the bounded staged-send budget.
 */
export const CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS = 180_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_MULTI_IMAGE_HYDRATION_GRACE_MS = 8_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
export const MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS = 3;
const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";
const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;

const CHATGPT_DOM_REVISION_ATTRIBUTES = [
  "aria-hidden",
  "aria-label",
  "aria-busy",
  "aria-disabled",
  "aria-expanded",
  "class",
  "data-item-anchor",
  "data-is-last-node",
  "data-message-author-role",
  "data-state",
  "data-streaming-response-status",
  "data-testid",
  "data-turn",
  "data-turn-id",
  "data-turn-id-container",
  "disabled",
  "hidden",
  "inert",
  "open",
  "role",
  "start",
  "style",
] as const;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

interface ChatGptConnectorAttemptBudget {
  triggerAttempts: number;
}

function chatGptConnectorUnavailableError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
}

const CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE = "ChatGPT model controls are unavailable. The next prompt was not sent. Verify the model and thinking setting in ChatGPT, then retry.";
const CHATGPT_ACCOUNT_LIMIT_MINI_FALLBACK = /\bGPT[\s-]*5(?:\.5)?[\s-]*mini\b/i;

function chatGptModelControlUnavailableError(diagnostic: string): Error {
  return chatGptModelControlUnavailableAdapterError(diagnostic);
}

function chatGptModelControlUnavailableAdapterError(diagnostic: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE,
    {
      status: 502,
      errorType: "server_error",
      code: "model_controls_unavailable",
      retryable: false,
      cause: new Error(diagnostic),
    },
  );
}

export type ChatGptPersonalizationPreflight = "already-personalized" | "enabled";

const CHATGPT_PERSONALIZATION_CONTROL_SELECTOR = [
  '[data-testid="thread-header-right-actions"] [aria-haspopup="menu"]',
  '#conversation-header-actions [aria-haspopup="menu"]',
  '[data-content-sheet-root] > button[aria-expanded][aria-controls]',
].join(", ");
const CHATGPT_PERSONALIZATION_CHOICE_SELECTOR = '[role="menuitemradio"], [role="radio"]';
const CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS = 30_000;
const CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS = 5_000;

class ChatGptPersonalizationDeadlineError extends Error {
  constructor() {
    super("ChatGPT personalization preflight exceeded its readiness deadline");
    this.name = "ChatGptPersonalizationDeadlineError";
  }
}

class ChatGptPersistentBrowserStateError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "ChatGptPersistentBrowserStateError";
  }
}

function remainingChatGptPersonalizationMs(deadline: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ChatGptPersonalizationDeadlineError();
  return remaining;
}

async function runChatGptPersonalizationStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = remainingChatGptPersonalizationMs(deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withBrowserTurnAbort(Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptPersonalizationDeadlineError()), timeoutMs);
      }),
    ]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mutating personalization work owns its AbortSignal and must settle its cleanup before the caller
 * can observe cancellation. Unlike observation races, returning early here could release the page
 * while a rollback or composer clear was still running against the persistent browser profile.
 */
async function runChatGptPersonalizationOwnedStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  remainingChatGptPersonalizationMs(deadline, signal);
  const result = await operation();
  remainingChatGptPersonalizationMs(deadline, signal);
  return result;
}

async function waitForChatGptPersonalizationPoll(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return;
  }
  if (signal.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("ChatGPT personalization preflight aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runChatGptPersonalizationCleanup<T>(
  operation: (deadline: number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  try {
    return await operation(deadline, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pressChatGptPersonalizationEscape(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  await page.locator("body").press("Escape", {
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
}

async function dismissChatGptPersonalizationMenu(page: Page): Promise<void> {
  await runChatGptPersonalizationCleanup((deadline, signal) => (
    pressChatGptPersonalizationEscape(page, deadline, signal)
  ));
}

async function waitForChatGptOwnedPersonalizationMenu(
  page: Page,
  control: Locator,
  deadline: number,
  signal?: AbortSignal,
): Promise<Locator> {
  let menuId: string | null = null;
  while (!menuId) {
    const remaining = remainingChatGptPersonalizationMs(deadline, signal);
    menuId = await control.getAttribute("aria-controls", { timeout: remaining, signal });
    if (!menuId) await waitForChatGptPersonalizationPoll(Math.min(50, remaining), signal);
  }
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  try {
    await menu.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization control did not expose its owned menu before the readiness deadline",
    );
  }
  return menu;
}

type ChatGptPersonalizationChoiceIndex = 0 | 1;

interface ChatGptPersonalizationState {
  menu: Locator;
  choices: Locator;
  checkedIndex: ChatGptPersonalizationChoiceIndex;
}

interface ChatGptPersonalizationToggleReceipt {
  originalIndex: ChatGptPersonalizationChoiceIndex;
}

async function readChatGptPersonalizationCheckedIndex(
  choices: Locator,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationChoiceIndex> {
  const checked: boolean[] = [];
  for (let index = 0; index < 2; index += 1) {
    const choice = choices.nth(index);
    const ariaChecked = await choice.getAttribute("aria-checked", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    const dataState = await choice.getAttribute("data-state", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    checked.push(ariaChecked === "true" || dataState === "checked");
  }
  if (checked.filter(Boolean).length !== 1) {
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization menu did not expose one checked state",
    );
  }
  return checked[0] ? 0 : 1;
}

async function openChatGptStructuralPersonalizationState(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationState> {
  const controls = page.locator(CHATGPT_PERSONALIZATION_CONTROL_SELECTOR).filter({ visible: true });
  const control = controls.first();
  try {
    await control.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT Temporary Chat did not expose a structural personalization control before the readiness deadline",
    );
  }
  const controlCount = await runChatGptPersonalizationStep(() => controls.count(), deadline, signal);
  if (controlCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT Temporary Chat exposed ${controlCount} structural personalization controls; expected exactly one`,
    );
  }
  await control.click({
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
  const menu = await waitForChatGptOwnedPersonalizationMenu(page, control, deadline, signal);
  const choices = menu.locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR).filter({ visible: true });
  if (await runChatGptPersonalizationStep(() => choices.count(), deadline, signal) !== 2) {
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization menu did not expose exactly two checkable states",
    );
  }
  return {
    menu,
    choices,
    checkedIndex: await readChatGptPersonalizationCheckedIndex(choices, deadline, signal),
  };
}

async function restoreChatGptPersonalizationChoice(
  page: Page,
  receipt: ChatGptPersonalizationToggleReceipt,
): Promise<void> {
  await runChatGptPersonalizationCleanup(async (deadline, signal) => {
    await pressChatGptPersonalizationEscape(page, deadline, signal);
    let state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex === receipt.originalIndex) {
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      return;
    }
    await state.choices.nth(receipt.originalIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);

    state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex !== receipt.originalIndex) {
      throw new Error("ChatGPT personalization rollback did not restore the original checked state");
    }
    await pressChatGptPersonalizationEscape(page, deadline, signal);
  });
}

async function toggleChatGptPersonalizationChoice(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationToggleReceipt> {
  let receipt: ChatGptPersonalizationToggleReceipt | undefined;
  try {
    const state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    receipt = { originalIndex: state.checkedIndex };
    const nextIndex: ChatGptPersonalizationChoiceIndex = state.checkedIndex === 0 ? 1 : 0;
    await state.choices.nth(nextIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await runChatGptPersonalizationStep(settleChatGptUi, deadline, signal);
    return receipt;
  } catch (error) {
    try {
      if (receipt) await restoreChatGptPersonalizationChoice(page, receipt);
      else await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT personalization change failed and its original state could not be restored",
      );
    }
    throw error;
  }
}

async function ensureChatGptPersonalizedConnectorAccessWithinDeadline(
  page: Page,
  deadline: number,
  abortSignal: AbortSignal,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
): Promise<ChatGptPersonalizationPreflight> {
  const capture = async (checkpoint: string): Promise<void> => {
    if (!captureDiagnostic) return;
    await runChatGptPersonalizationStep(() => captureDiagnostic(checkpoint), deadline, abortSignal);
  };
  const proveConnectorAccess = async (): Promise<boolean> => {
    if (!proveConfiguredConnectorAccess) return false;
    return runChatGptPersonalizationOwnedStep(
      () => proveConfiguredConnectorAccess(abortSignal),
      deadline,
      abortSignal,
    );
  };
  // The visible sheet can be aria-hidden during hydration. Include those controls in the role
  // query but still require visibility; never select a hidden duplicate or switch locator rules.
  const personalized = page
    .getByRole("button", { name: /^(?:Personalized|个性化)$/, exact: true, includeHidden: true })
    .filter({ visible: true });
  const unpersonalized = page
    .getByRole("button", { name: /^(?:Unpersonalized|非个性化)$/, exact: true, includeHidden: true })
    .filter({ visible: true });
  let personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
  let unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
  if (personalizedCount === 0 && unpersonalizedCount === 0) {
    await runChatGptPersonalizationStep(settleChatGptUi, deadline, abortSignal);
    personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
    unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
    if (personalizedCount === 0 && unpersonalizedCount === 0) {
      if (!proveConfiguredConnectorAccess) {
        await capture("personalization-control-missing");
        throw chatGptConnectorUnavailableError(
          "ChatGPT Temporary Chat did not expose a verifiable personalization control",
        );
      }
      if (await proveConnectorAccess()) {
        await capture("personalization-already-enabled");
        return "already-personalized";
      }
      await capture("personalization-unpersonalized");
      const toggleReceipt = await toggleChatGptPersonalizationChoice(page, deadline, abortSignal);
      try {
        if (await proveConnectorAccess()) {
          await capture("personalization-enabled");
          return "enabled";
        }
      } catch (error) {
        try {
          await restoreChatGptPersonalizationChoice(page, toggleReceipt);
        } catch (restoreError) {
          throw new ChatGptPersistentBrowserStateError(
            [error, restoreError],
            "ChatGPT personalization proof failed and the original state could not be restored",
          );
        }
        throw error;
      }
      try {
        await restoreChatGptPersonalizationChoice(page, toggleReceipt);
      } catch (restoreError) {
        throw new ChatGptPersistentBrowserStateError(
          [restoreError],
          "ChatGPT personalization changed but connector access was not proven and the original state could not be restored",
        );
      }
      throw chatGptConnectorUnavailableError(
        "The configured ChatGPT connector remained unavailable after the structural personalization state changed",
      );
    }
  }
  if (personalizedCount === 1 && unpersonalizedCount === 0) {
    await capture("personalization-already-enabled");
    return "already-personalized";
  }
  if (personalizedCount !== 0 || unpersonalizedCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT exposed an invalid Temporary Chat personalization state`
      + ` (personalized=${personalizedCount}, unpersonalized=${unpersonalizedCount})`,
    );
  }

  await capture("personalization-unpersonalized");
  await unpersonalized.click({
    timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
    signal: abortSignal,
  });
  try {
    const menu = await waitForChatGptOwnedPersonalizationMenu(
      page,
      unpersonalized,
      deadline,
      abortSignal,
    );
    const choice = menu
      .locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR)
      .filter({ hasText: /^(?:Personalized|个性化)/ });
    if (await runChatGptPersonalizationStep(() => choice.count(), deadline, abortSignal) !== 1) {
      throw chatGptConnectorUnavailableError(
        "ChatGPT personalization menu did not expose one exact Personalized choice",
      );
    }
    await choice.click({
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await personalized.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await unpersonalized.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
  } catch (error) {
    try {
      await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT labeled personalization change failed and its opened menu could not be closed",
      );
    }
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT did not confirm Personalized connector access for this Temporary Chat",
    );
  }
  await capture("personalization-enabled");
  return "enabled";
}

/** New Temporary Chats may suppress connectors until this exact browser conversation is Personalized. */
export async function ensureChatGptPersonalizedConnectorAccess(
  page: Page,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
  abortSignal?: AbortSignal,
): Promise<ChatGptPersonalizationPreflight> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new ChatGptPersonalizationDeadlineError()),
    Math.max(1, deadline - Date.now()),
  );
  deadlineTimer.unref?.();
  const operationSignal = abortSignal
    ? AbortSignal.any([abortSignal, deadlineController.signal])
    : deadlineController.signal;
  try {
    return await ensureChatGptPersonalizedConnectorAccessWithinDeadline(
      page,
      deadline,
      operationSignal,
      captureDiagnostic,
      proveConfiguredConnectorAccess,
    );
  } catch (error) {
    if (error instanceof ChatGptPersistentBrowserStateError) throw error;
    if (!abortSignal?.aborted && (
      error instanceof ChatGptPersonalizationDeadlineError
      || deadlineController.signal.aborted
      || Date.now() >= deadline
    )) {
      throw chatGptConnectorUnavailableError("ChatGPT personalization preflight exceeded its readiness deadline");
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export class ChatGptPromptAttachmentIntegrityError extends ChatGptWebAdapterError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      status: 502,
      errorType: "server_error",
      code: "prompt_attachment_integrity",
      retryable: false,
      cause,
    });
    this.name = "ChatGptPromptAttachmentIntegrityError";
  }
}

const chatGptTemporaryChatOnboardingDialog = (page: Page): Locator => page
  .locator('[role="dialog"]')
  .filter({ hasText: "Not in history" })
  .filter({ hasText: "No model training" })
  .filter({ hasText: "Memory off" })
  .last();

export async function dismissChatGptTemporaryChatOnboarding(page: Page): Promise<boolean> {
  const dialog = chatGptTemporaryChatOnboardingDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return false;
  const continueButton = dialog.getByRole("button", { name: "Continue", exact: true }).last();
  if (!await continueButton.isVisible().catch(() => false)) {
    throw new Error("ChatGPT Temporary Chat onboarding is visible without its Continue action");
  }
  await continueButton.click({ force: true });
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

type ChatGptTextScope = Pick<Locator, "getByText" | "getByTestId">;

const chatGptSubscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last();

const chatGptExpiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText: /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i })
  .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (await chatGptExpiredSessionAlert(page).isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "The ChatGPT session has expired. Sign in again in Codex Web GPT.",
      { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false },
    );
  }
  if (!await chatGptSubscriptionFailureAlert(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

export async function throwIfChatGptTerminalErrorAlert(scope: ChatGptTextScope): Promise<void> {
  if (await scope.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "ChatGPT displayed an error for this response. Check the ChatGPT tab for the exact error, then retry the turn.",
      { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
    );
  }
  if (!await chatGptTerminalErrorAlert(scope).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  await onVisible?.();

  if (autoApprove) {
    // ChatGPT exposes either "Allow once" or the shorter "Allow" for the
    // current one-shot approval. Keep the matcher anchored so persistent
    // actions such as "Always allow" cannot match.
    const allowCurrentAction = dialog
      .getByRole("button", { name: /^Allow(?: once)?$/ })
      .last();
    await allowCurrentAction.waitFor({ state: "visible", timeout: 10_000 });
    await allowCurrentAction.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!await dialog.isVisible().catch(() => false)) return true;
  const deny = dialog.getByRole("button", { name: "Deny", exact: true }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function assertChatGptWebMultipartInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  maxMessageChars: number,
  partCount: 2 | 3,
  transport?: {
    stagingEffort: ChatGptWebModelMode["effort"];
    maxStageMessageTokens: number;
    maxStageChars: number;
    finalMessageTokens: number;
    finalMessageChars: number;
    finalImageTokens?: number;
  },
): void {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new ChatGptWebAdapterError(
      "Bigger Context is unavailable for Luna because every later browser request includes the accumulated transcript inside the same 28,000-token transport budget.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  const { contextWindow: baseContextWindow } = resolveChatGptWebContextLimits(
    modelId,
    effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
    imageTokens = 0,
  ): void => {
    const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      modelId,
      messageEffort,
      capabilities,
    );
    if (browserComposerCharLimit !== undefined && messageChars > browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (browserMessageTokenLimit !== undefined && messageTokens > browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    const messageBudget = resolveChatGptWebMessageTokenBudget(modelId, messageEffort, capabilities, imageTokens);
    if (messageTokens > messageBudget) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds its ${messageBudget.toLocaleString("en-US")}-token input budget after reserving space for ChatGPT and attachments. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };
  if (transport) {
    assertMessageBoundary(
      "stage",
      transport.maxStageMessageTokens,
      transport.maxStageChars,
      transport.stagingEffort,
    );
    assertMessageBoundary(
      "final part",
      transport.finalMessageTokens,
      transport.finalMessageChars,
      effort,
      transport.finalImageTokens,
    );
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  const experimentalContextWindow = baseContextWindow * partCount;
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "three-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

/** Keep the requested effort when it fits; otherwise use an available mode that carries every stage. */
export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  maxStageMessageTokens: number,
  maxStageChars: number,
  preferredEffort?: ChatGptWebModelMode["effort"],
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID || !capabilities.solAvailable) {
    throw new ChatGptWebAdapterError(
      "Bigger Context staging is unavailable for a Luna-only account.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const fallbackEfforts: readonly ChatGptWebModelMode["effort"][] = capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  const preferredAvailable = preferredEffort !== undefined
    && (capabilities.proAvailable || ["low", "medium", "high"].includes(preferredEffort));
  const efforts = [...new Set(preferredAvailable ? [preferredEffort, ...fallbackEfforts] : fallbackEfforts)];
  for (const effort of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, effort, capabilities);
    const limits = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
    const messageTokenLimit = resolveChatGptWebMessageTokenBudget(modelId, effort, capabilities);
    const tokenFits = maxStageMessageTokens <= messageTokenLimit;
    const charsFit = limits.browserComposerCharLimit === undefined
      || maxStageChars <= limits.browserComposerCharLimit;
    if (tokenFits && charsFit) return mode;
  }
  throw new ChatGptWebAdapterError(
    `No ChatGPT effort available to this account can carry a Bigger Context stage with ${maxStageMessageTokens.toLocaleString("en-US")} estimated tokens and ${maxStageChars.toLocaleString("en-US")} characters.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export const browserStageTimeouts = {
  promptPreparation: 60_000,
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 20_000,
  // A Bigger Context stage posts a much larger payload onto a conversation that already holds the
  // earlier parts. This budget covers ChatGPT accepting the submission, not just the click.
  multipartStageSend: 180_000,
  // Staging asks for one transaction-bound acknowledgement, not an open-ended model answer.
  multipartStageAcknowledgement: CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
} as const;

/**
 * Detects that this process was suspended (system sleep) by watching for gaps in a steady tick.
 * On Apple Silicon the monotonic clock keeps advancing through sleep, so elapsed time alone cannot
 * distinguish "the stage really took 15 minutes" from "the machine slept for 14 of them" — and a
 * stage budget charged for slept time cancels turns that never got their budget awake.
 */
export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
  ) {
    this.lastTickAt = Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Exposed for tests; production ticks come from the interval above. */
  tick(now: number): void {
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap >= this.gapThresholdMs) this.suspendedTotalMs += gap - this.tickIntervalMs;
  }

  suspendedMs(): number {
    return this.suspendedTotalMs;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();

/**
 * How much of a stage budget remains once slept time is refunded. Zero means the stage really
 * consumed its budget while awake and the timeout stands.
 */
export function remainingStageBudgetMs(
  timeoutMs: number,
  elapsedMs: number,
  suspendedMs: number,
): number {
  const awakeMs = elapsedMs - suspendedMs;
  if (awakeMs >= timeoutMs) return 0;
  return Math.max(250, timeoutMs - awakeMs);
}

export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS = 5_000;
export const MAX_CHATGPT_BROWSER_PAGE_REBINDS = 2;

export class ChatGptBrowserObservationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ChatGPT browser DOM observation did not respond within ${timeoutMs}ms`);
    this.name = "ChatGptBrowserObservationTimeoutError";
  }
}

export async function withChatGptBrowserObservationTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptBrowserObservationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectAfterClosingBrowserConnection<T>(
  previousConnection: Pick<Browser, "close"> | undefined,
  connect: () => Promise<T>,
): Promise<T> {
  if (previousConnection) await previousConnection.close();
  return connect();
}

export const CHATGPT_MIN_OPERATIONAL_VIEWPORT = Object.freeze({ width: 320, height: 240 });

async function waitForOperationalChatGptViewport(page: Page, signal?: AbortSignal): Promise<void> {
  try {
    await withBrowserTurnAbort(page.waitForFunction(
      ({ width, height }) => innerWidth >= width && innerHeight >= height,
      CHATGPT_MIN_OPERATIONAL_VIEWPORT,
      { polling: 50, timeout: 10_000 },
    ), signal);
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
    throw new Error(
      `ChatGPT browser surface did not expose an operational viewport: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";
export const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin"
  ? "Meta+A"
  : "Control+A";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function withBrowserTurnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function browserPageUrl(page: Page): string | undefined {
  const candidate = page as Page & { url?: unknown };
  if (typeof candidate.url === "function") return (candidate.url as () => string)();
  return typeof candidate.url === "string" ? candidate.url : undefined;
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Select the Codex Native connector without advertising the ordinary turn tool environment. */
  nativeConnector?: boolean;
  retainConversation?: boolean;
  requireRetainedConversation?: boolean;
  /** Exact persisted Image Factory conversation URL used only to recover a retained chat after launcher restart. */
  resumeConversationUrl?: string;
  conversationKey?: string;
  surface?: "temporary" | "persistent";
  persistentProjectId?: string;
  persistentProjectName?: string;
  executionTarget?: ChatExecutionTarget;
  /** Image Factory retained chats do not attach a Codex connector to the project conversation. */
  skipConnectorIdentity?: boolean;
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Send activation is the ambiguity boundary after which a fresh surface must not replay this prompt. */
  nativeBinding?: NativeBindingSpec;
  nativeImageReconcile?: NativeImageReconcile;
  nativeAuthority?: NativeBrowserAuthority;
  onSendActivated?: () => void | Promise<void>;
  /** Semantic submission evidence proved that ChatGPT accepted the prompt. */
  onSubmitted?: (conversationUrl?: string) => void;
  /** One inert Bigger Context stage completed its exact acknowledgement boundary. */
  onMultipartStageAcknowledged?: (stageIndex: number) => void | Promise<void>;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Proven current-turn MCP activity; never response content or completion. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Atomically fences browser completion against concurrent MCP claims in the turn broker. */
  completionFence?: {
    begin(): Promise<number | undefined>;
    commit(revision: number): Promise<boolean>;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
  outputArtifactTarget?: OutputArtifactTarget;
  outputArtifactExecutionKey?: string;
  outputArtifactLimit?: number;
  outputArtifactExistingTotalBytes?: number;
  outputArtifactWriteManifest?: boolean;
  requireOutputArtifact?: boolean;
  onOutputArtifact?: (artifact: OutputArtifact) => void;
  onOutputArtifactCapture?: (capture: OutputImageCaptureResult) => void;
  onOutputArtifactWarning?: (warning: string) => void;
  /** Image Factory only: submit this turn through the selected source image's Describe edits dialog. */
  imageEditSource?: OutputImageSource;
  /** Automatic retained text turns may receive native Codex steering while this browser stays live. */
  followUp?: ChatGptFollowUpChannel;
}

interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialTurnIdentities: readonly string[];
  domCache: ChatGptSubmissionDomCache;
}

interface ChatGptSubmissionObservationRecovery {
  page: Page;
  baseline: ChatGptSubmissionBaseline;
}

type ChatGptObservationRecovery = (
  attempt: number,
  cause: ChatGptBrowserObservationTimeoutError,
  baseline: ChatGptSubmissionBaseline,
  abortSignal?: AbortSignal,
) => Promise<ChatGptSubmissionObservationRecovery>;

interface ChatGptAssistantTurnBinding {
  identity: string;
  locator: Locator;
  acceptedTurnIdentities: readonly string[];
}

interface ChatGptSubmissionDomState {
  userTurnCount: number;
  assistantTurnCount: number;
  visibleStopButtonCount: number;
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
}

interface ChatGptSubmissionDomCache {
  key?: string;
  snapshot?: ChatGptSubmissionDomState;
  fullScans?: number;
  cacheHits?: number;
}

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  browserHelperScriptPath?: string;
  browserDiagnosticsPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
  generatedImageKeys?: readonly string[];
}): boolean {
  return state.responsePresent
    && !state.running
    && (state.currentText.length > 0 || (state.generatedImageKeys?.length ?? 0) > 0)
    && state.completionActionVisible;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running" | "mcp_tool_call";

export function chatGptSubmissionEvidence(state: {
  initialTurnIdentities: readonly string[];
  userIdentities: readonly string[];
  responseIdentities: readonly string[];
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.userIdentities)) return "user_turn";
  if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

export type ChatGptConnectorAttachmentMode = "none" | "mention" | "retained";

/** A launcher lease may reuse a connector only after proving that exact retained surface is bound. */
export function chatGptConnectorAttachmentMode(
  localTools: boolean,
  reuseConversation: boolean,
): ChatGptConnectorAttachmentMode {
  if (!localTools) return "none";
  return reuseConversation ? "retained" : "mention";
}

export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfPromptAttachmentAborted(abortSignal);
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0 && !enabled) {
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count > 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  const actionOptions = { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS };
  let pressed = count === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
  if (count === 1 && pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    const composer = composerForm.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    const composerState = () => composer.evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement;
      const pills = [...copy.querySelectorAll('[data-id^="plugin:"][data-keyword]')];
      const connectors = pills.map(pill => pill.getAttribute("data-keyword")).sort();
      for (const pill of pills) pill.remove();
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value : copy.textContent ?? "";
      return { text: text.trim(), connectors };
    }, undefined, actionOptions);
    const before = await composerState();
    if (before.text) throw new Error("ChatGPT Think selection requires an empty prompt draft");
    await composer.focus(actionOptions);
    await composer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, actionOptions);
    await composer.pressSequentially("/think", { ...actionOptions, delay: 25 });
    await captureDiagnostic?.("think-slash-triggered");
    // The command popup shares menu-item classes with sidebar history. Count only this popup.
    const popup = composerForm.page().locator('.popover[aria-busy="false"]').filter({ visible: true });
    const rows = popup.locator('.__menu-item[tabindex="0"]').filter({ visible: true });
    await rows.first().waitFor({ state: "visible", timeout: 5_000, signal: abortSignal });
    if (await popup.count() !== 1 || await rows.count() !== 1) {
      throw new Error("ChatGPT Think slash menu must expose exactly one command option");
    }
    const row = rows.first();
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      await composer.press("ArrowDown", actionOptions);
    }
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      throw new Error("ChatGPT Think slash option is not highlighted");
    }
    await captureDiagnostic?.("think-slash-menu-ready");
    throwIfPromptAttachmentAborted(abortSignal);
    await composer.press("Enter", actionOptions);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      const currentCount = await controls.count();
      if (currentCount > 1) throw new Error(`ChatGPT exposed ${currentCount} visible Think controls`);
      pressed = currentCount === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
      if (pressed === target) break;
      if (currentCount === 1 && pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await withBrowserTurnAbort(new Promise(resolveSleep => setTimeout(resolveSleep, 100)), abortSignal);
    }
    if (pressed !== target) {
      throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    }
    const after = await composerState();
    if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
      throw new Error("ChatGPT Think slash selection did not preserve the empty draft and selected connectors");
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}

export function chatGptNewTurnIdentity(
  initial: readonly string[],
  current: readonly string[],
): string | undefined {
  const previous = new Set(initial);
  const added = current.filter(identity => !previous.has(identity));
  if (added.length > 1) {
    throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  }
  return added[0];
}

export function chatGptReboundTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return chatGptNewTurnIdentity(initial, current);
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private lastToolBatchRevision = 0;
  private postToolAnswerBaselineText?: string;
  private missingPostToolAnswerSince?: number;

  constructor(
    private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS,
    private readonly missingPostToolAnswerMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  needsToolBatchObservation(revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < this.lastToolBatchRevision) {
      throw new Error("ChatGPT completion received an invalid tool-batch revision");
    }
    return revision > this.lastToolBatchRevision;
  }

  observeToolBatch(revision: number, currentText: string, imageSignature = ""): boolean {
    if (!this.needsToolBatchObservation(revision)) return false;
    // The caller acknowledges the batch only after this projection is captured. The outer Codex
    // harness therefore cannot execute the tool until this exact pre-tool answer boundary exists.
    this.postToolAnswerBaselineText = `${currentText}\0${imageSignature}`;
    this.lastToolBatchRevision = revision;
    this.missingPostToolAnswerSince = undefined;
    this.candidate = undefined;
    return true;
  }

  update(
    state: Parameters<typeof chatGptTurnIsComplete>[0] & {
      externalToolCallsInFlight?: boolean;
    },
    now = Date.now(),
  ): boolean {
    const imageSignature = (state.generatedImageKeys ?? []).join("\n");
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}\0${imageSignature}`;
    // An outstanding tool call proves the model has more to say, whatever the rendered message
    // currently looks like. Completing here would return a truncated answer and retire the turn
    // while its own tool calls were still in flight.
    if (state.externalToolCallsInFlight) {
      this.candidate = undefined;
      this.missingPostToolAnswerSince = undefined;
      return false;
    }
    if (this.postToolAnswerBaselineText === `${state.currentText}\0${imageSignature}`) {
      this.candidate = undefined;
      if (!chatGptTurnIsComplete(state)) {
        this.missingPostToolAnswerSince = undefined;
        return false;
      }
      this.missingPostToolAnswerSince ??= now;
      if (now - this.missingPostToolAnswerSince >= this.missingPostToolAnswerMs) {
        throw new Error("ChatGPT completed without producing a final answer after its last Codex tool call");
      }
      return false;
    }
    this.missingPostToolAnswerSince = undefined;
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  /**
   * Clears only the missing-response window, leaving `sawResponse` history intact.
   *
   * Callers use this when proven external progress suspends DOM health checks: the suspended
   * stretch must not be charged against the grace period, or the first observation after it
   * resumes would fail instantly against a timestamp recorded long before.
   */
  clearMissingResponse(): void {
    this.missingResponseSince = undefined;
  }

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
    generatedImageKeys?: readonly string[];
    externalProgressLive?: boolean;
  }, now = Date.now()): string | undefined {
    if (state.responsePresent) this.sawResponse = true;
    if (state.externalProgressLive) {
      // Every conclusion below asserts that ChatGPT stopped producing this turn. A tool call that
      // is still completing disproves all of them, whatever the renderer is currently exposing, so
      // no window may accrue while the model is provably working.
      this.missingResponseSince = undefined;
      this.emptyCompletionSince = undefined;
      this.missingCompletionAction = undefined;
      return undefined;
    }
    if (state.responsePresent) {
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && (state.generatedImageKeys?.length ?? 0) === 0
      && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

/**
 * Consecutive internal observation faults tolerated before a turn is abandoned.
 *
 * An internal observation fault is not evidence that the upstream turn failed. The loop
 * re-observes within a consecutive budget; any successful observation resets that budget, and
 * exhausting it fails closed with the original fault as the cause.
 */
export const MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS = 8;

/**
 * How stale recorded MCP progress may be and still suppress DOM health checks.
 *
 * An outstanding tool call reports liveness regardless of age, so a call that never returns would
 * otherwise hold a turn open forever — turns carry no deadline unless a caller supplies one. This
 * bounds the silence since the last recorded activity rather than the turn's total duration, so a
 * long turn that keeps calling tools is never penalised for taking a long time.
 */
export const CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000;

/** Tolerated clock difference between the recording daemon and the observing helper process. */
export const CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS = 5_000;

/** Proven MCP activity, additionally required to be recent enough to still be evidence. */
export function chatGptExternalProgressSuppressesDomHealth(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): boolean {
  if (!chatGptExternalProgressIsLive(snapshot, now, CHATGPT_RESPONSE_DOM_GRACE_MS)) return false;
  const lastProgressAt = snapshot?.lastProgressAt;
  if (lastProgressAt === undefined) return false;
  const age = now - lastProgressAt;
  // A timestamp from the future would keep `age` below the ceiling forever. Recorded activity can
  // only precede the observation, so anything meaningfully ahead of now is not evidence at all.
  return age >= -CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS
    && age < CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
}

export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  stoppedThinkingVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
  generatedImageKeys: string[];
}

interface ChatGptResponseDomCache {
  key?: string;
  snapshot?: ChatGptResponseDomSnapshot;
  fullScans?: number;
  cacheHits?: number;
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  markdownSegments: [],
  completionActionVisible: false,
  stoppedThinkingVisible: false,
  traceBlocks: [],
  generatedImageKeys: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 250) {}

  observe(blocks: ChatGptVisibleTraceBlock[], completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    for (const block of blocks) {
      // Final-answer roots are carried by ChatGptMarkdownBuffer. Commentary roots are identified
      // structurally by responseDomSnapshot before they reach this tracker.
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const stripped = block.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const text = block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
      if (!text) continue;
      let candidate = this.traceCandidates.get(slot);
      if (!candidate || candidate.text !== text) {
        candidate = { text, changedAt: now };
        this.traceCandidates.set(slot, candidate);
        if (!completionActionVisible && this.traceStabilityMs > 0) continue;
      }
      // A commentary Markdown root remains mutable until ChatGPT appends the next reasoning item.
      // Emitting it earlier lets a tool-status boundary split one semantic paragraph into multiple
      // Codex messages. The next anchored item (or final completion evidence) is the stable boundary.
      if (block.kind === "commentary" && block.complete === false && !completionActionVisible) continue;
      if (!completionActionVisible && now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedTrace.get(slot);
      if (previous === text) continue;
      this.emittedTrace.set(slot, text);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";

      if (previous && text.startsWith(previous)) {
        output.push({ kind, text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind, text });
      }
    }
    return output;
  }
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

const CHATGPT_DIAGNOSTIC_SAFE_STRING_KEYS = new Set([
  "tag",
  "role",
  "ariaExpanded",
  "ariaChecked",
  "dataState",
  "dataHighlighted",
  "origin",
]);

/** Defense in depth: persisted browser traces contain structure, never rendered UI text. */
export function sanitizeChatGptBrowserDiagnosticState(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeChatGptBrowserDiagnosticState);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (typeof candidate === "string") {
      return CHATGPT_DIAGNOSTIC_SAFE_STRING_KEYS.has(key) && candidate.length <= 200
        ? [[key, candidate]]
        : [];
    }
    const sanitized = sanitizeChatGptBrowserDiagnosticState(candidate);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "checkpoint";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
}

function pruneBrowserDiagnostics(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
    .map(entry => {
      const path = join(root, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
    rmSync(trace.path, { recursive: true, force: true });
  }
}

class ChatGptBrowserDiagnostics {
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;

  constructor(
    private readonly traceId: string,
    private readonly root: string,
    private readonly appName: string,
  ) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    try {
      if (!this.initialized) {
        privateDirectory(this.root);
        privateDirectory(this.directory);
        pruneBrowserDiagnostics(this.root);
        this.initialized = true;
      }
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const includeScreenshot = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1";
      const [screenshotResult, stateResult] = await Promise.allSettled([
        includeScreenshot
          ? page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })
          : Promise.resolve(undefined),
        withChatGptBrowserObservationTimeout(page.evaluate(({
          composerSelector,
          effortControlSelector,
          effortItemSelector,
          effortSliderContainerSelector,
          assistantTurnSelector,
          userTurnSelector,
          stopButtonSelector,
          completionActionSelector,
          appName,
        }) => {
          const rendered = (element: Element): boolean => {
            const candidate = element as HTMLElement;
            const style = getComputedStyle(candidate);
            return candidate.isConnected
              && style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0";
          };

          const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
            .filter(rendered)
            .slice(-limit)
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                ariaExpanded: element.getAttribute("aria-expanded"),
                ariaChecked: element.getAttribute("aria-checked"),
                dataState: element.getAttribute("data-state"),
                dataHighlighted: element.getAttribute("data-highlighted"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                textChars: (element.textContent ?? "").length,
              };
            });
          const exactText = (element: Element, expected: string): boolean => (
            [element, ...element.querySelectorAll("*")].some(candidate => (
              candidate.children.length === 0
              && (candidate.textContent ?? "").replace(/\s+/g, " ").trim() === expected
            ))
          );
          const composers = [...document.querySelectorAll(composerSelector)].filter(rendered);
          const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(rendered);
          const selectedConnectors = composers.flatMap(composer => (
            [...composer.querySelectorAll('[data-id^="plugin:"][data-keyword]')]
          ))
            .filter(rendered);
          const exactConnectorRows = [...document.querySelectorAll('.__menu-item[tabindex="0"]')]
            .filter(element => rendered(element) && exactText(element, appName));
          const currentUrl = new URL(location.href);
          const integerAttribute = (element: Element, name: string): number | null => {
            const raw = element.getAttribute(name);
            return raw !== null && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
              ? Number(raw) : null;
          };
          return {
            location: {
              origin: currentUrl.origin,
              pathSegments: currentUrl.pathname.split("/").filter(Boolean).length,
              temporaryChat: currentUrl.searchParams.has("temporary-chat"),
            },
            titleChars: document.title.length,
            viewport: { width: innerWidth, height: innerHeight },
            surfaceBound: typeof (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
              .__CODEX_WEB_GPT_SURFACE_ID__ === "string",
            // textContent avoids the synchronous layout forced by innerText on huge prompts.
            bodyTextChars: document.body?.textContent?.length ?? 0,
            composer: {
              visibleCount: composers.length,
              textChars: composers.map(element => (
                element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                  ? element.value : element.textContent ?? ""
              ).length),
              editors: composers.map(element => ({
                tag: element.tagName.toLowerCase(),
                contentEditable: (element as HTMLElement).isContentEditable,
                focused: element === document.activeElement,
              })),
              selectedConnectorCount: selectedConnectors.length,
              exactSelectedConnectorCount: selectedConnectors.filter(
                element => element.getAttribute("data-keyword") === appName,
              ).length,
            },
            focus: {
              tag: document.activeElement?.tagName.toLowerCase() ?? null,
              role: document.activeElement?.getAttribute("role") ?? null,
              documentFocused: document.hasFocus(),
            },
            effortControls: rows(effortControlSelector, 10),
            effortItems: rows(effortItemSelector, 20),
            effortSliders: [...document.querySelectorAll(effortSliderContainerSelector)]
              .filter(rendered).slice(-10)
              .flatMap(container => [...container.querySelectorAll('[role="slider"]')])
              .map(element => ({
                min: integerAttribute(element, "aria-valuemin"),
                max: integerAttribute(element, "aria-valuemax"),
                value: integerAttribute(element, "aria-valuenow"),
              })),
            menus: rows('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]', 20),
            connectorRows: exactConnectorRows.slice(-20).map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                dataState: element.getAttribute("data-state"),
                dataHighlighted: element.getAttribute("data-highlighted"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                textChars: (element.textContent ?? "").length,
              };
            }),
            overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
            turns: {
              user: document.querySelectorAll(userTurnSelector).length,
              stopButtonCount: [...document.querySelectorAll(stopButtonSelector)].filter(rendered).length,
              assistant: assistantTurns.map(element => ({
                textChars: (element.textContent ?? "").length,
                htmlChars: (element as HTMLElement).innerHTML.length,
                markdownCount: element.querySelectorAll(".markdown").length,
                streamingStatusCount: element.querySelectorAll("[data-streaming-response-status]").length,
                completionActionCount: element.querySelectorAll(completionActionSelector).length,
                renderedCompletionActionCount: [...element.querySelectorAll(completionActionSelector)]
                  .filter(rendered).length,
              })),
            },
          };
        }, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR,
          effortControlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
          effortItemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
          effortSliderContainerSelector: CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
          assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
          userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
          stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
          completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
          appName: this.appName,
        })),
      ]);
      const capturedAt = new Date().toISOString();
      if (screenshotResult.status === "fulfilled" && screenshotResult.value) {
        atomicWriteFile(join(this.directory, `${stem}.png`), screenshotResult.value);
      }
      const captureErrors = Object.fromEntries([
        ...(screenshotResult.status === "rejected" ? [[
          "screenshot",
          redactChatGptUiDiagnostic(
            screenshotResult.reason instanceof Error ? screenshotResult.reason.message : String(screenshotResult.reason),
          ),
        ]] : []),
        ...(stateResult.status === "rejected" ? [[
          "state",
          redactChatGptUiDiagnostic(
            stateResult.reason instanceof Error ? stateResult.reason.message : String(stateResult.reason),
          ),
        ]] : []),
      ]);
      atomicWriteFile(join(this.directory, `${stem}.json`), `${JSON.stringify({
        version: 2,
        capturedAt,
        traceId: this.traceId,
        checkpoint,
        ...(error !== undefined ? {
          error: redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error)),
        } : {}),
        ...(stateResult.status === "fulfilled"
          ? { state: sanitizeChatGptBrowserDiagnosticState(stateResult.value) }
          : {}),
        ...(Object.keys(captureErrors).length > 0 ? { captureErrors } : {}),
      }, null, 2)}\n`);
      if (Object.keys(captureErrors).length > 0) {
        console.warn(
          `[chatgpt-web] browser diagnostic partial capture trace=${this.traceId}`
          + ` checkpoint=${stem} failures=${Object.keys(captureErrors).join(",")}`,
        );
      }
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem} path=${this.directory}`);
    } catch (captureError) {
      console.warn(
        `[chatgpt-web] browser diagnostic capture failed trace=${this.traceId}`
        + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}:`
        + ` ${captureError instanceof Error ? captureError.message : String(captureError)}`,
      );
    }
  }
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const browserHelperScriptPath = configured.browserHelperScriptPath?.trim();
  const browserDiagnosticsPath = resolve(expandUserPath(
    configured.browserDiagnosticsPath?.trim() || join(getConfigDir(), "diagnostics", "browser-turns"),
  ));
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (browserHelperScriptPath && browserHost !== "launcher") {
    throw new Error("Explicit browser helper script requires a launcher host");
  }
  const resolvedBrowserHelperScriptPath = browserHelperScriptPath
    ? resolve(expandUserPath(browserHelperScriptPath))
    : undefined;
  if (resolvedBrowserHelperScriptPath && !existsSync(resolvedBrowserHelperScriptPath)) {
    throw new Error(`Explicit browser helper script does not exist: ${resolvedBrowserHelperScriptPath}`);
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    ...(resolvedBrowserHelperScriptPath ? { browserHelperScriptPath: resolvedBrowserHelperScriptPath } : {}),
    browserDiagnosticsPath,
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    if (Math.floor(parsed.base64.length * 3 / 4) > 20_000_000) {
      throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    if (sniffImageMime(buffer) !== parsed.mediaType.toLowerCase()) {
      throw new Error(`ChatGPT web input image ${image.ref} MIME type does not match its bytes`);
    }
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  return chatGptImageFilePayloads(prompt.images);
}

/**
 * Insert `value` at the caret of an already-resolved ChatGPT composer, returning whether the edit
 * was applied. Runs inside the page, so it may reference only globals and its two arguments.
 *
 * Effort selection closes a menu immediately before a staged part is attached, and focus is still
 * settling when this runs: the composer can be the active element while the caret has not yet been
 * placed inside it, or focus can still be on the menu that just closed. Reading that as a rejected
 * edit failed whole turns roughly a tenth of a second after the effort menu closed, so the caret is
 * placed explicitly instead of assumed. An existing collapsed caret inside the composer is left
 * exactly where the user put it; only a missing or foreign one is replaced, and always with a
 * position inside this composer, so an insert can never land in another element.
 */
export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (
    !selection.isCollapsed
    || !selection.anchorNode
    || !element.contains(selection.anchorNode)
  ) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();

  private constructor(private readonly config: ResolvedBrowserConfig) {}
  /**
   * Lexical/contenteditable may preserve ASCII spaces by exposing some of them as NBSP through DOM
   * textContent. That happens inside multi-space runs and for a single leading space after a line
   * break. Treat only those DOM-only representations as equivalent. Other single spaces, tabs,
   * newlines, intentional expected NBSP characters, and every other mutation remain exact and
   * fail closed.
   */
  private promptCodeUnitEquivalent(
    expected: string,
    observed: string,
    index: number,
  ): boolean {
    const expectedUnit = expected[index];
    const observedUnit = observed[index];

    if (expectedUnit === observedUnit) return true;
    if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;

    return expected[index - 1] === " "
      || expected[index + 1] === " "
      || expected[index - 1] === "\n";
  }

  private promptTextEquivalent(
    expected: string,
    observed: string,
  ): boolean {
    if (expected.length !== observed.length) return false;

    for (let index = 0; index < expected.length; index += 1) {
      if (!this.promptCodeUnitEquivalent(expected, observed, index)) {
        return false;
      }
    }

    return true;
  }

  private promptEquivalentPrefixLength(
    expected: string,
    observed: string,
  ): number {
    const length = Math.min(expected.length, observed.length);

    let index = 0;
    while (
      index < length
      && this.promptCodeUnitEquivalent(expected, observed, index)
    ) {
      index += 1;
    }

    return index;
  }

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    if (!chatGptBrowserCapacityAvailable()) {
      return Promise.reject(new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      ));
    }
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    activeChatGptBrowserTurns += 1;
    const run = Promise.resolve().then(() => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn));
    this.activeRuns.set(turn.traceId, run);
    void run.finally(() => {
      activeChatGptBrowserTurns = Math.max(0, activeChatGptBrowserTurns - 1);
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  verifyConnector(traceId = `verify_${randomUUID().replaceAll("-", "")}`): Promise<string> {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      return Promise.reject(new Error("ChatGPT connector verification trace id is invalid"));
    }
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive(traceId));
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  ensureImageFactoryProject(store: ImageFactoryStore, abortSignal?: AbortSignal) {
    return this.enqueueMaintenance("Image Factory project setup", async () => {
      abortSignal?.throwIfAborted();
      const startedAt = Date.now();
      let setupTraceId: string | undefined;
      const log: ImageFactoryProjectLog = (event, fields = {}) => imageFactorySetupLog(event, {
        traceId: setupTraceId,
        elapsedMs: Date.now() - startedAt,
        ...fields,
      });
      log("started", {
        browserHost: this.config.browserHost,
        capacityAvailable: chatGptBrowserCapacityAvailable(),
      });
      if (!chatGptBrowserCapacityAvailable()) {
        log("rejected_capacity");
        throw new Error("Image Factory setup requires an available ChatGPT browser slot");
      }
      activeChatGptBrowserTurns += 1;
      let connection: Awaited<ReturnType<typeof connectLauncherBrowserHost>> | undefined;
      let setupStatus: "completed" | "failed" = "completed";
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeatInFlight = false;
      try {
        let page: Page;
        if (this.config.browserHost === "launcher") {
          setupTraceId = `image_setup_${randomUUID().replaceAll("-", "")}`;
          log("launcher_lease_requested");
          const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "start", traceId: setupTraceId, helperPid: process.pid,
          });
          log("launcher_lease_received", {
            surfaceId: shortImageFactoryId(lease.surfaceId),
            reused: lease.reused,
            connectorBound: lease.connectorBound,
            cancelledByUser: lease.cancelledByUser,
          });
          if (!lease.surfaceId) {
            log("launcher_lease_missing_surface");
            throw new Error("Launcher did not lease a browser tab for Image Factory setup");
          }
          const sendHeartbeat = () => {
            if (heartbeatInFlight) return;
            heartbeatInFlight = true;
            log("launcher_heartbeat");
            void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
              phase: "heartbeat", traceId: setupTraceId!, helperPid: process.pid,
            }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(() => {}).finally(() => {
              heartbeatInFlight = false;
            });
          };
          heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
          heartbeatTimer.unref?.();
          log("browser_connection_requested", { surfaceId: shortImageFactoryId(lease.surfaceId) });
          connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!, 20_000, lease.surfaceId);
          page = connection.page;
          log("browser_connection_ready", { url: imageFactoryPageLocation(page) });
        } else {
          log("browser_page_requested");
          page = await this.ensurePage();
          log("browser_page_ready", { url: imageFactoryPageLocation(page) });
        }
        const openSettings = async (projectId: string): Promise<Locator> => {
          abortSignal?.throwIfAborted();
          log("settings_navigation_started", { projectId: shortImageFactoryId(projectId) });
          try {
            await openImageFactoryProject(page, projectId, log);
            abortSignal?.throwIfAborted();
            log("settings_navigation_completed", {
              projectId: shortImageFactoryId(projectId),
              url: imageFactoryPageLocation(page),
            });
            log("settings_details_wait_started", { projectId: shortImageFactoryId(projectId) });
            await page.getByRole("button", { name: "Show project details", exact: true })
              .waitFor({ state: "visible", timeout: 60_000 });
            log("settings_details_visible", { projectId: shortImageFactoryId(projectId) });
            await page.getByRole("button", { name: "Show project details", exact: true }).click({ signal: abortSignal });
            log("settings_menu_opened", { projectId: shortImageFactoryId(projectId) });
            await page.getByRole("menuitem", { name: "Project settings", exact: true }).click({ signal: abortSignal });
            log("settings_dialog_opened", { projectId: shortImageFactoryId(projectId) });
            return page.getByRole("dialog");
          } catch (error) {
            log("settings_open_failed", {
              projectId: shortImageFactoryId(projectId),
              url: imageFactoryPageLocation(page),
              error: imageFactoryErrorMessage(error),
            });
            throw error;
          }
        };
        const inspect = async (id: string) => {
          if (!/^g-p-[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error("Image Factory project id is invalid");
          const dialog = await openSettings(id);
          try {
            log("settings_values_read_started", { projectId: shortImageFactoryId(id) });
            const memory = (await dialog.getByRole("button", { name: "Memory", exact: true }).innerText())
              .toLowerCase().includes("project-only") ? "project-only" as const : "unknown" as const;
            const instructions = await dialog.getByRole("textbox", { name: "Instructions", exact: true }).inputValue();
            log("settings_values_read_completed", {
              projectId: shortImageFactoryId(id),
              memory,
              instructionsLength: instructions.length,
            });
            return { id, memory, instructions };
          } catch (error) {
            log("settings_values_read_failed", {
              projectId: shortImageFactoryId(id),
              error: imageFactoryErrorMessage(error),
            });
            throw error;
          } finally {
            await dialog.getByRole("button", { name: "Close", exact: true }).click().then(
              () => log("settings_dialog_closed", { projectId: shortImageFactoryId(id) }),
              error => log("settings_dialog_close_failed", {
                projectId: shortImageFactoryId(id),
                error: imageFactoryErrorMessage(error),
              }),
            );
          }
        };
        const ui: ImageFactoryProjectUi = {
          accountKey: async () => {
            abortSignal?.throwIfAborted();
            log("account_page_check_started", { url: imageFactoryPageLocation(page) });
            if (!/^https:\/\/chatgpt\.com(?:\/|$)/i.test(page.url())) {
              await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
            }
            const profileButton = page.locator(
              '[data-testid="accounts-profile-button"], [aria-label*="open profile menu" i], [aria-label*="mở menu hồ sơ" i]',
            ).last();
            await profileButton.waitFor({ state: "visible", timeout: 30_000 });
            const label = await profileButton.getAttribute("aria-label");
            if (!label) throw new Error("ChatGPT account identity is unavailable");
            const accountKey = createHash("sha256").update(label).digest("hex");
            log("account_page_check_completed", { accountKey: shortImageFactoryId(accountKey) });
            return accountKey;
          },
          list: async () => {
            abortSignal?.throwIfAborted();
            log("project_list_navigation_started");
            await prepareProjectDirectory(page);
            log("project_list_navigation_completed", { url: imageFactoryPageLocation(page) });
            const rows = page.locator('[role="grid"] [role="row"][data-page-table-selectable-row="true"]');
            const found = new Map<string, { id: string; name: string }>();
            let stablePasses = 0;
            let visitedRows = 0;
            for (let pass = 0; pass < 12 && stablePasses < 2; pass += 1) {
              abortSignal?.throwIfAborted();
              const rowCount = await rows.count();
              const observedNames: string[] = [];
              for (let index = visitedRows; index < rowCount; index += 1) {
                const row = rows.nth(index);
                const observedName = await readProjectRowLabel(row);
                observedNames.push(observedName || "<empty>");
                // Only open exact Image Factory rows. Opening every project to discover its id
                // creates a list -> detail -> list loop and looks like bot navigation.
                if (!(await isImageFactoryProjectRow(row))) continue;
                log("project_row_open_started", { pass, index });
                await page.waitForTimeout(900);
                await row.click({ signal: abortSignal });
                await page.waitForURL(/\/g\/g-p-[A-Za-z0-9_-]+\/project(?:$|\/)/, { timeout: 60_000 });
                const id = new URL(page.url()).pathname.split("/")[2] ?? "";
                if (!/^g-p-[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error("ChatGPT project row did not expose a valid project id");
                found.set(id, { id, name: IMAGE_FACTORY_PROJECT_NAME });
                log("project_row_open_completed", { pass, index, projectId: shortImageFactoryId(id) });
                await page.waitForTimeout(700);
                await prepareProjectDirectory(page);
              }
              visitedRows = rowCount;
              log("project_list_page_observed", { pass, rowCount, found: found.size, names: observedNames.join(" | ") });
              await rows.last().scrollIntoViewIfNeeded().catch(() => {});
              await new Promise(resolveSleep => setTimeout(resolveSleep, 500));
              stablePasses = await rows.count() <= rowCount ? stablePasses + 1 : 0;
            }
            log("project_list_completed", { count: found.size, stablePasses });
            return [...found.values()];
          },
          inspect,
          writeInstructions: async (id, text) => {
            log("instructions_navigation_started", { projectId: shortImageFactoryId(id) });
            const dialog = await openSettings(id);
            log("instructions_editor_opened", { projectId: shortImageFactoryId(id) });
            await dialog.getByRole("textbox", { name: "Instructions", exact: true }).fill(text, { signal: abortSignal });
            log("instructions_filled", { projectId: shortImageFactoryId(id), instructionsLength: text.length });
            await dialog.getByRole("button", { name: "Save", exact: true }).click({ signal: abortSignal });
            log("instructions_save_clicked", { projectId: shortImageFactoryId(id) });
            await dialog.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
            log("instructions_save_settled", { projectId: shortImageFactoryId(id) });
          },
        };
        return await ensureImageFactoryProject(store, ui, log, abortSignal);
      } catch (error) {
        setupStatus = "failed";
        log("failed", { error: imageFactoryErrorMessage(error) });
        throw error;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (connection) {
          log("browser_connection_closing");
          await connection.browser.close().then(
            () => log("browser_connection_closed"),
            error => log("browser_connection_close_failed", { error: imageFactoryErrorMessage(error) }),
          );
        }
        try {
          if (setupTraceId) {
            log("launcher_lease_ending", { status: setupStatus });
            await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
              phase: "end", traceId: setupTraceId, helperPid: process.pid, status: setupStatus,
            }).catch(error => {
              if (setupStatus === "completed") throw error;
            });
          }
        } finally {
          activeChatGptBrowserTurns = Math.max(0, activeChatGptBrowserTurns - 1);
        }
        log("finished", { status: setupStatus, durationMs: Date.now() - startedAt });
      }
    });
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: Pick<ChatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    chatGptSuspensionClock.start();
    const startedAt = performance.now();
    const suspendedAtStart = suspensionClock.suspendedMs();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stageTimedOut = false;
    let actionPromise: Promise<T> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const fireOrRearm = () => {
          // A stage that spans a system sleep has not consumed its budget: the browser was as
          // frozen as this process, so slept time is refunded before the timer is re-armed.
          const suspendedMs = suspensionClock.suspendedMs() - suspendedAtStart;
          const remaining = remainingStageBudgetMs(timeoutMs, performance.now() - startedAt, suspendedMs);
          if (remaining > 0) {
            timer = setTimeout(fireOrRearm, remaining);
            return;
          }
          stageTimedOut = true;
          controller.abort();
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      actionPromise = action(controller.signal);
      const value = await Promise.race([actionPromise, timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      let surfacedError = stageTimedOut
        ? new Error(`ChatGPT browser stage timed out: ${stage}`, { cause: error })
        : error;
      if (stageTimedOut && awaitAbortedActionSettlement && actionPromise) {
        try {
          await actionPromise;
        } catch (settlementError) {
          if (settlementError instanceof ChatGptPersistentBrowserStateError) {
            surfacedError = settlementError;
          }
        }
      }
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${surfacedError instanceof Error ? surfacedError.message : String(surfacedError)}`);
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
        throw chatGptModelControlUnavailableError(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      // Enable Think during prompt attachment, after fresh connector selection. Ordinary Luna
      // still clears a previous Think selection here; retained Think is checked on every attach.
      if (!mode.thinkEnabled) await setChatGptThinkMode(composerForm, false, captureDiagnostic);
      return mode;
    }
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
    const effortWaitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        currentEffort.waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "effort" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableError(
        "ChatGPT rendered the composer but its model/effort control did not become ready",
      );
    } finally {
      effortWaitAbort.abort();
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    await throwIfChatGptRateLimitDialog(page);
    let activation = await activateChatGptEffortMenu(page, currentEffort);
    if (activation.method === "pointerdown") {
      await captureDiagnostic?.("effort-menu-pointerdown-fallback");
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const latest = activation.menu.getByRole("menuitemradio", { name: "Latest", exact: true }).last();
    if (await latest.isVisible().catch(() => false)
      && (await latest.getAttribute("aria-checked") !== "true"
        || await activation.menu.locator('[data-view="advanced"]').count() > 0)) {
      // Create image remains selected on retained image conversations and hides the thinking
      // slider. Restore the automatic model before selecting its effort for every continuation.
      await withChatGptNavigationGuard(page, signal => latest.press("Enter", { timeout: 10_000, signal }));
      activation = await activateChatGptEffortMenu(page, currentEffort);
      // Current ChatGPT separates model selection from the thinking view. Selecting even an
      // already-checked Latest row returns from the advanced view; read its retained ARIA state
      // after that row becomes hidden, then operate only on the visible thinking slider.
      const selectedLatest = activation.menu.getByRole("menuitemradio", { name: "Latest", exact: true, includeHidden: true }).last();
      if (await selectedLatest.getAttribute("aria-checked") !== "true") {
        throw chatGptModelControlUnavailableError("ChatGPT did not confirm Latest model selection");
      }
      await captureDiagnostic?.("latest-model-selected");
    }
    const effortSlider = activation.slider;
    const sliderContainer = activation.sliderContainer;
    const accountLimitMiniFallbackActive = async (): Promise<boolean> => {
      const readText = async (scope: Locator): Promise<string> => {
        const innerText = scope.innerText;
        return typeof innerText === "function" ? innerText.call(scope) : "";
      };
      const [controlResult, menuResult] = await Promise.allSettled([
        readText(currentEffort),
        readText(activation.menu),
      ]);
      const controlText = controlResult.status === "fulfilled" ? controlResult.value : "";
      const menuText = menuResult.status === "fulfilled" ? menuResult.value : "";
      return CHATGPT_ACCOUNT_LIMIT_MINI_FALLBACK.test(`${controlText}\n${menuText}`);
    };
    const acceptAccountLimitMiniFallback = async (): Promise<boolean> => {
      if (!await accountLimitMiniFallbackActive()) return false;
      await captureDiagnostic?.("account-limit-mini-fallback-accepted");
      await page.keyboard.press("Escape");
      return true;
    };
    const waitAbort = new AbortController();
    try {
      const waitForSlider = async () => {
        const deadline = Date.now() + 70_000;
        try {
          await sliderContainer.waitFor({ state: "visible", timeout: 1_000, signal: waitAbort.signal });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          await throwIfChatGptRateLimitDialog(page);
          await throwIfChatGptSessionFailureAlert(page);
          if (await activation.menu.locator('[data-model-selection-view][data-has-slider="false"]').count() > 0) {
            if (await accountLimitMiniFallbackActive()) return "account-limit-mini-fallback" as const;
            throw chatGptModelControlUnavailableAdapterError("The active model picker explicitly reports that no thinking slider is available");
          }
          // A post-ACK re-render can dismiss the picker after activation was observed. Reopen only
          // a demonstrably closed owner, once; an open picker with no slider is not proof to retry.
          if (await currentEffort.getAttribute("aria-expanded") === "false"
            || await currentEffort.getAttribute("data-state") === "closed") {
            await activateChatGptEffortMenu(page, currentEffort);
            await captureDiagnostic?.("effort-menu-reopened-after-dismissal");
          }
          await sliderContainer.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()), signal: waitAbort.signal });
        }
        await effortSlider.waitFor({ state: "attached", timeout: Math.max(1, deadline - Date.now()), signal: waitAbort.signal });
        return "slider" as const;
      };
      const ready = await Promise.race([
        waitForSlider(),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
      if (ready === "account-limit-mini-fallback") {
        await captureDiagnostic?.("account-limit-mini-fallback-accepted");
        await page.keyboard.press("Escape");
        return mode;
      }
      await captureDiagnostic?.("effort-slider-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableAdapterError(
        `ChatGPT effort slider did not become ready for item index ${uiEffortIndex}`,
      );
    } finally {
      waitAbort.abort();
    }
    let sliderState = parseChatGptEffortSliderState(
      await effortSlider.getAttribute("aria-valuemin"),
      await effortSlider.getAttribute("aria-valuemax"),
      await effortSlider.getAttribute("aria-valuenow"),
    );
    if (!sliderState) {
      if (await acceptAccountLimitMiniFallback()) return mode;
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT effort slider exposed an invalid ARIA range",
      );
    }
    const targetValue = sliderState.min + uiEffortIndex;
    if (targetValue > sliderState.max) {
      if (await acceptAccountLimitMiniFallback()) return mode;
      const proUsageLimitHint = uiEffortIndex === 4 && sliderState.min === 0 && sliderState.max === 3
        ? " If you have made many Pro requests recently, ChatGPT may have temporarily hidden Pro because you reached its usage limit."
        : "";
      throw chatGptModelControlUnavailableAdapterError(
        `ChatGPT effort slider does not expose item index ${uiEffortIndex}`
        + ` (min=${sliderState.min}; max=${sliderState.max})`
        + proUsageLimitHint,
      );
    }
    const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
    while (sliderState.value !== targetValue) {
      await throwIfChatGptRateLimitDialog(page);
      const direction = targetValue > sliderState.value ? 1 : -1;
      const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
      const previousValue = sliderState.value;
      await sliderControl.press(key);
      const changeDeadline = Date.now() + 5_000;
      do {
        sliderState = parseChatGptEffortSliderState(
          await effortSlider.getAttribute("aria-valuemin"),
          await effortSlider.getAttribute("aria-valuemax"),
          await effortSlider.getAttribute("aria-valuenow"),
        );
        if (!sliderState) {
          throw chatGptModelControlUnavailableError(
            "ChatGPT effort slider lost its semantic ARIA state",
          );
        }
        if (sliderState.value !== previousValue) break;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
      } while (Date.now() < changeDeadline);
      if (sliderState.value !== previousValue + direction) {
        throw chatGptModelControlUnavailableError(
          `ChatGPT effort slider did not move exactly one step with ${key}`
          + ` (before=${previousValue}; after=${sliderState.value})`,
        );
      }
    }
    await captureDiagnostic?.("effort-selected");
    await page.keyboard.press("Escape");
    return mode;
  }

  private async activeComposer(
    page: Page,
    timeoutMs = 30_000,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      count = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(
          composers.count(),
          Math.max(1, Math.min(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS, deadline - Date.now())),
        ),
        abortSignal,
      );
      if (count === 1) return composers.first();
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
        abortSignal,
      );
    }
    throw new Error(
      "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",
      { cause: new Error(`Visible ChatGPT composer count was ${count}`) },
    );
  }

  /** Put every browser operation on one fully hydrated Temporary Chat document. */
  private async prepareTemporaryChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.("temporary-chat-navigation-complete");
    }
    let composer: Locator;
    try {
      composer = await this.activeComposer(page);
    } catch {
      throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    }
    if (await dismissChatGptTemporaryChatOnboarding(page)) {
      await captureDiagnostic?.("temporary-chat-onboarding-dismissed");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    await captureDiagnostic?.("session-verified");
    return composer;
  }

  /** Prepare one normal project chat. It is only used by the Image Factory child worker. */
  private async preparePersistentChatSurface(
    page: Page,
    projectId: string,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    projectName?: string,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    if (!projectId.trim()) throw new Error("Image Factory project_id is not configured");
    await openImageFactoryProject(page, projectId, () => {}, { projectName, abortSignal });
    await captureDiagnostic?.("persistent-chat-navigation-complete");
    let composer: Locator;
    try {
      composer = await withChatGptNavigationGuard(
        page, signal => this.activeComposer(page, 10_000, signal), abortSignal,
      );
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError || abortSignal?.aborted) throw error;
      throw new Error("ChatGPT web login is expired or the Image Factory project surface is unavailable");
    }
    await captureDiagnostic?.("persistent-composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertPersistentChatPage(page, projectId);
    await captureDiagnostic?.("persistent-session-verified");
    return composer;
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 50): Promise<void> {
    await page.evaluate(({ timeout, attributeFilter }) => new Promise<void>(resolveMutation => {
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolveMutation();
      };
      const observer = new MutationObserver(() => {
        if (settleTimer) return;
        // Let one React mutation batch finish before the next compact state read.
        settleTimer = setTimeout(finish, 16);
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter,
      });
      const timeoutTimer = setTimeout(finish, timeout);
    }), { timeout: timeoutMs, attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES] });
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    const domMutation = this.waitForTurnDomMutation(page);
    if (!externalProgress) {
      await withBrowserTurnAbort(domMutation, signal);
      return;
    }
    const progressWaitAbort = new AbortController();
    const progressSignal = signal
      ? AbortSignal.any([progressWaitAbort.signal, signal])
      : progressWaitAbort.signal;
    try {
      await withBrowserTurnAbort(Promise.race([
        domMutation,
        externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
      ]), signal);
    } finally {
      progressWaitAbort.abort();
    }
  }

  private async waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const progress = externalProgress?.snapshot();
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = await this.currentSubmissionAnswerText(page, baseline, signal);
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (progress && progress.lastToolBatchRevision > initialToolBatchRevision) return "mcp_tool_call";
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      // Until the new response is bound, last() can still be a historical failed answer.
      // Response errors are checked against the bound current turn in the observation loops.
      let evidence: ChatGptSubmissionEvidence | undefined;
      if (externalProgress) {
        const progressWaitAbort = new AbortController();
        const progressSignal = signal
          ? AbortSignal.any([progressWaitAbort.signal, signal])
          : progressWaitAbort.signal;
        try {
          const observed = await withBrowserTurnAbort(Promise.race([
            this.currentSubmissionEvidence(page, baseline, signal).then(value => ({ kind: "dom" as const, value })),
            externalProgress.waitForChange(progress?.revision ?? 0, progressSignal)
              .then(() => ({ kind: "external" as const })),
          ]), signal);
          if (observed.kind === "external") continue;
          evidence = observed.value;
        } finally {
          progressWaitAbort.abort();
        }
      } else {
        evidence = await this.currentSubmissionEvidence(page, baseline, signal);
      }
      if (evidence) return evidence;
      await this.waitForTurnDomOrExternalProgress(
        page,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState> {
    throwIfPromptAttachmentAborted(signal);
    const observed = await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(options => {
      type ObserverState = { id: string; revision: number; observer: MutationObserver };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_TURN_OBSERVER__?: ObserverState;
      };
      const observerState = scope.__CODEX_WEB_GPT_TURN_OBSERVER__ ??= (() => {
        const state: ObserverState = {
          id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
        };
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        return state;
      })();
      const observerKey = `${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      const identities = (elements: Element[], attribute: string): string[] => {
        const values = elements.map(element => element.getAttribute(attribute));
        if (values.some(value => typeof value !== "string" || value.trim().length === 0)) {
          throw new Error(`ChatGPT conversation turn has no stable ${attribute} identity`);
        }
        const typed = values as string[];
        if (new Set(typed).size !== typed.length) {
          throw new Error("ChatGPT exposed duplicate conversation turn identities");
        }
        return typed;
      };
      const visible = (element: Element): boolean => {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        const bounds = candidate.getBoundingClientRect();
        return candidate.isConnected
          && style.visibility !== "hidden"
          && (bounds.width > 0 || bounds.height > 0);
      };
      // data-testid contains a display index: ChatGPT can renumber it while the same turn lives.
      // Virtualization removes a turn's section, but retains its outer identity container.
      const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(element =>
        element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
          !== element.getAttribute("data-turn-id-container"));
      const turnIdentities = identities(containers, "data-turn-id-container");
      const userIdentities = identities([...document.querySelectorAll(options.userTurnSelector)], "data-turn-id");
      const responseIdentities = identities([...document.querySelectorAll(options.assistantTurnSelector)], "data-turn-id");
      const knownTurns = new Set(turnIdentities);
      if ([...userIdentities, ...responseIdentities].some(identity => !knownTurns.has(identity))) {
        throw new Error("ChatGPT conversation turn has no matching identity container");
      }
      return {
        key: observerKey,
        snapshot: {
          userTurnCount: userIdentities.length,
          assistantTurnCount: responseIdentities.length,
          visibleStopButtonCount: [...document.querySelectorAll(options.stopButtonSelector)].filter(visible).length,
          turnIdentities,
          userIdentities,
          responseIdentities,
        },
      };
    }, {
      userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
      stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    }), signal));
    const snapshot = observed.snapshot ?? cache?.snapshot;
    if (!snapshot) throw new Error("ChatGPT turn DOM revision cache has no baseline snapshot");
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    return snapshot;
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    return chatGptSubmissionEvidence({
      initialTurnIdentities: baseline.initialTurnIdentities,
      userIdentities: state.userIdentities,
      responseIdentities: state.responseIdentities,
      generationRunning: state.visibleStopButtonCount > 0,
    });
  }

  private async currentSubmissionAnswerText(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const identity = chatGptNewTurnIdentity(
      baseline.initialTurnIdentities,
      state.responseIdentities,
    );
    if (!identity) return "";
    const locator = page.locator(`[data-turn-id=${JSON.stringify(identity)}]`);
    return (await this.responseDomSnapshot(locator, {})).visibleText;
  }

  private async captureSubmissionBaseline(page: Page): Promise<ChatGptSubmissionBaseline> {
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const domCache: ChatGptSubmissionDomCache = {};
    const state = await this.submissionDomState(page, domCache);
    return {
      userTurns,
      responseTurns,
      initialTurnIdentities: state.turnIdentities,
      domCache,
    };
  }

  private async waitForNewAssistantTurn(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    graceMs: number = CHATGPT_RESPONSE_DOM_GRACE_MS,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptAssistantTurnBinding> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    let responseDeadline = Math.min(
      deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + graceMs,
    );
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (observationPage.isClosed()) throw chatGptBrowserTabClosedError();
      let progress = externalProgress?.snapshot();
      if (progress?.lastProgressAt !== undefined) {
        responseDeadline = Math.min(
          deadline ?? Number.POSITIVE_INFINITY,
          Math.max(responseDeadline, progress.lastProgressAt + graceMs),
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT web turn timed out");
      }
      await throwIfChatGptSessionFailureAlert(observationPage);
      await throwIfChatGptRateLimitDialog(observationPage);
      let state: ChatGptSubmissionDomState;
      try {
        state = await this.submissionDomState(
          observationPage,
          observationBaseline.domCache,
          signal,
        );
      } catch (error) {
        const latestProgress = externalProgress?.snapshot();
        if (error instanceof ChatGptBrowserObservationTimeoutError && recoverObservation) {
          recoveryAttempts += 1;
          if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
            throw new Error(
              `ChatGPT accepted the message, but its DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
              { cause: error },
            );
          }
          const recovered = await recoverObservation(
            recoveryAttempts,
            error,
            observationBaseline,
            signal,
          );
          observationPage = recovered.page;
          observationBaseline = recovered.baseline;
          continue;
        }
        if (!chatGptExternalProgressIsLive(latestProgress, Date.now(), graceMs)) throw error;
        await this.waitForTurnDomOrExternalProgress(
          observationPage,
          latestProgress?.revision ?? 0,
          externalProgress,
          signal,
        );
        continue;
      }
      recoveryAttempts = 0;
      // A tool batch can arrive while the DOM probe is in flight. Read progress again before
      // acknowledging its boundary; the pre-probe snapshot can otherwise leave the broker waiting
      // despite this exact iteration having successfully observed the page.
      progress = externalProgress?.snapshot();
      const identity = chatGptNewTurnIdentity(
        observationBaseline.initialTurnIdentities,
        state.responseIdentities,
      );
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = identity
          ? (await this.responseDomSnapshot(
            observationPage.locator(`[data-turn-id=${JSON.stringify(identity)}]`),
            {},
          )).visibleText
          : "";
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (identity) return {
        identity,
        locator: observationPage.locator(`[data-turn-id=${JSON.stringify(identity)}]`),
        acceptedTurnIdentities: state.turnIdentities,
      };
      // A delayed renderer wake can cross the grace while the assistant appears. Only a fresh
      // observation can prove it is still missing; the explicit turn deadline remains above.
      if (Date.now() >= responseDeadline
        && !chatGptExternalProgressSuppressesDomHealth(progress, Date.now())) {
        throw new Error("ChatGPT accepted the message but did not expose its assistant turn in the DOM");
      }
      await this.waitForTurnDomOrExternalProgress(
        observationPage,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    const boundCount = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(binding.locator.count(), signal),
    );
    if (boundCount === 1) return binding;
    if (boundCount > 1) {
      throw new Error(`ChatGPT exposed ${boundCount} DOM nodes for the bound assistant turn`);
    }
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const acceptedTurns = new Set(binding.acceptedTurnIdentities);
    if (state.userIdentities.some(identity => !acceptedTurns.has(identity))) {
      throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
    }
    const identity = chatGptReboundTurnIdentity(
      baseline.initialTurnIdentities,
      binding.identity,
      state.responseIdentities,
    );
    if (!identity || identity === binding.identity) return binding;
    return {
      identity,
      locator: page.locator(`[data-turn-id=${JSON.stringify(identity)}]`),
      acceptedTurnIdentities: state.turnIdentities,
    };
  }

  private async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill], [data-inline-selection-pill-cursor-target]',
      )
        .forEach(part => part.remove());
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 20_000, signal: abortSignal });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page, abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
      if (this.promptTextEquivalent(prompt, observed)) return;
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
        abortSignal,
      );
    }
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = this.promptEquivalentPrefixLength(prompt, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator('[data-id^="plugin:"][data-keyword]')
      .filter({ hasText: this.config.appName, visible: true });
  }

  private async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    const selected = this.selectedConnectorControl(composer);
    const keywords = await withBrowserTurnAbort(
      withChatGptBrowserObservationTimeout(selected.evaluateAll(elements => (
        elements.map(element => element.getAttribute("data-keyword"))
      ))),
      abortSignal,
    );
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private async connectorMentionRowTitles(
    menuRows: Locator,
    abortSignal?: AbortSignal,
  ): Promise<string[]> {
    let texts: string[];
    try {
      texts = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).allInnerTexts()),
        abortSignal,
      );
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      texts = [];
    }
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const titles = await this.connectorMentionRowTitles(menuRows, abortSignal);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && titles.includes(DEV_CHATGPT_CONNECTOR_NAME)) {
      return `ChatGPT exposes the isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)},`
        + ` but production requires a separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)};`
        + ` create ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the production tunnel and leave the DEV connector unchanged`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + `; create a connector with that exact name before retrying`;
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    await runChatGptPersonalizationCleanup(async (deadline, signal) => {
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      const timeoutMs = Math.max(1, deadline - Date.now());
      let composer = await this.activeComposer(page, timeoutMs, signal);
      await composer.focus({
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY, {
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await composer.press("Backspace", {
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
      composer = await this.activeComposer(page, Math.max(1, deadline - Date.now()), signal);
      let connectorSelected = await this.connectorIsSelected(composer, signal);
      let imageGenerationSelected = await this.imageGenerationToolIsSelected(composer, signal);

      // Inline ecosystem pills are contenteditable=false nodes. In a retained Image Factory
      // conversation ChatGPT can keep the previous picture_v2 pill after Send, and native
      // select-all/backspace only clears the editable text around it. Put the caret after the
      // retained pill and delete it through the editor before proving the composer is empty.
      if (connectorSelected || imageGenerationSelected) {
        await composer.focus({
          signal,
          timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
        });
        await composer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
          signal,
          timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
        });
        await composer.press("Backspace", {
          signal,
          timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
        });
        await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
        composer = await this.activeComposer(page, Math.max(1, deadline - Date.now()), signal);
        connectorSelected = await this.connectorIsSelected(composer, signal);
        imageGenerationSelected = await this.imageGenerationToolIsSelected(composer, signal);
      }

      const remainingMs = Math.max(1, deadline - Date.now());
      const remainingText = await composer.evaluate(
        element => element.textContent?.trim() ?? "",
        undefined,
        { timeout: remainingMs, signal },
      );
      if (remainingText.length > 0 || connectorSelected || imageGenerationSelected) {
        throw new Error(
          `ChatGPT connector cleanup did not produce an empty composer`
          + ` (visibleCharacters=${remainingText.length}, connectorSelected=${connectorSelected},`
          + ` imageGenerationSelected=${imageGenerationSelected})`,
        );
      }
    });
  }

  private selectedImageGenerationControl(composer: Locator): Locator {
    return composer
      .locator(CHATGPT_CREATE_IMAGE_PILL_SELECTOR)
      .filter({ visible: true });
  }

  private async imageGenerationToolIsSelected(
    composer: Locator,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const selected = this.selectedImageGenerationControl(composer);
    const values = await withBrowserTurnAbort(
      withChatGptBrowserObservationTimeout(selected.evaluateAll(elements => elements.map(element => ({
        id: element.getAttribute("data-id"),
        symbol: element.getAttribute("data-symbol"),
        keyword: element.getAttribute("data-keyword"),
        hint: element.getAttribute("data-system-hint-type"),
      })))),
      abortSignal,
    );
    if (values.length > 1) {
      throw new Error("ChatGPT composer exposed duplicate Create image selections");
    }
    return values.length === 1
      && values[0]!.id === "picture_v2"
      && values[0]!.symbol === "ecosystemMention"
      && values[0]!.keyword === CHATGPT_CREATE_IMAGE_MENU_TEXT
      && values[0]!.hint === "picture_v2";
  }

  private async selectImageGenerationTool(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    let mutationStarted = false;
    try {
      const retainedComposer = await this.activeComposer(page, 30_000, abortSignal);
      if (await this.imageGenerationToolIsSelected(retainedComposer, abortSignal)
        && await retainedComposer.locator('[data-id^="plugin:"][data-keyword]').count() === 0
        && !(await this.attachedPromptText(page, abortSignal)).trim()) {
        // A completed image turn leaves its tool pill selected. Reuse the verified pill only
        // when there is no prompt draft or connector to carry into the next submission.
        await captureDiagnostic?.("create-image-tool-reused");
        return retainedComposer;
      }
      await this.clearChatGptComposerState(page);
      let composer = await this.activeComposer(page, 30_000, abortSignal);
      await composer.fill("", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await composer.focus({
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
      mutationStarted = true;
      await composer.pressSequentially(CHATGPT_IMAGE_MENTION_QUERY, {
        delay: 25,
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await captureDiagnostic?.("create-image-mention-triggered");

      // Sidebar chats can also be named Create image and share the menu-item class.
      // Only the hydrated mention popup may supply the command being selected.
      const popup = page.locator('.popover[aria-busy="false"]').filter({ visible: true });
      const menuRows = popup.locator('.__menu-item[tabindex="0"]');
      const imageResult = menuRows.filter({
        has: page.getByText(CHATGPT_CREATE_IMAGE_MENU_TEXT, { exact: true }),
      });
      await imageResult.first().waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      await captureDiagnostic?.("create-image-menu-visible");
      if (await popup.count() !== 1 || await imageResult.count() !== 1) {
        throw new Error("ChatGPT @image menu did not expose one exact Create image row");
      }

      const rowHighlighted = async () => await imageResult.getAttribute("data-highlighted", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      }) !== null;
      if (!await rowHighlighted()) {
        const visibleRowCount = await withBrowserTurnAbort(
          withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
          abortSignal,
        );
        for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
          await composer.press("ArrowDown", {
            signal: abortSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
        }
      }
      if (!await rowHighlighted()) {
        throw new Error("ChatGPT @image menu could not highlight Create image");
      }
      await composer.press("Enter", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await captureDiagnostic?.("create-image-choice-activated");

      // Selecting Create image replaces the ProseMirror subtree. Re-resolve the active composer,
      // then prove the stable picture_v2 ecosystem pill before attaching any user prompt text.
      composer = await this.activeComposer(page, 30_000, abortSignal);
      const selected = this.selectedImageGenerationControl(composer);
      await selected.waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      if (!await this.imageGenerationToolIsSelected(composer, abortSignal)) {
        throw new Error("ChatGPT composer did not select the Create image tool");
      }
      await captureDiagnostic?.("create-image-tool-selected");
      return composer;
    } catch (error) {
      if (!mutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT Create image selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const capture = async (checkpoint: string): Promise<void> => {
      throwIfPromptAttachmentAborted(abortSignal);
      await withBrowserTurnAbort(captureDiagnostic?.(checkpoint) ?? Promise.resolve(), abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
    };
    let composer: Locator;
    const menuRows = page.locator('.__menu-item[tabindex="0"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    await ensureChatGptPersonalizedConnectorAccess(
      page,
      capture,
      async (personalizationSignal) => {
        let proofResult: boolean | undefined;
        let proofError: unknown;
        try {
          composer = await this.activeComposer(page, 30_000, personalizationSignal);
          await composer.fill("", {
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await composer.focus({
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await withBrowserTurnAbort(settleChatGptUi(), personalizationSignal);
          await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
            delay: 25,
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await capture("personalization-proof-mention-triggered");
          try {
            await appResult.waitFor({ state: "visible", timeout: 2_500, signal: personalizationSignal });
            proofResult = true;
            await capture("personalization-proof-menu-visible");
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
            proofResult = false;
            await capture("personalization-proof-menu-missing");
            const mention = await composer.evaluate(element => ({
              text: element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                ? element.value : element.textContent ?? "",
              focused: element === document.activeElement,
            }), undefined, { timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, signal: personalizationSignal });
            if (mention.text !== CHATGPT_CONNECTOR_MENTION_QUERY) {
              throw new ChatGptPromptAttachmentIntegrityError(
                `ChatGPT did not preserve the connector mention (expectedChars=${CHATGPT_CONNECTOR_MENTION_QUERY.length}, actualChars=${mention.text.length}, focused=${mention.focused})`,
              );
            }
          }
        } catch (error) {
          proofError = error;
        }
        try {
          await this.clearChatGptComposerState(page);
        } catch (cleanupError) {
          throw new ChatGptPersistentBrowserStateError(
            proofError !== undefined ? [proofError, cleanupError] : [cleanupError],
            "ChatGPT connector proof did not leave a verified empty composer",
          );
        }
        if (proofError !== undefined) throw proofError;
        return proofResult === true;
      },
      abortSignal,
    );
    try {
      composer = await this.activeComposer(page, 30_000, abortSignal);
      if (await this.connectorIsSelected(composer, abortSignal)) {
        await capture("connector-already-selected");
        return composer;
      }
      await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });

      let firstMenuCaptured = false;
      while (attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        composer = await this.activeComposer(page, 30_000, abortSignal);
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
          delay: 25,
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
        if (!firstMenuCaptured) {
          firstMenuCaptured = true;
          await capture("connector-mention-triggered");
        }
        try {
          await appResult.waitFor({
            state: "visible",
            timeout: 2_500,
            signal: abortSignal,
          });
          await capture("connector-menu-visible");
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          const visibleRows = await this.connectorMentionRowTitles(menuRows, abortSignal);
          const knownIdentityMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
            && (
              visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME)
              || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => visibleRows.includes(name))
            );
          if (knownIdentityMismatch) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal),
            );
          }
          if (
            catalogRefreshAvailable
            && visibleRows.length > 0
            && !visibleRows.includes(this.config.appName)
            && attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS
          ) {
            throw new ChatGptConnectorCatalogStaleError(
              this.config.appName,
              attemptBudget.triggerAttempts,
            );
          }
          if (attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal),
            );
          }
        }
      }
      const exactResultCount = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(appResult.count()),
        abortSignal,
      );
      if (exactResultCount !== 1) {
        throw chatGptConnectorUnavailableError(
          `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
          + ` after ${attemptBudget.triggerAttempts} complete mention trigger attempt(s)`,
        );
      }
      // Hidden launcher maintenance keeps a 1x1 Chromium viewport, so pointer activation cannot
      // reach this menu. Require the exact row to own ChatGPT's keyboard highlight first;
      // otherwise move the menu highlight until it does. Keep
      // focus on the composer, activate through the menu's real keyboard owner, then prove the exact
      // selected connector pill below.
      const rowHighlighted = async () => await appResult.getAttribute("data-highlighted", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      }) !== null;
      if (!await rowHighlighted()) {
        const visibleRowCount = await withBrowserTurnAbort(
          withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
          abortSignal,
        );
        for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
          await composer.press("ArrowDown", {
            signal: abortSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
        }
      }
      if (!await rowHighlighted()) {
        throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.config.appName)}`);
      }
      await composer.press("Enter", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await capture("connector-choice-activated");
      // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
      // again instead of returning the pre-selection locator, otherwise the real turn can focus a
      // detached/hidden editor even though verification just succeeded.
      const selectedComposer = await this.activeComposer(page, 30_000, abortSignal);
      const selectedConnector = this.selectedConnectorControl(selectedComposer);
      await selectedConnector.waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      if (!await this.connectorIsSelected(selectedComposer, abortSignal)) {
        throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
      }
      await capture("connector-selected");
      return selectedComposer;
    } catch (error) {
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT connector selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
    requireThink = false,
    requireImageGenerationTool = false,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const connectorMode = chatGptConnectorAttachmentMode(localTools, reuseConnector);
    let composerMutationStarted = false;
    try {
      if (requireImageGenerationTool) {
        if (localTools) throw new Error("Image Factory generation cannot share the composer with a connector selection");
        const selectedComposer = await this.selectImageGenerationTool(
          page,
          captureDiagnostic,
          abortSignal,
        );
        composerMutationStarted = true;
        if (requireThink) {
          await setChatGptThinkMode(selectedComposer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
        }
        await selectedComposer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await selectedComposer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
        await this.insertPromptText(page, ` ${prompt}`, abortSignal);
        await this.assertPromptAttached(page, prompt, abortSignal);
        const currentComposer = await this.activeComposer(page, 30_000, abortSignal);
        if (!await this.imageGenerationToolIsSelected(currentComposer, abortSignal)) {
          throw new Error("ChatGPT Create image tool disappeared while attaching the prompt");
        }
        return;
      }
      if (connectorMode !== "mention") {
        // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
        // collapse to the first paragraph on the launcher-owned Electron surface. Image Factory also
        // reuses this composer between submissions, and Lexical can retain the previous draft after
        // fill(""). For Browser-only turns, clear through native editor deletion and prove the
        // composer is empty before inserting the next prompt. Retained connector turns keep their
        // selected pill and continue to use fill("") for the text-only reset.
        if (connectorMode === "none") {
          await this.clearChatGptComposerState(page);
        }
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        composerMutationStarted = true;
        if (connectorMode === "retained") {
          await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        }
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        if (requireThink) {
          await setChatGptThinkMode(composer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
        }
        await this.insertPromptText(page, prompt, abortSignal);
        await this.assertPromptAttached(page, prompt, abortSignal);
        return;
      }
      const selectedComposer = await this.selectConnector(
        page,
        captureDiagnostic,
        catalogRefreshAvailable,
        connectorAttemptBudget,
        abortSignal,
      );
      // selectConnector owns and rolls back every mutation until it returns. From this point the
      // attachment owns the selected pill and prompt text as one transaction.
      composerMutationStarted = true;
      if (requireThink) {
        await setChatGptThinkMode(selectedComposer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
      }
      await selectedComposer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
      await selectedComposer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await this.insertPromptText(page, ` ${prompt}`, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
    } catch (error) {
      if (!composerMutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT prompt attachment failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async waitForSubmissionAcceptedWithRecovery(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptSubmissionEvidence> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    for (;;) {
      try {
        const evidence = await this.waitForSubmissionAccepted(
          observationPage,
          observationBaseline,
          abortSignal,
          externalProgress,
          initialToolBatchRevision,
          completionTracker,
        );
        return evidence;
      } catch (error) {
        if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !recoverObservation) throw error;
        recoveryAttempts += 1;
        if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
          throw new Error(
            `ChatGPT submission DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
            { cause: error },
          );
        }
        const recovered = await recoverObservation(
          recoveryAttempts,
          error,
          observationBaseline,
          abortSignal,
        );
        observationPage = recovered.page;
        observationBaseline = recovered.baseline;
      }
    }
  }

  private async sendAttachedPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    submissionLifecycle?: Pick<BrowserTurn, "onSendActivated" | "onSubmitted" | "persistentProjectId" | "nativeAuthority">,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
    attachmentGuard?: AttachmentGuard,
    requireImageGenerationTool = false,
  ): Promise<ChatGptSubmissionEvidence> {
    const composer = await this.activeComposer(page);
    if (requireImageGenerationTool && !await this.imageGenerationToolIsSelected(composer, abortSignal)) {
      throw new Error("ChatGPT Create image tool is not selected at Send time");
    }
    const form = composer.locator("xpath=ancestor::form[1]");
    const effectiveAttachmentGuard = attachmentGuard ?? await clearPromptAttachments({
      form,
      abortSignal,
      log: () => {},
    });
    const sendButton = form.getByTestId("send-button");
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    await settleChatGptUi();
    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
    for (;;) {
      if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      if (await sendButton.isEnabled()) break;
      if (Date.now() >= sendEnableDeadline) {
        await captureDiagnostic?.("send-disabled");
        throw new Error("ChatGPT send button remained disabled after the complete prompt was attached");
      }
      await settleChatGptUi();
    }
    await captureDiagnostic?.("send-ready");
    await effectiveAttachmentGuard.assertReady(abortSignal);
    const initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0;
    await submissionLifecycle?.nativeAuthority?.claim();
    await submissionLifecycle?.onSendActivated?.();
    await effectiveAttachmentGuard.assertReady(abortSignal);
    abortSignal?.throwIfAborted();
    await sendButton.press("Enter", {
      noWaitAfter: true,
      signal: abortSignal,
      // runStage owns the operation budget. A second Locator timeout would silently collapse the
      // 180-second Bigger Context budget back to the ordinary 20 seconds after Enter has already
      // submitted the message; semantic submission evidence below remains the authority.
      timeout: 0,
    });
    const evidence = await this.waitForSubmissionAcceptedWithRecovery(
      page,
      baseline,
      abortSignal,
      externalProgress,
      initialToolBatchRevision,
      completionTracker,
      recoverObservation,
    );
    const submittedUrl = submissionLifecycle?.persistentProjectId
      ? await withBrowserTurnAbort(
        waitForImageFactoryConversationUrl(page, submissionLifecycle.persistentProjectId),
        abortSignal,
      )
      : browserPageUrl(page);
    if (submissionLifecycle?.nativeAuthority) {
      const state = await this.submissionDomState(page, baseline.domCache, abortSignal);
      const userId = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities);
      if (!userId) throw new Error("native_user_turn_missing");
      await submissionLifecycle.nativeAuthority.submitted(userId, submittedUrl);
    }
    submissionLifecycle?.onSubmitted?.(submittedUrl);
    return evidence;
  }

  private async sendFollowUpPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    request: ChatGptFollowUpRequest,
    channel: ChatGptFollowUpChannel,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptSubmissionEvidence> {
    if (channel.isTerminal(request)) throw new Error("ChatGPT follow-up is no longer active");
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    const form = composer.locator("xpath=ancestor::form[1]");
    const attachmentGuard = await clearPromptAttachments({ form, abortSignal, log: () => {} });
    await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await this.insertPromptText(page, request.text, abortSignal);
    await this.assertPromptAttached(page, request.text, abortSignal);

    const sendButton = form.getByTestId("send-button");
    if (await sendButton.count() !== 1) {
      throw new Error("ChatGPT follow-up requires exactly one send-button in the active composer");
    }
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
    while (!await sendButton.isEnabled()) {
      throwIfPromptAttachmentAborted(abortSignal);
      if (Date.now() >= sendEnableDeadline) {
        throw new Error("ChatGPT follow-up send button remained disabled");
      }
      await settleChatGptUi();
    }
    if (channel.isTerminal(request)) throw new Error("ChatGPT follow-up expired before Send activation");
    await attachmentGuard.assertReady(abortSignal);
    const initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0;
    if (!channel.recordEvent({ type: "send_activated", requestId: request.requestId, revision: request.revision })) {
      throw new Error("ChatGPT follow-up Send activation is stale");
    }
    await attachmentGuard.assertReady(abortSignal);
    abortSignal?.throwIfAborted();
    await sendButton.press("Enter", {
      noWaitAfter: true,
      signal: abortSignal,
      timeout: 0,
    });
    const evidence = await this.waitForSubmissionAcceptedWithRecovery(
      page,
      baseline,
      abortSignal,
      externalProgress,
      initialToolBatchRevision,
      completionTracker,
      recoverObservation,
    );
    if (!channel.recordEvent({
      type: "submitted",
      requestId: request.requestId,
      revision: request.revision,
      ...(browserPageUrl(page) ? { conversationUrl: browserPageUrl(page) } : {}),
    })) {
      throw new Error("ChatGPT follow-up submission evidence is stale");
    }
    return evidence;
  }

  private async sendImageEditPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    source: OutputImageSource,
    prompt: string,
    abortSignal?: AbortSignal,
    submissionLifecycle?: Pick<BrowserTurn, "onSendActivated" | "onSubmitted" | "persistentProjectId" | "nativeAuthority">,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptSubmissionEvidence> {
    if (!source.assistantTurnId || !source.candidateKey || (!source.cardId && !source.fileIdentity)) {
      throw new Error("Image edit source provenance is incomplete");
    }
    const sourceMatches = (candidate: Awaited<ReturnType<typeof detectOutputImages>>[number]) =>
      (!!source.cardId && candidate.cardId === source.cardId)
      || (!!source.fileIdentity && candidate.fileIdentity === source.fileIdentity);
    let sourceTurn = page.locator(`[data-turn-id=${JSON.stringify(source.assistantTurnId)}]`);
    let resolvedAssistantTurnId = source.assistantTurnId;
    const directMatches = await sourceTurn.count() === 1
      && (await detectOutputImages(sourceTurn)).some(sourceMatches);
    if (!directMatches) {
      const assistantTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
      const matches: Array<{ locator: Locator; assistantTurnId: string }> = [];
      for (let index = 0, count = await assistantTurns.count(); index < count; index += 1) {
        const turn = assistantTurns.nth(index);
        if (!(await detectOutputImages(turn)).some(sourceMatches)) continue;
        const assistantTurnId = await turn.getAttribute("data-turn-id");
        if (!assistantTurnId) continue;
        matches.push({ locator: turn, assistantTurnId });
      }
      if (matches.length !== 1) {
        throw new Error(matches.length === 0
          ? "Image edit source assistant turn is unavailable"
          : "Image edit source assistant turn is ambiguous");
      }
      sourceTurn = matches[0]!.locator;
      resolvedAssistantTurnId = matches[0]!.assistantTurnId;
    }
    const budget = new ImageTransferDeadline(Date.now() + 60_000, abortSignal);
    const log = imageTransferLog(`edit_${source.submissionId ?? source.assistantTurnId}`, source.jobId);
    const viewer = await openBoundImageViewer({
      page,
      responseTurn: sourceTurn,
      candidate: {
        key: source.candidateKey,
        cardId: source.cardId,
        fileIdentity: source.fileIdentity,
        assistantTurnId: resolvedAssistantTurnId,
        readiness: "ready",
      },
      budget,
      log,
    });
    try {
      await viewer.assertCurrent();
      // The image editor's visible placeholder is presentation text and is not consistently
      // reflected into aria/data-placeholder attributes. The viewer has already been bound to the
      // exact source image, so bind the composer structurally inside that viewer instead: one
      // visible contenteditable whose nearest form owns the image-edit send button.
      const editors = viewer.scope.locator('form [contenteditable="true"]');
      const visibleEditors: Locator[] = [];
      for (let index = 0, count = await budget.observe(editors.count()); index < count; index += 1) {
        const editor = editors.nth(index);
        if (await budget.observe(editor.isVisible())) visibleEditors.push(editor);
      }
      if (visibleEditors.length !== 1) throw new Error("Image edit composer is unavailable or ambiguous");
      const editor = visibleEditors[0]!;
      const form = editor.locator("xpath=ancestor::form[1]");
      if (await budget.observe(form.count()) !== 1 || !await budget.observe(form.isVisible())) {
        throw new Error("Image edit Describe edits form is unavailable or ambiguous");
      }
      const send = form.getByTestId("send-button");
      if (await budget.observe(send.count()) !== 1 || !await budget.observe(send.isVisible())) {
        throw new Error("Image edit send button is unavailable or ambiguous");
      }
      await editor.focus({ timeout: Math.min(5_000, budget.remaining()) });
      await editor.fill(prompt, { timeout: Math.min(10_000, budget.remaining()) });
      const typed = (await budget.observe(editor.innerText())).replace(/\u00a0/g, " ").trim();
      if (typed !== prompt.trim()) throw new Error("Image edit prompt did not round-trip through Describe edits");
      const sendEnableDeadline = Math.min(budget.deadlineAt, Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS);
      while (!await budget.observe(send.isEnabled())) {
        if (Date.now() >= sendEnableDeadline) throw new Error("Image edit send button remained disabled");
        await budget.pause();
      }
      const initialToolBatchRevision = 0;
      await submissionLifecycle?.nativeAuthority?.claim();
    await submissionLifecycle?.onSendActivated?.();
      abortSignal?.throwIfAborted();
      await send.press("Enter", { noWaitAfter: true, signal: abortSignal, timeout: 0 });
      const evidence = await this.waitForSubmissionAcceptedWithRecovery(
        page,
        baseline,
        abortSignal,
        undefined,
        initialToolBatchRevision,
        completionTracker,
        recoverObservation,
      );
      const state = await this.submissionDomState(page, baseline.domCache, abortSignal);
      const userTurnId = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities);
      if (!userTurnId) throw new Error("Image edit submission has no new user turn");
      const userTurn = page.locator(`[data-turn-id=${JSON.stringify(userTurnId)}]`);
      // The user message commits before ChatGPT hydrates its Edited image thumbnail.
      // Do not abort an accepted edit while the source reference is still rendering.
      await userTurn.locator('img, [data-file-id], [data-asset-id], [data-testid*="image"]').first()
        .waitFor({ state: "attached", timeout: 10_000, signal: abortSignal });
      const submittedUrl = submissionLifecycle?.persistentProjectId
        ? await withBrowserTurnAbort(
          waitForImageFactoryConversationUrl(page, submissionLifecycle.persistentProjectId),
          abortSignal,
        )
        : browserPageUrl(page);
      await submissionLifecycle?.nativeAuthority?.submitted(userTurnId, submittedUrl);
      submissionLifecycle?.onSubmitted?.(submittedUrl);
      return evidence;
    } finally {
      await viewer.close();
      budget.dispose();
    }
  }

  private async waitForMultipartAcknowledgement(
    page: Page,
    initialResponseTurn: ChatGptAssistantTurnBinding,
    submissionBaseline: ChatGptSubmissionBaseline,
    stage: ChatGptWebMultipartStage,
    deadline: number | undefined,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    completionTracker = new ChatGptCompletionTracker(),
  ): Promise<void> {
    // A staged message may briefly create an assistant shell and then replace it while ChatGPT
    // ingests the attached context. The ordinary 60-second missing-response verdict would cut the
    // dedicated multipart acknowledgement budget back down after that transient shell appears.
    // Keep DOM absence bounded by the same per-stage budget that owns this protocol step.
    const domHealthTracker = new ChatGptTurnDomHealthTracker(
      CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
    );
    const responseDomCache: ChatGptResponseDomCache = {};
    let responseTurn = initialResponseTurn;
    for (;;) {
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      if (abortSignal?.aborted) {
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
        throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT Bigger Context transaction timed out while awaiting a stage acknowledgement");
      }
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn.locator);
      let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
      if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {
        const rebound = await this.reconcileAssistantTurnBinding(
          page,
          submissionBaseline,
          responseTurn,
          abortSignal,
        );
        if (rebound.identity !== responseTurn.identity) {
          responseTurn = rebound;
          responseDomCache.key = undefined;
          responseDomCache.snapshot = undefined;
          snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        }
      }
      if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
      const externalProgressSnapshot = externalProgress?.snapshot();
      if (externalProgress
        && externalProgressSnapshot
        && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
        completionTracker.observeToolBatch(
          externalProgressSnapshot.lastToolBatchRevision,
          snapshot.visibleText,
        );
        await externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
      }
      const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
        externalProgressSnapshot,
        Date.now(),
      );
      const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
      if (!snapshot.responsePresent && externalProgressLive) {
        // Proven MCP activity outranks a momentarily unavailable staging DOM, exactly as it does
        // in the main turn loop.
        domHealthTracker.clearMissingResponse();
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
        continue;
      }
      const running = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
      });
      if (domError) throw new Error(domError);
      if (completionTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        currentHtml: snapshot.fullHtml,
        completionActionVisible: snapshot.completionActionVisible,
        externalToolCallsInFlight,
      })) {
        const actual = snapshot.visibleText.trim();
        if (actual !== stage.acknowledgement) {
          throw new ChatGptWebAdapterError(
            "ChatGPT did not confirm the Bigger Context handoff. Disable Bigger Context or retry the task.",
            {
              status: 502,
              errorType: "server_error",
              code: "multipart_protocol_violation",
              retryable: false,
              cause: new Error(
                `Bigger Context acknowledgement mismatch (actualChars=${actual.length.toLocaleString("en-US")})`,
              ),
            },
          );
        }
        return;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
  }

  private async resetCompactionComposerForRetry(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const before = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (before) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT changed while the compaction prompt was being prepared. Check the ChatGPT tab before retrying.",
        new Error(`Submission evidence appeared after prompt attachment failed: ${before}`),
      );
    }

    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
    throwIfPromptAttachmentAborted(abortSignal);

    const after = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (after) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT changed while the compaction prompt was being reset. Check the ChatGPT tab before retrying.",
        new Error(`Submission evidence appeared while resetting the prompt: ${after}`),
      );
    }
    const observed = await this.attachedPromptText(page, abortSignal);
    if (observed.length > 0) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT composer could not reset cleanly for compaction retry (actualChars=${observed.length})`,
      );
    }
  }

  private async attachPromptWithCompactionRetry(
    page: Page,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
    requireThink = false,
    requireImageGenerationTool = false,
  ): Promise<void> {
    let retryAvailable = compaction;
    for (;;) {
      try {
        await this.attachPrompt(
          page,
          prompt,
          localTools,
          captureDiagnostic,
          abortSignal,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          reuseConnector,
          requireThink,
          requireImageGenerationTool,
        );
        return;
      } catch (error) {
        if (!retryAvailable || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
        retryAvailable = false;
        const evidence = await this.currentSubmissionEvidence(page, baseline, abortSignal);
        if (evidence) {
          throw new ChatGptPromptAttachmentIntegrityError(
            "ChatGPT changed while the compaction prompt was being prepared. Check the ChatGPT tab before retrying.",
            new Error(`Prompt attachment failed before submission evidence appeared: ${evidence}`, { cause: error }),
          );
        }
        await captureDiagnostic?.("prompt-attachment-integrity-retry");
        await this.resetCompactionComposerForRetry(page, baseline, abortSignal);
      }
    }
  }

  private async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    // CDP Input.insertText is interpreted as live typing by ChatGPT's Lexical plugins. On a large
    // JSON transport it can turn literal Markdown backticks into rich code nodes, remove the
    // delimiters from textContent, and leave the next insertion outside the intended block. The
    // browser's plain-text editing command updates the same focused contenteditable atomically
    // without running those Markdown shortcuts. Exact readback below remains the authority.
    const inserted = await composer.evaluate(insertPlainTextIntoComposer, text, {
      timeout: 20_000,
      signal: abortSignal,
    });
    throwIfPromptAttachmentAborted(abortSignal);
    if (!inserted) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT composer rejected the plain-text editing command",
      );
    }
  }

  private async verifyConnectorExclusive(
    traceId = `verify_${randomUUID().replaceAll("-", "")}`,
  ): Promise<string> {
    const page = await this.ensurePage();
    const diagnostics = new ChatGptBrowserDiagnostics(
      traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      this.config.appName,
    );
    const captureDiagnostic = (checkpoint: string): Promise<void> => diagnostics.capture(page, checkpoint);
    try {
      await captureDiagnostic("connector-verification-started");
      await this.prepareTemporaryChatSurface(page, captureDiagnostic);
      // The launcher refreshes its owned ChatGPT document before starting this helper. A second
      // reload here can discard the first catalog's exact mismatch evidence and report a generic
      // menu failure instead of identifying the connector the account actually exposes.
      await this.selectConnector(page, captureDiagnostic);
      // Verification proves selection but does not submit a turn. Leaving the selected plugin in
      // ChatGPT's persisted composer draft makes the next hard refresh restore half-hydrated plugin
      // state; clearing it through native editor deletion keeps repeated verification transactional.
      await this.clearChatGptComposerState(page);
      await captureDiagnostic("connector-verification-cleared");
      await captureDiagnostic("connector-verification-succeeded");
      return this.config.appName;
    } catch (error) {
      await diagnostics.capture(page, "connector-verification-failed", error);
      throw error;
    }
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt, abortSignal: AbortSignal, log: ImageTransferLog): Promise<AttachmentGuard> {
    const files = chatGptPromptFilePayloads(prompt);
    abortSignal.throwIfAborted();
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const emptyGuard = await clearPromptAttachments({ form: composerForm, abortSignal, log });
    if (files.length === 0) {
      log("attachments_skipped", { referenceCount: 0, attachmentCount: 0 });
      return emptyGuard;
    }
    return attachPromptFiles({ page, form: composerForm, files, abortSignal, log });
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    cache?: ChatGptResponseDomCache,
  ): Promise<ChatGptResponseDomSnapshot> {
    const observed = await responseTurn.evaluate((element, options) => {
      const root = element as HTMLElement;
      type ObserverState = { id: number; revision: number; observer: MutationObserver };
      type ObserverRegistry = { documentId: string; nextId: number; states: WeakMap<Element, ObserverState> };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_RESPONSE_OBSERVERS__?: ObserverRegistry;
      };
      const registry = scope.__CODEX_WEB_GPT_RESPONSE_OBSERVERS__ ??= {
        documentId: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
        nextId: 0,
        states: new WeakMap<Element, ObserverState>(),
      };
      let observerState = registry.states.get(root);
      if (!observerState) {
        observerState = {
          id: ++registry.nextId,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
        };
        const state = observerState;
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        registry.states.set(root, state);
      }
      const observerKey = `${registry.documentId}:${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        return candidate.isConnected
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };

      // ChatGPT uses the same Markdown renderer for intermediate commentary and for the final
      // answer. Older responses nested commentary in the streaming-status container. Pro can also
      // render a completed commentary Markdown root immediately before that live status container.
      // Final-answer Markdown follows the live status instead, so DOM order remains the semantic
      // boundary without relying on localized labels such as "Pro thinking".
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(renderedInDom);
      const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")]
        .filter(renderedInDom);
      // CHATGPT_COMMENTARY_CLASSIFIER_BEGIN
      // Self-contained so the test suite can execute this exact source against a synthetic DOM;
      // it must not close over anything from the surrounding evaluate scope.
      const selectChatGptAnswerRoots = (
        markdownRoots: HTMLElement[],
        statusContainers: HTMLElement[],
      ): { commentaryRoots: HTMLElement[]; answerRoots: HTMLElement[] } => {
        const firstStatusContainer = statusContainers[0];
        const commentary = markdownRoots.filter(candidate => (
          candidate.closest("[data-streaming-response-status]") !== null
          // Chain-of-thought components carry reasoning, never the final answer, so containment is
          // a position-independent commentary signal. Position alone cannot separate "commentary
          // between two status containers" from "answer between two tool calls".
          || candidate.closest('[data-testid^="cot-v5"]') !== null
          // Only Markdown that precedes the FIRST status container is prior commentary. Keying
          // this on "some status follows me" silently reclassified answer text as commentary as
          // soon as a second tool call opened another status container below it, which both zeroed
          // the visible text and dropped every answer chunk emitted between tool calls.
          || (firstStatusContainer !== undefined && Boolean(
            // 4 is Node.DOCUMENT_POSITION_FOLLOWING, inlined to keep this function standalone.
            candidate.compareDocumentPosition(firstStatusContainer) & 4,
          ))
        ));
        return {
          commentaryRoots: commentary,
          answerRoots: markdownRoots.filter(candidate => !commentary.includes(candidate)),
        };
      };
      // CHATGPT_COMMENTARY_CLASSIFIER_END
      const classified = selectChatGptAnswerRoots(allMarkdownRoots, streamingStatusContainers);
      const commentaryRoots = classified.commentaryRoots;
      // Image-only answers have no `.markdown` root. Generated cards participate in completion
      // binding, but their controls (for example "Edit") are UI and must never become answer text.
      const projectedAnswerRoots = classified.answerRoots;
      const imageAnswerRoots = [...root.querySelectorAll<HTMLElement>(options.generatedImageCardSelector)]
        .filter(renderedInDom);
      const completionRoots = [...projectedAnswerRoots, ...imageAnswerRoots];
      // CHATGPT_MARKDOWN_CONTENT_BEGIN
      const chatGptMarkdownContent = (markdownRoot: HTMLElement): HTMLElement => {
        const content = markdownRoot.cloneNode(true) as HTMLElement;
        // These are embedded renderers, not Markdown answer text. Their loading labels, controls
        // and plot axes change independently of generation (including after a later paragraph).
        // Keep their UI out of both the emitted HTML and the text consistency fingerprint.
        // Also remove the controls/media already excluded by chatGptHtmlToMarkdown, so their
        // accessibility labels cannot become consistency fingerprints for untransmitted text.
        // Ordinary code blocks, surrounding prose and the original observed DOM remain intact.
        for (const widget of Array.from(content.querySelectorAll(
          ".chart-widget-container, [data-code-block-preview-pane], button, script, style, svg, img, picture, source",
        ))) widget.remove();
        return content;
      };
      // ChatGPT may merge adjacent `.markdown` roots or virtualize an earlier prefix while a streamed
      // answer is finalized. Root boundaries and visible indices therefore are not identity:
      // flatten semantic blocks and preserve ChatGPT's source ranges across that reparenting.
      const flattenedMarkdownSegments: Array<{
        tag: string;
        html: string;
        text: string;
        group?: string;
        sourceStart?: number;
        sourceEnd?: number;
      }> = [];
      const blockMarkdownTags = new Set([
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
        "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
      ]);
      const markdownText = (element: HTMLElement): string => {
        // Detached content has no layout-derived innerText. Preserve textual line boundaries
        // explicitly: plain textContent would conflate "A<br>B" with "AB" in the guard.
        const parts: string[] = [];
        const blockBoundary = () => {
          if (parts.length > 0 && !parts.at(-1)!.endsWith("\n")) parts.push("\n");
        };
        const visit = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
          if (!(node instanceof HTMLElement)) return;
          const tag = node.tagName.toLowerCase();
          const block = blockMarkdownTags.has(tag);
          if (block) blockBoundary();
          if (tag === "br") parts.push("\n");
          node.childNodes.forEach(visit);
          if (block) blockBoundary();
        };
        visit(element);
        return parts.join("").trim();
      };
      // CHATGPT_MARKDOWN_CONTENT_END
      let listGroupIndex = 0;
      const sourceRange = (candidate: Element): { sourceStart: number; sourceEnd: number } | undefined => {
        const startAttribute = candidate.getAttribute("data-start");
        const endAttribute = candidate.getAttribute("data-end");
        if (startAttribute === null || endAttribute === null) return undefined;
        if (!startAttribute.trim() || !endAttribute.trim()) return undefined;
        const sourceStart = Number(startAttribute);
        const sourceEnd = Number(endAttribute);
        return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
          ? { sourceStart, sourceEnd }
          : undefined;
      };
      const appendBlockSegment = (child: HTMLElement) => {
        const tag = child.tagName.toLowerCase();
        const childRange = sourceRange(child);
        const listItems = tag === "ol" || tag === "ul"
          ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
          : [];
        if (listItems.length === 0) {
          flattenedMarkdownSegments.push({
            tag,
            html: child.outerHTML,
            text: markdownText(child),
            ...childRange,
          });
          return;
        }

        const group = childRange
          ? `list:${childRange.sourceStart}:${tag}`
          : `list:${listGroupIndex++}:${tag}`;
        const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
        listItems.forEach((item, itemIndex) => {
          const shell = child.cloneNode(false) as HTMLElement;
          shell.removeAttribute("data-is-last-node");
          if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
            shell.setAttribute("start", String(orderedStart + itemIndex));
          }
          shell.append(item.cloneNode(true));
          flattenedMarkdownSegments.push({
            tag: `${tag}:item`,
            html: shell.outerHTML,
            text: markdownText(item),
            group,
            ...sourceRange(item),
          });
        });
      };
      projectedAnswerRoots.map(chatGptMarkdownContent).forEach((markdownRoot) => {
        const children = [...markdownRoot.children] as HTMLElement[];
        const hasBlockChildren = children.some(child => blockMarkdownTags.has(child.tagName.toLowerCase()));
        if (!hasBlockChildren) {
          if (markdownRoot.innerHTML.trim()) flattenedMarkdownSegments.push({
            tag: "root",
            html: markdownRoot.innerHTML,
            text: markdownText(markdownRoot),
            ...sourceRange(markdownRoot),
          });
          return;
        }

        let inlineRun: Node[] = [];
        const flushInlineRun = () => {
          if (inlineRun.length === 0) return;
          const nodes = inlineRun;
          inlineRun = [];
          const shell = document.createElement("span");
          nodes.forEach(node => shell.append(node.cloneNode(true)));
          const text = markdownText(shell);
          if (text) {
            const rangedElements = nodes.flatMap(node => node instanceof Element
              ? [node, ...node.querySelectorAll<HTMLElement>("[data-start][data-end]")]
              : []);
            const ranges = rangedElements
              .map(sourceRange)
              .filter((range): range is { sourceStart: number; sourceEnd: number } => range !== undefined);
            flattenedMarkdownSegments.push({
              tag: "inline",
              html: shell.outerHTML,
              text,
              ...(ranges.length > 0 ? {
                sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
                sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
              } : {}),
            });
          }
        };

        markdownRoot.childNodes.forEach((node) => {
          if (node instanceof HTMLElement && blockMarkdownTags.has(node.tagName.toLowerCase())) {
            flushInlineRun();
            appendBlockSegment(node);
            return;
          }
          inlineRun.push(node);
        });
        flushInlineRun();
      });
      const markdownSegments = flattenedMarkdownSegments.map((segment, index, segments) => ({
        key: segment.sourceStart !== undefined
          ? `${segment.sourceStart}:${segment.tag}`
          : `${index}:${segment.tag}`,
        tag: segment.tag,
        html: segment.html,
        text: segment.text,
        ...(segment.group ? { group: segment.group } : {}),
        ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
        ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
        streamable: index < segments.length - 1,
      }));
      const rendered = completionRoots.at(-1);
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(options.completionActionSelector)]
          .filter(renderedInDom)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      completionRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => completionRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        // Current cot-v5 action rows expose the semantic text on their item anchor while the
        // discoverable data-testid lives on a textless icon below it. Promote that descendant to
        // the owned row; otherwise every non-button action is silently filtered as empty text.
        return candidate.closest<HTMLElement>("button")
          ?? candidate.closest<HTMLElement>("[data-item-anchor]")
          ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      const hasFollowingRenderedSibling = (candidate: HTMLElement): boolean => {
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        for (
          let sibling = itemAnchor?.nextElementSibling;
          sibling;
          sibling = sibling.nextElementSibling
        ) {
          if (sibling instanceof HTMLElement && renderedInDom(sibling) && sibling.innerText.trim()) {
            return true;
          }
        }
        return false;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => renderedInDom(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          ...(kind === "commentary" ? { complete: hasFollowingRenderedSibling(candidate) } : {}),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null,
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...(block.kind === "commentary" ? {
          complete: block.complete === true || index < blocks.length - 1,
        } : {}),
      }));
      const stoppedThinkingVisible = (() => {
        // Only ChatGPT UI in the bound response may terminate the turn. A model quoting this
        // phrase in its answer or reasoning is ordinary content, not a stopped-thinking status.
        const isStatus = (candidate: HTMLElement): boolean => {
          if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)
            || candidate.closest("pre, code, blockquote")) return false;
          for (let element: HTMLElement | null = candidate; element; element = element.parentElement) {
            if (!renderedInDom(element)) return false;
          }
          return true;
        };
        const ariaMatch = [...root.querySelectorAll<HTMLElement>('[aria-label="Stopped thinking"]')]
          .some(isStatus);
        if (ariaMatch) return true;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.replace(/\s+/g, " ").trim() !== "Stopped thinking") continue;
          const parent = node.parentElement;
          if (parent && isStatus(parent)) return true;
        }
        return false;
      })();
      return {
        key: observerKey,
        snapshot: {
          responsePresent: true,
          visibleText: projectedAnswerRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
          fullHtml: projectedAnswerRoots.map(candidate => candidate.innerHTML).join(""),
          markdownSegments,
          completionActionVisible: completionAction !== undefined,
          stoppedThinkingVisible,
          traceBlocks,
          // Card identity is enough to classify an image-only assistant response before a hidden
          // Electron view hydrates the preview URL. outputImageSignature below enriches this when
          // source/readiness becomes available without making lazy loading a completion gate.
          generatedImageKeys: imageAnswerRoots.map(candidate => `card:${candidate.id}`),
        },
      };
    }, {
      completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
      generatedImageCardSelector: CHATGPT_GENERATED_IMAGE_CARD_SELECTOR,
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    }, { timeout: 2_000 }).catch(() => undefined);
    if (!observed) {
      if (responseTurn.page().isClosed()) {
        throw chatGptBrowserTabClosedError();
      }
      return absentResponseDomSnapshot();
    }
    const snapshot = observed.snapshot ?? cache?.snapshot ?? absentResponseDomSnapshot();
    // Image payload state is intentionally kept out of the Markdown projection. It participates
    // only in completion so image-only replies are first-class responses.
    if (snapshot.responsePresent) {
      const generatedImageSignature = await outputImageSignature(responseTurn).catch(() => []);
      if (generatedImageSignature.length > 0) snapshot.generatedImageKeys = generatedImageSignature;
    }
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          }));
        return {
          textChars: (root.innerText ?? root.textContent ?? "").trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    const nativeAbort = new AbortController();
    if (turn.nativeBinding) {
      turn = { ...turn, abortSignal: turn.abortSignal ? AbortSignal.any([turn.abortSignal, nativeAbort.signal]) : nativeAbort.signal };
      if (this.config.browserHost !== "launcher" || !readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!).features?.includes(NATIVE_AUTHORITY_PROTOCOL)) {
        throw new Error("native_launcher_restart_required");
      }
      turn.nativeAuthority = new NativeBrowserAuthority(turn.nativeBinding!);
      await turn.nativeAuthority.admit(Boolean(turn.nativeImageReconcile));
    }
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (this.config.browserHost !== "launcher") return this.runBrowserTurn(turn);
    if (turn.executionTarget?.output === "image" || turn.requireOutputArtifact) {
      assertLauncherImageDownloadSupport(this.config.browserHostDescriptorPath!);
    }

    const acquireLease = () => notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "start",
        ...(turn.nativeBinding ? { nativeScope: turn.nativeBinding.scope } : {}),
        traceId: turn.traceId,
        helperPid: process.pid,
        ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
        ...((turn.conversationKey
          && !turn.skipConnectorIdentity
          && (turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation))
          ? { connectorIdentity: this.config.appName }
          : {}),
        ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
        ...(turn.resumeConversationUrl ? {
          resumeConversationUrl: turn.resumeConversationUrl,
          ...(turn.persistentProjectId ? { persistentProjectId: turn.persistentProjectId } : {}),
        } : {}),
      }).catch(error => {
        if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
        if (error instanceof LauncherRetainedConversationUnavailableError) {
          throw chatGptRetainedConversationUnavailableError();
        }
        throw error;
      });
    const lease = await acquireLease();
    const surfaceId = lease.surfaceId;
    if (turn.nativeAuthority) turn.nativeAuthority.surface(lease.tabId!, surfaceId!, turn.conversationKey ?? turn.nativeBinding!.requestSha256);
    const reused = lease.reused === true;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void turn.nativeAuthority?.heartbeat().catch(error => nativeAbort.abort(error));
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };
    try {
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      if (turn.requireRetainedConversation && !reused) {
        throw chatGptRetainedConversationUnavailableError();
      }
      if (reused && !turn.prepareResume) {
        throw new Error("Launcher reused a ChatGPT conversation without a continuation prompt");
      }
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      sendHeartbeat();
      await this.preparePrompt(turn, () => Promise.resolve(turn.onPreparedSelected?.(reused)));
      return await this.runBrowserTurn(turn, surfaceId, undefined, reused);
    } catch (error) {
      originalError = error;
      terminal = error instanceof ChatGptCompactionHandoffAccepted
        ? "completed"
        : (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
        ? "aborted"
        : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        const release = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminalMessage ? { message: terminalMessage } : {}),
          ...(terminal === "completed" && turn.retainConversation && !turn.nativeBinding ? { retain: true } : {}),
          ...(terminal === "completed" && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
            ? { connectorBound: true }
            : {}),
        });
        if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
      } catch (controlError) {
        if (controlError instanceof ChatGptWebAdapterError && controlError.code === "client_cancelled") {
          throw controlError;
        }
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  }

  private async preparePrompt<T>(turn: BrowserTurn, action: () => Promise<T>): Promise<T> {
    try {
      return await this.runStage(turn.traceId, "prompt_preparation", browserStageTimeouts.promptPreparation, signal => (
        withBrowserTurnAbort(action(), turn.abortSignal ? AbortSignal.any([signal, turn.abortSignal]) : signal)
      ));
    } catch (error) {
      if (error instanceof Error && error.message === "ChatGPT browser stage timed out: prompt_preparation") {
        throw new ChatGptWebAdapterError(
          "ChatGPT prompt preparation timed out before submission. The prompt was not sent; inspect the context size or retry after the runtime recovers.",
          { status: 504, errorType: "server_error", code: "prompt_preparation_timeout", retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation = false,
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const executionTarget = turn.executionTarget ?? { output: "text" as const, surface: "temporary" as const };
    if (executionTarget.output === "image"
      && (executionTarget.surface !== "persistent"
        || executionTarget.projectId !== turn.persistentProjectId
        || executionTarget.imageSessionId.length === 0)) {
      throw new Error("Image execution target does not match the persistent Image Factory surface");
    }
    if (executionTarget.output === "text" && executionTarget.surface !== "temporary") {
      throw new Error("Text execution targets must use Temporary Chat");
    }
    if (turn.surface === "persistent" && !turn.persistentProjectId) {
      throw new Error("Persistent ChatGPT turns require an Image Factory project id");
    }
    if ((turn.externalProgress !== undefined) !== (turn.completionFence !== undefined)) {
      throw new Error("Tool-capable ChatGPT turns require both progress and terminal-fence transports");
    }
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const browserCapabilities = turn.nativeConnector
      ? { ...turn.capabilities, localToolsEnabled: true }
      : turn.capabilities;
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, browserCapabilities);
    const prepare = reuseConversation ? turn.prepareResume : turn.prepare;
    if (!prepare) throw new Error("The retained ChatGPT conversation has no continuation prompt");
    const prepared = await this.preparePrompt(turn, prepare);
    if (turn.nativeAuthority) {
      if (prepared.multipart) throw new Error("native_multipart_requires_separate_bound_requests");
      if (turn.nativeImageReconcile) await turn.nativeAuthority.prepareReconcile(turn.nativeImageReconcile);
      else await turn.nativeAuthority.prepare(prepared.text, turn.reasoning ?? "");
    }
    const diagnostics = new ChatGptBrowserDiagnostics(
      turn.traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      this.config.appName,
    );
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    let releaseFollowUp: (() => void) | undefined;
    let releaseNetworkDiagnostics: (() => void) | undefined;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const multipartTransactionId = prepared.multipart
        ? `ctx_${randomUUID().replaceAll("-", "")}`
        : undefined;
      const multipartStages = prepared.multipart && multipartTransactionId
        ? prepared.multipart.parts.slice(0, -1).map((payload, index) => formatChatGptWebMultipartStage(
          payload,
          multipartTransactionId,
          index + 1,
          prepared.multipart!.parts.length,
        ))
        : undefined;
      const multipartFinalPrompt = prepared.multipart && multipartTransactionId
        ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
        : undefined;
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      const attachmentBytes = chatGptPromptFilePayloads(prepared)
        .reduce((total, file) => total + file.buffer.length, 0);
      const maxMessageChars = compiledChatGptWebMaxMessageChars(prepared);
      const maxStageMessageTokens = multipartStages
        ? Math.max(...multipartStages.map(stage => estimateTokens(stage.text, turn.modelId)))
        : undefined;
      const maxStageChars = multipartStages
        ? Math.max(...multipartStages.map(stage => stage.text.length))
        : undefined;
      const stagingMode = multipartStages
        ? resolveChatGptWebMultipartStagingMode(
          turn.modelId,
          browserCapabilities,
          maxStageMessageTokens!,
          maxStageChars!,
          requestedMode.effort,
        )
        : requestedMode;
      if (prepared.multipart) {
        assertChatGptWebMultipartInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
          prepared.multipart.parts.length,
          multipartStages
            && multipartFinalPrompt
            && maxStageMessageTokens !== undefined
            && maxStageChars !== undefined ? {
            stagingEffort: stagingMode.effort,
            maxStageMessageTokens,
            maxStageChars,
            finalMessageTokens: estimateTokens(multipartFinalPrompt, turn.modelId),
            finalMessageChars: multipartFinalPrompt.length,
            finalImageTokens: estimateChatGptWebImageTokens(prepared),
          } : undefined,
        );
      } else {
        assertChatGptWebInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
        );
      }
      let deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      let page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (maintenancePage) return maintenancePage;
        if (!launcherSurfaceId) {
          const managed = await this.pageForNewTurn();
          if (abortSignal.aborted) {
            await managed.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          return managed;
        }
        const connection = await connectLauncherBrowserHost(
          this.config.browserHostDescriptorPath!,
          browserStageTimeouts.browserPage,
          launcherSurfaceId,
          abortSignal,
        );
        if (abortSignal.aborted) {
          await connection.browser.close().catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        await waitForOperationalChatGptViewport(connection.page, abortSignal);
        return connection.page;
      });
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      if (turn.nativeImageReconcile) {
        if (!turn.nativeAuthority || !turn.outputArtifactTarget || !turn.outputArtifactExecutionKey || !launcherSurfaceId) {
          throw new Error("native_reconcile_target_required");
        }
        const source = turn.nativeImageReconcile;
        const responseTurn = page.locator(`[data-turn-id=${JSON.stringify(source.assistantTurnId)}]`);
        await responseTurn.waitFor({ state: "attached", timeout: 30_000, signal: turn.abortSignal });
        if (await responseTurn.count() !== 1) throw new Error("native_reconcile_response_ambiguous");
        const capture = await new OutputImageAdapter().captureFinal({
          page, responseTurn, assistantTurnId: source.assistantTurnId, traceId: turn.traceId,
          executionKey: turn.outputArtifactExecutionKey, target: turn.outputArtifactTarget,
          abortSignal: turn.abortSignal, maxArtifacts: turn.outputArtifactLimit,
          excludeCandidateKeys: source.excludeCandidateKeys, writeManifest: false,
          launcherOwner: { descriptorPath: this.config.browserHostDescriptorPath!, traceId: turn.traceId,
            helperPid: process.pid, surfaceId: launcherSurfaceId,
            jobId: turn.outputArtifactTarget.metadata!.jobId! },
        });
        for (const artifact of capture.artifacts) {
          turn.nativeAuthority.artifact(artifact);
          turn.onOutputArtifact?.(artifact);
        }
        turn.nativeAuthority.capture(capture);
        turn.onOutputArtifactCapture?.(capture);
        const responseText = await responseTurn.innerText();
        await turn.nativeAuthority.complete(source.assistantTurnId, createHash("sha256").update(responseText).digest("hex"), responseText);
        return responseText;
      }
      releaseNetworkDiagnostics = turn.nativeBinding ? undefined : observeChatGptConversationResponses(page, turn.traceId);
      const rebindLauncherPage = async (
        attempt: number,
        cause: Error,
        callerSignal?: AbortSignal,
      ): Promise<void> => {
        if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} is rebinding its existing launcher page after a stalled DOM probe:`
          + ` ${redactChatGptUiDiagnostic(cause.message)}`,
        );
        const previousConnection = turnConnection;
        // The observation timeout races the Playwright operation but cannot cancel the underlying
        // page.evaluate by itself. A failed disconnect is terminal: opening a replacement while
        // the stale probe still owns its transport would recreate the contention this rebind is
        // meant to remove.
        const connection = await connectAfterClosingBrowserConnection(
          previousConnection,
          () => {
            turnConnection = undefined;
            return this.runStage(
              turn.traceId,
              `response_page_rebind_${attempt}`,
              browserStageTimeouts.browserPage,
              async (stageSignal) => {
                const signal = callerSignal
                  ? AbortSignal.any([stageSignal, callerSignal])
                  : turn.abortSignal
                    ? AbortSignal.any([stageSignal, turn.abortSignal])
                    : stageSignal;
                await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
                  phase: "heartbeat",
                  traceId: turn.traceId,
                  helperPid: process.pid,
                  refreshViewport: true,
                });
                const rebound = await connectLauncherBrowserHost(
                  this.config.browserHostDescriptorPath!,
                  browserStageTimeouts.browserPage,
                  launcherSurfaceId,
                  signal,
                );
                // Own the connection before validating its page: viewport failure still needs
                // the outer diagnostic capture and finally block to release this exact transport.
                turnConnection = rebound.browser;
                diagnosticPage = rebound.page;
                await waitForOperationalChatGptViewport(rebound.page, signal);
                return rebound;
              },
            );
          },
        );
        turnConnection = connection.browser;
        releaseNetworkDiagnostics?.();
        page = connection.page;
        releaseNetworkDiagnostics = turn.nativeBinding ? undefined : observeChatGptConversationResponses(page, turn.traceId);
        diagnosticPage = page;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} rebound its existing launcher page after a stalled DOM probe`,
        );
      };
      const recoverPageObservation = async (
        attempt: number,
        cause: ChatGptBrowserObservationTimeoutError,
        baseline: ChatGptSubmissionBaseline,
        checkpoint: "submission-page-rebound" | "assistant-page-rebound",
        abortSignal?: AbortSignal,
      ): Promise<ChatGptSubmissionObservationRecovery> => {
        await rebindLauncherPage(attempt, cause, abortSignal);
        const reboundBaseline: ChatGptSubmissionBaseline = {
          ...baseline,
          userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
          responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
          domCache: {},
        };
        await diagnostics.capture(page, checkpoint);
        return { page, baseline: reboundBaseline };
      };
      const recoverSubmissionObservation: ChatGptObservationRecovery = (
        attempt,
        cause,
        baseline,
        abortSignal,
      ) => recoverPageObservation(
        attempt,
        cause,
        baseline,
        "submission-page-rebound",
        abortSignal,
      );
      const recoverAssistantObservation: ChatGptObservationRecovery = (
        attempt,
        cause,
        baseline,
        abortSignal,
      ) => recoverPageObservation(
        attempt,
        cause,
        baseline,
        "assistant-page-rebound",
        abortSignal,
      );
      // Rebinding the exact leased page is a browser-ownership operation. Read-only
      // compaction needs it too; acquiring MCP tools is not a prerequisite.
      const launcherObservationRecovery = launcherSurfaceId !== undefined
        && this.config.browserHostDescriptorPath !== undefined;
      await diagnostics.capture(page, "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${prepared.multipart ? `multipart-${prepared.multipart.parts.length}` : "inline"}, maxMessageChars=${maxMessageChars}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length}, compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (multipartStages) {
        console.info(
          `[chatgpt-web] browser turn ${turn.traceId} multipart staging effort=${stagingMode.effort}`
          + ` maxStageMessageTokens=${maxStageMessageTokens} maxStageChars=${maxStageChars}`,
        );
      }
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          turn.surface === "persistent" ? "persistent_chat_preparation" : "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          stageSignal => {
            const signal = turn.abortSignal
              ? AbortSignal.any([stageSignal, turn.abortSignal])
              : stageSignal;
            return turn.surface === "persistent"
              ? this.preparePersistentChatSurface(
                page,
                turn.persistentProjectId!,
                checkpoint => diagnostics.capture(page, checkpoint),
                turn.persistentProjectName,
                signal,
              )
              : this.prepareTemporaryChatSurface(
                page,
                checkpoint => diagnostics.capture(page, checkpoint),
              );
          },
        );
      }
      // A retained lease proves the connector binding, not the current model selection.
      // Reconcile the live control before every submission, including retained continuations.
      let mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
        this.selectModelAndEffort(
          page,
          turn.modelId,
          stagingMode.effort,
          browserCapabilities,
          checkpoint => diagnostics.capture(page, checkpoint),
        )
      ));
      await diagnostics.capture(page, "effort-selection-complete");

      let finalPrompt = prepared.text;
      if (prepared.multipart && multipartStages && multipartTransactionId && multipartFinalPrompt) {
        for (let index = 0; index < multipartStages.length; index += 1) {
          const stage = multipartStages[index]!;
          if (index > 0) {
            // ChatGPT can reset its model/effort after a completed response. The previous ACK
            // proves receipt of that part, not the model selected for this next Send.
            mode = await this.runStage(turn.traceId, `multipart_stage_${index + 1}_effort_selection`, browserStageTimeouts.effortSelection, () => (
              this.selectModelAndEffort(page, turn.modelId, stagingMode.effort, browserCapabilities,
                checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`))
            ));
          }
          let stageBaseline = await this.captureSubmissionBaseline(page);
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            browserStageTimeouts.promptAttachment,
            (stageSignal) => this.attachPrompt(
              page,
              stage.text,
              false,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            ),
            chatGptSuspensionClock,
            true,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-attachment-complete`);

          const evidence = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_send`,
            browserStageTimeouts.multipartStageSend,
            (stageSignal) => {
              const sendSignal = turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal;
              return this.sendAttachedPrompt(
                page,
                stageBaseline,
                checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
                sendSignal,
                undefined,
                undefined,
                undefined,
                launcherObservationRecovery
                  ? async (...args) => {
                    const recovered = await recoverSubmissionObservation(...args);
                    stageBaseline = recovered.baseline;
                    return recovered;
                  }
                  : undefined,
                undefined,
                false,
              );
            },
          );
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart part ${index + 1}/${prepared.multipart.parts.length} submission accepted evidence=${evidence}`,
          );
          await this.runStage(
              turn.traceId,
              `multipart_stage_${index + 1}_acknowledgement`,
              browserStageTimeouts.multipartStageAcknowledgement,
              async (stageSignal) => {
                const acknowledgementSignal = turn.abortSignal
                  ? AbortSignal.any([stageSignal, turn.abortSignal])
                  : stageSignal;
                const responseTurn = await this.waitForNewAssistantTurn(
                  page,
                  stageBaseline,
                  deadline,
                  acknowledgementSignal,
                  // A part still being ingested has produced no MCP activity, so there is no progress
                  // to consult here; the dedicated acknowledgement stage owns this wait.
                  undefined,
                  CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
                  undefined,
                  launcherObservationRecovery
                    ? async (...args) => {
                      const recovered = await recoverAssistantObservation(...args);
                      stageBaseline = recovered.baseline;
                      return recovered;
                    }
                    : undefined,
                );
                await this.waitForMultipartAcknowledgement(
                  page,
                  responseTurn,
                  stageBaseline,
                  stage,
                  deadline,
                  acknowledgementSignal,
                  turn.externalProgress,
                );
              },
              chatGptSuspensionClock,
            );

          await diagnostics.capture(page, `multipart-stage-${index + 1}-acknowledged`);
          await turn.onMultipartStageAcknowledged?.(index + 1);
        }
        // Reconcile even when the requested effort equals staging: a cached mode is not proof
        // that ChatGPT retained it after the last ACK.
        mode = await this.runStage(
            turn.traceId,
            "final_part_effort_selection",
            browserStageTimeouts.effortSelection,
            () => this.selectModelAndEffort(
              page,
              turn.modelId,
              requestedMode.effort,
              browserCapabilities,
              checkpoint => diagnostics.capture(page, `final-part-${checkpoint}`),
            ),
          );
        await diagnostics.capture(page, "final-part-effort-selected");
        finalPrompt = multipartFinalPrompt;
      }

      let completionTracker = new ChatGptCompletionTracker();
      let submissionBaseline = await this.captureSubmissionBaseline(page);
      let finalSubmissionEvidence: ChatGptSubmissionEvidence;
      if (turn.imageEditSource) {
        if (!reuseConversation || prepared.images.length > 0 || prepared.multipart) {
          throw new Error("Image edit requires a retained conversation and a plain Describe edits prompt");
        }
        finalSubmissionEvidence = await this.runStage(
          turn.traceId,
          "image_edit_send",
          browserStageTimeouts.send,
          stageSignal => {
            const sendSignal = turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal;
            return this.sendImageEditPrompt(
              page,
              submissionBaseline,
              turn.imageEditSource!,
              finalPrompt,
              sendSignal,
              turn,
              completionTracker,
              launcherObservationRecovery
                ? async (...args) => {
                  const recovered = await recoverSubmissionObservation(...args);
                  submissionBaseline = recovered.baseline;
                  return recovered;
                }
                : undefined,
            );
          },
        );
        await diagnostics.capture(page, "image-edit-send-complete");
      } else {
        let catalogRefreshAvailable = mode.localTools && !reuseConversation && !prepared.multipart;
        const connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 };
        for (;;) {
          try {
            await this.runStage(
              turn.traceId,
              "prompt_attachment",
              browserStageTimeouts.promptAttachment,
              (stageSignal) => {
                const promptAbortSignal = turn.abortSignal
                  ? AbortSignal.any([stageSignal, turn.abortSignal])
                  : stageSignal;
                return this.attachPromptWithCompactionRetry(
                  page,
                  finalPrompt,
                  mode.localTools,
                  turn.compaction === true,
                  submissionBaseline,
                  checkpoint => diagnostics.capture(page, checkpoint),
                  promptAbortSignal,
                  catalogRefreshAvailable,
                  connectorAttemptBudget,
                  reuseConversation,
                  mode.thinkEnabled,
                  executionTarget.output === "image",
                );
              },
              chatGptSuspensionClock,
              true,
            );
            break;
          } catch (error) {
            if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
            catalogRefreshAvailable = false;
            await diagnostics.capture(page, "connector-catalog-stale");
            await this.runStage(
              turn.traceId,
              "connector_catalog_refresh",
              browserStageTimeouts.temporaryChatPreparation,
              async stageSignal => {
                const signal = turn.abortSignal
                  ? AbortSignal.any([stageSignal, turn.abortSignal])
                  : stageSignal;
                await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
                await this.prepareTemporaryChatSurface(
                  page,
                  checkpoint => diagnostics.capture(page, checkpoint),
                );
                mode = await this.selectModelAndEffort(
                  page,
                  turn.modelId,
                  turn.reasoning,
                  turn.capabilities,
                  checkpoint => diagnostics.capture(page, checkpoint),
                );
                submissionBaseline = await this.captureSubmissionBaseline(page);
              },
            );
            await diagnostics.capture(page, "connector-catalog-refreshed");
          }
        }
        await diagnostics.capture(page, "prompt-attachment-complete");
        const attachmentGuard = await this.runStage(
          turn.traceId,
          "file_attachment",
          browserStageTimeouts.fileAttachment,
          stageSignal => {
            const signal = turn.abortSignal
              ? AbortSignal.any([stageSignal, turn.abortSignal])
              : stageSignal;
            return this.attachFiles(
              page,
              prepared,
              signal,
              imageTransferLog(turn.traceId, turn.outputArtifactTarget?.metadata?.jobId),
            );
          },
        );
        await diagnostics.capture(page, attachmentGuard ? "file-attachment-complete" : "file-attachment-skipped");
        finalSubmissionEvidence = await this.runStage(
          turn.traceId,
          "send",
          // A multipart commit lands on a conversation already carrying every staged part, so it
          // needs the same acceptance headroom the stages themselves get.
          prepared.multipart ? browserStageTimeouts.multipartStageSend : browserStageTimeouts.send,
          (stageSignal) => {
            const sendSignal = turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal;
            return this.sendAttachedPrompt(
              page,
              submissionBaseline,
              checkpoint => diagnostics.capture(page, checkpoint),
              sendSignal,
              turn.externalProgress,
              turn,
              completionTracker,
              launcherObservationRecovery
                ? async (...args) => {
                  const recovered = await recoverSubmissionObservation(...args);
                  submissionBaseline = recovered.baseline;
                  return recovered;
                }
                : undefined,
              attachmentGuard,
              executionTarget.output === "image",
            );
          },
        );
      }
      console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${finalSubmissionEvidence}`);
      let responseTurn = await this.waitForNewAssistantTurn(
        page,
        submissionBaseline,
        deadline,
        turn.abortSignal,
        turn.externalProgress,
        CHATGPT_RESPONSE_DOM_GRACE_MS,
        completionTracker,
        launcherObservationRecovery
          ? async (...args) => {
            const recovered = await recoverAssistantObservation(...args);
            submissionBaseline = recovered.baseline;
            return recovered;
          }
          : undefined,
      );
      await diagnostics.capture(page, "send-accepted");

      const followUpQueue: ChatGptFollowUpRequest[] = [];
      if (turn.followUp) {
        releaseFollowUp = turn.followUp.bind(request => {
          followUpQueue.push(request);
        });
      }

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let capturedResponse = false;
      let sentAt = Date.now();
      let visibleTrace = new ChatGptVisibleTraceTracker();
      let markdownBuffer = new ChatGptMarkdownBuffer();
      const outputImageAdapter = new OutputImageAdapter();
      let checkpointStream = turn.captureLunaCheckpoint
        ? new ChatGptLunaCheckpointStream()
        : undefined;
      const emitMarkdownDelta = (delta: string): void => {
        const visible = checkpointStream ? checkpointStream.push(delta) : delta;
        if (visible) turn.onTextDelta(visible);
      };
      const throwMarkdownConsistencyError = (error: unknown): never => {
        if (!(error instanceof ChatGptMarkdownConsistencyError)) throw error;
        if (error.diagnostic) {
          console.error(
            `[chatgpt-web] browser turn ${turn.traceId} Markdown conflict: ${JSON.stringify(error.diagnostic)}`,
          );
        }
        throw new ChatGptWebAdapterError(error.message, {
          status: 502,
          errorType: "server_error",
          code: "browser_stream_inconsistent",
          retryable: false,
        });
      };
      let domHealthTracker = new ChatGptTurnDomHealthTracker();
      let responseDomCache: ChatGptResponseDomCache = {};
      let consecutiveObservationRebinds = 0;
      let internalObservationFaults = 0;
      let observedThisIteration = false;
      let completionFenceRevision: number | undefined;
      let imageOutputShortfallSince: number | undefined;
      for (;;) {
        // The heartbeat is a consumer callback, so it stays outside the observation-fault region:
        // a defect in the caller must not be retried as though the page could not be read.
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }
       try {
        observedThisIteration = false;
        if (page.isClosed()) {
          throw chatGptBrowserTabClosedError();
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptTerminalErrorAlert(responseTurn.locator);

        if (mode.localTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
        )) {
          internalObservationFaults = 0;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        if (!snapshot.responsePresent) {
          try {
            const rebound = await withChatGptBrowserObservationTimeout(
              this.reconcileAssistantTurnBinding(
                page,
                submissionBaseline,
                responseTurn,
                turn.abortSignal,
              ),
            );
            if (rebound.identity !== responseTurn.identity) {
              responseTurn = rebound;
              responseDomCache.key = undefined;
              responseDomCache.snapshot = undefined;
              snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
            }
          } catch (error) {
            if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !launcherSurfaceId) throw error;
            consecutiveObservationRebinds += 1;
            if (consecutiveObservationRebinds > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
              throw new Error(
                `ChatGPT browser DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
                { cause: error },
              );
            }
            await rebindLauncherPage(consecutiveObservationRebinds, error, turn.abortSignal);
            submissionBaseline = {
              ...submissionBaseline,
              userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
              responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
              domCache: {},
            };
            responseTurn = {
              ...responseTurn,
              locator: page.locator(`[data-turn-id=${JSON.stringify(responseTurn.identity)}]`),
            };
            responseDomCache.key = undefined;
            responseDomCache.snapshot = undefined;
            await diagnostics.capture(page, "response-page-rebound");
            continue;
          }
        }
        if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
        if (snapshot.responsePresent) consecutiveObservationRebinds = 0;
        // The page was read successfully, so the fault budget is genuinely consecutive even when
        // this iteration goes on to `continue` for a rebind, confirmation, or liveness pause.
        internalObservationFaults = 0;
        observedThisIteration = true;
        // Liveness may postpone a verdict, never waive it: once activity goes stale the DOM alone
        // decides, so a tool call that never returns cannot hold a turn with no explicit deadline open forever.
        const externalProgressSnapshot = turn.externalProgress?.snapshot();
        if (turn.externalProgress
          && externalProgressSnapshot
          && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
          completionTracker.observeToolBatch(
            externalProgressSnapshot.lastToolBatchRevision,
            snapshot.visibleText,
            snapshot.generatedImageKeys.join("\n"),
          );
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
        }
        const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
          externalProgressSnapshot,
          Date.now(),
        );
        const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
        while (followUpQueue.length > 0 && turn.followUp?.isTerminal(followUpQueue[0]!)) {
          followUpQueue.shift();
        }
        const pendingFollowUp = followUpQueue[0];
        if (pendingFollowUp && turn.followUp && !externalToolCallsInFlight) {
          const followUpComposer = await this.activeComposer(page, 1_000, turn.abortSignal).catch(() => undefined);
          const followUpSend = followUpComposer
            ?.locator("xpath=ancestor::form[1]")
            .getByTestId("send-button");
          const followUpComposerReady = Boolean(followUpSend
            && await followUpSend.count().catch(() => 0) === 1
            && await followUpSend.isVisible().catch(() => false));
          if (followUpComposerReady) {
            submissionBaseline = await this.captureSubmissionBaseline(page);
            completionTracker = new ChatGptCompletionTracker();
            try {
              const followUpEvidence = await this.sendFollowUpPrompt(
                page,
                submissionBaseline,
                pendingFollowUp,
                turn.followUp,
                turn.abortSignal,
                turn.externalProgress,
                completionTracker,
                launcherObservationRecovery
                  ? async (...args) => {
                    const recovered = await recoverSubmissionObservation(...args);
                    submissionBaseline = recovered.baseline;
                    return recovered;
                  }
                  : undefined,
              );
            } catch (error) {
              turn.followUp.recordEvent({
                type: "rejected",
                requestId: pendingFollowUp.requestId,
                revision: pendingFollowUp.revision,
                message: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
            followUpQueue.shift();
            // A successor revision owns a fresh generation budget only after its Send action has
            // been verified. Time spent waiting for a safe composer must not consume that budget.
            deadline = this.config.turnTimeoutMs === undefined
              ? undefined
              : Date.now() + this.config.turnTimeoutMs;
            responseTurn = await this.waitForNewAssistantTurn(
              page,
              submissionBaseline,
              deadline,
              turn.abortSignal,
              turn.externalProgress,
              CHATGPT_RESPONSE_DOM_GRACE_MS,
              completionTracker,
              launcherObservationRecovery
                ? async (...args) => {
                  const recovered = await recoverAssistantObservation(...args);
                  submissionBaseline = recovered.baseline;
                  return recovered;
                }
                : undefined,
            );
            finalText = "";
            sawRunning = false;
            loggedCompletionWait = false;
            capturedResponse = false;
            sentAt = Date.now();
            visibleTrace = new ChatGptVisibleTraceTracker();
            markdownBuffer = new ChatGptMarkdownBuffer();
            checkpointStream = turn.captureLunaCheckpoint ? new ChatGptLunaCheckpointStream() : undefined;
            domHealthTracker = new ChatGptTurnDomHealthTracker();
            responseDomCache = {};
            consecutiveObservationRebinds = 0;
            internalObservationFaults = 0;
            completionFenceRevision = undefined;
            imageOutputShortfallSince = undefined;
            await diagnostics.capture(page, `follow-up-${pendingFollowUp.revision}-submitted`);
            continue;
          }
        }
        if (!snapshot.responsePresent && externalProgressLive) {
          // Current-turn MCP activity proves that ChatGPT is still executing even if its renderer
          // temporarily cannot expose the response subtree. DOM remains authoritative for text and
          // completion; this only prevents a live turn from being misclassified as vanished.
          domHealthTracker.clearMissingResponse();
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          if (!capturedResponse) {
            capturedResponse = true;
            await diagnostics.capture(page, "response-visible");
          }
          const textDelta = (() => {
            try {
              return markdownBuffer.observe(snapshot.markdownSegments);
            } catch (error) {
              return throwMarkdownConsistencyError(error);
            }
          })();
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
            generatedImageKeys: snapshot.generatedImageKeys,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
          const completionObserved = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            generatedImageKeys: snapshot.generatedImageKeys,
            externalToolCallsInFlight,
          });
          const expectedImageCount = turn.outputArtifactLimit ?? 1;
          const imageOutputShortfall = expectedImageCount > 1
            && snapshot.generatedImageKeys.length > 0
            && snapshot.generatedImageKeys.length < expectedImageCount
            && !running;
          if (imageOutputShortfall) imageOutputShortfallSince ??= Date.now();
          else imageOutputShortfallSince = undefined;
          const imageHydrationPending = imageOutputShortfall
            && Date.now() - imageOutputShortfallSince! < CHATGPT_MULTI_IMAGE_HYDRATION_GRACE_MS;
          const completionReady = completionObserved
            && !imageHydrationPending
            && followUpQueue.length === 0
            && !turn.followUp?.hasUnsubmitted();
          if (!completionReady) completionFenceRevision = undefined;
          if (completionReady) {
            if (prepared.multipart) assertChatGptMultipartContextAvailable(snapshot.visibleText);
            if (turn.completionFence) {
              if (completionFenceRevision === undefined) {
                const revision = await turn.completionFence.begin();
                if (revision === undefined) {
                  await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                  continue;
                }
                completionFenceRevision = revision;
                // The fence revision is captured after this DOM projection. Force one fresh read
                // before commit so an MCP activity that just settled cannot disappear between a
                // stale cached completion and the broker's terminal decision.
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
              if (!await turn.completionFence.commit(completionFenceRevision)) {
                completionFenceRevision = undefined;
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
            }
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const outputArtifactTarget = turn.outputArtifactTarget;
            const outputArtifactExecutionKey = turn.outputArtifactExecutionKey;
            await turn.nativeAuthority?.visible(responseTurn.identity);
            if (outputArtifactTarget && outputArtifactExecutionKey && snapshot.generatedImageKeys.length > 0) {
              const capture = await outputImageAdapter.captureFinal({
                page, responseTurn: responseTurn.locator, assistantTurnId: responseTurn.identity,
                traceId: turn.traceId, executionKey: outputArtifactExecutionKey,
                target: outputArtifactTarget, abortSignal: turn.abortSignal,
                maxArtifacts: turn.outputArtifactLimit,
                existingTotalBytes: turn.outputArtifactExistingTotalBytes,
                writeManifest: turn.outputArtifactWriteManifest,
                launcherOwner: launcherSurfaceId ? {
                  descriptorPath: this.config.browserHostDescriptorPath!, traceId: turn.traceId,
                  helperPid: process.pid, surfaceId: launcherSurfaceId,
                  jobId: outputArtifactTarget.metadata?.jobId ?? outputArtifactExecutionKey,
                } : undefined,
              });
              for (const artifact of capture.artifacts) {
                turn.nativeAuthority?.artifact(artifact);
                turn.onOutputArtifact?.(artifact);
              }
              turn.nativeAuthority?.capture(capture);
              turn.onOutputArtifactCapture?.(capture);
              if (capture.failures.length > 0 || capture.artifacts.length === 0) {
                const failureCodes = capture.failures.map(failure => `${failure.candidateKey}:${failure.code}`).join(",");
                const message = `Generated image capture failed for ${capture.failures.length} artifact(s) (${failureCodes || "no_artifact"})`;
                if (outputArtifactTarget.capturePolicy === "required" && capture.artifacts.length === 0) throw new Error(message);
                turn.onOutputArtifactWarning?.(message);
              }
            }
            if (turn.requireOutputArtifact && !turn.outputArtifactTarget && snapshot.generatedImageKeys.length > 0) {
              throw new Error("ChatGPT generated an image but no trusted writable workspace is available");
            }
            const final = (() => {
              try {
                return markdownBuffer.finish();
              } catch (error) {
                return throwMarkdownConsistencyError(error);
              }
            })();
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText, snapshot.generatedImageKeys.length > 0);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
            await turn.nativeAuthority?.complete(responseTurn.identity, createHash("sha256").update(finalText).digest("hex"), finalText);
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 60_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-60s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn.locator).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionVisible: false,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
       } catch (error) {
        // Only a defect in this worker is retried here. Every deliberate signal — adapter errors,
        // aborts, closed tabs, DOM-health verdicts — still fails the turn immediately.
        // Retry only faults raised while reading the page. Once observation succeeded, a
        // TypeError belongs to a consumer - Markdown buffering, text/trace callbacks, checkpoint
        // capture - and retrying it would rerun an iteration whose side effects already happened.
        if (!(error instanceof TypeError) || observedThisIteration) throw error;
        internalObservationFaults += 1;
        if (internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS) {
          throw new Error(
            `ChatGPT browser observation failed ${internalObservationFaults} times in a row: ${error.message}`,
            { cause: error },
          );
        }
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault`
          + ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${error.message}`,
        );
        await diagnostics.capture(page, "internal-observation-fault");
        responseDomCache.key = undefined;
        responseDomCache.snapshot = undefined;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
       }
      }

      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} completed`
        + ` (markdownChars=${finalText.length}, domFullScans=${responseDomCache.fullScans ?? 0}, domCacheHits=${responseDomCache.cacheHits ?? 0})`,
      );
      return finalText;
    } catch (error) {
      let failure: unknown = error;
      if (error instanceof DOMException && error.name === "AbortError"
        && turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted) {
        console.info(`[chatgpt-web] browser turn ${turn.traceId} ended after accepted structured compaction handoff`);
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnostics.capture(diagnosticPage, "compaction-handoff-accepted");
        }
        throw turn.abortSignal.reason;
      }
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:`
        + ` ${redactChatGptUiDiagnostic(failure instanceof Error ? failure.message : String(failure))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", failure);
      }
      throw failure;
    } finally {
      releaseFollowUp?.();
      releaseNetworkDiagnostics?.();
      prepared.release();
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
