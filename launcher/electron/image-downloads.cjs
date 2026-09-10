const { mkdtempSync, lstatSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const IMAGE_DOWNLOAD_FEATURE = "owned-image-download-v1";
const OWNER_FIELDS = ["traceId", "helperPid", "surfaceId", "targetId", "jobId", "candidateKey", "transactionId"];
const failure = code => Object.assign(new Error(code), { code });

/** Only an explicitly armed transaction changes Electron's ordinary download behavior. */
class OwnedImageDownloads {
  constructor({ directory = tmpdir(), logger } = {}) {
    this.directory = directory;
    this.logger = logger;
    this.transactions = new Map();
    this.byContents = new Map();
    this.sessions = new Map();
  }

  owned(body) {
    for (const field of OWNER_FIELDS.filter(field => field !== "helperPid")) {
      if (typeof body?.[field] !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body[field])) {
        throw failure("image_download_owner_invalid");
      }
    }
    if (!Number.isSafeInteger(body.helperPid) || body.helperPid < 1) throw failure("image_download_owner_invalid");
    const transaction = this.transactions.get(body.transactionId);
    if (transaction && OWNER_FIELDS.some(field => transaction.owner[field] !== body[field])) {
      throw failure("image_download_owner_mismatch");
    }
    return transaction;
  }

  begin(contents, body) {
    const existing = this.owned(body);
    if (existing) {
      if (existing.contents !== contents || existing.maxBytes !== body.maxBytes || existing.deadlineAt !== body.deadlineAt) {
        throw failure("image_download_transaction_conflict");
      }
      return this.snapshot(existing);
    }
    if (contents.isDestroyed()) throw failure("image_download_tab_closed");
    if (this.byContents.has(contents.id)) throw failure("image_download_tab_busy");
    if (!Number.isSafeInteger(body.maxBytes) || body.maxBytes < 1 || body.maxBytes > 100_000_000
      || !Number.isSafeInteger(body.deadlineAt) || body.deadlineAt <= Date.now()
      || body.deadlineAt > Date.now() + 60_000) throw failure("image_download_limits_invalid");
    const directory = mkdtempSync(join(this.directory, "codex-image-download-"));
    const transaction = {
      owner: Object.fromEntries(OWNER_FIELDS.map(field => [field, body[field]])),
      contents, session: contents.session, directory, path: join(directory, "original"), maxBytes: body.maxBytes,
      deadlineAt: body.deadlineAt, state: "armed", finished: false, released: false,
    };
    this.transactions.set(body.transactionId, transaction);
    this.byContents.set(contents.id, transaction);
    const session = contents.session;
    if (!this.sessions.has(session)) {
      const listener = (_event, item, source) => {
        const active = source && this.byContents.get(source.id);
        if (!active || active.contents !== source || active.state !== "armed") return;
        this.accept(active, item);
      };
      session.on("will-download", listener);
      this.sessions.set(session, listener);
    }
    transaction.onDestroyed = () => this.release(transaction.owner);
    contents.once("destroyed", transaction.onDestroyed);
    transaction.timer = setTimeout(() => {
      this.fail(transaction, "image_download_timeout");
      transaction.reaper = setTimeout(() => this.release(transaction.owner), 10_000);
      transaction.reaper.unref?.();
    }, Math.max(1, body.deadlineAt - Date.now()));
    transaction.timer.unref?.();
    this.log(transaction, "armed");
    return this.snapshot(transaction);
  }

  accept(transaction, item) {
    transaction.item = item;
    transaction.state = "downloading";
    transaction.onUpdated = (_event, state) => {
      if (item.getReceivedBytes() > transaction.maxBytes || item.getTotalBytes() > transaction.maxBytes) {
        this.fail(transaction, "image_download_size_limit");
      } else if (state === "interrupted") this.fail(transaction, "image_download_interrupted");
    };
    transaction.onDone = (_event, state) => {
      transaction.finished = true;
      item.off("updated", transaction.onUpdated);
      if (transaction.released || transaction.state === "failed") { this.clean(transaction); return; }
      if (state !== "completed") {
        this.fail(transaction, state === "cancelled" ? "image_download_cancelled" : "image_download_interrupted");
        return;
      }
      try {
        const stat = lstatSync(transaction.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw failure("image_download_file_invalid");
        if (stat.size > transaction.maxBytes) throw failure("image_download_size_limit");
        transaction.byteLength = stat.size;
        transaction.state = "completed";
        this.log(transaction, "completed", { byteLength: stat.size });
      } catch (error) {
        this.fail(transaction, error.code?.startsWith("image_download_") ? error.code : "image_download_file_unavailable");
      }
    };
    item.on("updated", transaction.onUpdated);
    item.once("done", transaction.onDone);
    try {
      // Synchronous in will-download, before Electron considers showing a save dialog.
      item.setSavePath(transaction.path);
      this.log(transaction, "started");
      transaction.onUpdated(undefined, "progressing");
    } catch { this.fail(transaction, "image_download_save_path_failed"); }
  }

  fail(transaction, code) {
    if (transaction.state === "failed") return;
    transaction.state = "failed";
    transaction.code = code;
    this.log(transaction, "failed", { code });
    if (transaction.item && !transaction.finished) {
      try { transaction.item.cancel(); } catch { transaction.finished = true; }
    }
    if (!transaction.item || transaction.finished) this.clean(transaction);
  }

  snapshot(transaction) {
    return {
      transactionId: transaction.owner.transactionId, state: transaction.state,
      ...(transaction.code ? { code: transaction.code } : {}),
      ...(transaction.state === "completed" ? { path: transaction.path, byteLength: transaction.byteLength } : {}),
    };
  }

  status(body) {
    const transaction = this.owned(body);
    if (!transaction) throw failure("image_download_transaction_missing");
    return this.snapshot(transaction);
  }

  release(body) {
    const transaction = this.owned(body);
    if (!transaction) return { released: false };
    transaction.released = true;
    clearTimeout(transaction.timer);
    clearTimeout(transaction.reaper);
    this.transactions.delete(body.transactionId);
    this.byContents.delete(transaction.contents.id);
    transaction.contents.off("destroyed", transaction.onDestroyed);
    const session = transaction.session;
    if (![...this.transactions.values()].some(value => value.session === session)) {
      session.off("will-download", this.sessions.get(session));
      this.sessions.delete(session);
    }
    if (transaction.item && !transaction.finished) {
      try { transaction.item.cancel(); } catch { transaction.finished = true; }
    }
    if (!transaction.item || transaction.finished) this.clean(transaction);
    this.log(transaction, "released");
    return { released: true };
  }

  releaseContents(contents) {
    const transaction = contents && this.byContents.get(contents.id);
    if (transaction) this.release(transaction.owner);
  }

  clean(transaction) {
    try { rmSync(transaction.directory, { recursive: true, force: true }); }
    catch { this.log(transaction, "cleanup_failed", { code: "image_download_cleanup_failed" }); }
  }

  log(transaction, event, fields = {}) {
    this.logger?.info?.(`browser.image_download.${event}`, { ...transaction.owner, ...fields });
  }

  destroy() {
    for (const transaction of [...this.transactions.values()]) this.release(transaction.owner);
  }
}

module.exports = { OwnedImageDownloads, IMAGE_DOWNLOAD_FEATURE };
