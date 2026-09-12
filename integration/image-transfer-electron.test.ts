import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { ImageTransferDeadline } from "../src/adapters/chatgpt-web/image-transfer";
import { downloadOutputImage } from "../src/adapters/chatgpt-web/artifacts/image/image-downloader";
import { openBoundImageViewer } from "../src/adapters/chatgpt-web/artifacts/image/image-viewer";
import { OutputImageAdapter } from "../src/adapters/chatgpt-web/artifacts/image/output-image-adapter";
import { resolveOutputArtifactTarget } from "../src/adapters/chatgpt-web/artifacts/artifact-target";
import { attachPromptFiles, type AttachmentGuard } from "../src/adapters/chatgpt-web/file-attachments";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptFollowUpChannel, type ChatGptFollowUpRequest } from "../src/adapters/chatgpt-web/follow-up";
import type { LauncherImageDownloadOwner } from "../src/adapters/chatgpt-web/artifacts/image/download-transaction";
import type { OutputImageCandidate } from "../src/adapters/chatgpt-web/artifacts/types";

const require = createRequire(import.meta.url);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const payload = (index = 1) => Buffer.concat([png, Buffer.from([index])]);
const preview = (index = 1) => `data:image/png;base64,${payload(index).toString("base64")}`;
let electron: ElectronApplication;
let root: string;
let server: Server;
let origin: string;
let sequence = 0;
const pages: Page[] = [];
const requests = new Map<string, number>();
const trace = (stage: string, fields?: Record<string, unknown>) => {
  if (process.env.CODEX_IMAGE_TRANSFER_TEST_TRACE === "1") console.info("[image-transfer-fixture]", stage, fields ?? {});
};

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected the image transfer operation to reject");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "image-transfer-electron-"));
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname !== "/download") { response.end("<!doctype html><title>Image transfer fixture</title>"); return; }
    const key = url.searchParams.get("key")!;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    const bytes = url.searchParams.has("oversized") ? Buffer.alloc(128_000, 1) : payload(Number(url.searchParams.get("image") ?? 1));
    response.writeHead(200, { "content-type": "image/png", "content-disposition": 'attachment; filename="fixture.png"', "content-length": bytes.length });
    response.write(bytes.subarray(0, 1));
    const timer = setTimeout(() => response.end(bytes.subarray(1)), Number(url.searchParams.get("delay") ?? 0));
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  electron = await _electron.launch({
    executablePath: require("../launcher/node_modules/electron") as string,
    args: [resolve(import.meta.dir, "fixtures/image-transfer-electron.cjs")],
    env: { ...process.env, CODEX_IMAGE_TRANSFER_FIXTURE_ROOT: root },
    timeout: 30_000,
  });
  await electron.firstWindow();
}, 40_000);

afterEach(async () => {
  for (const page of pages.splice(0)) if (!page.isClosed()) await page.close();
});
afterAll(async () => {
  await electron?.close();
  if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  if (root) rmSync(root, { recursive: true, force: true });
});

async function newPage(): Promise<{ page: Page; owner: LauncherImageDownloadOwner; key: string }> {
  const key = `case-${++sequence}`;
  const created = electron.waitForEvent("window");
  const metadataPromise = electron.evaluate(async (_electron, args) => {
    return (globalThis as any).imageTransferFixture.create(args);
  }, { id: key, helperPid: process.pid, url: `${origin}/fixture?case=${key}` });
  const [page, metadata] = await Promise.all([created, metadataPromise]);
  await page.waitForLoadState();
  pages.push(page);
  const descriptorPath = join(root, `${key}.json`);
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, features: ["owned-image-download-v1"],
    profile: "production", pid: metadata.pid, endpoint: origin, control: metadata.control,
    helper: { executable: metadata.executable, script: resolve(import.meta.dir, "fixtures/image-transfer-electron.cjs") },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: metadata.surfaceId, surfaceTargets: { [metadata.surfaceId]: metadata.targetId },
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return { page, key, owner: { descriptorPath, traceId: metadata.traceId, helperPid: process.pid,
    surfaceId: metadata.surfaceId, jobId: metadata.jobId } };
}

async function assertClean() {
  let snapshot: { transactions: number; files: string[]; observations: Array<{ savePathAssigned: boolean }> } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    snapshot = await electron.evaluate(() => (globalThis as any).imageTransferFixture.snapshot());
    if (!snapshot!.transactions && !snapshot!.files.length) break;
    await Bun.sleep(50);
  }
  expect(snapshot!.transactions).toBe(0);
  expect(snapshot!.files).toEqual([]);
  expect(snapshot!.observations.every(item => item.savePathAssigned)).toBeTrue();
}

