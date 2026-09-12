import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { openImageFactoryProject } from "../src/adapters/chatgpt-web/image-factory/project-navigation";
import { withChatGptNavigationGuard } from "../src/adapters/chatgpt-web/rate-limit";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

let app: ElectronApplication;
let page: Page;
let root: string;
const projectId = "g-p-configured-project";
const projectUrl = `https://chatgpt.com/g/${projectId}/project`;
const composer = '<h1>Art studio</h1><div id="prompt-textarea" contenteditable="true"></div>';
const rateLimit = '<div data-testid="modal-conversation-history-rate-limit" style="position:fixed;inset:0;background:white;z-index:100">Lịch sử đang bị giới hạn</div>';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "project-navigation-electron-"));
  app = await _electron.launch({
    executablePath: require("../launcher/node_modules/electron"),
    args: [resolve(import.meta.dir, "fixtures/project-navigation-electron.cjs")],
    env: { ...process.env, PROJECT_NAVIGATION_TEST_ROOT: root },
  });
  await app.firstWindow();
}, 30_000);
afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  const opened=app.waitForEvent("window");
  const loaded=app.evaluate(async ({BrowserWindow})=>{
    const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
    await window.loadURL("about:blank");
  });
  [page]=await Promise.all([opened,loaded]);
  page.on("pageerror", error => console.error("Fixture page error:", error.message));
});
afterEach(async()=>{ if(page&&!page.isClosed())await page.close(); });

test("direct configured ID loads once; existing project and retained conversation cause no navigation", async () => {
  const urls: string[] = [];
  await page.route("https://chatgpt.com/**", route => {
    urls.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: composer });
  });
  await openImageFactoryProject(page, projectId);
  await openImageFactoryProject(page, projectId);
  const conversationUrl = `https://chatgpt.com/g/${projectId}-studio/c/conversation-12345678`;
  await page.evaluate(url => history.pushState({}, "", url), conversationUrl);
  await openImageFactoryProject(page, projectId);
  expect(page.url()).toBe(conversationUrl);
  expect(urls).toEqual([projectUrl]);
});

test("a visible composer is not ready while the project is still loading", async () => {
  await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body:
    composer.replace("Art studio", "Loading project") + '<script>setTimeout(() => document.querySelector("h1").textContent="Art studio", 300)</script>',
  }));
  await openImageFactoryProject(page, projectId);
  expect(await page.getByRole("heading").innerText()).toBe("Art studio");
});

test.each([false, true])("retained Create image mode restores Latest and Medium (picker dismissal=%s)", async dismissOnce => {
  await page.setContent(`<form><div id="prompt-textarea" contenteditable="true"></div>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" aria-controls="picker" aria-expanded="false" onclick="openPicker()">Create image</button></form>
    <div id="picker" role="menu" hidden>
      <div role="menuitemradio" id="image-mode" aria-checked="true">Create image</div>
      <div role="menuitemradio" id="latest" tabindex="0" aria-checked="false">Latest</div>
      <div role="menuitem" tabindex="0" id="thinking" data-model-reasoning-effort-slider style="width:200px;height:30px" hidden><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span></div>
    </div><script>
      const picker=document.querySelector('#picker'), control=document.querySelector('button');
      let opens=0;
      function openPicker(){
        opens++;picker.hidden=false;control.setAttribute('aria-expanded','true');
        if(${dismissOnce} && opens===2){
          document.querySelector('#thinking').hidden=true;
          setTimeout(()=>{picker.hidden=true;control.setAttribute('aria-expanded','false');},20);
        } else if(opens>=3)document.querySelector('#thinking').hidden=false;
      }
      document.querySelector('#latest').onkeydown=e=>{if(e.key==='Enter'){
        document.querySelector('#latest').setAttribute('aria-checked','true');
        document.querySelector('#image-mode').setAttribute('aria-checked','false');
        document.querySelector('#thinking').hidden=false;control.textContent='Latest';
        picker.hidden=true;control.setAttribute('aria-expanded','false');
      }};
      document.querySelector('#thinking').onkeydown=e=>{const slider=document.querySelector('[role=slider]');
        if(e.key==='ArrowRight')slider.setAttribute('aria-valuenow',String(Number(slider.getAttribute('aria-valuenow'))+1));
      };
      document.onkeydown=e=>{if(e.key==='Escape'){picker.hidden=true;control.setAttribute('aria-expanded','false');}};
    </script>`);
  const mode = await (ChatGptBrowserWorker.prototype as any).selectModelAndEffort.call({
    activeComposer: async () => page.locator('#prompt-textarea'),
  }, page, "gpt-5.6-sol", "medium", { localToolsEnabled: false, solAvailable: true, proAvailable: true });
  expect(mode.effort).toBe("medium");
  expect(await page.locator('#latest').getAttribute('aria-checked')).toBe("true");
  expect(await page.getByRole('slider', { includeHidden: true }).getAttribute('aria-valuenow')).toBe("1");
});

