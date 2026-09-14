import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile, getConfigDir, loadConfig } from "../../config";
import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import type { OutputImageArtifact, OutputImageCaptureResult } from "./artifacts/types";

export const NATIVE_AUTHORITY_PROTOCOL = "native-authority";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const identity = /^[A-Za-z0-9_:-]{1,160}$/;

/** Environment required when the Launcher exposes its packaged Electron binary as the helper executable. */
export function nativeHelperInspectionEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: "1",
    CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
  };
}

export interface NativeBindingSpec {
  workspace: string;
  requestSha256: string;
  threadId: string;
  scope: string;
  ordinal: number;
  eventId?: string;
  parentRequestSha256?: string;
  imageJobId?: string;
  imageSessionId?: string;
}
export interface NativeImageReconcile {
  assistantTurnId: string;
  userTurnId: string;
  excludeCandidateKeys: string[];
}
interface NativeAuthorityManifest {
  executable: string;
  args: string[];
  integrityFiles: string[];
  lifecycleEvents?: Array<"turn_completed">;
}
interface Registration {
  workspace: string;
  executable: string;
  executableSha256: string;
  args: string[];
  integrityFiles: Array<{ path: string; sha256: string }>;
  lifecycleEvents?: Array<"turn_completed">;
}

export const NATIVE_REQUEST_MARKER = "NATIVE_REQUEST ";
const NATIVE_AUTHORITY_MANIFEST = join(".codex", "native-authority.json");
const NATIVE_AUTHORITY_REGISTRY = "native-authorities.json";

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readNativeAuthorityManifest(root: string): NativeAuthorityManifest {
  const path = join(root, NATIVE_AUTHORITY_MANIFEST);
  if (!existsSync(path)) throw new Error("native_authority_manifest_missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
    throw new Error("native_authority_manifest_invalid");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<NativeAuthorityManifest>;
  if (typeof value.executable !== "string" || !value.executable.trim()
    || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || !Array.isArray(value.integrityFiles) || value.integrityFiles.length === 0
    || value.integrityFiles.some(file => typeof file !== "string" || !file.trim())
    || (value.lifecycleEvents !== undefined && (!Array.isArray(value.lifecycleEvents)
      || value.lifecycleEvents.some(event => event !== "turn_completed")))) {
    throw new Error("native_authority_manifest_invalid");
  }
  return { executable: value.executable, args: value.args, integrityFiles: value.integrityFiles,
    ...(value.lifecycleEvents ? { lifecycleEvents: value.lifecycleEvents } : {}) };
}
interface Binding {
  request_sha256: string;
  thread_id: string | null;
  kind: "SEMANTIC" | "IMAGE";
  status: string;
  payload: {
    model: string;
    reasoning_effort: string;
    tool_policy: "read_only_evidence" | "image_factory" | "flow_operation" | "delivery_operation";
    prompt_sha256: string;
    requested_count?: number;
    image_session_id?: string;
    source_artifact_id?: string;
    inputs: Array<{ path: string; sha256: string }>;
  };
}

/** Explicit installation snapshots a workspace-owned authority manifest and never stores credentials. */
export function installNativeAuthority(workspace: string, directory = getConfigDir()): Registration {
  const root = realpathSync(workspace);
  const manifest = readNativeAuthorityManifest(root);
  const executable = realpathSync(isAbsolute(manifest.executable)
    ? manifest.executable
    : resolve(root, manifest.executable));
  const args = manifest.args.map(arg => arg.replaceAll("{workspace}", root));
  const integrityFiles = manifest.integrityFiles.map(file => {
    const path = realpathSync(isAbsolute(file) ? file : resolve(root, file));
    if (!pathInside(root, path)) throw new Error("native_authority_manifest_invalid");
    return { path, sha256: hash(readFileSync(path)) };
  });
  const value: Registration = { workspace: root, executable, executableSha256: hash(readFileSync(executable)),
    args, integrityFiles, ...(manifest.lifecycleEvents ? { lifecycleEvents: manifest.lifecycleEvents } : {}) };
  const path = join(directory, NATIVE_AUTHORITY_REGISTRY);
  const previous = existsSync(path) ? readRegistrations(path) : {};
  previous[root] = value;
  atomicWriteFile(path, JSON.stringify({ version: 1, workspaces: previous }, null, 2) + "\n", { mode: 0o600 });
  return value;
}

/** Supported, read-only loaded-runtime report. No ChatGPT page or model request is opened. */
export async function inspectLoadedNativeRuntime(workspace: string, canaryId: string): Promise<Record<string, unknown>> {
  if (!registration(workspace)) throw new Error("native_authority_not_installed");
  const config = loadConfig();
  if (config.mode !== "full" || config.browserHost !== "launcher" || !config.browserHostDescriptorPath) {
    throw new Error("native_full_launcher_required");
  }
  const descriptor = readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath);
  if (!descriptor.nativeBuild || !descriptor.features?.includes(NATIVE_AUTHORITY_PROTOCOL)) throw new Error("native_launcher_restart_required");
  const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("native_daemon_health_unavailable");
  const health = await response.json() as Record<string, any>;
  if (health.service !== "codex-chatgpt-web" || !health.native_runtime?.sha256) throw new Error("native_daemon_restart_required");
  const helper = await new Promise<Record<string, any>>((resolveInfo, reject) => {
    const child = spawn(descriptor.helper.executable, [descriptor.helper.script, "--native-runtime-info"],
      {
        // descriptor.helper.executable is Electron on packaged macOS builds.  It must run the
        // metadata script as Node, just like the long-lived helper client does.
        env: nativeHelperInspectionEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    let stdout = "";
    let stderrBytes = 0;
    const stderrHash = createHash("sha256");
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("native_helper_inspection_timeout")); }, 10_000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 100_000) child.kill("SIGTERM"); });
    // Stderr can contain browser diagnostics. Keep only a length and digest for correlation;
    // never surface its contents through the CLI or canary evidence.
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; stderrHash.update(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const stderrEvidence = `stderr_bytes=${stderrBytes}:stderr_sha256=${stderrHash.digest("hex")}`;
        if (code !== 0) throw new Error(`native_helper_inspection_failed:${stderrEvidence}`);
        const serialized = stdout.trim();
        if (!serialized) throw new Error(`native_helper_inspection_empty_output:${stderrEvidence}`);
        let value: Record<string, unknown>;
        try { value = JSON.parse(serialized) as Record<string, unknown>; }
        catch { throw new Error(`native_helper_inspection_invalid_output:${stderrEvidence}`); }
        if (value.protocol !== NATIVE_AUTHORITY_PROTOCOL) throw new Error("native_helper_restart_required");
        resolveInfo(value);
      } catch (error) { reject(error); }
    });
  });
  if (!health.native_image_tool_schema_hashes || JSON.stringify(health.native_image_tool_schema_hashes)
      !== JSON.stringify(helper.tool_schema_hashes)) throw new Error("native_loaded_tool_schema_mismatch");
  return { source: "LAUNCHER_READBACK", user_confirmed_restart: false, canary_id: canaryId,
    observed_at: new Date().toISOString(), launcher_started_at: descriptor.nativeBuild.started_at,
    runtime_started_at: health.native_runtime.started_at, helper_started_at: helper.started_at,
    launcher_sha256: descriptor.nativeBuild.launcher_sha256,
    helper_sha256: helper.helper_sha256, runtime_sha256: health.native_runtime.sha256,
    mode: health.mode, max_browser_tabs: descriptor.nativeBuild.max_native_tabs,
    protocols: [...new Set([...(descriptor.features ?? []), ...(helper.features ?? [])])],
    observed_limits: helper.observed_limits, tool_schema_hashes: helper.tool_schema_hashes,
    limits_source: "BRIDGE_PROTOCOL_NOT_PROVIDER_QUALIFICATION" };
}

