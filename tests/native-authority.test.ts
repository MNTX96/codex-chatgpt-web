import { test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NativeBrowserAuthority, callNativeAuthority, installNativeAuthority, resolveNativeBinding,
  nativeHelperInspectionEnvironment, validateNativeBinding, type NativeBindingSpec } from "../src/adapters/chatgpt-web/native-authority";
import { ImageFactoryService } from "../src/adapters/chatgpt-web/image-factory/service";
import { ImageFactoryStore } from "../src/adapters/chatgpt-web/image-factory/state";
import { imageFactoryInitialPrompt } from "../src/adapters/chatgpt-web/image-factory/prompt-template";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const root = mkdtempSync("/private/tmp/native-authority-bridge-"); roots.push(root);
  const spec: NativeBindingSpec = { workspace: root, requestSha256: "a".repeat(64),
    threadId: "thread-1", eventId: "event-1", ordinal: 1, scope: hash(root) };
  const binding = { request_sha256: spec.requestSha256, thread_id: spec.threadId, kind: "SEMANTIC", status: "BOUND",
    payload: { model: "chatgpt-web/high", reasoning_effort: "high", tool_policy: "read_only_evidence",
      prompt_sha256: hash("original"), inputs: [{ path: join(root, "input.txt"), sha256: "b".repeat(64) }] } };
  return { root, spec, binding };
}

test("native request binds compiled prompt, input order and actual leased surface before Send", async () => {
  const { spec, binding } = fixture();
  const calls: Array<Record<string, any>> = [];
  const rpc = async (_workspace: string, payload: Record<string, unknown>) => {
    calls.push(payload);
    if (payload.operation === "admit") return { lease: { slot: 1, lease_epoch: 8 } };
    if (payload.operation === "bind") return binding;
    if (payload.operation === "prepare-send") return { ordinal: 1 };
    if (payload.operation === "claim") return { submission_id: "SEND1", send_permit: true };
    return {};
  };
  const guard = new NativeBrowserAuthority(spec, rpc);
  await guard.admit();
  guard.surface("TAB1", "SURFACE1", "CONV1");
  await guard.prepare("exact compiled prompt", "high");
  await guard.claim();
  const claim = calls.find(call => call.operation === "claim")!;
  expect(claim.compiled_prompt_sha256).toBe(hash("exact compiled prompt"));
  expect(claim.input_sha256s).toEqual(["b".repeat(64)]);
  expect(claim.surface).toEqual({ slot: 1, lease_epoch: 8, tab_id: "TAB1", surface_id: "SURFACE1", conversation_key: "CONV1" });
  await guard.submitted("USER1", "https://chatgpt.com/c/WEB:abcdefgh");
  await guard.visible("ASSISTANT1");
  await guard.complete("ASSISTANT1", hash("{}"), "{}");
  expect(calls.filter(call => call.operation === "observe").map(call => call.phase)).toEqual(["SUBMITTED", "RESPONSE_VISIBLE", "COMPLETE"]);
});

test("a used Send permit stops the helper without attempting a second submission", async () => {
  const { spec, binding } = fixture();
  const guard = new NativeBrowserAuthority(spec, async (_root, value) => value.operation === "bind"
    ? binding : { submission_id: "SEND1", send_permit: false });
  await guard.prepare("compiled", "high");
  await expect(guard.claim()).rejects.toThrow("requires_reconciliation");
});

test("native helper cannot silently reduce configured image thinking", async () => {
  const { spec, binding } = fixture();
  let claims = 0;
  const guard = new NativeBrowserAuthority(spec, async (_root, value) => {
    if (value.operation === "claim") claims++;
    return binding;
  });
  await expect(guard.prepare("compiled", "medium")).rejects.toThrow("effort_mismatch");
  expect(claims).toBe(0);
});

test("native scope validation rejects a different workspace or invalid ordinal", () => {
  const { spec } = fixture();
  expect(() => validateNativeBinding({ ...spec, scope: "c".repeat(64) })).toThrow("native_binding_invalid");
  expect(() => validateNativeBinding({ ...spec, ordinal: 0 })).toThrow("native_binding_invalid");
  expect(() => validateNativeBinding({ ...spec, threadId: "../../other" })).toThrow("native_binding_invalid");
});