async function cards(page: Page, key: string, options: { menu?: boolean; overlay?: boolean; disabledMs?: number; delay?: number; oversized?: boolean; count?: number } = {}) {
  const count = options.count ?? 1;
  await page.setContent(`<!doctype html><style>
    .card { display:inline-block; position:relative; margin:10px; }
    .card img { width:180px; height:180px; }
    .overlay { position:absolute; inset:35px 0 0; pointer-events:none; }
    [role=dialog] { position:fixed; inset:0; background:white; z-index:10; }
    [role=dialog] img { width:400px; height:400px; display:block; }
    [role=menu] { position:fixed; top:100px; right:20px; z-index:20; background:white; }
  </style><button onclick="window.wrongClicks++">Download unrelated</button><section id="assistant">
  ${Array.from({ length: count }, (_, i) => `<div class="card group/imagegen-image" id="image-${i + 1}">
    <button onclick="window.wrongClicks++">Share</button><button aria-label="Edit image" onclick="openViewer(${i + 1})">Edit</button>
    <img src="${preview(i + 1)}" onclick="openViewer(${i + 1})">
    ${options.overlay ? `<button class="overlay" onclick="openViewer(${i + 1})"></button>` : ""}
  </div>`).join("")}</section><script>
    window.wrongClicks=0; window.openClicks=0; window.downloadClicks=0; window.menuClicks=0;
    window.openViewer = index => {
      window.openClicks++;
      document.querySelectorAll('[role=dialog]').forEach(root => root.remove());
      const viewer = document.createElement('div'); viewer.setAttribute('role','dialog');
      viewer.setAttribute('data-image-id','image-'+index);
      viewer.innerHTML = '<button onclick="this.parentElement.remove()" aria-label="Close">Close</button>'
        + '<button onclick="window.wrongClicks++">Share</button>'
        + '<img src="'+document.querySelector('#image-'+index+' img').src+'">'
        + '<button id="download-trigger" ${options.menu ? 'aria-haspopup="menu" aria-expanded="false" aria-controls="download-menu"' : ""} ${options.disabledMs ? "disabled" : ""}>Download</button>';
      document.body.append(viewer);
      const trigger=viewer.querySelector('#download-trigger');
      const download = () => location.assign(${JSON.stringify(`${origin}/download?key=${key}&delay=${options.delay ?? 0}${options.oversized ? "&oversized=1" : ""}&image=`)}+index);
      trigger.onclick = () => {
        window.downloadClicks++;
        if (${!!options.menu}) {
          trigger.setAttribute('aria-expanded','true');
          const menu=document.createElement('div'); menu.id='download-menu'; menu.setAttribute('role','menu'); menu.setAttribute('aria-labelledby','download-trigger');
          menu.innerHTML='<button role="menuitem">Download original</button>';
          menu.firstElementChild.onclick=()=>{ window.menuClicks++; download(); menu.remove(); }; document.body.append(menu);
        } else download();
      };
      ${options.disabledMs ? `setTimeout(()=>trigger.disabled=false,${options.disabledMs});` : ""}
    };
  </script>`);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("#assistant img")].every(image => image.complete && image.naturalWidth > 0));
}

function capture(page: Page, owner: LauncherImageDownloadOwner, options: { maxBytes?: number; signal?: AbortSignal; budget?: ImageTransferDeadline } = {}) {
  return downloadOutputImage({ page, responseTurn: page.locator("#assistant"),
    candidate: { key: "image-1", imageSrc: preview(), readiness: "ready" }, maxBytes: options.maxBytes ?? 10_000,
    launcherOwner: owner, abortSignal: options.signal, budget: options.budget, log: trace });
}

