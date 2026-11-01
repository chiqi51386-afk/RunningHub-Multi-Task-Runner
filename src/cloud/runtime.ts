import path from "node:path";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { RunningHubBackend } from "../core/index.js";
import { GeminiStore } from "../core/gemini/store.js";
import { GeminiPool } from "../core/gemini/pool.js";
import { WorkflowSkillStore } from "../core/gemini/workflowSkills.js";
import { selectOptimization } from "../core/gemini/selection.js";
import { H3_OPTIMIZATION_ROUTES } from "../core/gemini/routes.js";
import { optimizeH3 } from "../core/gemini/h3Optimizer.js";
import { syncBundledWorkflows } from "../core/workflows/bundled.js";
import { resolveMediaInputs } from "../core/workflows/mediaInputs.js";
import { MV_WORKFLOW_ID, validateMvInput } from "../core/workflows/mvValidation.js";
import type { CreateJobInput, WorkflowRecord } from "../core/types.js";
import { CloudSecrets, privateFile } from "./secrets.js";

export async function cloudRuntime(directory: string, bundleDirectory: string) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(["uploads", "downloads", "tts"].map(name => mkdir(path.join(root, name), { recursive: true, mode: 0o700 })));
  const secrets = new CloudSecrets(await privateFile(path.join(root, "secrets.key"), 32));
  const backend = new RunningHubBackend({ databasePath: path.join(root, "runninghub.sqlite"), secretStore: secrets,
    config: { outputDir: path.join(root, "downloads"),
      apiHost: "https://www.runninghub.ai" } });
  const gemini = new GeminiPool(new GeminiStore(backend.database.raw, secrets));
  const skills = new WorkflowSkillStore(backend.database.raw);
  const names = ["minimax-h3-sharp.rhworkflow.json", "h3-digital-human-mv.rhworkflow.json", "infinitetalk-digital-human.rhworkflow.json", "h3-first-last.rhworkflow.json"];
  syncBundledWorkflows(backend.database, await Promise.all(names.map(async key => ({ key, value: JSON.parse(await readFile(path.join(bundleDirectory, key), "utf8")) }))));
  backend.database.raw.exec("CREATE TABLE IF NOT EXISTS cloud_requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, jobs TEXT NOT NULL)");

  async function mediaPath(file: string): Promise<string> {
    if (typeof file !== "string") throw new Error("Media path required");
    const actual = await realpath(path.resolve(root, file));
    const roots = await Promise.all(["uploads", "tts"].map(name => realpath(path.join(root, name))));
    if (!roots.some(dir => actual.startsWith(dir + path.sep)) || !(await stat(actual)).isFile()) throw new Error("Place media under uploads/ or use generated tts/ audio");
    return actual;
  }
  async function readMedia(file: string, type: "image" | "audio", signal: AbortSignal) {
    const actual = await mediaPath(file), info = await stat(actual);
    if (info.size > (type === "image" ? 20 : 13) * 1024 * 1024) throw new Error("Optimization media is too large");
    const types: Record<string, string> = type === "image" ? { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }
      : { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4" };
    const mimeType = types[path.extname(actual).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported optimization media format");
    return { mimeType, data: (await readFile(actual, { signal })).toString("base64") };
  }
  backend.scheduler.optimizePrompt = async (job, signal) => {
    const optimization = job.profileSnapshot.promptOptimization;
    if (!optimization) throw new Error("Missing optimization configuration");
    const workflow: WorkflowRecord = { id: job.workflowId, name: job.workflowName, runningHubWorkflowId: job.runningHubWorkflowId,
      raw: optimization.raw, profile: job.profileSnapshot, profileVersion: job.profileVersion, workflowHash: "snapshot", createdAt: job.createdAt, updatedAt: job.createdAt };
    return optimizeH3(workflow, { workflowId: job.workflowId, parameters: job.parameters, media: job.media }, gemini,
      async file => { const image = await readMedia(file, "image", signal); return { ...image, mimeType: image.mimeType as "image/jpeg" | "image/png" | "image/webp" }; },
      signal, optimization.model, async state => {
        signal.throwIfAborted();
        const current = backend.jobs.get(job.id);
        if (current?.status !== "OPTIMIZING") throw new Error("Task stopped");
        backend.database.updateJob(job.id, { profileSnapshot: { ...current.profileSnapshot, promptOptimization: structuredClone(state) } });
      }, file => readMedia(file, "audio", signal));
  };

  async function prepare(input: CreateJobInput & { optimize?: boolean }): Promise<CreateJobInput> {
    const workflow = backend.workflows.get(input.workflowId);
    if (!workflow) throw new Error("Unknown workflow");
    if (input.optimize !== undefined && typeof input.optimize !== "boolean") throw new Error("optimize must be boolean");
    const parameters: Record<string, unknown> = Object.fromEntries(workflow.profile.parameters.map(p => [p.id, p.defaultValue]));
    const ids = new Set(workflow.profile.parameters.map(p => p.id));
    for (const [id, value] of Object.entries(input.parameters ?? {})) {
      if (!ids.has(id)) throw new Error("Unknown parameter: " + id);
      parameters[id] = value;
    }
    for (const p of workflow.profile.parameters) if (p.visible === false && !["image", "audio", "video"].includes(p.valueType)) parameters[p.id] = p.defaultValue;
    const supplied = await Promise.all((input.media ?? []).map(async m => ({ parameterId: m.parameterId, localPath: await mediaPath(m.localPath) })));
    if (new Set(supplied.map(m => m.parameterId)).size !== supplied.length) throw new Error("Duplicate media slot");
    const resolved = resolveMediaInputs(workflow.profile, parameters, Object.fromEntries(supplied.map(m => [m.parameterId, { mode: "replace" as const, localPath: m.localPath }])));
    Object.assign(parameters, resolved.parameters);
    const media = resolved.media;
    if (workflow.runningHubWorkflowId === MV_WORKFLOW_ID) validateMvInput(workflow.profile, parameters, media);
    const settings = gemini.store.settings();
    // Distribution default (owner's rule): prompt optimization is ON by default
    // for workflows that have an optimization route. Workflows without a route
    // (e.g. InfiniTalk) are unaffected; an explicit optimize:false still wins.
    const selection = selectOptimization(workflow, parameters,
      input.optimize ?? (H3_OPTIMIZATION_ROUTES[workflow.runningHubWorkflowId] !== undefined),
      settings.optimizationEnabled, settings.model);
    const prompt = workflow.profile.parameters.find(p => p.semanticType === "prompt" && p.visible !== false);
    return { workflowId: input.workflowId, taskName: input.taskName, production: input.production, namingRule: input.namingRule,
      parameters, media, instanceType: input.instanceType, outputDir: backend.config.outputDir,
      promptOptimization: selection ? { ...selection, originalText: String(prompt ? parameters[prompt.id] ?? "" : ""),
        skill: skills.snapshot(workflow.runningHubWorkflowId, workflow.runningHubWorkflowId !== "2106994828660080641" && media.length > 0) } : undefined };
  }
  return { root, backend, gemini, skills, prepare, mediaPath };
}
export type CloudRuntime = Awaited<ReturnType<typeof cloudRuntime>>;
