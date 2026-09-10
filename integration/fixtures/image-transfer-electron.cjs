// Isolated local Electron fixture. Never loads a ChatGPT profile or the production launcher.
const { app, BrowserWindow, session } = require("electron");
const { mkdirSync, readdirSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");
const { OwnedImageDownloads } = require("../../launcher/electron/image-downloads.cjs");
const { BrowserHost } = require("../../launcher/electron/browser-host.cjs");
const { BrowserControlServer } = require("../../launcher/electron/control-server.cjs");

const root = process.env.CODEX_IMAGE_TRANSFER_FIXTURE_ROOT;
if (!root || !isAbsolute(root)) throw new Error("The fixture requires an absolute private temporary directory");
app.setPath("userData", join(root, "electron-profile"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const directory = join(root, "downloads");
  mkdirSync(directory, { recursive: true });
  const manager = new OwnedImageDownloads({ directory });
  const partition = session.fromPartition(`image-transfer-test-${process.pid}`);
  const tabs = new Map();
  const observations = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "automatic", imageDownloads: manager, turnTabs: tabs,
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  partition.on("will-download", (_event, item, contents) => {
    queueMicrotask(() => observations.push({ contentsId: contents?.id, savePathAssigned: !!item.getSavePath() }));
  });
  global.imageTransferFixture = {
    async create({ id, helperPid, url }) {
      const window = new BrowserWindow({ show: false, width: 1_000, height: 800,
        webPreferences: { session: partition, backgroundThrottling: false, contextIsolation: true } });
      const contents = window.webContents;
      const surfaceId = id.padStart(32, "0");
      const owner = { traceId: `fixture-${id}`, helperPid, surfaceId, jobId: `job-${id}` };
      tabs.set(id, { ...owner, interactionMode: "automatic", status: "running", view: { webContents: contents } });
      window.once("closed", () => { manager.releaseContents(contents); tabs.delete(id); });
      await window.loadURL(url);
      return { ...owner, contentsId: contents.id, targetId: contents.getOrCreateDevToolsTargetId(),
        control: server.descriptor(), pid: process.pid, executable: process.execPath };
    },
    snapshot() {
      return { transactions: manager.transactions.size, files: readdirSync(directory), observations };
    },
  };
  app.once("before-quit", () => { manager.destroy(); void server.close(); });
  const ready = new BrowserWindow({ show: false, webPreferences: { session: partition } });
  await ready.loadURL("data:text/html,fixture-ready");
});
