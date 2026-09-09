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
  create(onCreated: (id: string) => void): Promise<ImageFactoryProject>;
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

export async function ensureImageFactoryProject(store: ImageFactoryStore, ui: ImageFactoryProjectUi): Promise<ImageFactoryProjectBinding> {
  const accountKey = await ui.accountKey();
  if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new ImageFactoryError("image_account_unverified");
  const lockKey = `${store.directory}:${accountKey}`;
  const previous = locks.get(lockKey) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const key = imageKey("project", accountKey);
    const binding = store.read<ImageFactoryProjectBinding>("project", key);
    let project: ImageFactoryProject | undefined;
    if (binding) {
      if (binding.accountKey !== accountKey) throw new ImageFactoryError("image_account_mismatch");
      // An incomplete setup must be resumed, not replaced repeatedly after a transient UI error.
      try {
        project = await ui.inspect(binding.projectId);
      } catch (error) {
        if (binding.phase === "created") {
          throw new ImageFactoryError(
            "image_project_setup_failed",
            `The previously created Image Factory project ${binding.projectId} could not be reopened; retry after ChatGPT project UI access is restored (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        // The binding may point at a deleted or inaccessible project. Continue through the
        // verified-name search so a replacement can be created without touching the old chat.
        project = undefined;
      }
    }
    if (!project || project.memory !== "project-only") {
      const matches = (await ui.list()).filter(value => value.name === "Image Factory");
      const suitable: ImageFactoryProject[] = [];
      for (const match of matches) {
        try {
          const candidate = await ui.inspect(match.id);
          if (candidate.memory === "project-only") suitable.push(candidate);
        } catch {
          // An uninspectable project cannot be proven safe and is never selected.
        }
      }
      const managed = suitable.filter(value => value.instructions.includes("[BEGIN CODEX-CHATGPT-WEB IMAGE FACTORY"));
      const candidates = managed.length ? managed : suitable;
      if (candidates.length > 1) throw new ImageFactoryError("image_project_ambiguous", "Multiple eligible Image Factory projects; choose one by configuring a verified binding.");
      project = candidates[0];
      if (!project) {
        try {
          project = await ui.create(projectId => store.write("project", key, { accountKey, projectId, phase: "created" } satisfies ImageFactoryProjectBinding));
        } catch (error) {
          throw new ImageFactoryError("image_project_setup_failed", error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (project.memory !== "project-only") throw new ImageFactoryError("image_project_memory_unverified");
    const instructions = mergeImageFactoryInstructions(project.instructions);
    if (instructions !== project.instructions) {
      try {
        await ui.writeInstructions(project.id, instructions);
      } catch (error) {
        throw new ImageFactoryError("image_project_instructions_failed", error instanceof Error ? error.message : String(error));
      }
    }
    const verified = await ui.inspect(project.id);
    if (verified.memory !== "project-only" || verified.instructions !== instructions) throw new ImageFactoryError("image_project_setup_unverified");
    const result: ImageFactoryProjectBinding = { accountKey, projectId: project.id, phase: "ready", instructionsVersion: IMAGE_FACTORY_INSTRUCTIONS_VERSION, instructionsHash: IMAGE_FACTORY_INSTRUCTIONS_HASH };
    store.write("project", key, result);
    return result;
  });
  locks.set(lockKey, operation);
  try { return await operation; }
  finally { if (locks.get(lockKey) === operation) locks.delete(lockKey); }
}
