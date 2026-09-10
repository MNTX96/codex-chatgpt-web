const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { OwnedImageDownloads } = require("../electron/image-downloads.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "owned-images-test-"));
  const manager = new OwnedImageDownloads({ directory });
  const session = new EventEmitter();
  const contents = (id) => Object.assign(new EventEmitter(), {
    id, session, isDestroyed: () => false, getOrCreateDevToolsTargetId: () => `target-${id}`,
  });
  const owner = (id = 1) => ({
    traceId: `trace-${id}`, helperPid: process.pid, surfaceId: `surface-${id}`,
    targetId: `target-${id}`, jobId: `job-${id}`, candidateKey: `image-${id}`,
    transactionId: `transaction-${id}`, maxBytes: 1_024, deadlineAt: Date.now() + 30_000,
  });
  const item = () => Object.assign(new EventEmitter(), {
    path: undefined, cancelled: false, received: 0, total: 0,
    setSavePath(path) { this.path = path; },
    getReceivedBytes() { return this.received; }, getTotalBytes() { return this.total; },
    cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); },
    complete(bytes = Buffer.from("image")) {
      writeFileSync(this.path, bytes); this.emit("done", {}, "completed");
    },
  });
  t.after(() => { manager.destroy(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, manager, session, contents, owner, item };
}

test("owned downloads set a temporary path synchronously and release every file/listener", t => {
  const f = fixture(t); const owner = f.owner(); const contents = f.contents(1);
  assert.equal(f.manager.begin(contents, owner).state, "armed");
  const item = f.item();
  f.session.emit("will-download", {}, item, contents);
  assert.equal(typeof item.path, "string");
  assert.equal(f.manager.status(owner).state, "downloading");
  item.complete();
  assert.equal(f.manager.status(owner).state, "completed");
  assert.equal(existsSync(f.manager.status(owner).path), true);
  f.manager.release(owner);
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(f.session.listenerCount("will-download"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
  assert.equal(item.listenerCount("updated"), 0);
  assert.equal(item.listenerCount("done"), 0);
});

test("downloads outside the registered webContents retain ordinary Electron behavior", t => {
  const f = fixture(t); f.manager.begin(f.contents(1), f.owner());
  const item = f.item();
  f.session.emit("will-download", {}, item, f.contents(2));
  assert.equal(item.path, undefined);
  assert.equal(item.cancelled, false);
  assert.equal(f.manager.status(f.owner()).state, "armed");
});

test("two concurrent jobs have isolated paths and same-tab conflicts fail before a click", t => {
  const f = fixture(t); const a = f.owner(1), b = f.owner(2);
  const ca = f.contents(1), cb = f.contents(2);
  f.manager.begin(ca, a); f.manager.begin(cb, b);
  assert.throws(() => f.manager.begin(ca, { ...b, transactionId: "third" }), /tab_busy/);
  const ia = f.item(), ib = f.item();
  f.session.emit("will-download", {}, ib, cb);
  f.session.emit("will-download", {}, ia, ca);
  assert.notEqual(ia.path, ib.path);
  ib.complete(Buffer.from("second")); ia.complete(Buffer.from("first"));
  assert.equal(f.manager.status(a).byteLength, 5);
  assert.equal(f.manager.status(b).byteLength, 6);
  f.manager.release(a);
  assert.equal(existsSync(ib.path), true);
  assert.equal(f.session.listenerCount("will-download"), 1);
  f.manager.release(b);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("registration is idempotent and all ownership fields are checked on status/release", t => {
  const f = fixture(t); const body = f.owner(), contents = f.contents(1);
  assert.deepEqual(f.manager.begin(contents, body), f.manager.begin(contents, body));
  assert.equal(readdirSync(f.directory).length, 1);
  assert.throws(() => f.manager.begin(contents, { ...body, maxBytes: 99 }), /transaction_conflict/);
  for (const field of ["traceId", "helperPid", "surfaceId", "targetId", "jobId", "candidateKey"]) {
    const other = { ...body, [field]: field === "helperPid" ? process.pid + 1 : "other" };
    assert.throws(() => f.manager.status(other), /owner_mismatch/);
    assert.throws(() => f.manager.release(other), /owner_mismatch/);
  }
});

test("oversized and interrupted downloads cancel and clean their partial file", t => {
  const f = fixture(t);
  for (const [index, mode] of ["declared", "received", "interrupted"].entries()) {
    const body = f.owner(index + 1), contents = f.contents(index + 1), item = f.item();
    f.manager.begin(contents, body); f.session.emit("will-download", {}, item, contents);
    writeFileSync(item.path, "partial");
    if (mode === "declared") item.total = 2_000;
    if (mode === "received") item.received = 2_000;
    item.emit("updated", {}, mode === "interrupted" ? "interrupted" : "progressing");
    assert.equal(item.cancelled, true);
    assert.equal(f.manager.status(body).code, mode === "interrupted" ? "image_download_interrupted" : "image_download_size_limit");
    assert.equal(existsSync(item.path), false);
    f.manager.release(body);
  }
  assert.deepEqual(readdirSync(f.directory), []);
});

test("cancellation before/after download start and tab destruction leave no temporary files", t => {
  const f = fixture(t);
  for (const [index, mode] of ["before", "during", "tab-close"].entries()) {
    const body = f.owner(index + 1), contents = f.contents(index + 1), item = f.item();
    f.manager.begin(contents, body);
    if (mode !== "before") {
      f.session.emit("will-download", {}, item, contents); writeFileSync(item.path, "partial");
    }
    if (mode === "tab-close") contents.emit("destroyed"); else f.manager.release(body);
    if (mode !== "before") assert.equal(item.cancelled, true);
    assert.deepEqual(readdirSync(f.directory), []);
  }
});

test("a transaction deadline cancels its download without waiting for the helper", async t => {
  const f = fixture(t), body = { ...f.owner(), deadlineAt: Date.now() + 30 }, contents = f.contents(1);
  f.manager.begin(contents, body); const item = f.item();
  f.session.emit("will-download", {}, item, contents);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.manager.status(body).code, "image_download_timeout");
  assert.equal(item.cancelled, true);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("BrowserHost binds transactions to a live automatic tab and preserves Zero Risk", t => {
  const f = fixture(t), body = f.owner(), contents = f.contents(1);
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "automatic", imageDownloads: f.manager,
    turnTabs: new Map([["tab", { traceId: body.traceId, helperPid: body.helperPid,
      surfaceId: body.surfaceId, interactionMode: "automatic", status: "running", view: { webContents: contents } }]]),
  });
  for (const field of ["traceId", "helperPid", "surfaceId", "targetId"]) {
    assert.throws(() => host.imageDownload("begin", { ...body, [field]: field === "helperPid" ? process.pid + 1 : "other" }), /owner_mismatch/);
  }
  assert.equal(host.imageDownload("begin", body).state, "armed");
  host.getBrowserInteractionMode = () => "manual";
  assert.throws(() => host.imageDownload("begin", body), /disabled in Zero Risk/);
});