test("Create image mention ignores same-named sidebar chats and stale popups", async () => {
  await page.setContent(`<aside>
    <a class="__menu-item" tabindex="0" href="#wrong"><span>Create image</span></a>
    <a class="__menu-item" tabindex="0" href="#wrong-2"><span>Create image</span></a>
  </aside><div class="popover" aria-busy="false" hidden><div class="__menu-item" tabindex="0"><span>Create image</span></div></div>
  <div class="popover" aria-busy="true"><div class="__menu-item" tabindex="0"><span>Create image</span></div></div>
  <form><div id="prompt-textarea" contenteditable="true" style="min-height:60px;width:600px"></div></form>
  <div class="popover" aria-busy="false" id="choices" hidden><div class="__menu-item" tabindex="0" data-highlighted=""><span>Create image</span><span>Visualize anything</span></div></div>
  <script>
    const editor=document.querySelector('#prompt-textarea');
    editor.oninput=()=>{if(editor.textContent==='@image')document.querySelector('#choices').hidden=false;};
    editor.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#choices').hidden=true;
      editor.innerHTML='<span data-inline-selection-pill data-id="picture_v2" data-symbol="ecosystemMention" data-keyword="Create image" data-system-hint-type="picture_v2">Create image</span>';}};
  </script>`);
  const prototype = ChatGptBrowserWorker.prototype as any;
  await prototype.selectImageGenerationTool.call({
    clearChatGptComposerState: async () => {},
    activeComposer: async () => page.locator('#prompt-textarea'),
    selectedImageGenerationControl: prototype.selectedImageGenerationControl,
    imageGenerationToolIsSelected: prototype.imageGenerationToolIsSelected,
  }, page);
  expect(await page.locator('#prompt-textarea [data-id="picture_v2"]').count()).toBe(1);
  expect(page.url()).not.toContain('#wrong');
});

test("checked Latest in the advanced picker returns to the slider before choosing Pro", async () => {
  await page.setContent(`<form><div id="prompt-textarea" contenteditable="true"></div>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" aria-controls="picker" aria-expanded="false" onclick="document.querySelector('#picker').hidden=false;this.setAttribute('aria-expanded','true')">Thinking effort</button></form>
    <div id="picker" role="menu" hidden><div data-view="advanced">
      <div role="menuitemradio" id="latest" tabindex="0" aria-checked="true">Latest</div>
      <div id="power" role="menuitem" tabindex="0" data-model-reasoning-effort-slider style="width:200px;height:30px" hidden><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"></span></div>
    </div></div><script>
      window.latestActivations=0;
      document.querySelector('#latest').onkeydown=e=>{if(e.key==='Enter'){window.latestActivations++;e.target.hidden=true;document.querySelector('[data-view]').setAttribute('data-view','simple');document.querySelector('#power').hidden=false;}};
      document.querySelector('#power').onkeydown=e=>{if(e.key==='ArrowRight'){const s=document.querySelector('[role=slider]');s.setAttribute('aria-valuenow',String(Number(s.getAttribute('aria-valuenow'))+1));}};
      document.onkeydown=e=>{if(e.key==='Escape'){document.querySelector('#picker').hidden=true;document.querySelector('button').setAttribute('aria-expanded','false');}};
    </script>`);
  const mode = await (ChatGptBrowserWorker.prototype as any).selectModelAndEffort.call({
    activeComposer: async () => page.locator('#prompt-textarea'),
  },page,"gpt-5.6-sol","max",{localToolsEnabled:false,solAvailable:true,proAvailable:true});
  expect(mode.effort).toBe("max");
  expect(await page.getByRole('slider',{includeHidden:true}).getAttribute('aria-valuenow')).toBe("4");
  expect(await page.evaluate(()=>(window as any).latestActivations)).toBe(1);
});

