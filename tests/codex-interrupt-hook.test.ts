import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_INTERRUPT_HOOK_END,
  MANAGED_INTERRUPT_HOOK_START,
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("installs one narrowly trusted Interrupt hook and restores the exact Codex config", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    "",
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "existing-hook"',
    "",
  ].join("\n");
  const config = { runtimeCommand: ["/opt/Codex Web/runtime/bun", "/opt/Codex Web/app/cli.js"] };
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", config);

  expect(installed.installed.groupIndex).toBe(1);
  expect(installed.installed.stateKey).toBe(`${resolve("/Users/test/.codex/config.toml")}:interrupt:1:0`);
  expect(installed.text).toContain('[[hooks.Interrupt]]');
  expect(installed.text).toContain(`[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`);
  expect(installed.text).toContain(`trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`);
  verifyCodexInterruptHook(installed.text, installed.installed);
  expect(restoreCodexInterruptHook(installed.text, installed.installed)).toBe(original);
  verifyCodexInterruptHookRestored(original);
});

test("trusts the canonical Codex config path before a new config file exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-interrupt-hook-"));
  try {
    const configPath = join(directory, "config.toml");
    const installed = installCodexInterruptHook("", configPath, { runtimeCommand: ["/opt/runtime"] });
    expect(installed.installed.stateKey).toBe(
      `${join(realpathSync.native(directory), "config.toml")}:interrupt:0:0`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Interrupt hook command is absolute, quoted, and bound to the exact application home", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["/Applications/Codex Web GPT.app/runtime/bun", "/Applications/Codex Web GPT.app/app/cli.js"] },
    "/Users/test/Application Support/Codex Web GPT",
    "darwin",
  )).toBe(
    "'/Applications/Codex Web GPT.app/runtime/bun' '/Applications/Codex Web GPT.app/app/cli.js'"
      + " '--home' '/Users/test/Application Support/Codex Web GPT' 'hook' 'interrupt'",
  );
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["C:\\Program Files\\Codex Web GPT\\bun.exe", "C:\\Program Files\\Codex Web GPT\\cli.js"] },
    "C:\\Users\\test\\Codex Web GPT",
    "win32",
  )).toBe(
    '"C:\\Program Files\\Codex Web GPT\\bun.exe" "C:\\Program Files\\Codex Web GPT\\cli.js"'
      + ' "--home" "C:\\Users\\test\\Codex Web GPT" "hook" "interrupt"',
  );
});

test("Interrupt hook trust hash is deterministic and changes with its exact command", () => {
  const first = codexInterruptHookHash("'runtime' 'hook' 'interrupt'");
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(codexInterruptHookHash("'runtime' 'hook' 'interrupt'")).toBe(first);
  expect(codexInterruptHookHash("'other-runtime' 'hook' 'interrupt'")).not.toBe(first);
});

test("refuses to remove a modified or duplicated managed hook", () => {
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(
    original,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  );
  const modified = installed.text.replace("timeout = 3", "timeout = 2");
  expect(() => restoreCodexInterruptHook(modified, installed.installed)).toThrow("changed after setup");
  expect(() => restoreCodexInterruptHook(
    installed.text.replace(MANAGED_INTERRUPT_HOOK_END, `approved = false\n${MANAGED_INTERRUPT_HOOK_END}`),
    installed.installed,
  )).toThrow("changed after setup");
  for (const extension of [
    '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
    `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.unexpected]\nvalue = true\n`,
  ]) {
    expect(() => restoreCodexInterruptHook(
      installed.text.replace(MANAGED_INTERRUPT_HOOK_END, extension + MANAGED_INTERRUPT_HOOK_END),
      installed.installed,
    )).toThrow("changed after setup");
  }
  const reordered = [
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "new-earlier-hook"',
    "",
    installed.text,
  ].join("\n");
  expect(() => restoreCodexInterruptHook(reordered, installed.installed)).toThrow("order changed after setup");
  expect(() => installCodexInterruptHook(installed.text, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] }))
    .toThrow("already contains");
});

test("preserves native TOML editor tables inserted before the trailing hook comment", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime"],
    });
    // Native config writes normalize line endings and insert tables before the trailing comment.
    const appended = "\n[features]\ngoals = true\n";
    const edited = installed.text.replaceAll("\r\n", "\n")
      .replace(MANAGED_INTERRUPT_HOOK_END, appended + MANAGED_INTERRUPT_HOOK_END);
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + appended);
    verifyCodexInterruptHookRestored(restored);
    expect(() => restoreCodexInterruptHook(
      edited.replace("timeout = 3", "timeout = 2"), installed.installed,
    )).toThrow("changed after setup");
  }
});