function readRegistrations(path: string): Record<string, Registration> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("native_authority_registry_invalid");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || !value.workspaces || typeof value.workspaces !== "object") {
    throw new Error("native_authority_registry_invalid");
  }
  return value.workspaces;
}

function registration(workspace: string, directory = getConfigDir()): Registration | undefined {
  const path = join(directory, NATIVE_AUTHORITY_REGISTRY);
  if (!existsSync(path)) return undefined;
  const root = realpathSync(workspace);
  const value = readRegistrations(path)[root];
  if (!value) return undefined;
  const validShape = value.workspace === root
    && typeof value.executable === "string"
    && digest.test(value.executableSha256)
    && Array.isArray(value.args)
    && value.args.every(arg => typeof arg === "string" && !arg.includes("\0"))
    && Array.isArray(value.integrityFiles)
    && value.integrityFiles.length > 0
    && value.integrityFiles.every(file => typeof file?.path === "string" && digest.test(file.sha256))
    && (value.lifecycleEvents === undefined || (Array.isArray(value.lifecycleEvents)
      && value.lifecycleEvents.every(event => event === "turn_completed")));
  if (!validShape) throw new Error("native_authority_registry_invalid");
  let executable: string;
  try { executable = realpathSync(value.executable); }
  catch { throw new Error("native_authority_installation_drift"); }
  if (executable !== value.executable || hash(readFileSync(executable)) !== value.executableSha256
    || value.integrityFiles.some(file => {
      try {
        const path = realpathSync(file.path);
        return path !== file.path || !pathInside(root, path) || hash(readFileSync(path)) !== file.sha256;
      } catch { return true; }
    })) {
    throw new Error("native_authority_installation_drift");
  }
  return value;
}

