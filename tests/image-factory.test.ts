import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_TOOL_NAMES, imageGenerateSchema, imageJobSchema, imageToolInventory, assertWebImageToolRouting } from "../src/adapters/chatgpt-web/image-factory/contracts";
import { IMAGE_FACTORY_INSTRUCTIONS, mergeImageFactoryInstructions } from "../src/adapters/chatgpt-web/image-factory/instructions";
import { ensureImageFactoryProject } from "../src/adapters/chatgpt-web/image-factory/project-manager";
import { ImageFactoryService } from "../src/adapters/chatgpt-web/image-factory/service";
import { ImageFactoryStore, imageKey } from "../src/adapters/chatgpt-web/image-factory/state";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Image Factory contract", () => {
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
    let creates = 0;
    const ui = {
      accountKey: async () => accountKey,
      list: async () => [...projects.values()].map(({ id }) => ({ id, name: "Image Factory" })),
      inspect: async (id: string) => {
        const project = projects.get(id);
        if (!project) throw new Error("missing project");
        return project;
      },
      create: async (onCreated: (id: string) => void) => {
        creates += 1;
        const project = { id: `g-p-${creates.toString().padStart(16, "0")}`, memory: "project-only" as const, instructions: "" };
        projects.set(project.id, project);
        onCreated(project.id);
        await new Promise(resolve => setTimeout(resolve, 5));
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
    expect(creates).toBe(1);
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
    let created = 0;
    const ui = {
      accountKey: async () => accountKey,
      list: async () => {
        throw new Error("list must not create a replacement for an incomplete binding");
      },
      inspect: async () => {
        throw new Error("project UI temporarily unavailable");
      },
      create: async () => {
        created += 1;
        throw new Error("unexpected replacement");
      },
      writeInstructions: async () => {},
    };
    await expect(ensureImageFactoryProject(store, ui)).rejects.toThrow("previously created Image Factory project");
    expect(created).toBe(0);
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
