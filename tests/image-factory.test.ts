import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { describe, expect, test, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { IMAGE_TOOL_NAMES, imageEditSchema, imageGenerateSchema, imageJobSchema, imageToolInventory, assertWebImageToolRouting } from "../src/adapters/chatgpt-web/image-factory/contracts";
import { IMAGE_FACTORY_INSTRUCTIONS, mergeImageFactoryInstructions } from "../src/adapters/chatgpt-web/image-factory/instructions";
import { resolveImageFactoryModelPolicy } from "../src/adapters/chatgpt-web/image-factory/model-policy";
import { IMAGE_FACTORY_MULTI_IMAGE_PROMPT_TEMPLATE, imageFactoryContinuationPrompt, imageFactoryInitialPrompt } from "../src/adapters/chatgpt-web/image-factory/prompt-template";
import { ensureImageFactoryProject } from "../src/adapters/chatgpt-web/image-factory/project-manager";
import {
  isImageFactoryProjectRow,
  readProjectRowLabel,
  verifiedImageFactoryConversationUrl,
  waitForImageFactoryConversationUrl,
} from "../src/adapters/chatgpt-web/image-factory/project-navigation";
import { ImageFactoryService } from "../src/adapters/chatgpt-web/image-factory/service";
import { imageFactoryReconciler } from "../src/adapters/chatgpt-web/image-factory/reconcile";
import { ImageFactoryStore, imageKey, type ImageSession, type StoredImageJob } from "../src/adapters/chatgpt-web/image-factory/state";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { configuredImageFactoryProjectId, imageFactoryResumePlan, resolveImageFactoryProjectConfig, resolveImageFactoryProjectId } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { CodexProviderConfig } from "../src/types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Image Factory contract", () => {
  test("Image Factory inherits the parent Sol effort including Instant", () => {
    const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
    expect(resolveImageFactoryModelPolicy(plus, "gpt-5.6-sol", "low")).toEqual({
      modelId: "gpt-5.6-sol",
      reasoning: "low",
    });
    expect(resolveImageFactoryModelPolicy(plus, "gpt-5.6-sol", "medium")).toEqual({
      modelId: "gpt-5.6-sol",
      reasoning: "medium",
    });
    expect(resolveImageFactoryModelPolicy(plus, "gpt-5.6-sol", "high")).toEqual({
      modelId: "gpt-5.6-sol",
      reasoning: "high",
    });
  });

  test("Image Factory inherits supported higher thinking and Luna/Think exactly", () => {
    const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
    expect(resolveImageFactoryModelPolicy(pro, "gpt-5.6-sol", "xhigh").reasoning).toBe("xhigh");
    expect(resolveImageFactoryModelPolicy(pro, "gpt-5.6-sol", "max").reasoning).toBe("max");
    expect(resolveImageFactoryModelPolicy(
      { localToolsEnabled: false, solAvailable: false, proAvailable: false },
      "gpt-5.6-luna",
      "low",
    )).toEqual({ modelId: "gpt-5.6-luna", reasoning: "low" });
    expect(resolveImageFactoryModelPolicy(
      { localToolsEnabled: false, solAvailable: false, proAvailable: false },
      "gpt-5.6-luna",
      "medium",
    )).toEqual({ modelId: "gpt-5.6-luna", reasoning: "medium" });
  });

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
    let currentProjectName: string | null = "  Design lab  ";
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the authenticated local control request.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({ ok: true, projectId: currentProjectId, projectName: currentProjectName })}\n`);
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
      await expect(resolveImageFactoryProjectConfig(provider)).resolves.toEqual({ projectId: "first-project-id", projectName: "Design lab" });
      currentProjectName = "Studio renamed";
      currentProjectId = "second-project-id";
      await expect(resolveImageFactoryProjectId(provider)).resolves.toBe("second-project-id");
      await expect(resolveImageFactoryProjectConfig(provider)).resolves.toEqual({ projectId: "second-project-id", projectName: "Studio renamed" });
      currentProjectId = null;
      await expect(resolveImageFactoryProjectId(provider)).rejects.toThrow(
        "Image Factory is not configured. Set project_id in Configuration → Image Factory.",
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("generate can recover from stale project-only conversation state after launcher restart", () => {
    const projectId = "g-p-image-factory";
    expect(imageFactoryResumePlan(
      "generate",
      true,
      `https://chatgpt.com/g/${projectId}/project`,
      projectId,
      1,
    )).toEqual({
      prepareResume: true,
      requireRetainedConversation: false,
    });
  });

  test("edit and compensation fail closed when no recoverable retained conversation URL exists", () => {
    const projectId = "g-p-image-factory";
    const staleProjectUrl = `https://chatgpt.com/g/${projectId}/project`;
    expect(imageFactoryResumePlan("edit", true, staleProjectUrl, projectId, 1)).toEqual({
      prepareResume: true,
      requireRetainedConversation: true,
    });
    expect(imageFactoryResumePlan("generate", true, staleProjectUrl, projectId, 2)).toEqual({
      prepareResume: true,
      requireRetainedConversation: true,
    });
  });

  test("a verified Image Factory conversation URL is supplied for restart recovery", () => {
    const projectId = "g-p-image-factory";
    const conversationUrl = `https://chatgpt.com/g/${projectId}-image-factory/c/6aa36a93-7164-83ec-8342-0441376d4255`;
    expect(imageFactoryResumePlan("generate", true, conversationUrl, projectId, 1)).toEqual({
      prepareResume: true,
      requireRetainedConversation: true,
      resumeConversationUrl: conversationUrl,
    });
  });

  test("reconcile uses the assistant turn recorded by that job instead of session-wide legacy state", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-reconcile-job-turn-"));
    temporaryDirectories.push(directory);
    const namespace = "namespace";
    const threadId = "thread-reconcile";
    const owner = imageKey(namespace, threadId);
    const projectId = "g-p-image-factory";
    const conversationUrl = `https://chatgpt.com/g/${projectId}-image-factory/c/6aa36a93-7164-83ec-8342-0441376d4255`;
    const submission = {
      id: "submission-1",
      attempt: 1,
      requestedCount: 1,
      generatedCount: 1,
      downloadedCount: 0,
      assistantTurnId: "assistant-target-job",
      candidateKeys: ["candidate-target"],
      excessCandidateKeys: [],
      failures: [],
    };
    const job: StoredImageJob = {
      key: imageKey("job", "reconcile"),
      owner,
      payloadHash: imageKey("payload", "reconcile"),
      operation: "generate",
      input: { request_id: "request-reconcile", prompt: "draw", count: 1 },
      requestedCount: 1,
      attemptCount: 1,
      submissions: [submission],
      phase: "terminal",
      updatedAt: Date.now(),
      result: {
        jobId: "job-reconcile",
        imageSessionId: "session-reconcile",
        status: "failed",
        requestedCount: 1,
        generatedCount: 1,
        downloadedCount: 0,
        attemptCount: 1,
        artifacts: [],
        submissions: [submission],
      },
    };
    const session = {
      id: "session-reconcile",
      owner,
      projectId,
      conversationUrl,
      hasConversation: true,
      updatedAt: Date.now(),
      // Simulate stale state written by the removed session-wide implementation.
      lastAssistantTurnId: "assistant-from-another-job",
    } as ImageSession & { lastAssistantTurnId: string };
    const environment = {
      cwd: directory,
      roots: [directory],
      writableRoots: [directory],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [directory], networkAccess: true },
      tools: [],
    };
    const artifact = {
      kind: "generated_image" as const,
      id: "img_recovered",
      relativePath: ".codex/chatgpt-web-artifacts/reconcile/recovered.png",
      absolutePath: join(directory, "recovered.png"),
      mimeType: "image/png" as const,
      byteLength: 8,
      sha256: "d".repeat(64),
      source: {
        assistantTurnId: "assistant-target-job",
        candidateKey: "candidate-target",
        imageSessionId: session.id,
        projectId,
        conversationUrl,
      },
    };
    let observedAssistantTurnId: string | undefined;
    const workerFactory = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({
      run: async (turn: Parameters<ChatGptBrowserWorker["run"]>[0]) => {
        observedAssistantTurnId = turn.imageReconcile?.assistantTurnId;
        turn.onOutputArtifact?.(artifact);
        turn.onOutputArtifactCapture?.({
          artifacts: [artifact],
          failures: [],
          candidateKeys: ["candidate-target"],
          excessCandidateKeys: [],
          detectedCandidates: 1,
          ignoredCandidates: 0,
        });
        return "recovered";
      },
    } as unknown as ChatGptBrowserWorker);
    try {
      const provider: CodexProviderConfig = {
        adapter: "chatgpt-web",
        baseUrl: "browser://image-factory-reconcile-test",
        chatgptWeb: { solAvailable: true },
      };
      const result = await imageFactoryReconciler(provider, namespace)(job, session, {
        threadId,
        modelId: "gpt-5.6-sol",
        reasoning: "high",
        environment,
        signal: new AbortController().signal,
        activity: () => () => {},
      });
      expect(observedAssistantTurnId).toBe("assistant-target-job");
      expect(result.status).toBe("completed");
      expect(result.artifacts.map(value => value.id)).toEqual(["img_recovered"]);
    } finally {
      workerFactory.mockRestore();
    }
  });

  test("Image Factory waits for the retained conversation route after first project submission", async () => {
    const projectId = "custom-project-id";
    const conversationUrl = `https://chatgpt.com/g/${projectId}-image-factory/c/6aa36a93-7164-83ec-8342-0441376d4255`;
    let currentUrl = `https://chatgpt.com/g/${projectId}/project`;
    let waits = 0;
    let observedTimeout: number | undefined;
    const page = {
      url: () => currentUrl,
      waitForURL: async (
        matcher: string | RegExp | ((url: URL) => boolean),
        options?: { timeout?: number },
      ) => {
        waits += 1;
        observedTimeout = options?.timeout;
        currentUrl = conversationUrl;
        const matched = typeof matcher === "function"
          ? matcher(new URL(currentUrl))
          : matcher instanceof RegExp
            ? matcher.test(currentUrl)
            : currentUrl === matcher;
        if (!matched) throw new Error(`URL did not match: ${currentUrl}`);
      },
    } as unknown as Parameters<typeof waitForImageFactoryConversationUrl>[0];

    await expect(waitForImageFactoryConversationUrl(page, projectId)).resolves.toBe(conversationUrl);
    expect(waits).toBe(1);
    expect(observedTimeout).toBe(60_000);
    await expect(waitForImageFactoryConversationUrl(page, projectId)).resolves.toBe(conversationUrl);
    expect(waits).toBe(1);
  });

  test("a navigation 429 survives the job journal with no Send attempts", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-rate-limit-"));
    temporaryDirectories.push(directory);
    const service = new ImageFactoryService(new ImageFactoryStore(directory), "rate-test", async () => {
      throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests. Try again in a few minutes.", {
        status: 429, code: "rate_limit_exceeded", errorType: "rate_limit_error", retryable: true,
      });
    }, () => true);
    const parent = { threadId: "thread", modelId: "gpt-5.6-sol", reasoning: "high", signal: new AbortController().signal, activity: () => () => {},
      environment: { cwd: directory, roots: [directory], writableRoots: [directory], tools: [], sandboxPolicy: { type: "dangerFullAccess" as const } } };
    const job = await service.call(parent, "chatgpt_image_generate", { request_id: "rate", prompt: "draw" });
    const result = await service.call(parent, "chatgpt_image_wait", { job_id: job.jobId });
    expect(result).toMatchObject({ status: "failed", attemptCount: 0, error: {
      status: 429, code: "rate_limit_exceeded", errorType: "rate_limit_error", retryable: true,
    } });
    expect((await service.call(parent, "chatgpt_image_wait", { job_id: job.jobId })).error).toEqual(result.error);
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
    const parent = { threadId: "thread", modelId: "gpt-5.6-sol", reasoning: "high", signal: new AbortController().signal, activity: () => () => {},
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
    expect(imageGenerateSchema.parse({ request_id: "one", prompt: "Draw" }).count).toBe(1);
    expect(imageGenerateSchema.parse({ request_id: "four", prompt: "Draw", count: 4 }).count).toBe(4);
    expect(imageEditSchema.parse({
      request_id: "edit",
      image_session_id: "session",
      source_artifact_id: "artifact",
      prompt: "Change shirt",
    }).count).toBe(1);
    for (const count of [0, 5, 1.5, Number.NaN]) {
      expect(() => imageGenerateSchema.parse({ request_id: "one", prompt: "Draw", count })).toThrow();
      expect(() => imageEditSchema.parse({
        request_id: "edit",
        image_session_id: "session",
        source_artifact_id: "artifact",
        prompt: "Change shirt",
        count,
      })).toThrow();
    }
    for (const key of ["workspaceRoot", "projectId", "account", "permissions"]) {
      expect(() => imageGenerateSchema.parse({ request_id: "one", prompt: "Draw", [key]: "forged" })).toThrow();
    }
    expect(() => imageJobSchema.parse({ job_id: "../../other" })).toThrow();
    expect(imageToolInventory().map(tool => tool.name)).toEqual([...IMAGE_TOOL_NAMES]);
  });
  test("multi-image prompts use one explicit output slot per requested image", () => {
    const prompt = imageFactoryInitialPrompt("generate", "A studio portrait of the same character.", 3);
    expect(prompt).toContain("Create 3 separate images.");
    expect(prompt.match(/^Image \d+:/gm)).toHaveLength(3);
    expect(prompt.match(/A studio portrait of the same character\./g)).toHaveLength(3);
    expect(prompt).toContain("Return them as 3 separate image outputs in one response.");
    expect(prompt).toContain("One Image line must map to one standalone generated-image card/file.");
    expect(prompt).toContain("Produce exactly 3 standalone generated-image cards/files");
    expect(prompt).toContain("invoke it 3 times before finishing this response");
    expect(prompt).toContain("Do NOT combine multiple requested images into a collage");

    const alreadyCanonical = `Create 3 separate images.\nImage 1: front view.\nImage 2: side view.\nImage 3: back view.\nReturn them as 3 separate image outputs, NOT as a collage.`;
    const reinforcedCanonical = imageFactoryInitialPrompt("generate", alreadyCanonical, 3);
    expect(reinforcedCanonical).toStartWith(alreadyCanonical);
    expect(reinforcedCanonical).toContain("Produce exactly 3 standalone generated-image cards/files");
    expect(imageFactoryInitialPrompt("generate", "Draw one dog", 1)).toBe("Draw one dog");
    expect(IMAGE_FACTORY_MULTI_IMAGE_PROMPT_TEMPLATE).toContain("Image {N}: {complete description for image N}");
    expect(IMAGE_FACTORY_MULTI_IMAGE_PROMPT_TEMPLATE).toContain("Produce exactly {N} standalone generated-image cards/files");
  });
  test("multi-edit and compensation prompts stay separate and source-stable", () => {
    const edit = imageFactoryInitialPrompt("edit", "Change the shirt to blue.", 2);
    expect(edit.match(/^Image \d+:/gm)).toHaveLength(2);
    expect(edit).toContain("original source image");
    expect(edit).toContain("not from another generated variant");

    const initial = imageFactoryInitialPrompt(
      "generate",
      `Create 3 separate images.\nImage 1: front view.\nImage 2: side view.\nImage 3: back view.\nShared constraints: same character and outfit.\nReturn them as 3 separate image outputs.`,
      3,
    );
    const continuation = imageFactoryContinuationPrompt("generate", initial, 1, 2);
    expect(continuation.match(/^Image \d+:/gm)).toHaveLength(2);
    expect(continuation).toContain("2 additional separate images");
    expect(continuation).toContain("2 separate image outputs");
    expect(continuation).toContain("originally requested Image 2: side view.");
    expect(continuation).toContain("originally requested Image 3: back view.");
    expect(continuation).toContain("Shared constraints: same character and outfit.");
    expect(continuation).not.toContain("front view.");

    const editContinuation = imageFactoryContinuationPrompt("edit", edit, 1, 1);
    expect(editContinuation).toContain("original source image");
    expect(editContinuation).toContain("Shared edit:\nChange the shirt to blue.");
    expect(() => imageFactoryInitialPrompt("generate", "Draw", 5)).toThrow("integer from 1 through 4");
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
    expect(first.instructionsVersion).toBe(3);
    expect(projects.get(first.projectId)?.instructions).toContain("[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY v3]");
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
    let receivedModel: string | undefined;
    let receivedReasoning: string | undefined;
    const service = new ImageFactoryService(store, "namespace", async options => {
      receivedReference = options.images[0]?.imageUrl.startsWith("data:image/png;base64,") === true;
      receivedModel = options.modelId;
      receivedReasoning = options.reasoning;
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
    const parent = { threadId: "thread-1", modelId: "gpt-5.6-sol", reasoning: "high", environment, signal: new AbortController().signal, activity: () => { releases += 1; return () => { releases += 1; }; } };
    const first = await service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "draw a dog", reference_image_paths: [reference] });
    expect(first.status).toBe("running");
    const result = await service.call(parent, "chatgpt_image_wait", { job_id: first.jobId });
    expect(result.status).toBe("completed");
    expect(result.artifacts).toHaveLength(1);
    expect(receivedReference).toBe(true);
    expect(receivedModel).toBe("gpt-5.6-sol");
    expect(receivedReasoning).toBe("high");
    expect(releases).toBe(2);
    expect((await service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "draw a dog", reference_image_paths: [reference] })).jobId).toBe(first.jobId);
    await expect(service.call(parent, "chatgpt_image_generate", { request_id: "request-1", prompt: "different payload" })).rejects.toThrow("idempotency_conflict");
  });

  test("unknown execution failures preserve a safe pre-Send diagnostic", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-pre-send-failure-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(join(directory, "state"));
    const environment = {
      cwd: directory,
      roots: [directory],
      writableRoots: [directory],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [directory], networkAccess: true },
      tools: [],
    };
    const service = new ImageFactoryService(store, "namespace", async () => {
      throw new Error("launcher helper exited before ready https://chatgpt.com/c/example?token=secret");
    }, () => true);
    const parent = {
      threadId: "thread-pre-send-failure",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      environment,
      signal: new AbortController().signal,
      activity: () => () => {},
    };

    const started = await service.call(parent, "chatgpt_image_generate", {
      request_id: "request-pre-send-failure",
      prompt: "draw",
    });
    const result = await service.call(parent, "chatgpt_image_wait", { job_id: started.jobId });
    expect(result.status).toBe("failed");
    expect(result.attemptCount).toBe(0);
    expect(result.error).toEqual({
      code: "image_generation_failed",
      message: "Image Factory execution failed: Error: launcher helper exited before ready https://chatgpt.com/c/example",
    });
  });

  test("image edit resolves one stored source artifact and preserves requested variant count", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-edit-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(join(directory, "state"));
    const namespace = "namespace";
    const threadId = "thread-edit";
    const owner = imageKey(namespace, threadId);
    const imageSessionId = "edit-session";
    const sourceArtifactId = "img_source";
    const source = {
      assistantTurnId: "assistant-source",
      candidateKey: "image-source",
      cardId: "image-source",
      fileIdentity: "file_source",
      imageSessionId,
      conversationUrl: "https://chatgpt.com/c/WEB:edit-session",
      projectId: "project",
    };
    store.write("session", imageKey(owner, imageSessionId), {
      id: imageSessionId,
      owner,
      hasConversation: true,
      conversationUrl: source.conversationUrl,
      artifacts: { [sourceArtifactId]: source },
      updatedAt: Date.now(),
    });
    const environment = {
      cwd: directory,
      roots: [directory],
      writableRoots: [directory],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [directory], networkAccess: true },
      tools: [],
    };
    let executionSource: unknown;
    let executionCount = 0;
    const service = new ImageFactoryService(store, namespace, async options => {
      executionSource = options.sourceArtifact;
      executionCount = options.requestedCount;
      const artifacts = [1, 2].map(index => ({
        kind: "generated_image" as const,
        id: `img_edit_${index}`,
        relativePath: `.codex/chatgpt-web-artifacts/edit/image-${index}.png`,
        absolutePath: join(directory, `image-${index}.png`),
        mimeType: "image/png" as const,
        byteLength: 8,
        sha256: String(index).repeat(64),
        source: {
          assistantTurnId: `assistant-edit-${index}`,
          candidateKey: `image-edit-${index}`,
          cardId: `image-edit-${index}`,
          imageSessionId,
          conversationUrl: source.conversationUrl,
        },
      }));
      return {
        status: "completed" as const,
        artifacts,
        requestedCount: 2,
        generatedCount: 2,
        downloadedCount: 2,
        attemptCount: 1,
        sourceArtifactId,
      };
    }, () => true);
    const parent = {
      threadId,
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      environment,
      signal: new AbortController().signal,
      activity: () => () => {},
    };

    const started = await service.call(parent, "chatgpt_image_edit", {
      request_id: "edit-request",
      image_session_id: imageSessionId,
      source_artifact_id: sourceArtifactId,
      prompt: "Change the shirt to blue",
      count: 2,
    });
    const result = await service.call(parent, "chatgpt_image_wait", { job_id: started.jobId });
    expect(executionSource).toEqual(source);
    expect(executionCount).toBe(2);
    expect(result).toMatchObject({
      status: "completed",
      requestedCount: 2,
      generatedCount: 2,
      downloadedCount: 2,
      attemptCount: 1,
      sourceArtifactId,
    });
    expect(result.artifacts).toHaveLength(2);
  });

  test("image edit fails closed when stored provenance is missing", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "image-factory-edit-missing-"));
    temporaryDirectories.push(directory);
    const store = new ImageFactoryStore(join(directory, "state"));
    const namespace = "namespace";
    const threadId = "thread-edit-missing";
    const owner = imageKey(namespace, threadId);
    const imageSessionId = "edit-session";
    store.write("session", imageKey(owner, imageSessionId), {
      id: imageSessionId,
      owner,
      hasConversation: true,
      conversationUrl: "https://chatgpt.com/c/WEB:edit-session",
      artifacts: {},
      updatedAt: Date.now(),
    });
    const environment = { cwd: directory, roots: [directory], writableRoots: [directory],
      sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
    let executions = 0;
    const service = new ImageFactoryService(store, namespace, async () => {
      executions += 1;
      return { status: "failed", artifacts: [] };
    }, () => true);
    const parent = { threadId, modelId: "gpt-5.6-sol", reasoning: "high", environment, signal: new AbortController().signal, activity: () => () => {} };
    await expect(service.call(parent, "chatgpt_image_edit", {
      request_id: "edit-request",
      image_session_id: imageSessionId,
      source_artifact_id: "missing",
      prompt: "Change the shirt",
    })).rejects.toThrow("source artifact has no usable Image Factory provenance");
    expect(executions).toBe(0);
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
    const parent = { threadId: "thread-2", modelId: "gpt-5.6-sol", reasoning: "high", environment, signal: new AbortController().signal, activity: () => () => {} };
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
    const parent = { threadId: "thread", modelId: "gpt-5.6-sol", reasoning: "high", environment, signal: new AbortController().signal,
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