test("a picker that explicitly lacks thinking controls fails before Send without treating a banner as authority", async () => {
  await page.setContent(`<form><div id="prompt-textarea" contenteditable="true"></div>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" aria-controls="picker" aria-expanded="false" onclick="openPicker()">Thinking effort</button>
    <button type="button" data-testid="send-button" onclick="window.sent=true">Send</button></form>
    <div id="picker" role="menu" hidden><div data-model-selection-view="true" data-has-slider="false" data-view="advanced">
      <span>Thinking unavailable</span><div id="latest" role="menuitemradio" tabindex="0" aria-checked="false">Latest</div>
    </div></div><script>
      const control=document.querySelector('[data-testid="model-switcher-dropdown-button"]');
      const picker=document.querySelector('#picker');
      function openPicker(){picker.hidden=false;control.setAttribute('aria-expanded','true');}
      document.querySelector('#latest').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.target.setAttribute('aria-checked','true');e.target.hidden=true;}};
    </script>`);
  await expect((ChatGptBrowserWorker.prototype as any).selectModelAndEffort.call({
    activeComposer:async()=>page.locator('#prompt-textarea'),
  },page,"gpt-5.6-sol","max",{localToolsEnabled:false,solAvailable:true,proAvailable:true}))
    .rejects.toMatchObject({code:"model_controls_unavailable",retryable:false});
  expect(await page.evaluate(()=>(window as any).sent===true)).toBe(false);
},30_000);

test("empty retained image composer reuses its verified tool pill without deleting it", async () => {
  await page.setContent(`<form><div id="prompt-textarea" contenteditable="true" style="min-height:60px">
    <span data-inline-selection-pill data-id="picture_v2" data-symbol="ecosystemMention" data-keyword="Create image" data-system-hint-type="picture_v2" contenteditable="false">Create image</span>
    <span data-inline-selection-pill-cursor-target>\uFEFF</span>&nbsp;
  </div></form>`);
  const prototype = ChatGptBrowserWorker.prototype as any;
  const checkpoints: string[] = [];
  const selected = await prototype.selectImageGenerationTool.call({
    clearChatGptComposerState: async () => { throw new Error("must not delete the retained tool"); },
    activeComposer: async () => page.locator('#prompt-textarea'),
    selectedImageGenerationControl: prototype.selectedImageGenerationControl,
    imageGenerationToolIsSelected: prototype.imageGenerationToolIsSelected,
    attachedPromptText: prototype.attachedPromptText,
  }, page, async (checkpoint: string) => { checkpoints.push(checkpoint); });
  expect(await selected.locator('[data-id="picture_v2"]').count()).toBe(1);
  expect(checkpoints).toEqual(["create-image-tool-reused"]);
});

test.each(["draft", "connector"])("retained image tool cannot be reused with a leftover %s", async leftover => {
  await page.setContent(`<div id="prompt-textarea" contenteditable="true" style="min-height:60px">
    <span data-inline-selection-pill data-id="picture_v2" data-symbol="ecosystemMention" data-keyword="Create image" data-system-hint-type="picture_v2">Create image</span>
    ${leftover === "draft" ? "an old prompt" : '<span data-id="plugin:other" data-keyword="Other connector">Other connector</span>'}
  </div>`);
  const prototype = ChatGptBrowserWorker.prototype as any;
  await expect(prototype.selectImageGenerationTool.call({
    clearChatGptComposerState: async () => { throw new Error("fresh selection required"); },
    activeComposer: async () => page.locator('#prompt-textarea'),
    selectedImageGenerationControl: prototype.selectedImageGenerationControl,
    imageGenerationToolIsSelected: prototype.imageGenerationToolIsSelected,
    attachedPromptText: prototype.attachedPromptText,
  }, page)).rejects.toThrow("fresh selection required");
});

