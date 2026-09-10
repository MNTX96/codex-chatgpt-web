import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { IMAGE_TOOL_NAMES, imageGenerateSchema, imageJobSchema, imageToolInventory, assertWebImageToolRouting } from "../src/adapters/chatgpt-web/image-factory/contracts";
import { IMAGE_FACTORY_INSTRUCTIONS, mergeImageFactoryInstructions } from "../src/adapters/chatgpt-web/image-factory/instructions";
import { ensureImageFactoryProject } from "../src/adapters/chatgpt-web/image-factory/project-manager";
import { isImageFactoryProjectRow, openImageFactoryProject, readProjectRowLabel } from "../src/adapters/chatgpt-web/image-factory/project-navigation";
import { ImageFactoryService } from "../src/adapters/chatgpt-web/image-factory/service";
import { ImageFactoryStore, imageKey } from "../src/adapters/chatgpt-web/image-factory/state";
import { configuredImageFactoryProjectId, resolveImageFactoryProjectId } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { CodexProviderConfig } from "../src/types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Image Factory contract", () => {
  test("runtime project_id gate only requires a non-empty configured value", () => {
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://image-factory-project-id-test",
      chatgptWeb: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    expect(() => configuredImageFactoryProjectId(provider)).toThrow(
      "Image Factory is not configured. Set project_id in Configuration → Image Factory.",
    );
    expect(configuredImageFactoryProjectId({
      ...provider,
      chatgptWeb: { ...provider.chatgptWeb, imageFactoryProjectId: "  custom-project-id  " },
    })).toBe("custom-project-id");
  });

  test("launcher Image Factory project_id is resolved live for every job", async () => {
    let currentProjectId: string | null = "first-project-id";
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the authenticated local control request.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({ ok: true, projectId: currentProjectId })}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-live-config-"));
      temporaryDirectories.push(directory);
      const descriptorPath = join(directory, "launcher-browser.json");
      writeFileSync(descriptorPath, `${JSON.stringify({
        version: 3,
        kind: LAUNCHER_BROWSER_HOST_KIND,
        profile: "development",
        pid: process.pid,
        endpoint: "http://127.0.0.1:39110",
        control: {
          endpoint: `http://127.0.0.1:${address.port}`,
          token: "launcher-control-token-0123456789abcdefghijklmnop",
        },
        helper: { executable: process.execPath, script: import.meta.path },
        partition: "persist:codex-web-gpt-dev-chatgpt",
        idleUrl: LAUNCHER_BROWSER_IDLE_URL,
        surfaceId: "launcher_surface_id_0123456789AB",
        surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
        createdAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
      const provider: CodexProviderConfig = {
        adapter: "chatgpt-web",
        baseUrl: "browser://image-factory-live-project-id-test",
        chatgptWeb: {
          browserHost: "launcher",
          browserHostDescriptorPath: descriptorPath,
          imageFactoryProjectId: "stale-runtime-config-id",
        },
      };
      await expect(resolveImageFactoryProjectId(provider)).resolves.toBe("first-project-id");
      currentProjectId = "second-project-id";
      await expect(resolveImageFactoryProjectId(provider)).resolves.toBe("second-project-id");
      currentProjectId = null;
      await expect(resolveImageFactoryProjectId(provider)).rejects.toThrow(
        "Image Factory is not configured. Set project_id in Configuration → Image Factory.",
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("configured Image Factory project opens from Projects and verifies the clicked row by project_id", async () => {
    let currentUrl = "https://chatgpt.com/projects";
    const navigations: Array<{ url: string; options: unknown }> = [];
    const events: string[] = [];
    const projects = [
      { id: "g-p-other", name: "Other project" },
      { id: "custom-project-id", name: "Image Factory" },
    ];
    const rows = {
      count: async () => projects.length,
      nth: (index: number) => ({
        locator: () => ({
          first: () => ({
            getAttribute: async (name: string) => name === "aria-label"
              ? `Open project options for ${projects[index].name}`
              : null,
          }),
        }),
        getByRole: () => ({ textContent: async () => projects[index].name }),
        click: async () => {
          currentUrl = `https://chatgpt.com/g/${projects[index].id}/project`;
        },
      }),
      last: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    };
    const page = {
      url: () => currentUrl,
      goto: async (url: string, options: unknown) => {
        navigations.push({ url, options });
        currentUrl = url;
      },
      locator: () => rows,
      getByRole: () => ({ waitFor: async () => {} }),
      waitForTimeout: async () => {},
      waitForURL: async (matcher: string | RegExp | ((url: URL) => boolean)) => {
        const matched = typeof matcher === "function"
          ? matcher(new URL(currentUrl))
          : matcher instanceof RegExp
            ? matcher.test(currentUrl)
            : currentUrl === matcher;
        if (!matched) throw new Error(`URL did not match: ${currentUrl}`);
      },
    } as unknown as Parameters<typeof openImageFactoryProject>[0];

    await openImageFactoryProject(page, "  custom-project-id  ", event => events.push(event));
    expect(navigations).toEqual([]);
    expect(currentUrl).toBe("https://chatgpt.com/g/custom-project-id/project");
    expect(events).toEqual([
      "project_directory_ready",
      "project_directory_candidate_opened",
      "project_directory_match_opened",
    ]);

    await openImageFactoryProject(page, "custom-project-id", event => events.push(event));
    expect(navigations).toHaveLength(0);
    expect(events.at(-1)).toBe("project_document_reused");
    await expect(openImageFactoryProject(page, "   ")).rejects.toThrow("Image Factory project_id is not configured");
  });

  test("adapter rounds share live image jobs within a namespace", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-shared-"));
    temporaryDirectories.push(directory);
    let created = 0;
    const create = () => {
      created += 1;
      return new ImageFactoryService(new ImageFactoryStore(directory), "shared", async ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), () => true);
    };
    const first = ImageFactoryService.shared(directory, "shared", create);
    const parent = { threadId: "thread", signal: new AbortController().signal, activity: () => () => {},
      environment: { cwd: directory, roots: [directory], writableRoots: [directory], tools: [], sandboxPolicy: { type: "dangerFullAccess" as const } } };
    const job = await first.call(parent, "chatgpt_image_generate", { request_id: "request", prompt: "draw" });
    const nextRound = ImageFactoryService.shared(directory, "shared", create);
    expect((await nextRound.call(parent, "chatgpt_image_cancel", { job_id: job.jobId })).status).toBe("cancelled");
    expect(created).toBe(1);
    expect(ImageFactoryService.shared(directory, "other", create)).not.toBe(first);
  });

  test("project row matching isolates the exact title from rendered metadata", async () => {
    const projectRow = (projectName: string, cellText = `${projectName}Today`) => {
      const expectedButton = {
        first() { return this; },
        isVisible: async () => projectName === "Image Factory",
      };
      const cell = {
        textContent: async () => cellText,
      };
      return {
        locator: () => ({
          first() { return this; },
          getAttribute: async () => `Open project options for ${projectName}`,
        }),
        getByRole: (role: string, options?: { name?: string; exact?: boolean }) => {
          if (role === "button") {
            expect(options).toEqual({ name: "Open project options for Image Factory", exact: true });
            return expectedButton;
          }
          return { first: () => cell };
        },
      } as unknown as Parameters<typeof readProjectRowLabel>[0];
    };

    const observedProductionShape = projectRow("Image Factory");
    expect(await readProjectRowLabel(observedProductionShape)).toBe("Image Factory");
    expect(await isImageFactoryProjectRow(observedProductionShape)).toBe(true);
    expect(await readProjectRowLabel(projectRow("Image Factory 2"))).toBe("Image Factory 2");
    expect(await isImageFactoryProjectRow(projectRow("Image Factory 2"))).toBe(false);
    expect(await readProjectRowLabel(projectRow("VFMU · universe", "VFMU · universePinnedYesterday"))).toBe("VFMU · universe");
    expect(await isImageFactoryProjectRow(projectRow("VFMU · universe"))).toBe(false);
  });

  test("strict arguments cannot smuggle workspace or project authority", () => {
    expect(imageGenerateSchema.parse({ request_id: "one", prompt: " Draw " }).prompt).toBe("Draw");
    for (const key of ["workspaceRoot", "projectId", "account", "permissions"]) {
      expect(() => imageGenerateSchema.parse({ request_id: "one", prompt: "Draw", [key]: "forged" })).toThrow();
    }
    expect(() => imageJobSchema.parse({ job_id: "../../other" })).toThrow();
    expect(imageToolInventory().map(tool => tool.name)).toEqual([...IMAGE_TOOL_NAMES]);
  });
  test("routing is based on exact tool identity", () => {
    expect(() => assertWebImageToolRouting("image_gen__imagegen")).toThrow("chatgpt_image_generate");
    expect(() => assertWebImageToolRouting("view_image")).not.toThrow();
    expect(() => assertWebImageToolRouting("my_image_analysis")).not.toThrow();
  });
  test("managed instructions preserve surrounding content and are idempotent", () => {
    const original = "User preferences\n";
    const merged = mergeImageFactoryInstructions(original);
    expect(merged.startsWith(original)).toBe(true);
    expect(mergeImageFactoryInstructions(merged)).toBe(merged);
    const old = "prefix\n[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY v0]\nold\n[END CODEX-CHATGPT-WEB IMAGE FACTORY]\nsuffix";
    expect(mergeImageFactoryInstructions(old)).toBe(`prefix\n${IMAGE_FACTORY_INSTRUCTIONS}\nsuffix`);
  });
  test("malformed and duplicate instructions fail closed", () => {
    for (const text of [IMAGE_FACTORY_INSTRUCTIONS.repeat(2), "[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY v1]", "[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY broken"]) {
      expect(() => mergeImageFactoryInstructions(text)).toThrow();
    }
  });

  test("project setup is serialized and reuses the verified Project-only binding", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-project-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(directory);
    const accountKey = "a".repeat(64);
    const projects = new Map<string, { id: string; memory: "project-only"; instructions: string }>();
    projects.set("g-p-0000000000000001", { id: "g-p-0000000000000001", memory: "project-only", instructions: "" });
    const ui = {
      accountKey: async () => accountKey,
      list: async () => [...projects.values()].map(({ id }) => ({ id, name: "Image Factory" })),
      inspect: async (id: string) => {
        const project = projects.get(id);
        if (!project) throw new Error("missing project");
        return project;
      },
      writeInstructions: async (id: string, instructions: string) => {
        const project = projects.get(id);
        if (!project) throw new Error("missing project");
        project.instructions = instructions;
      },
    };
    const [first, second] = await Promise.all([
      ensureImageFactoryProject(store, ui),
      ensureImageFactoryProject(store, ui),
    ]);
    expect(first.projectId).toBe(second.projectId);
    expect(first.instructionsVersion).toBe(1);
    expect(projects.get(first.projectId)?.instructions).toContain("[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY v1]");
  });

  test("incomplete project setup is retried in place instead of creating duplicates", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-recovery-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(directory);
    const accountKey = "b".repeat(64);
    const projectId = "g-p-1234567890abcdef";
    store.write("project", imageKey("project", accountKey), { accountKey, projectId, phase: "created" });
    const ui = {
      accountKey: async () => accountKey,
      list: async () => {
        throw new Error("list must not create a replacement for an incomplete binding");
      },
      inspect: async () => {
        throw new Error("project UI temporarily unavailable");
      },
      writeInstructions: async () => {},
    };
    await expect(ensureImageFactoryProject(store, ui)).rejects.toThrow("previously created Image Factory project");
  });

  test("cancelling project inspection prevents a later instructions write", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-setup-abort-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    let writes = 0;
    const ui = {
      accountKey: async () => "a".repeat(64),
      list: async () => [{ id: "g-p-0000000000000001", name: "Image Factory" }],
      inspect: async (id: string) => {
        controller.abort();
        return { id, memory: "project-only" as const, instructions: "" };
      },
      writeInstructions: async () => { writes += 1; },
    };
    await expect(ensureImageFactoryProject(new ImageFactoryStore(directory), ui, () => {}, controller.signal)).rejects.toThrow();
    expect(writes).toBe(0);
  });

  test("image jobs are idempotent, write through the trusted target, and preserve references", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-job-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(join(directory, "state"));
    const reference = join(directory, "reference.png");
    writeFileSync(reference, Buffer.from("89504e470d0a1a0a", "hex"));
    const environment = {
      cwd: directory,
      roots: [directory],
      writableRoots: [directory],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [directory], networkAccess: true },
      tools: [],
    };
    let releases = 0;
    let receivedReference = false;
    const service = new ImageFactoryService(store, "namespace", async options => {
      receivedReference = options.images[0]?.imageUrl.startsWith("data:image/png;base64,") === true;
      options.update({ session: { ...options.request.session, accountKey: "b".repeat(64), updatedAt: Date.now() }, phase: "submitted" });
      const artifact = {
        kind: "generated_image" as const,
        id: "img_test",
        relativePath: ".codex/chatgpt-web-artifacts/job/image-test.png",
        absolutePath: join(directory, "image-test.png"),
        mimeType: "image/png" as const,
        byteLength: 8,
        sha256: "c".repeat(64),
        source: { assistantTurnId: "assistant", candidateKey: "image-1" },
      };
      return { status: "completed" as const, artifacts: [artifact] };
    }, () => true);
    const parent = { threadId: "thread-1", environment, signal: new AbortController().signal, activity: () => { releases += 1; return () => { releases += 1; }; } };
    const first = await service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "draw a dog", reference_image_paths: [reference] });
    expect(first.status).toBe("running");
    const result = await service.call(parent, "chatgpt_image_wait", { job_id: first.jobId });
    expect(result.status).toBe("completed");
    expect(result.artifacts).toHaveLength(1);
    expect(receivedReference).toBe(true);
    expect(releases).toBe(2);
    expect((await service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "draw a dog", reference_image_paths: [reference] })).jobId).toBe(first.jobId);
    await expect(service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "different payload" })).rejects.toThrow("idempotency_conflict");
  });

  test("cancel stops a child job without deleting its journal", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-cancel-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(join(directory, "state"));
    const environment = {
      cwd: directory,
      roots: [directory],
      writableRoots: [directory],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [directory], networkAccess: true },
      tools: [],
    };
    const service = new ImageFactoryService(store, "namespace", async ({ signal }) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), () => true);
    const parent = { threadId: "thread-2", environment, signal: new AbortController().signal, activity: () => () => {} };
    const first = await service.call(parent, "chatgpt_image_generate", { request_id: "request-2", prompt: "draw a cat" });
    const cancelled = await service.call(parent, "chatgpt_image_cancel", { job_id: first.jobId });
    expect(cancelled.status).toBe("cancelled");
    expect(readdirSync(join(directory, "state")).some(name => name.startsWith("job-"))).toBe(true);
  });

  test("a rejected parent activity cannot leave a phantom running job", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-activity-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(join(directory, "state"));
    const service = new ImageFactoryService(store, "namespace", async () => ({ status: "failed", artifacts: [] }), () => true);
    const environment = { cwd: directory, roots: [directory], writableRoots: [directory],
      sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
    const parent = { threadId: "thread", environment, signal: new AbortController().signal,
      activity: (): (() => void) => { throw new Error("parent retired"); } };
    await expect(service.call(parent, "chatgpt_image_generate", { request_id: "request", prompt: "draw" })).rejects.toThrow("parent retired");
    expect(readdirSync(store.directory)).toHaveLength(0);
  });

  test("the turn broker exposes virtual image calls without queuing native tool work", async () => {
    const brokerDirectory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-broker-"));
    temporaryDirectories.push(brokerDirectory);
    const socketPath = join(brokerDirectory, "broker.sock");
    const broker = TurnBroker.forSocket(socketPath);
    const environment = {
      cwd: "/tmp",
      roots: ["/tmp"],
      writableRoots: ["/tmp"],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: ["/tmp"], networkAccess: true },
      tools: [],
    };
    const token = await broker.register(environment, 60_000, "image-broker-test");
    broker.bindImageTools(token, async (name, args) => ({
      content: [{ type: "text", text: JSON.stringify({ name, args }) }],
      structuredContent: { name, args },
    }));
    const activityId = `activity_${"a".repeat(24)}`;
    try {
      const claimed = await callTurnBroker<{ bindingId: string; imageFactory: boolean }>(socketPath, { method: "claim", token, activityId });
      expect(claimed.imageFactory).toBe(true);
      const response = await callTurnBroker<{ structuredContent: { name: string } }>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "chatgpt_image_wait",
        arguments: { job_id: "job" },
      });
      expect(response.structuredContent.name).toBe("chatgpt_image_wait");
      const release = broker.holdImageActivity(token);
      expect(broker.beginCompletionFence(token)).toBeUndefined();
      release();
      await callTurnBroker(socketPath, { method: "activity_complete", token, activityId });
      expect(broker.beginCompletionFence(token)).toBe(4);
    } finally {
      await broker.revoke(token);
      await broker.close();
    }
  });
});
