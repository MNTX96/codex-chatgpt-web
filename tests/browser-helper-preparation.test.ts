import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test("helper bounds unresolved preparation, releases its lease, and preserves preflight errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "helper-preparation-"));
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    const stage = ChatGptBrowserWorker.prototype.runStage;
    ChatGptBrowserWorker.prototype.runStage = function(traceId, name, timeout, action, ...rest) {
      return stage.call(this, traceId, name, name === "prompt_preparation" ? 150 : timeout, action, ...rest);
    };
    ChatGptBrowserWorker.prototype.runBrowserTurn = async () => { throw new Error("browser must not start before preparation settles"); };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `);
  const active = new Set<string>();
  const ended = new Map<string, string>();
  const heartbeats = new Set<string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    if (body.phase === "start") {
      active.add(body.traceId);
      return Response.json({ ok:true, surfaceId:"launcher_surface_id_0123456789AB", reused:false, connectorBound:false });
    }
    if (body.phase === "heartbeat") heartbeats.add(body.traceId);
    if (body.phase === "end") { active.delete(body.traceId); ended.set(body.traceId, body.status); }
    return Response.json({ ok:true, cancelledByUser:false });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version:3, kind:LAUNCHER_BROWSER_HOST_KIND, profile:"production", pid:process.pid,
    endpoint:`http://127.0.0.1:${server.port}`,
    control:{endpoint:`http://127.0.0.1:${server.port}`,token:"launcher-control-token-0123456789abcdefghijklmnop"},
    helper:{executable:process.execPath,script:helper}, partition:"persist:codex-web-gpt-chatgpt",idleUrl:LAUNCHER_BROWSER_IDLE_URL,
    surfaceId:"launcher_surface_id_0123456789AB",surfaceTargets:{launcher_surface_id_0123456789AB:"owned-target"},createdAt:new Date().toISOString(),
  }), { mode:0o600 });
  const client = new LauncherBrowserHelperClient({
    appName:"Codex Native2",browserHost:"launcher",browserHostDescriptorPath:descriptorPath,browserHelperScriptPath:helper,
    storageStatePath:join(root,"unused.json"),chromeExecutablePath:join(root,"unused-chrome"),headed:true,autoApproveToolCalls:false,
  });
  try {
    await expect(client.run({
      traceId:"preparation_never_settles",modelId:"gpt-5.6-sol",reasoning:"high",
      capabilities:{localToolsEnabled:false,solAvailable:true,proAvailable:false},
      prepare:()=>new Promise(()=>{}),onTextDelta() {},
    })).rejects.toMatchObject({ status:504,code:"prompt_preparation_timeout",retryable:false });
    expect(active.size).toBe(0);
    expect(ended.get("preparation_never_settles")).toBe("failed");
    expect(heartbeats.has("preparation_never_settles")).toBe(true);
    await expect(client.run({
      traceId:"preparation_context_exceeded",modelId:"gpt-5.6-sol",reasoning:"high",
      capabilities:{localToolsEnabled:false,solAvailable:true,proAvailable:false},
      prepare:async()=>{throw new ChatGptWebAdapterError("Oversized record",{status:400,errorType:"invalid_request_error",code:"context_length_exceeded",retryable:false});},
      onTextDelta() {},
    })).rejects.toMatchObject({ status:400,code:"context_length_exceeded",message:"Oversized record" });
    expect(active.size).toBe(0);
  } finally {
    await client.close();server.stop(true);rmSync(root,{recursive:true,force:true});
  }
}, 10_000);