test("Electron: accepted image edit waits for the source thumbnail to hydrate", async () => {
  const { page, key } = await newPage();
  await cards(page, key);
  await page.locator("#assistant").evaluate(element => element.setAttribute("data-turn-id", "source-turn-123"));
  await page.locator("#image-1 img").click();
  await page.evaluate(source => {
    const form = document.createElement("form");
    form.innerHTML = '<div contenteditable="true"></div><button type="button" data-testid="send-button">Send</button>';
    form.querySelector("button")!.onclick = () => {
      const user = document.createElement("section");
      user.setAttribute("data-turn-id", "new-edit-user");
      user.textContent = "Change the color";
      document.body.append(user);
      setTimeout(() => {
        const image = document.createElement("img"); image.alt = "Edited image"; image.src = source; user.append(image);
      }, 300);
    };
    document.querySelector('[role="dialog"]')!.append(form);
  }, preview());
  let submitted = false;
  const method = (ChatGptBrowserWorker.prototype as any).sendImageEditPrompt;
  await method.call({
    waitForSubmissionAcceptedWithRecovery: async () => "user_turn",
    submissionDomState: async () => ({ userIdentities: ["old-user", "new-edit-user"] }),
  }, page, { initialTurnIdentities: ["old-user"], domCache: {} }, {
    assistantTurnId: "source-turn-123", candidateKey: "image-1", cardId: "image-1",
  }, "Change the color", undefined, { onSubmitted: () => { submitted = true; } });
  expect(submitted).toBe(true);
  expect(await page.locator('[data-turn-id="new-edit-user"] img').count()).toBe(1);
}, 15_000);

test("Electron: scoped Edit image opener ignores unrelated overlay and toolbar controls", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { overlay: true });
  expect((await capture(page, owner)).equals(payload())).toBeTrue();
  expect(await page.evaluate(() => [ (window as any).wrongClicks, (window as any).openClicks, (window as any).downloadClicks ])).toEqual([0, 1, 1]);
  expect(requests.get(key)).toBe(1);
  await assertClean();
}, 15_000);

test("Electron: Download opens a related portal menu without clicking unrelated controls", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { menu: true });
  expect((await capture(page, owner)).equals(payload())).toBeTrue();
  expect(await page.evaluate(() => [ (window as any).wrongClicks, (window as any).downloadClicks, (window as any).menuClicks ])).toEqual([0, 1, 1]);
  expect(requests.get(key)).toBe(1); await assertClean();
}, 15_000);

test("Electron: download listener survives a click delayed beyond five seconds", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { disabledMs: 5_300, delay: 200 });
  const started = Date.now();
  expect((await capture(page, owner)).equals(payload())).toBeTrue();
  expect(Date.now() - started).toBeGreaterThanOrEqual(5_300);
  expect(requests.get(key)).toBe(1); await assertClean();
}, 20_000);

test("Electron: slow download and two simultaneous jobs keep the correct tab/job ownership", async () => {
  const one = await newPage(), two = await newPage();
  await cards(one.page, one.key, { delay: 700 }); await cards(two.page, two.key, { delay: 200 });
  const bytes = await Promise.all([capture(one.page, one.owner), capture(two.page, two.owner)]);
  expect(bytes.every(value => value.equals(payload()))).toBeTrue();
  expect(requests.get(one.key)).toBe(1); expect(requests.get(two.key)).toBe(1);
  await assertClean();
}, 15_000);

test("Electron: oversized files fail and remove partial downloads", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { oversized: true, delay: 400 });
  expect(await rejection(capture(page, owner, { maxBytes: 1_000 }))).toMatchObject({ code: "image_download_size_limit" });
  expect(requests.get(key)).toBe(1); await assertClean();
}, 15_000);

test("Electron: cancelling a running download never repeats the click and cleans its file", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { delay: 5_000 });
  const controller = new AbortController();
  const running = capture(page, owner, { signal: controller.signal });
  // Observe rejection immediately, but run the matcher only after dispatching abort.
  // Bun's rejects matcher can otherwise wait for settlement before this test advances.
  const outcome = running.then(() => ({ ok: true }), error => ({ ok: false, error }));
  trace("awaiting_download_click");
  await page.waitForFunction(() => (window as any).downloadClicks === 1, undefined, { timeout: 5_000, polling: 50 });
  trace("download_click_observed");
  await Bun.sleep(150); controller.abort(); trace("abort_dispatched");
  expect(await outcome).toMatchObject({ ok: false });
  trace("capture_cancelled");
  expect(requests.get(key)).toBe(1); await assertClean();
}, 15_000);

test("Electron: one deadline covers a slow download and its temporary-file cleanup", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { delay: 10_000 });
  const budget = new ImageTransferDeadline(Date.now() + 3_000);
  try { expect(await rejection(capture(page, owner, { budget }))).toMatchObject({ code: "image_transfer_timeout" }); }
  finally { budget.dispose(); }
  expect(requests.get(key)).toBe(1); await assertClean();
}, 15_000);

