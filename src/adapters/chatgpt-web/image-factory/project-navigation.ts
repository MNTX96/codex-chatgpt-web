import type { Locator, Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR } from "../../../chatgpt-session";
import { ChatGptWebAdapterError } from "../adapter-error";
import { throwIfChatGptRateLimitDialog, withChatGptNavigationGuard } from "../rate-limit";
import type { ImageFactoryProjectLog } from "./project-manager";

const directoryUrl = "https://chatgpt.com/projects";
export const IMAGE_FACTORY_PROJECT_NAME = "Image Factory";
const PROJECT_OPTIONS_LABEL_PREFIX = "Open project options for ";

export async function readProjectRowLabel(row: Locator): Promise<string> {
  const optionsButton = row.locator(`button[aria-label^="${PROJECT_OPTIONS_LABEL_PREFIX}"]`).first();
  const optionsLabel = await optionsButton.getAttribute("aria-label").catch(() => null);
  if (optionsLabel?.startsWith(PROJECT_OPTIONS_LABEL_PREFIX)) {
    const projectName = optionsLabel.slice(PROJECT_OPTIONS_LABEL_PREFIX.length).replace(/\s+/g, " ").trim();
    if (projectName) return projectName;
  }
  return ((await row.getByRole("gridcell").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
}

export async function isImageFactoryProjectRow(row: Locator): Promise<boolean> {
  const optionsButton = row
    .getByRole("button", {
      name: `${PROJECT_OPTIONS_LABEL_PREFIX}${IMAGE_FACTORY_PROJECT_NAME}`,
      exact: true,
    })
    .first();
  return await optionsButton.isVisible().catch(() => false);
}

export function projectIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value, "https://chatgpt.com");
    if (url.origin !== "https://chatgpt.com") return undefined;
    const match = /^\/g\/([^/]+)\/project\/?$/.exec(url.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function projectPathSuffix(value: string, projectId: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.hash) return undefined;
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) return undefined;
    const prefix = `/g/${normalizedProjectId}`;
    if (!url.pathname.startsWith(prefix)) return undefined;
    const suffix = url.pathname.slice(prefix.length);
    if (!suffix.startsWith("/") && !/^-[A-Za-z0-9_-]{1,160}\//.test(suffix)) return undefined;
    return suffix;
  } catch {
    return undefined;
  }
}

export function imageFactoryPageBelongsToProject(value: string, projectId: string): boolean {
  const suffix = projectPathSuffix(value, projectId);
  if (!suffix) return false;
  return /^(?:-[A-Za-z0-9_-]{1,160})?\/(?:project\/?|c\/[A-Za-z0-9:_-]{8,160}\/?)$/.test(suffix);
}

export function verifiedImageFactoryConversationUrl(value: string | undefined, projectId: string): string | undefined {
  if (!value) return undefined;
  const suffix = projectPathSuffix(value, projectId);
  if (!suffix || !/^(?:-[A-Za-z0-9_-]{1,160})?\/c\/[A-Za-z0-9:_-]{8,160}\/?$/.test(suffix)) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

export async function waitForImageFactoryConversationUrl(
  page: Page,
  projectId: string,
  timeoutMs = 10_000,
): Promise<string> {
  const current = verifiedImageFactoryConversationUrl(page.url(), projectId);
  if (current) return current;
  try {
    await page.waitForURL(
      url => verifiedImageFactoryConversationUrl(url.toString(), projectId) !== undefined,
      { timeout: timeoutMs },
    );
  } catch (error) {
    throw new Error(
      "ChatGPT accepted the Image Factory prompt but did not expose its retained conversation URL",
      { cause: error },
    );
  }
  const conversationUrl = verifiedImageFactoryConversationUrl(page.url(), projectId);
  if (!conversationUrl) {
    throw new Error("ChatGPT Image Factory conversation URL changed to an unverified route");
  }
  return conversationUrl;
}

export async function prepareProjectDirectory(page: Page, abortSignal?: AbortSignal): Promise<void> {
  await withChatGptNavigationGuard(page, async signal => {
    if (page.url() !== directoryUrl) {
      const link = page.locator('a[href="/projects"]').first();
      if (await link.isVisible()) await link.click({ signal });
      else await page.goto(directoryUrl, { waitUntil: "domcontentloaded", timeout: 30_000, signal });
    }
    await page.waitForURL(directoryUrl, { timeout: 15_000, signal });
    await page.getByRole("button", { name: "New", exact: true }).waitFor({ state: "visible", timeout: 15_000, signal });
    // Preserve the same document while React installs the directory navigation handlers.
    await page.waitForTimeout(1500);
  }, abortSignal);
}

export interface ImageFactoryProjectNavigationOptions {
  projectName?: string;
  abortSignal?: AbortSignal;
}

async function waitForProjectComposer(page: Page, projectId: string, signal: AbortSignal): Promise<void> {
  await page.waitForURL(url => imageFactoryPageBelongsToProject(url.toString(), projectId), { timeout: 10_000, signal });
  await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout: 10_000, signal });
  // ChatGPT paints a generic composer before the configured project's data is loaded.
  await page.getByRole("heading", { name: /^Loading project(?:…|\.\.\.)?$/i })
    .waitFor({ state: "hidden", timeout: 10_000, signal });
  if (projectIdFromUrl(page.url())) {
    await page.locator("h1").filter({ hasText: /\S/, hasNotText: /^Loading project(?:…|\.\.\.)?$/i }).first()
      .waitFor({ state: "visible", timeout: 10_000, signal });
  }
}

