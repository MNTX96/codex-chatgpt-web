import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Codex executes command hooks through cmd.exe /C on Windows. Quoting every argument preserves
  // spaces and shell metacharacters in the installed runtime path.
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): Array<{
  start: number; end: number;
}> {
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  const ownedPrefix = installed.fragment.slice(0, marker);
  // Native config writes normalize CRLF to LF; commands and owned fields must still match exactly.
  const pattern = new RegExp(hookTextPattern(ownedPrefix), "g");
  let match = pattern.exec(text);
  let duplicate = match ? pattern.exec(text) : null;

  if (match && !duplicate) {
    const first = match.index;
    const ownedEnd = first + match[0].length;
    if (interruptGroupCount(text.slice(0, first)) !== installed.groupIndex) {
      throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
    }
    const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
    if (managedMarkerCount(text) !== 1 || endMarker < 0
      || (endMarker >= first && endMarker < ownedEnd)
      || text.split(MANAGED_INTERRUPT_HOOK_END).length !== 2) {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
    }
    if (endMarker < first) {
      // A moved comment is independent of the owned definitions. Prove it is still a comment,
      // rather than matching text inside an unrelated TOML value, before removing it separately.
      const precedingConfig = text.slice(0, first);
      const withoutMarker = precedingConfig.slice(0, endMarker)
        + precedingConfig.slice(endMarker + MANAGED_INTERRUPT_HOOK_END.length);
      try {
        if (JSON.stringify(canonicalJson(Bun.TOML.parse(precedingConfig)))
          !== JSON.stringify(canonicalJson(Bun.TOML.parse(withoutMarker)))) {
          throw new Error("Marker removal changes TOML values");
        }
      } catch {
        throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
      }
    }
    if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
      throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
    }
    // Codex's TOML editor inserts new tables before trailing comments. The end marker can therefore
    // move past unrelated config even though the owned hook fields remain unchanged.
    const appendedConfig = text.slice(ownedEnd, endMarker < first ? undefined : endMarker);
    const firstAssignment = appendedConfig.split(/\r\n|\n|\r/)
      .map(line => line.trim()).find(line => line && !line.startsWith("#"));
    if (firstAssignment && !/^\[\[?.+\]\]?(?:\s*#.*)?$/.test(firstAssignment)) {
      throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
    }
    if (firstAssignment) {
      // A later table can also extend the owned hook or trust state. Compare those exact
      // definitions with Bun's TOML parser before treating the inserted tables as unrelated.
      const ownedDefinitions = (fragment: string): string => {
        const { hooks } = Bun.TOML.parse(fragment) as {
          hooks: { Interrupt: unknown[]; state: Record<string, unknown> };
        };
        return JSON.stringify(canonicalJson([hooks.Interrupt[0], hooks.state[installed.stateKey]]));
      };
      try {
        if (ownedDefinitions(ownedPrefix) !== ownedDefinitions(ownedPrefix + appendedConfig)) {
          throw new Error("Modified owned definitions");
        }
      } catch {
        throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
      }
    }
    const end = endMarker + MANAGED_INTERRUPT_HOOK_END.length;
    const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
    const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(end))?.[0].length ?? 0;
    return [{ start: first, end: ownedEnd }, { start: endMarker, end: end + trailingLength }];
  }

  // Fallback for Codex TOML normalization
  let parsed: any;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  const interrupts = parsed.hooks?.Interrupt;
  if (!Array.isArray(interrupts) || interrupts.length <= installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const hookDef = interrupts[installed.groupIndex];
  if (!hookDef || !Array.isArray(hookDef.hooks) || hookDef.hooks.length !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const cmdHook = hookDef.hooks[0];
  if (cmdHook.type !== "command" || cmdHook.command !== installed.command || cmdHook.timeout !== 3) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (Object.hasOwn(cmdHook, "async") && cmdHook.async !== false) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const allowedKeys = new Set(["type", "command", "timeout", "async"]);
  for (const key of Object.keys(cmdHook)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
    }
  }
  if (Object.keys(hookDef).length !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  let managedInterruptCount = 0;
  for (const interrupt of interrupts) {
    if (Array.isArray(interrupt.hooks)) {
      for (const h of interrupt.hooks) {
        if (h.type === "command" && h.command === installed.command) {
          managedInterruptCount++;
        }
      }
    }
  }
  if (managedInterruptCount !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  const stateTable = parsed.hooks?.state;
  if (!stateTable || typeof stateTable !== "object" || !Object.hasOwn(stateTable, installed.stateKey)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const myState = stateTable[installed.stateKey];
  if (myState.trusted_hash !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (Object.keys(myState).length !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }

  if (managedMarkerCount(text) !== 1 || text.split(MANAGED_INTERRUPT_HOOK_END).length - 1 !== 1) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  const startMarkerIndex = text.indexOf(MANAGED_INTERRUPT_HOOK_START);
  const endMarkerIndex = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (startMarkerIndex > endMarkerIndex) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  const textWithoutMarkers = text
    .replace(MANAGED_INTERRUPT_HOOK_START, "")
    .replace(MANAGED_INTERRUPT_HOOK_END, "");
  let parsedWithoutMarkers: any;
  try {
    parsedWithoutMarkers = Bun.TOML.parse(textWithoutMarkers);
  } catch {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (JSON.stringify(canonicalJson(parsedWithoutMarkers)) !== JSON.stringify(canonicalJson(parsed))) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }

  const escapedKey = installed.stateKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stateHeaderRegex = new RegExp(`\\[\\s*hooks\\.state\\.["']${escapedKey}["']\\s*\\]`);
  const stateHeaderMatch = stateHeaderRegex.exec(text);
  if (!stateHeaderMatch) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const sH_idx = stateHeaderMatch.index;
  
  const nextBracket = text.indexOf('[', sH_idx + 1);
  const searchArea = text.slice(sH_idx, nextBracket > -1 ? nextBracket : text.length);
  const hashRegex = /trusted_hash\s*=\s*["']([^"']+)["']/;
  const hashMatch = hashRegex.exec(searchArea);
  if (!hashMatch || hashMatch[1] !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const sHash_idx = sH_idx + hashMatch.index;
  let sHash_end = text.indexOf('\n', sHash_idx);
  if (sHash_end < 0) sHash_end = text.length;

  let stateStart = sH_idx;
  while (stateStart > 0 && (text[stateStart - 1] === ' ' || text[stateStart - 1] === '\t')) stateStart--;
  if (stateStart > 0 && text[stateStart - 1] === '\n') {
      stateStart--;
      if (stateStart > 0 && text[stateStart - 1] === '\r') stateStart--;
  }
  let stateEnd = sHash_end;
  while (stateEnd < text.length && (text[stateEnd] === ' ' || text[stateEnd] === '\t')) stateEnd++;
  if (stateEnd < text.length && text[stateEnd] === '\r') stateEnd++;
  if (stateEnd < text.length && text[stateEnd] === '\n') stateEnd++;

  const endMarkerEnd = endMarkerIndex + MANAGED_INTERRUPT_HOOK_END.length;
  const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
  const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(endMarkerEnd))?.[0].length ?? 0;
  
  const managedBlock = text.slice(startMarkerIndex, endMarkerEnd);
  let parsedManaged: any;
  try {
    parsedManaged = Bun.TOML.parse(managedBlock);
  } catch {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (!parsedManaged.hooks || !parsedManaged.hooks.Interrupt || parsedManaged.hooks.Interrupt.length !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (Object.keys(parsedManaged).length !== 1 || Object.keys(parsedManaged.hooks).length !== 1) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  const range1 = { start: startMarkerIndex, end: endMarkerEnd + trailingLength };
  const range2 = { start: stateStart, end: stateEnd };
  if (range1.start < range2.end && range2.start < range1.end) {
     throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  return [range1, range2];
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = Bun.TOML.parse(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