test("Electron: cancellation before actionability prevents a late Download click", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { disabledMs: 5_300 });
  const controller = new AbortController();
  const outcome = capture(page, owner, { signal: controller.signal }).then(() => ({ ok: true }), error => ({ ok: false, error }));
  await page.locator("#download-trigger").waitFor({ timeout: 5_000 });
  await Bun.sleep(150); controller.abort();
  expect(await outcome).toMatchObject({ ok: false });
  await page.locator("#download-trigger").evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).disabled = false));
  await Bun.sleep(200);
  expect(await page.evaluate(() => (window as any).downloadClicks)).toBe(0);
  expect(requests.get(key)).toBeUndefined(); await assertClean();
}, 15_000);

test("Electron: two image cards persist distinct readable artifacts with one download per card", async () => {
  const { page, owner, key } = await newPage(); await cards(page, key, { count: 2 });
  const target = resolveOutputArtifactTarget({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, "a".repeat(64), undefined)!;
  const result = await new OutputImageAdapter().captureFinal({ page, responseTurn: page.locator("#assistant"),
    assistantTurnId: key, traceId: owner.traceId, executionKey: "a".repeat(64), target, launcherOwner: owner });
  expect(result.failures).toEqual([]); expect(result.artifacts.length).toBe(2);
  expect(readFileSync(result.artifacts[0]!.absolutePath).equals(payload(1))).toBeTrue();
  expect(readFileSync(result.artifacts[1]!.absolutePath).equals(payload(2))).toBeTrue();
  expect(JSON.parse(readFileSync(join(root, result.manifestPath!), "utf8")).artifacts.length).toBe(2);
  expect(requests.get(key)).toBe(2); await assertClean();
}, 15_000);

test("Electron: an unmounted card fails before dispatching any click", async () => {
  const { page, key } = await newPage(); await cards(page, key);
  await page.locator("#image-1").evaluate(element => element.remove());
  const budget = new ImageTransferDeadline(Date.now() + 1_000);
  try {
    expect(await rejection(openBoundImageViewer({ page, responseTurn: page.locator("#assistant"),
      candidate: { key: "image-1", imageSrc: preview(), readiness: "ready" }, budget, log() {} }))).toMatchObject({ code: "image_card_unmounted", retryable: true });
  } finally { budget.dispose(); }
  expect(requests.get(key)).toBeUndefined();
});

test("Electron: a remounted viewer has exactly one binding even when the old dialog stays hidden", async () => {
  const { page, key } = await newPage(); await cards(page, key);
  const budget = new ImageTransferDeadline(Date.now() + 5_000);
  try {
    const viewer = await openBoundImageViewer({ page, responseTurn: page.locator("#assistant"),
      candidate: { key: "image-1", imageSrc: preview(), readiness: "ready" }, budget, log() {} });
    await viewer.scope.evaluate(element => { const replacement = element.cloneNode(true); (element as HTMLElement).style.display = "none"; element.after(replacement); });
    await viewer.assertCurrent(); expect(await viewer.scope.count()).toBe(1); await viewer.close();
  } finally { budget.dispose(); }
});

test("Electron: duplicate gallery card ids are selected by file identity before Edit image opens", async () => {
  const { page, key } = await newPage();
  const first = "file_00000000000000000000000000000001";
  const second = "file_00000000000000000000000000000002";
  const third = "file_00000000000000000000000000000003";
  await page.setContent(`<!doctype html><style>
    [class*="imagegen-image"] { display:block; width:180px; height:180px; }
    [class*="imagegen-image"] img { width:180px; height:180px; }
    [role=dialog] { position:fixed; inset:0; background:white; z-index:10; }
    [role=dialog] img { width:400px; height:400px; display:block; }
  </style><section id="assistant">
    <div id="image-duplicate" class="group/imagegen-image" data-primary="true" data-file-id="${first}">
      <button aria-label="Edit image" onclick="openViewer()">Edit</button>
      <img data-file-id="${first}" src="${preview(1)}">
    </div>
    <button id="gallery-1" aria-label="Image 1 of 3" onclick="selectImage(1, '${first}')"><div id="image-duplicate" class="group/imagegen-image"><img data-file-id="${first}" src="${preview(1)}"></div></button>
    <button id="gallery-2" aria-label="Image 2 of 3" onclick="selectImage(2, '${second}')"><div id="image-duplicate" class="group/imagegen-image"><img data-file-id="${second}" src="${preview(2)}"></div></button>
    <button id="gallery-3" aria-label="Image 3 of 3" onclick="selectImage(3, '${third}')"><div id="image-duplicate" class="group/imagegen-image"><img data-file-id="${third}" src="${preview(3)}"></div></button>
  </section><script>
    window.galleryClicks=[]; window.openClicks=0;
    window.selectImage=(index, identity)=>{
      window.galleryClicks.push(index);
      const card=document.querySelector('#assistant > [data-primary]');
      const image=card.querySelector('img');
      card.setAttribute('data-file-id', identity); image.setAttribute('data-file-id', identity);
      image.src=document.querySelector('#gallery-'+index+' img').src;
    };
    window.openViewer=()=>{
      window.openClicks++;
      const source=document.querySelector('#assistant > [data-primary] img');
      const viewer=document.createElement('div'); viewer.setAttribute('role','dialog');
      viewer.innerHTML='<button aria-label="Close" onclick="this.parentElement.remove()">Close</button>'
        + '<img data-file-id="'+source.getAttribute('data-file-id')+'" src="'+source.src+'">';
      document.body.append(viewer);
    };
  </script>`);
  const budget = new ImageTransferDeadline(Date.now() + 5_000);
  try {
    const viewer = await openBoundImageViewer({
      page,
      responseTurn: page.locator("#assistant"),
      candidate: { key: second, cardId: "image-duplicate", fileIdentity: second, imageSrc: preview(2), readiness: "ready" },
      budget,
      log: trace,
    });
    expect(await page.evaluate(() => [(window as any).galleryClicks, (window as any).openClicks])).toEqual([[2], 1]);
    await viewer.scope.locator("img").evaluate((image, source) => {
      (image as HTMLImageElement).src = source;
    }, preview(3));
    await viewer.assertCurrent();
    await viewer.close();
  } finally { budget.dispose(); }
  expect(requests.get(key)).toBeUndefined();
});

test("Electron: one shared gallery card selects a nested output before Edit image opens", async () => {
  const { page, key } = await newPage();
  const first = "file_00000000000000000000000000000011";
  const second = "file_00000000000000000000000000000012";
  const third = "file_00000000000000000000000000000013";
  await page.setContent(`<!doctype html><style>
    [class*="imagegen-image"] { display:block; width:520px; min-height:180px; }
    #preview img { width:180px; height:180px; }
    .gallery img { width:44px; height:44px; }
    [role=dialog] { position:fixed; inset:0; background:white; z-index:10; }
    [role=dialog] img { width:400px; height:400px; display:block; }
  </style><section id="assistant">
    <div id="image-shared" class="group/imagegen-image" data-file-id="${first}">
      <button id="preview" aria-label="Generated image"><img alt="Generated image" data-file-id="${first}" src="${preview(1)}"></button>
      <button aria-label="Edit image" onclick="openViewer()">Edit</button>
      <button id="gallery-1" class="gallery" aria-label="Generated image" onclick="selectImage(1, '${first}')"><img data-file-id="${first}" src="${preview(1)}"></button>
      <button id="gallery-2" class="gallery" aria-label="Generated image" onclick="selectImage(2, '${second}')"><img data-file-id="${second}" src="${preview(2)}"></button>
      <button id="gallery-3" class="gallery" aria-label="Generated image" onclick="selectImage(3, '${third}')"><img data-file-id="${third}" src="${preview(3)}"></button>
    </div>
  </section><script>
    window.galleryClicks=[]; window.openClicks=0;
    window.selectImage=(index, identity)=>{
      window.galleryClicks.push(index);
      const card=document.querySelector('#image-shared');
      const image=document.querySelector('#preview img');
      const selected=document.querySelector('#gallery-'+index+' img');
      card.setAttribute('data-file-id', identity); image.setAttribute('data-file-id', identity); image.src=selected.src;
    };
    window.openViewer=()=>{
      window.openClicks++;
      const source=document.querySelector('#preview img');
      const viewer=document.createElement('div'); viewer.setAttribute('role','dialog');
      viewer.innerHTML='<button aria-label="Close" onclick="this.parentElement.remove()">Close</button>'
        + '<img data-file-id="'+source.getAttribute('data-file-id')+'" src="'+source.src+'">';
      document.body.append(viewer);
    };
  </script>`);
  const budget = new ImageTransferDeadline(Date.now() + 5_000);
  try {
    const viewer = await openBoundImageViewer({
      page,
      responseTurn: page.locator("#assistant"),
      candidate: { key: second, cardId: "image-shared", fileIdentity: second, imageSrc: preview(2), readiness: "ready" },
      budget,
      log: trace,
    });
    expect(await page.evaluate(() => [(window as any).galleryClicks, (window as any).openClicks])).toEqual([[2], 1]);
    await viewer.assertCurrent();
    await viewer.close();
  } finally { budget.dispose(); }
  expect(requests.get(key)).toBeUndefined();
});

test("Electron: an opaque gallery output resolves stable identity before Edit image opens", async () => {
  const { page, key } = await newPage();
  const first = "file_00000000000000000000000000000021";
  const second = "file_00000000000000000000000000000022";
  const third = "file_00000000000000000000000000000023";
  await page.setContent(`<!doctype html><style>
    [class*="imagegen-image"] { display:block; width:520px; min-height:180px; }
    #preview img { width:180px; height:180px; }
    .gallery img { width:44px; height:44px; }
    [role=dialog] { position:fixed; inset:0; background:white; z-index:10; }
    [role=dialog] img { width:400px; height:400px; display:block; }
  </style><section id="assistant">
    <div id="image-shared-opaque" class="group/imagegen-image" data-file-id="${first}">
      <button id="preview" aria-label="Generated image"><img alt="Generated image" data-file-id="${first}" src="${preview(1)}"></button>
      <button aria-label="Edit image" onclick="openViewer()">Edit</button>
      <button id="gallery-1" class="gallery" aria-label="Generated image" onclick="selectImage(1, '${first}')"><img alt="Generated image" src="${preview(1)}"></button>
      <button id="gallery-2" class="gallery" aria-label="Generated image" onclick="selectImage(2, '${second}')"><img alt="Generated image" src="${preview(2)}"></button>
      <button id="gallery-3" class="gallery" aria-label="Generated image" onclick="selectImage(3, '${third}')"><img alt="Generated image" src="${preview(3)}"></button>
    </div>
  </section><script>
    window.galleryClicks=[]; window.openClicks=0;
    window.selectImage=(index, identity)=>{
      window.galleryClicks.push(index);
      const card=document.querySelector('#image-shared-opaque');
      const image=document.querySelector('#preview img');
      const selected=document.querySelector('#gallery-'+index+' img');
      card.setAttribute('data-file-id', identity); image.setAttribute('data-file-id', identity); image.src=selected.src;
    };
    window.openViewer=()=>{
      window.openClicks++;
      const source=document.querySelector('#preview img');
      const viewer=document.createElement('div'); viewer.setAttribute('role','dialog');
      viewer.innerHTML='<button aria-label="Close" onclick="this.parentElement.remove()">Close</button>'
        + '<img data-file-id="'+source.getAttribute('data-file-id')+'" src="'+source.src+'">';
      document.body.append(viewer);
    };
  </script>`);
  const budget = new ImageTransferDeadline(Date.now() + 5_000);
  const candidate: OutputImageCandidate = {
    key: "gallery-pending:image-shared-opaque:1",
    cardId: "image-shared-opaque",
    transientGalleryOrdinal: 1,
    readiness: "loading" as const,
  };
  try {
    const viewer = await openBoundImageViewer({
      page,
      responseTurn: page.locator("#assistant"),
      candidate,
      budget,
      log: trace,
    });
    expect(await page.evaluate(() => [(window as any).galleryClicks, (window as any).openClicks])).toEqual([[2], 1]);
    expect(candidate.key).toBe(second);
    expect(candidate.fileIdentity).toBe(second);
    expect(candidate.transientGalleryOrdinal).toBeUndefined();
    await viewer.assertCurrent();
    await viewer.close();
  } finally { budget.dispose(); }
  expect(requests.get(key)).toBeUndefined();
});

test("Electron: a matching thumbnail cannot disguise a different selected image", async () => {
  const { page, key } = await newPage(); await cards(page, key, { count: 2 });
  const budget = new ImageTransferDeadline(Date.now() + 5_000);
  try {
    const viewer = await openBoundImageViewer({ page, responseTurn: page.locator("#assistant"),
      candidate: { key: "image-1", imageSrc: preview(), readiness: "ready" }, budget, log: trace });
    await viewer.scope.evaluate((root, other) => {
      const main = root.querySelector<HTMLImageElement>("img")!;
      const thumbnail = main.cloneNode(true) as HTMLImageElement;
      thumbnail.style.width = thumbnail.style.height = "40px";
      root.append(thumbnail); root.setAttribute("data-image-id", "image-2"); main.src = other;
    }, preview(2));
    expect(await rejection(viewer.assertCurrent())).toMatchObject({ code: "image_viewer_identity_changed" });
    expect(await page.evaluate(() => (window as any).downloadClicks)).toBe(0);
    expect(requests.get(key)).toBeUndefined(); await viewer.close();
  } finally { budget.dispose(); }
});

async function uploadForm(page: Page, mode: "explicit" | "implicit" | "rejected" | "pending" = "explicit") {
  await page.setContent(`<form><textarea id="prompt-textarea">Edit the reference</textarea><input type="file" multiple data-testid="upload-photos-input"><div id="attachments"></div><button type="button" data-testid="send-button" onclick="window.sends++">Send</button></form><script>
    window.sends=0;
    document.querySelector('input').onchange=event=>{
      for(const file of event.target.files){
        const group=document.createElement('div'); group.setAttribute('role','group'); group.setAttribute('aria-label',file.name); group.setAttribute('data-upload-state','uploading');
        const image=document.createElement('img'); image.src=URL.createObjectURL(file); image.width=40; image.height=40; group.append(image);
        const remove=document.createElement('button'); remove.type='button'; remove.setAttribute('aria-label',${JSON.stringify(mode === "implicit" ? "添付ファイルを削除" : "Remove attachment")}); remove.textContent=${JSON.stringify(mode === "implicit" ? "削除" : "Remove")}; remove.onclick=()=>group.remove(); group.append(remove);
        document.querySelector('#attachments').append(group);
        ${mode !== "pending" ? `setTimeout(()=>{ ${mode === "implicit" ? "group.removeAttribute('data-upload-state');" : `group.setAttribute('data-upload-state','${mode === "rejected" ? "error" : "uploaded"}');`} },120);` : ""}
      }
    };
  </script>`);
}
const reference = (name = "reference.png") => ({ name, mimeType: "image/png", buffer: png });

async function seedStaleAttachment(
  page: Page,
  name: string,
  removeLabel = "Remove attachment",
  removeControls = 1,
) {
  await page.locator("#attachments").evaluate((root, options) => {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", options.name);
    group.setAttribute("data-upload-state", "uploaded");
    const image = document.createElement("img");
    image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    image.width = 40;
    image.height = 40;
    group.append(image);
    for (let index = 0; index < options.removeControls; index++) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `${options.removeLabel}${index === 0 ? "" : ` ${index + 1}`}`);
      remove.textContent = "×";
      remove.onclick = () => group.remove();
      group.append(remove);
    }
    root.append(group);
  }, { name, removeLabel, removeControls });
}