export async function openImageFactoryProject(
  page: Page,
  projectId: string,
  log: ImageFactoryProjectLog = () => {},
  options: ImageFactoryProjectNavigationOptions = {},
): Promise<void> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error("Image Factory project_id is not configured");
  options.abortSignal?.throwIfAborted();
  await throwIfChatGptRateLimitDialog(page);
  if (imageFactoryPageBelongsToProject(page.url(), normalizedProjectId)) {
    // Retained conversations must never be replaced with a new project chat.
    await withChatGptNavigationGuard(page, signal => waitForProjectComposer(page, normalizedProjectId, signal), options.abortSignal);
    log("project_document_reused");
    return;
  }

  try {
    log("project_direct_navigation_started");
    await withChatGptNavigationGuard(page, async signal => {
      await page.goto(`https://chatgpt.com/g/${encodeURIComponent(normalizedProjectId)}/project`, {
        waitUntil: "domcontentloaded", timeout: 30_000, signal,
      });
      await waitForProjectComposer(page, normalizedProjectId, signal);
    }, options.abortSignal);
    log("project_direct_navigation_ready");
    return;
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError || options.abortSignal?.aborted) throw error;
    log("project_direct_navigation_failed");
  }

  await openPinnedImageFactoryProject(page, normalizedProjectId, options, log);
}

export async function openPinnedImageFactoryProject(
  page: Page,
  projectId: string,
  options: ImageFactoryProjectNavigationOptions,
  log: ImageFactoryProjectLog = () => {},
): Promise<void> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error("Image Factory project_id is not configured");
  const projectName = options.projectName?.trim();
  if (!projectName) {
    throw new Error("Image Factory project did not become ready. Set its exact Project name in launcher settings and pin it in ChatGPT for fallback navigation.");
  }
  await withChatGptNavigationGuard(page, async signal => {
    const pinnedHeading = page.getByRole("heading", { name: "Pinned", exact: true });
    const section = page.locator('[class~="group/sidebar-expando-section"]').filter({ has: pinnedHeading });
    // A failed document load may leave an error page; recover the sidebar once, without /projects.
    if (!/^https:\/\/chatgpt\.com(?:\/|$)/.test(page.url())) {
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000, signal });
    }
    const header = section.getByRole("button", { name: "Pinned", exact: true });
    const expandedSidebar = await header.click({ trial: true, timeout: 1500, signal }).then(() => true, () => false);
    signal.throwIfAborted();
    if (!expandedSidebar) {
      await page.getByRole("button", { name: "Open sidebar", exact: true }).click({ timeout: 10_000, signal });
    }
    await header.waitFor({ state: "visible", timeout: 10_000, signal });
    if (await header.getAttribute("aria-expanded") !== "true") await header.click({ signal });
    const row = section.locator('[class~="group/project-unfurl-row"]')
      .filter({ has: page.getByText(projectName, { exact: true }) });
    await row.first().waitFor({ state: "visible", timeout: 10_000, signal });
    if (await row.count() !== 1) throw new Error("Pinned contains multiple projects with the configured Project name");
    log("project_pinned_name_clicked");
    await row.getByText(projectName, { exact: true }).click({ timeout: 10_000, signal });
    // Some sidebar versions expand the project's chats when its name is clicked.
    // The home action belongs to this exact named project, never to a sibling row.
    if (!imageFactoryPageBelongsToProject(page.url(), normalizedProjectId)
      && await row.getByRole("button", { name: "Open project home", exact: true }).isVisible()) {
      await row.getByRole("button", { name: "Open project home", exact: true }).press("Enter", { timeout: 10_000, signal });
    }
    await page.waitForURL(url => projectIdFromUrl(url.toString()) !== undefined, { timeout: 10_000, signal });
    if (!imageFactoryPageBelongsToProject(page.url(), normalizedProjectId)) {
      throw new Error("Pinned Project name does not match the configured project_id");
    }
    await waitForProjectComposer(page, normalizedProjectId, signal);
  }, options.abortSignal);
  log("project_pinned_navigation_ready");
}