export function validateNativeBinding(spec: NativeBindingSpec): void {
  if (!isAbsolute(spec.workspace) || !digest.test(spec.requestSha256) || !identity.test(spec.threadId)
    || spec.scope !== hash(realpathSync(spec.workspace))
    || !Number.isSafeInteger(spec.ordinal) || spec.ordinal < 1) throw new Error("native_binding_invalid");
}

export async function callNativeAuthority(
  workspace: string, payload: Record<string, unknown>, directory = getConfigDir(),
): Promise<Record<string, any>> {
  const trusted = registration(workspace, directory);
  if (!trusted) throw new Error("native_authority_not_installed");
  // No shell, no model-provided executable/argv/environment, and no credential reads.
  return new Promise((resolveResult, reject) => {
    const child = spawn(trusted.executable, trusted.args, { cwd: trusted.workspace, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let overflow = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("native_authority_timeout")); }, 20_000);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) { overflow = true; child.kill("SIGTERM"); }
    });
    child.stderr.resume(); // Do not leak arbitrary process diagnostics into the model/browser journal.
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        if (overflow) throw new Error("native_authority_output_limit");
        const result = JSON.parse(stdout);
        if (code !== 0) throw new Error(String(result.error?.message ?? "native_authority_failed"));
        resolveResult(result);
      } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload) + "\n");
  });
}

/** Resolve only a current native instruction marker or an existing task binding. */
/** Called only after the browser completion fence and successful surface release. */
export async function nativeTurnReleaseRequested(
  workspace: string, threadId: string, turnId: string, directory = getConfigDir(),
): Promise<boolean> {
  const installed = registration(workspace, directory);
  if (!installed?.lifecycleEvents?.includes("turn_completed")) return false;
  const result = await callNativeAuthority(workspace,
    { operation: "origin-release-needed", thread_id: threadId, turn_id: turnId }, directory);
  return result.release_requested === true;
}

export async function notifyNativeTurnCompleted(
  workspace: string, threadId: string, turnId: string, directory = getConfigDir(),
): Promise<void> {
  const installed = registration(workspace, directory);
  if (!installed?.lifecycleEvents?.includes("turn_completed")) return;
  if (!identity.test(threadId) || !identity.test(turnId)) throw new Error("native_lifecycle_identity_invalid");
  await callNativeAuthority(workspace, { operation: "turn-completed", thread_id: threadId,
    turn_id: turnId, completion_fence: true, surface_released: true }, directory);
}

export async function completeNativeTurnLifecycle(
  workspace: string, threadId: string, turnId: string,
  releaseRetained: (() => Promise<void>) | undefined, directory = getConfigDir(),
): Promise<void> {
  if (releaseRetained) {
    if (!await nativeTurnReleaseRequested(workspace, threadId, turnId, directory)) return;
    await releaseRetained();
  }
  await notifyNativeTurnCompleted(workspace, threadId, turnId, directory);
}

export async function resolveNativeBinding(
  workspace: string, threadId: string, currentInstruction: string, directory = getConfigDir(),
): Promise<NativeBindingSpec | undefined> {
  const marker = new RegExp(`^${NATIVE_REQUEST_MARKER}([a-f0-9]{64})(?:\\n|$)`).exec(currentInstruction);
  const installed = registration(workspace, directory);
  if (!installed) {
    if (marker) throw new Error("native_authority_not_installed");
    return undefined;
  }
  const ownerPath = join(directory, "runtime/native-thread-bindings", hash(realpathSync(workspace) + "\0" + threadId) + ".json");
  // Ordinary tasks in the same workspace are not native-authority transactions. Do not invoke
  // its CLI, inspect its database, or enroll a task just because its cwd matches.
  if (!marker && !existsSync(ownerPath)) return undefined;
  const loaded = marker
    ? await callNativeAuthority(workspace, { operation: "bind", request_sha256: marker[1], thread_id: threadId }, directory)
    : (await callNativeAuthority(workspace, { operation: "lookup", thread_id: threadId }, directory)).binding;
  if (!loaded) return undefined;
  if (marker && hash(currentInstruction.slice(marker[0].length)) !== loaded.payload.prompt_sha256) {
    throw new Error("native_original_prompt_hash_mismatch");
  }
  const spec = { workspace: realpathSync(workspace), threadId, requestSha256: loaded.request_sha256,
    scope: hash(realpathSync(workspace)), ordinal: 1 };
  atomicWriteFile(ownerPath, JSON.stringify(spec) + "\n", { mode: 0o600 });
  return spec;
}