function attachmentWorker(page: Page) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as unknown as {
    activeComposer(page: Page): Promise<Locator>;
    attachFiles(page: Page, prompt: { images: Array<{ ref: string; imageUrl: string }> }, signal: AbortSignal,
      log: (stage: string, fields?: Record<string, unknown>) => void): Promise<AttachmentGuard>;
  };
  worker.activeComposer = async () => page.locator("#prompt-textarea");
  return worker;
}

test("Electron upload: one/multiple references require accepted previews and guard removal before Send", async () => {
  for (const mode of ["explicit", "implicit"] as const) {
    const { page } = await newPage(); await uploadForm(page, mode);
    const files = mode === "explicit" ? [reference()] : [reference("one.png"), reference("two.png")];
    const stages: string[] = [];
    const guard = await attachPromptFiles({ page, form: page.locator("form"), files, log: stage => stages.push(stage) });
    await guard.assertReady(); expect(stages).toContain("attachments_accepted");
    await page.getByRole("group", { name: files[0]!.name, exact: true }).evaluate(element => element.remove());
    expect(await rejection(guard.assertReady())).toMatchObject({ code: "attachments_not_ready" });
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
  }
}, 15_000);

test("Electron upload: rejected uploads never reach Send", async () => {
  const { page } = await newPage(); await uploadForm(page, "rejected");
  expect(await rejection(attachPromptFiles({ page, form: page.locator("form"), files: [reference()], log: trace }))).toMatchObject({ code: "attachment_upload_rejected" });
  expect(await page.evaluate(() => (window as any).sends)).toBe(0);
}, 15_000);