test("loaded-runtime inspection launches a packaged Electron helper in Node mode", () => {
  const environment = nativeHelperInspectionEnvironment({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "0" });
  expect(environment).toMatchObject({
    PATH: "/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
  });
});

test("a prepared multi-image prompt does not duplicate all slots inside every Image line", () => {
  const prompt = "Create 3 separate images in one response.\nImage 1: Bowl.\nImage 2: Basket.\nImage 3: Bell.\nReturn 3 separate image outputs.";
  const compiled = imageFactoryInitialPrompt("generate", prompt, 3);
  expect([...compiled.matchAll(/^Image \d+:/gm)].map(match => match[0])).toEqual(["Image 1:", "Image 2:", "Image 3:"]);
});

test("same-workspace ordinary tasks do not invoke native authority or join its pool", async () => {
  const { root } = fixture();
  const home = join(root, "home"); mkdirSync(home);
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(join(root, "authority"), { recursive: true });
  writeFileSync(join(root, "authority/runtime.txt"), "isolated fixture\n");
  writeFileSync(join(root, ".codex/native-authority.json"), JSON.stringify({
    executable: process.execPath,
    args: ["-e", "process.exit(1)"],
    integrityFiles: ["authority/runtime.txt"],
  }));
  installNativeAuthority(root, home);
  expect(await resolveNativeBinding(root, "ordinary-task", "Review this source", home)).toBeUndefined();
  await expect(resolveNativeBinding(root, "native-task", "NATIVE_REQUEST " + "a".repeat(64) + "\noriginal", home)).rejects.toThrow();
});

test("workspace manifest can register an arbitrary native authority executable", async () => {
  const { root } = fixture();
  const home = join(root, "home"); mkdirSync(home);
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(join(root, "authority"), { recursive: true });
  writeFileSync(join(root, "authority/runtime.js"), [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), request: JSON.parse(input) })));",
    "",
  ].join("\n"));
  writeFileSync(join(root, ".codex/native-authority.json"), JSON.stringify({
    executable: process.execPath,
    args: ["{workspace}/authority/runtime.js"],
    integrityFiles: ["authority/runtime.js"],
  }));

  const installed = installNativeAuthority(root, home);
  expect(installed.args).toEqual([join(root, "authority/runtime.js")]);
  const result = await callNativeAuthority(root, { operation: "probe", value: 7 }, home);
  expect(result).toEqual({ cwd: root, request: { operation: "probe", value: 7 } });
});
test("reconciliation preserves existing job identity and never executes generation", async () => {
  const { root } = fixture();
  const store = new ImageFactoryStore(join(root, "state"));
  let generateCalls = 0, reconcileCalls = 0;
  const service = new ImageFactoryService(store, "fixture", async () => {
    generateCalls++;
    return { status: "failed", artifacts: [] };
  }, () => true, {}, async () => { reconcileCalls++; return { status: "partial", artifacts: [] }; });
  const parent = { threadId: "owner", modelId: "gpt-5.6-sol", reasoning: "high", environment: { cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [root], networkAccess: true }, tools: [] },
    signal: new AbortController().signal, activity: () => () => {} };
  const started = await service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "Bowl", count: 1 });
  await service.call(parent, "chatgpt_image_wait", { job_id: started.jobId });
  const result = await service.call(parent, "chatgpt_image_reconcile", { job_id: started.jobId });
  expect(result.jobId).toBe(started.jobId);
  expect(generateCalls).toBe(1);
  expect(reconcileCalls).toBe(1);
  await expect(service.call({ ...parent, threadId: "different-owner" }, "chatgpt_image_reconcile", { job_id: started.jobId })).rejects.toThrow("unavailable");
});


test("loaded image schema inventory covers generation, edit and observation-only recovery", async () => {
  const { imageToolInventory, imageToolSchemaHashes, IMAGE_TOOL_NAMES } = await import("../src/adapters/chatgpt-web/image-factory/contracts");
  const hashes = imageToolSchemaHashes();
  expect(Object.keys(hashes)).toEqual([...IMAGE_TOOL_NAMES]);
  for (const tool of imageToolInventory()) {
    expect(hashes[tool.name]).toBe(createHash("sha256").update(JSON.stringify(tool.parameters)).digest("hex"));
  }
  expect(hashes.chatgpt_image_generate).not.toBe(hashes.chatgpt_image_edit);
});