test("restores a hook whose end comment moved before unchanged definitions without losing MCP settings", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime"],
    });
    const mcp = '\n[mcp_servers.node_repl]\ncommand = "my-mcp"\n\n[mcp_servers.node_repl.env]\nMODE = "user-setting"\n';
    const definitions = installed.installed.fragment.replaceAll("\r\n", "\n")
      .replace(`${MANAGED_INTERRUPT_HOOK_END}\n`, "");
    for (const beforeModel of [false, true]) {
      const movedComment = `${MANAGED_INTERRUPT_HOOK_END}\n`;
      const edited = (beforeModel ? movedComment + original : original + movedComment) + mcp + definitions;
      expect(Bun.TOML.parse(edited)).toMatchObject(Bun.TOML.parse(installed.text));
      verifyCodexInterruptHook(edited, installed.installed);
      const restored = restoreCodexInterruptHook(edited, installed.installed);
      expect(restored).toBe(original + mcp);
      verifyCodexInterruptHookRestored(restored);

      for (const changed of [
        edited.replace("timeout = 3", "timeout = 2"),
        edited + "approved = false\n",
        edited + '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
        edited + `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.unexpected]\nvalue = true\n`,
        edited + movedComment,
      ]) {
        expect(() => restoreCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
      }
      const markerInsideValue = original + 'description = """\n' + movedComment + '"""\n' + mcp + definitions;
      expect(() => restoreCodexInterruptHook(markerInsideValue, installed.installed)).toThrow("markers changed after setup");
    }
  }
});

test("restores a hook whose trust-state table was relocated by the native TOML editor", () => {
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", {
    runtimeCommand: ["/opt/runtime"],
  });

  const stateKeyStr = JSON.stringify(installed.installed.stateKey);
  const stateTable = `[hooks.state.${stateKeyStr}]\ntrusted_hash = "${installed.installed.trustedHash}"\n`;
  const managedBlock = `${MANAGED_INTERRUPT_HOOK_START}\n[[hooks.Interrupt]]\n\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "/opt/runtime '\/Users\/test\/.codex\/config.toml' hook interrupt"\ntimeout = 3\n${MANAGED_INTERRUPT_HOOK_END}\n`;
  const unrelatedState = `[hooks.state."other:hook"]\ntrusted_hash = "sha256:abc"\n`;
  
  // Actually, wait, the installed.command has the arguments...
  // Let's just extract the managedBlock by stripping the state table from installed.fragment.
  const stateTableMatch = installed.installed.fragment.match(new RegExp(`\\[hooks\\.state\\.${stateKeyStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\n?trusted_hash = "[^"]+"\\n?`));
  expect(stateTableMatch).not.toBeNull();
  const stateTableActual = stateTableMatch![0];
  const managedBlockActual = installed.installed.fragment.replace(stateTableActual, "");

  // Simulate TOML rewrite: move state table before the interrupt block
  const edited = `${original}\n${unrelatedState}\n${stateTableActual}\n${managedBlockActual}`;
  
  // Verify it doesn't throw
  expect(() => verifyCodexInterruptHook(edited, installed.installed)).not.toThrow();

  // Restore preserves unrelated config
  const restored = restoreCodexInterruptHook(edited, installed.installed);
  expect(restored).toBe(`${original}\n${unrelatedState}\n\n`);

  // Negative cases for relocated layout
  const editedTimeoutChanged = edited.replace("timeout = 3", "timeout = 2");
  expect(() => verifyCodexInterruptHook(editedTimeoutChanged, installed.installed)).toThrow("changed after setup");

  const editedCommandChanged = edited.replace("'hook' 'interrupt'", "'hook' 'other'");
  expect(() => verifyCodexInterruptHook(editedCommandChanged, installed.installed)).toThrow("changed after setup");

  const editedHashChanged = edited.replace(installed.installed.trustedHash, "sha256:invalid");
  expect(() => verifyCodexInterruptHook(editedHashChanged, installed.installed)).toThrow("changed after setup");

  const editedExtraField = edited.replace(stateTableActual, `${stateTableActual}extra_field = true\n`);
  expect(() => verifyCodexInterruptHook(editedExtraField, installed.installed)).toThrow("changed after setup");

  const editedExtraHookEntry = edited.replace(
    'timeout = 3\n', 
    'timeout = 3\n\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "extra"\ntimeout = 3\n'
  );
  expect(() => verifyCodexInterruptHook(editedExtraHookEntry, installed.installed)).toThrow("changed after setup");

  const editedDuplicateMarker = edited.replace(MANAGED_INTERRUPT_HOOK_END, `${MANAGED_INTERRUPT_HOOK_END}\n${MANAGED_INTERRUPT_HOOK_END}`);
  expect(() => verifyCodexInterruptHook(editedDuplicateMarker, installed.installed)).toThrow("markers changed after setup");
});