async function pinnedFixture(options: { wrongId?: boolean; duplicate?: boolean; collapsed?: boolean; expandOnly?: boolean } = {}) {
  const urls: string[] = [];
  await page.route("https://chatgpt.com/**", async route => {
    const url = route.request().url();
    urls.push(url);
    if (url === projectUrl) return route.abort("failed");
    const row = `<div class="group/project-unfurl-row"><div role="button" data-sidebar-item="true" onclick="${options.expandOnly ? "window.expanded=true" : "openProject()"}"><span>Art studio</span></div><button aria-label="Open project home" onclick="openProject()">Home</button></div>`;
    await route.fulfill({ contentType: "text/html", body: `
      <button onclick="document.querySelector('#section').hidden=false">Open sidebar</button>
      <div id="section" class="group/sidebar-expando-section" ${options.collapsed ? "hidden" : ""}>
      <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#pinned').hidden=false"><h2>Pinned</h2></button>
      <div id="pinned" hidden>${row}${options.duplicate ? row : ""}</div></div>
      <div class="group/project-unfurl-row" onclick="window.clicked.push('outside-pinned')">Art studio</div>
      <script>window.clicked=[];function openProject(){window.clicked.push('configured');history.pushState({},'', '/g/${options.wrongId ? "g-p-other" : projectId}/project');document.body.innerHTML=${JSON.stringify(composer)};}</script>` });
  });
  return urls;
}

test("failed direct navigation uses only the exact configured name in Pinned", async () => {
  const urls = await pinnedFixture();
  await openImageFactoryProject(page, projectId, () => {}, { projectName: " Art studio " });
  expect(page.url()).toBe(projectUrl);
  expect(await page.evaluate(() => (window as any).clicked)).toEqual(["configured"]);
  expect(urls).toEqual([projectUrl, "https://chatgpt.com/"]);
}, 20_000);

test("collapsed sidebar opens Pinned and uses the named project's home action after unfurl", async () => {
  const urls = await pinnedFixture({ collapsed: true, expandOnly: true });
  await openImageFactoryProject(page, projectId, () => {}, { projectName: "Art studio" });
  expect(page.url()).toBe(projectUrl);
  expect(await page.evaluate(() => (window as any).expanded)).toBe(true);
  expect(await page.evaluate(() => (window as any).clicked)).toEqual(["configured"]);
  expect(urls).toEqual([projectUrl, "https://chatgpt.com/"]);
}, 20_000);

test("matching name with a different project ID fails before submission", async () => {
  await pinnedFixture({ wrongId: true });
  await expect(openImageFactoryProject(page, projectId, () => {}, { projectName: "Art studio" }))
    .rejects.toThrow("does not match the configured project_id");
}, 20_000);

test("duplicate pinned names are rejected without clicking either project", async () => {
  await pinnedFixture({ duplicate: true });
  await expect(openImageFactoryProject(page, projectId, () => {}, { projectName: "Art studio" }))
    .rejects.toThrow("multiple projects");
  expect(await page.evaluate(() => (window as any).clicked)).toEqual([]);
}, 20_000);

test("rate-limit on direct load returns structured 429 promptly with no fallback", async () => {
  const urls: string[] = [];
  await page.route("https://chatgpt.com/**", route => {
    urls.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: rateLimit });
  });
  const startedAt = Date.now();
  await expect(openImageFactoryProject(page, projectId, () => {}, { projectName: "Art studio" }))
    .rejects.toMatchObject({ status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true });
  // Includes a fresh Chromium document load; still well below the old 30-second click timeout.
  expect(Date.now() - startedAt).toBeLessThan(5000);
  expect(urls).toEqual([projectUrl]);
});

test("existing modal stops navigation even on a reusable project document", async () => {
  await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: rateLimit + composer }));
  await page.goto(projectUrl);
  await expect(openImageFactoryProject(page, projectId)).rejects.toMatchObject({ status: 429, code: "rate_limit_exceeded" });
});

test("a modal appearing during blocked click cancels it before acknowledging Got it", async () => {
  await page.setContent('<button onclick="window.clicked=true">Project</button><div id="blocker" style="position:fixed;inset:0"></div>');
  const acknowledgedRateLimit = rateLimit.replace("Lịch sử đang bị giới hạn", `Too many requests. You're making requests too quickly.
    <button onclick="window.acknowledged=true;document.querySelector('#blocker').remove();this.parentElement.remove()">Got it</button>`);
  const timer = setTimeout(() => void page.evaluate(html => document.body.insertAdjacentHTML("beforeend", html), acknowledgedRateLimit), 150);
  try {
    const startedAt = Date.now();
    await expect(withChatGptNavigationGuard(page, signal => page.getByRole("button", { name: "Project" }).click({ signal })))
      .rejects.toMatchObject({ status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(await page.evaluate(() => (window as any).acknowledged)).toBe(true);
    await page.evaluate(() => document.querySelectorAll('div').forEach(element => element.remove()));
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).clicked === true)).toBe(false);
  } finally { clearTimeout(timer); }
});