export class NativeBrowserAuthority {
  private submissionId?: string;
  private userTurnId?: string;
  private binding?: Binding;
  private compiledPromptSha256?: string;
  private readonly artifacts: Array<Record<string, string | undefined>> = [];
  private reconciling = false;
  private finishing = false;
  private generatedCount = 0;
  private ordinal = 1;
  private lease?: { slot: number; lease_epoch: number };
  private surfaceIdentity?: Record<string, unknown>;
  constructor(readonly spec: NativeBindingSpec, private readonly rpc = callNativeAuthority) {
    validateNativeBinding(spec);
  }
  async admit(reconcile = false): Promise<void> {
    const result = await this.rpc(this.spec.workspace, { operation: "admit",
      request_sha256: this.spec.requestSha256, thread_id: this.spec.threadId, reconcile,
      parent_request_sha256: this.spec.parentRequestSha256,
      image_job_id: this.spec.imageJobId, image_session_id: this.spec.imageSessionId });
    this.lease = result.lease;
  }
  surface(tabId: string, surfaceId: string, conversationKey: string): void {
    if (!this.lease || !tabId || !surfaceId || !conversationKey) throw new Error("native_visible_surface_required");
    this.surfaceIdentity = { ...this.lease, tab_id: tabId, surface_id: surfaceId, conversation_key: conversationKey };
  }
  async heartbeat(): Promise<void> {
    if (this.finishing) return;
    if (!this.lease) throw new Error("native_lease_missing");
    try {
      await this.rpc(this.spec.workspace, { operation: "heartbeat", request_sha256: this.spec.requestSha256,
        thread_id: this.spec.threadId, slot: this.lease.slot, lease_epoch: this.lease.lease_epoch });
    } catch (error) { if (!this.finishing) throw error; }
  }
  async prepareReconcile(source: NativeImageReconcile): Promise<void> {
    this.reconciling = true;
    const inspected = await this.rpc(this.spec.workspace, { operation: "inspect",
      request_sha256: this.spec.requestSha256, thread_id: this.spec.threadId });
    this.binding = inspected.binding;
    const receipt = inspected.receipts.findLast((r: any) => r.evidence.assistant_turn_id === source.assistantTurnId
      && r.evidence.user_turn_id === source.userTurnId);
    if (!receipt) throw new Error("image_submission_unknown");
    this.submissionId = receipt.submission_id;
    this.userTurnId = source.userTurnId;
  }
  async prepare(text: string, effort: string): Promise<void> {
    const bound = await this.rpc(this.spec.workspace, { operation: "bind",
      request_sha256: this.spec.requestSha256, thread_id: this.spec.threadId }) as Binding;
    if (bound.payload.reasoning_effort !== effort) throw new Error("native_actual_effort_mismatch");
    this.binding = bound;
    this.compiledPromptSha256 = hash(text);
    if (bound.kind === "SEMANTIC") {
      if (!this.spec.eventId) throw new Error("native_send_event_required");
      const prepared = await this.rpc(this.spec.workspace, { operation: "prepare-send",
        request_sha256: this.spec.requestSha256, thread_id: this.spec.threadId,
        event_id: this.spec.eventId, compiled_prompt_sha256: this.compiledPromptSha256 });
      this.ordinal = prepared.ordinal;
    }
  }
  async claim(): Promise<void> {
    if (!this.binding || !this.compiledPromptSha256) throw new Error("native_prompt_not_prepared");
    const result = await this.rpc(this.spec.workspace, { operation: "claim",
      request_sha256: this.spec.requestSha256, thread_id: this.spec.threadId,
      compiled_prompt_sha256: this.compiledPromptSha256,
      surface: this.surfaceIdentity,
      parent_request_sha256: this.spec.parentRequestSha256,
      input_sha256s: this.binding.payload.inputs.map(input => input.sha256), ordinal: this.ordinal });
    this.submissionId = result.submission_id;
    if (result.send_permit !== true) throw new Error("native_send_outcome_requires_reconciliation");
  }
  async submitted(userTurnId: string, conversationUrl?: string): Promise<void> {
    if (!identity.test(userTurnId)) throw new Error("native_user_turn_missing");
    this.userTurnId = userTurnId;
    await this.observe("SUBMITTED", { user_turn_id: userTurnId,
      ...(conversationUrl && !/[?#]/.test(conversationUrl) ? { conversation_url: conversationUrl } : {}) });
  }
  async visible(assistantTurnId: string): Promise<void> {
    if (!this.userTurnId || !identity.test(assistantTurnId)) throw new Error("native_response_identity_missing");
    await this.observe("RESPONSE_VISIBLE", { user_turn_id: this.userTurnId, assistant_turn_id: assistantTurnId });
  }
  artifact(value: OutputImageArtifact): void {
    this.artifacts.push({ path: value.absolutePath, sha256: value.sha256, artifact_id: value.id,
      assistant_turn_id: value.source.assistantTurnId, candidate_key: value.source.candidateKey,
      image_session_id: value.source.imageSessionId });
  }
  capture(value: OutputImageCaptureResult): void { this.generatedCount = value.detectedCandidates; }
  async complete(assistantTurnId: string, outputSha256: string, outputText?: string): Promise<void> {
    if (!this.userTurnId || !identity.test(assistantTurnId) || !digest.test(outputSha256)) {
      throw new Error("native_response_identity_missing");
    }
    this.finishing = true;
    if (this.reconciling) {
      await this.rpc(this.spec.workspace, { operation: "reconcile-complete", request_sha256: this.spec.requestSha256,
        thread_id: this.spec.threadId, submission_id: this.submissionId,
        evidence: { user_turn_id: this.userTurnId, assistant_turn_id: assistantTurnId,
          artifacts: this.artifacts, generated_count: this.generatedCount } });
    } else if (this.binding!.status !== "COMPLETE") {
      await this.observe("COMPLETE", { user_turn_id: this.userTurnId, assistant_turn_id: assistantTurnId,
        output_sha256: outputSha256, observed_effort: this.binding!.payload.reasoning_effort,
        native_route: this.binding!.payload.model, protocol: NATIVE_AUTHORITY_PROTOCOL,
        artifacts: this.artifacts, generated_count: this.generatedCount,
        ...(outputText !== undefined && this.binding!.kind === "SEMANTIC" ? { output_text: outputText } : {}) });
    }
    if (this.binding!.kind === "IMAGE") {
      await this.rpc(this.spec.workspace, { operation: "complete",
        request_sha256: this.spec.requestSha256, thread_id: this.spec.threadId });
    }
  }
  private async observe(phase: string, evidence: Record<string, unknown>): Promise<void> {
    if (!this.submissionId) throw new Error("native_send_claim_missing");
    await this.rpc(this.spec.workspace, { operation: "observe", request_sha256: this.spec.requestSha256,
      thread_id: this.spec.threadId, submission_id: this.submissionId, phase, evidence });
  }
}

export async function bindNativeImageRequest(
  parent: NativeBindingSpec, requestSha256: string, prompt: string, count: number,
  references: string[], sourceArtifactId?: string, imageSessionId?: string,
): Promise<NativeBindingSpec> {
  if (!digest.test(requestSha256)) throw new Error("native_image_binding_required");
  const row = await callNativeAuthority(parent.workspace, { operation: "load", request_sha256: requestSha256 });
  if (row.parent_request_sha256 !== parent.requestSha256 || row.kind !== "IMAGE"
    || row.payload.requested_count !== count || row.payload.prompt_sha256 !== hash(prompt)
    || row.payload.source_artifact_id !== sourceArtifactId
    || row.payload.image_session_id !== imageSessionId
    || (sourceArtifactId === undefined && JSON.stringify(row.payload.inputs.map((x: { path: string }) => resolve(x.path)))
      !== JSON.stringify(references.map(path => realpathSync(path))))) {
    throw new Error("native_image_payload_binding_mismatch");
  }
  if (row.thread_id !== null && row.thread_id !== parent.threadId) throw new Error("native_image_owner_mismatch");
  if (row.status !== "COMPLETE") {
    await callNativeAuthority(parent.workspace, { operation: "bind", request_sha256: requestSha256, thread_id: parent.threadId });
  }
  return { ...parent, requestSha256, parentRequestSha256: parent.requestSha256, ordinal: 1 };
}
