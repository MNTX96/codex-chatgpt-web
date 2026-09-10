import type { Locator, Page } from "playwright-core";
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

function pageBelongsToProject(value: string, projectId: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com") return false;
    const segments = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
    return segments[0] === "g"
      && segments[1] === projectId
      && (segments[2] === "project" || segments[2] === "c");
  } catch {
    return false;
  }
}

export async function prepareProjectDirectory(page: Page): Promise<void> {
  if (page.url() !== directoryUrl) {
    const link = page.locator('a[href="/projects"]').first();
    if (await link.isVisible()) await link.click();
    else await page.goto(directoryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.waitForURL(directoryUrl, { timeout: 30_000 });
  await page.getByRole("button", { name: "New", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  // The directory can render before React installs its navigation handlers.
  // Keep the same document alive through the observed hydration window.
  await page.waitForTimeout(1500);
}

export async function openImageFactoryProject(
  page: Page,
  projectId: string,
  log: ImageFactoryProjectLog = () => {},
): Promise<void> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error("Image Factory project_id is not configured");
  if (pageBelongsToProject(page.url(), normalizedProjectId)) {
    log("project_document_reused");
    return;
  }

  // A direct document load of /g/<project_id>/project can leave the Electron child surface
  // without a hydrated composer. Enter through the Projects directory and let ChatGPT's own
  // client-side navigation open the configured project instead.
  await prepareProjectDirectory(page);
  log("project_directory_ready");

  const rows = page.locator('[role="grid"] [role="row"][data-page-table-selectable-row="true"]');
  let visitedRows = 0;
  let stablePasses = 0;
  for (let pass = 0; pass < 12 && stablePasses < 2; pass += 1) {
    const rowCount = await rows.count();
    const candidates: Array<{ index: number; name: string }> = [];
    for (let index = visitedRows; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const name = await readProjectRowLabel(row).catch(() => "");
      candidates.push({ index, name });
    }
    candidates.sort((left, right) => (
      Number(right.name === IMAGE_FACTORY_PROJECT_NAME) - Number(left.name === IMAGE_FACTORY_PROJECT_NAME)
    ));

    for (const candidate of candidates) {
      const row = rows.nth(candidate.index);
      log("project_directory_candidate_opened", {
        index: candidate.index,
        preferredName: candidate.name === IMAGE_FACTORY_PROJECT_NAME,
      });
      await row.click();
      await page.waitForURL(url => projectIdFromUrl(url.toString()) !== undefined, { timeout: 30_000 });
      const observedProjectId = projectIdFromUrl(page.url());
      if (observedProjectId === normalizedProjectId) {
        log("project_directory_match_opened", { projectId: normalizedProjectId.slice(0, 12) });
        return;
      }
      log("project_directory_candidate_mismatch", {
        index: candidate.index,
        projectId: observedProjectId?.slice(0, 12),
      });
      await prepareProjectDirectory(page);
    }

    visitedRows = rowCount;
    if (rowCount > 0) await rows.last().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    stablePasses = await rows.count() <= rowCount ? stablePasses + 1 : 0;
  }
  throw new Error("Configured Image Factory project_id was not found in ChatGPT Projects");
}