test("Electron upload: cancellation during an upload never reaches Send", async () => {
  const { page } = await newPage(); await uploadForm(page, "pending"); const controller = new AbortController();
  const task = attachPromptFiles({ page, form: page.locator("form"), files: [reference()], abortSignal: controller.signal, log() {} });
  const outcome = task.then(() => ({ ok: true }), error => ({ ok: false, error }));
  await page.getByRole("group", { name: "reference.png", exact: true }).waitFor({ timeout: 5_000 }); controller.abort();
  expect(await outcome).toMatchObject({ ok: false });
  expect(await page.evaluate(() => (window as any).sends)).toBe(0);
});

test("Electron upload: a no-file turn clears a stale attachment left by the previous task", async () => {
  const { page } = await newPage();
  await uploadForm(page);
  await seedStaleAttachment(page, "task-a.png", "添付ファイルを削除");
  const worker = attachmentWorker(page);
  const guard = await worker.attachFiles(page, { images: [] }, new AbortController().signal, trace);
  await guard.assertReady();

  expect(await page.locator('form [role="group"][aria-label]').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).sends)).toBe(0);
});

test("Electron upload: a new file replaces a stale attachment instead of being appended beside it", async () => {
  const { page } = await newPage();
  await uploadForm(page);
  await seedStaleAttachment(page, "task-a.png");
  const worker = attachmentWorker(page);
  const freshImage = `data:image/png;base64,${png.toString("base64")}`;
  const guard = await worker.attachFiles(page, {
    images: [{ ref: "task-b", imageUrl: freshImage }],
  }, new AbortController().signal, trace);
  await guard.assertReady();

  expect(await page.locator('form [role="group"][aria-label]').evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")))).toEqual(["task-b.png"]);
  expect(await page.evaluate(() => (window as any).sends)).toBe(0);
});

test("Electron upload: ambiguous stale-attachment cleanup fails closed before Send", async () => {
  const { page } = await newPage();
  await uploadForm(page);
  await seedStaleAttachment(page, "ambiguous.png", "Remove attachment", 2);
  const worker = Object.create(ChatGptBrowserWorker.prototype) as unknown as {
    activeComposer(page: Page): Promise<Locator>;
    sendAttachedPrompt(page: Page, baseline: unknown): Promise<unknown>;
  };
  worker.activeComposer = async () => page.locator("#prompt-textarea");

  expect(await rejection(worker.sendAttachedPrompt(page, {}))).toMatchObject({
    code: "attachment_cleanup_control_ambiguous",
  });
  expect(await page.evaluate(() => (window as any).sends)).toBe(0);
});

test("Electron upload: follow-up removes a stale attachment before using the retained composer", async () => {
  const { page } = await newPage();
  await uploadForm(page);
  await seedStaleAttachment(page, "previous-turn.png", "添付ファイルを削除");
  const request: ChatGptFollowUpRequest = {
    requestId: "follow-up-stale-attachment",
    revision: 2,
    instructionId: "b".repeat(64),
    text: "Apply the follow-up without the previous file",
  };
  const channel = new ChatGptFollowUpChannel(5_000);
  void channel.enqueue(request);
  const worker = Object.create(ChatGptBrowserWorker.prototype) as unknown as {
    activeComposer(page: Page): Promise<Locator>;
    insertPromptText(page: Page, text: string): Promise<void>;
    assertPromptAttached(page: Page, text: string): Promise<void>;
    waitForSubmissionAcceptedWithRecovery(): Promise<"user_turn">;
    sendFollowUpPrompt(page: Page, baseline: unknown, request: ChatGptFollowUpRequest, channel: ChatGptFollowUpChannel): Promise<unknown>;
  };
  worker.activeComposer = async () => page.locator("#prompt-textarea");
  worker.insertPromptText = async (_page: Page, text: string) => { await page.locator("#prompt-textarea").fill(text); };
  worker.assertPromptAttached = async (_page: Page, text: string) => {
    expect(await page.locator("#prompt-textarea").inputValue()).toBe(text);
  };
  worker.waitForSubmissionAcceptedWithRecovery = async () => "user_turn";

  await worker.sendFollowUpPrompt(page, {}, request, channel);

  expect(await page.locator('form [role="group"][aria-label]').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).sends)).toBe(1);
  expect(await channel.waitForTerminal(request)).toMatchObject({ type: "submitted", revision: 2 });
});

test("Electron upload: the production send boundary rechecks references and cancellation after its callback", async () => {
  for (const cancel of [false, true]) {
    const { page } = await newPage(); await uploadForm(page);
    const guard = await attachPromptFiles({ page, form: page.locator("form"), files: [reference()], log() {} });
    const controller = new AbortController();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      activeComposer(page: Page): Promise<Locator>;
      sendAttachedPrompt(page: Page, baseline: unknown, diagnostic: undefined, signal: AbortSignal, progress: undefined,
        lifecycle: { onSendActivated(): Promise<void> }, tracker: undefined, recovery: undefined, guard: AttachmentGuard): Promise<unknown>;
    };
    worker.activeComposer = async () => page.locator("#prompt-textarea");
    expect(await rejection(worker.sendAttachedPrompt(page, {}, undefined, controller.signal, undefined, {
      async onSendActivated() {
        if (cancel) controller.abort(); else await page.getByRole("group", { name: "reference.png", exact: true }).evaluate(element => element.remove());
      },
    }, undefined, undefined, guard))).toBeDefined();
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
  }
}, 15_000);
