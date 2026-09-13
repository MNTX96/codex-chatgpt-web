import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Capture at module load. Re-reading a replaced file later cannot attest to loaded code.
const candidate = process.argv[1] ? resolve(process.argv[1]) : "";
const entrypoint = candidate && existsSync(candidate) && statSync(candidate).isFile() ? candidate : import.meta.path;
export const LOADED_RUNTIME_IDENTITY = Object.freeze({
  sha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
  started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
});
