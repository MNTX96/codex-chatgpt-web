import { IMAGE_FACTORY_INSTRUCTIONS_HASH, IMAGE_FACTORY_INSTRUCTIONS_VERSION, mergeImageFactoryInstructions } from "./instructions";
import { ImageFactoryError } from "./contracts";
import { ImageFactoryStore, imageKey } from "./state";

export interface ImageFactoryProject {
  id: string;
  memory: "project-only" | "default" | "unknown";
  instructions: string;
}
export interface ImageFactoryProjectUi {
  accountKey(): Promise<string>;
  list(): Promise<Array<{ id: string; name: string }>>;
  inspect(id: string): Promise<ImageFactoryProject>;
  writeInstructions(id: string, text: string): Promise<void>;
}
export interface ImageFactoryProjectBinding {
  accountKey: string;
  projectId: string;
  phase: "created" | "ready";
  instructionsVersion?: number;
  instructionsHash?: string;
}
const locks = new Map<string, Promise<unknown>>();

export type ImageFactoryProjectLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

function shortId(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 12)}…` : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

export async function ensureImageFactoryProject(
  store: ImageFactoryStore,
  ui: ImageFactoryProjectUi,
  log: ImageFactoryProjectLog = () => {},
  abortSignal?: AbortSignal,
): Promise<ImageFactoryProjectBinding> {
  abortSignal?.throwIfAborted();
  const startedAt = Date.now();
  log("account_lookup_started");
  const accountKey = await ui.accountKey();
  if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new ImageFactoryError("image_account_unverified");
  log("account_verified", { accountKey: shortId(accountKey) });
  const lockKey = `${store.directory}:${accountKey}`;
  const previous = locks.get(lockKey) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    abortSignal?.throwIfAborted();
    const key = imageKey("project", accountKey);
    const binding = store.read<ImageFactoryProjectBinding>("project", key);
    log("binding_loaded", {
      found: Boolean(binding),
      phase: binding?.phase,
      projectId: shortId(binding?.projectId),
    });
    let project: ImageFactoryProject | undefined;
    if (binding) {
      if (binding.accountKey !== accountKey) throw new ImageFactoryError("image_account_mismatch");
      // An incomplete setup must be resumed, not replaced repeatedly after a transient UI error.
      try {
        log("bound_project_inspect_started", { projectId: shortId(binding.projectId) });
        project = await ui.inspect(binding.projectId);
        log("bound_project_inspect_succeeded", {
          projectId: shortId(binding.projectId),
          memory: project.memory,
          instructionsLength: project.instructions.length,
        });
      } catch (error) {
        log("bound_project_inspect_failed", {
          projectId: shortId(binding.projectId),
          phase: binding.phase,
          error: errorMessage(error),
        });
        if (binding.phase === "created") {
          throw new ImageFactoryError(
            "image_project_setup_failed",
            `The previously created Image Factory project ${binding.projectId} could not be reopened; retry after ChatGPT project UI access is restored (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        // The binding may point at a deleted or inaccessible project. Continue through the
        // verified-name search so an existing Image Factory can be rebound by identity.
        project = undefined;
      }
    }
    if (!project || project.memory !== "project-only") {
      log("project_list_started");
      const matches = (await ui.list()).filter(value => value.name === "Image Factory");
      log("project_list_completed", { imageFactoryMatches: matches.length });
      const suitable: ImageFactoryProject[] = [];
      for (const match of matches) {
        try {
          log("candidate_inspect_started", { projectId: shortId(match.id) });
          const candidate = await ui.inspect(match.id);
          log("candidate_inspect_completed", {
            projectId: shortId(match.id),
            memory: candidate.memory,
            instructionsLength: candidate.instructions.length,
          });
          if (candidate.memory === "project-only") suitable.push(candidate);
        } catch (error) {
          log("candidate_inspect_failed", {
            projectId: shortId(match.id),
            error: errorMessage(error),
          });
          // An uninspectable project cannot be proven safe and is never selected.
        }
      }
      const managed = suitable.filter(value => value.instructions.includes("[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY"));
      const candidates = managed.length ? managed : suitable;
      log("project_candidates_classified", {
        suitable: suitable.length,
        managed: managed.length,
        candidates: candidates.length,
      });
      if (candidates.length > 1) throw new ImageFactoryError("image_project_ambiguous", "Multiple eligible Image Factory projects; choose one by configuring a verified binding.");
      project = candidates[0];
      if (project && binding && project.id !== binding.projectId) {
        log("binding_replaced_by_name_match", {
          previousProjectId: shortId(binding.projectId),
          projectId: shortId(project.id),
        });
      }
      if (!project) {
        throw new ImageFactoryError(
          "image_project_required",
          "Không tìm thấy project Image Factory. Hãy tạo project tên chính xác ‘Image Factory’, chọn Project-only memory, và thêm Instructions theo hướng dẫn trong ứng dụng rồi thử lại.",
        );
      }
    }
    if (project.memory !== "project-only") throw new ImageFactoryError("image_project_memory_unverified");
    abortSignal?.throwIfAborted();
    log("instructions_merge_started", {
      projectId: shortId(project.id),
      instructionsLength: project.instructions.length,
    });
    const instructions = mergeImageFactoryInstructions(project.instructions);
    if (instructions !== project.instructions) {
      try {
        log("instructions_write_started", {
          projectId: shortId(project.id),
          instructionsLength: instructions.length,
        });
        await ui.writeInstructions(project.id, instructions);
        log("instructions_write_completed", { projectId: shortId(project.id) });
      } catch (error) {
        log("instructions_write_failed", {
          projectId: shortId(project.id),
          error: errorMessage(error),
        });
        throw new ImageFactoryError("image_project_instructions_failed", error instanceof Error ? error.message : String(error));
      }
    } else {
      log("instructions_already_current", { projectId: shortId(project.id) });
    }
    log("final_project_inspect_started", { projectId: shortId(project.id) });
    const verified = await ui.inspect(project.id);
    abortSignal?.throwIfAborted();
    log("final_project_inspect_completed", {
      projectId: shortId(project.id),
      memory: verified.memory,
      instructionsLength: verified.instructions.length,
    });
    if (verified.memory !== "project-only" || verified.instructions !== instructions) throw new ImageFactoryError("image_project_setup_unverified");
    const result: ImageFactoryProjectBinding = { accountKey, projectId: project.id, phase: "ready", instructionsVersion: IMAGE_FACTORY_INSTRUCTIONS_VERSION, instructionsHash: IMAGE_FACTORY_INSTRUCTIONS_HASH };
    store.write("project", key, result);
    log("project_ready", {
      projectId: shortId(project.id),
      durationMs: Date.now() - startedAt,
      instructionsVersion: IMAGE_FACTORY_INSTRUCTIONS_VERSION,
    });
    return result;
  });
  locks.set(lockKey, operation);
  try { return await operation; }
  finally { if (locks.get(lockKey) === operation) locks.delete(lockKey); }
}
