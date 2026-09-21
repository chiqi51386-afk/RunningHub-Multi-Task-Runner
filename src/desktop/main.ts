import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access, appendFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { RunningHubBackend } from "../core/index.js";
import { InMemorySecretStore, PlainTextSecretStore } from "../core/secretStore.js";
import type { Account, CreateJobInput, Job, WorkflowProfile, WorkflowRecord } from "../core/types.js";

interface RendererDraft {
  workflowId: string;
  profileVersion: number;
  parameterValues: Record<string, unknown>;
  mediaOverrides: Record<string, { enabled: boolean; mode: "replace" | "clear"; localPath?: string }>;
}

let backend: RunningHubBackend;
const smokeMode = process.argv.includes("--smoke");
let mainWindow: BrowserWindow | undefined;
let desktopSettingsPath = "";
let defaultOutputDir = "";
const runningHubApiKeysUrl = "https://www.runninghub.ai/zh-cn/call-api/bill-task?tab=keys&type=consumer";

interface DesktopSettings { outputDir?: string }

async function readDesktopSettings(): Promise<DesktopSettings> {
  if (!desktopSettingsPath) return {};
  try {
    const parsed = JSON.parse(await readFile(desktopSettingsPath, "utf8")) as DesktopSettings;
    return typeof parsed.outputDir === "string" && path.isAbsolute(parsed.outputDir) ? parsed : {};
  } catch { return {}; }
}

async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  await writeFile(desktopSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// Keep one desktop window per user. A second shortcut click focuses the
// existing app instead of launching another instance that competes for files.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function accountView(account: Account) {
  return { id: account.id, label: account.label, state: account.state, coins: account.coins ?? account.balance, apiType: account.apiType, enabled: account.enabled, lastCheckedAt: account.lastCheckedAt, currentJobId: account.currentJobId };
}

function workflowView(workflow: WorkflowRecord) {
  return {
    id: workflow.id, name: workflow.name, runningHubWorkflowId: workflow.runningHubWorkflowId, sourceUrl: workflow.sourceUrl,
    parameterCount: workflow.profile.parameters.length, needsReview: workflow.profile.needsReview,
    profileVersion: workflow.profileVersion, updatedAt: workflow.updatedAt,
    functionDescription: workflow.profile.functionDescription,
    usageInstructions: workflow.profile.usageInstructions,
    parameters: workflow.profile.parameters, outputs: workflow.profile.outputs,
  };
}

const progressByStatus: Record<Job["status"], number> = {
  PENDING: 5, ASSIGNED: 10, UPLOADING: 20, SUBMITTING: 35, SUBMIT_UNKNOWN: 100,
  REMOTE_QUEUED: 45, RUNNING: 65, REMOTE_SUCCESS: 85, DOWNLOAD_PENDING: 88,
  DOWNLOADING: 94, COMPLETED: 100, FAILED: 100, RETRY_WAIT: 60, CANCELLED: 100,
};

function jobView(job: Job) {
  const account = job.accountId ? backend.accounts.get(job.accountId) : undefined;
  const mediaParameters = job.profileSnapshot.parameters.filter(parameter => ["image", "video", "audio"].includes(parameter.valueType));
  const media = mediaParameters.map(parameter => {
    const replacement = job.media.find(item => item.parameterId === parameter.id);
    const cleared = job.parameters[parameter.id] === "";
    return {
      parameterId: parameter.id,
      key: parameter.key,
      label: parameter.nodeTitle ?? parameter.fieldName,
      type: parameter.valueType as "image" | "video" | "audio",
      mode: replacement ? "replace" as const : cleared ? "clear" as const : "default" as const,
      fileName: replacement ? path.basename(replacement.localPath) : undefined,
      localPath: replacement?.localPath,
      previewUrl: replacement ? pathToFileURL(replacement.localPath).toString() : undefined,
    };
  });
  return {
    id: job.id, workflowName: job.workflowName, status: job.status, accountLabel: account?.label,
    remoteTaskId: job.remoteTaskId, createdAt: job.createdAt, startedAt: job.assignedAt, completedAt: job.completedAt,
    generationStartedAt: job.submitStartedAt ?? job.assignedAt,
    generationCompletedAt: job.remoteCompletedAt ?? (job.status === "COMPLETED" ? job.completedAt : undefined),
    progress: progressByStatus[job.status],
    outputType: job.outputs?.files[0]?.type,
    error: job.lastError?.message,
    inputs: {
      workflowId: job.workflowId,
      profileVersion: job.profileVersion,
      parameters: job.profileSnapshot.parameters
        .filter(parameter => parameter.visible !== false && !["image", "video", "audio"].includes(parameter.valueType))
        .map(parameter => ({
          id: parameter.id, key: parameter.key,
          label: parameter.nodeTitle ?? parameter.fieldName,
          semanticType: parameter.semanticType,
          value: job.parameters[parameter.id],
        })),
      media,
    },
    outputs: job.outputs?.files.map((file, index) => ({
      ...file,
      previewUrl: file.localPath ? pathToFileURL(file.localPath).toString() : file.url,
      label: file.label ?? job.profileSnapshot.outputs.find(output => output.nodeId === file.nodeId)?.label ?? job.profileSnapshot.outputs[index]?.label,
      stage: job.profileSnapshot.outputs.find(output => output.nodeId === file.nodeId)?.stage ?? job.profileSnapshot.outputs[index]?.stage,
    })),
  };
}

async function seedBundledWorkflows(): Promise<void> {
  if (backend.workflows.list().length > 0) return;
  const files = [
    "minimax-h3-multi-reference.rhworkflow.json",
    "minimax-h3-chinese-prompt.rhworkflow.json",
    "infinitetalk-digital-human.rhworkflow.json",
    "ltx-2.3-digital-human.rhworkflow.json",
  ];
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const candidates = [...new Set([app.getAppPath(), moduleRoot, process.cwd()])];
  let directory: string | undefined;
  for (const root of candidates) {
    const candidate = path.join(root, "bundled-workflows");
    if (await access(path.join(candidate, files[0]!)).then(() => true).catch(() => false)) {
      directory = candidate;
      break;
    }
  }
  if (!directory) throw new Error(`找不到内置工作流目录。已检查：${candidates.join("；")}`);
  for (const file of files) {
    const portable = JSON.parse(await readFile(path.join(directory, file), "utf8")) as unknown;
    backend.workflows.importPortablePackage(portable);
  }
}

function createJobInput(draft: RendererDraft): CreateJobInput {
  const workflow = backend.workflows.get(draft.workflowId);
  if (!workflow) throw new Error("工作流尚未导入桌面核心，请重新导入 API JSON。");
  if (workflow.profileVersion !== draft.profileVersion) throw new Error("工作流 Profile 已更新，请重新打开创建任务页面。");
  const parameters = { ...draft.parameterValues };
  const parameterIds = new Set(workflow.profile.parameters.map(parameter => parameter.id));
  for (const parameterId of Object.keys(parameters)) {
    if (!parameterIds.has(parameterId)) throw new Error(`参数 ${parameterId} 不属于当前工作流 Profile。`);
  }
  const media = [];
  for (const [parameterId, override] of Object.entries(draft.mediaOverrides)) {
    if (!parameterIds.has(parameterId)) throw new Error(`媒体参数 ${parameterId} 不属于当前工作流 Profile。`);
    if (override.mode === "replace") {
      if (!override.localPath) throw new Error(`媒体 ${parameterId} 已选择替换，但没有本地文件。`);
      media.push({ parameterId, localPath: override.localPath });
    } else if (override.mode === "clear") {
      parameters[parameterId] = "";
    }
  }
  return { workflowId: draft.workflowId, parameters, media };
}

function registerHandlers(): void {
  ipcMain.handle("accounts:list", () => backend.accounts.list().map(accountView));
  ipcMain.handle("accounts:add", (_event, input: { label: string; apiKey: string }) => accountView(backend.accounts.add(input.label, input.apiKey)));
  ipcMain.handle("accounts:updateKey", (_event, input: { id: string; apiKey: string }) => accountView(backend.accounts.updateKey(input.id, input.apiKey)));
  ipcMain.handle("accounts:refresh", async (_event, id: string) => accountView(await backend.accounts.refresh(id)));
  ipcMain.handle("accounts:refreshAll", async () => (await backend.accounts.refreshAll()).map(accountView));
  ipcMain.handle("accounts:setEnabled", (_event, id: string, enabled: boolean) => accountView(enabled ? backend.accounts.enable(id) : backend.accounts.disable(id)));
  ipcMain.handle("accounts:remove", (_event, id: string) => backend.accounts.remove(id));

  ipcMain.handle("workflows:list", () => backend.workflows.list().map(workflowView));
  ipcMain.handle("workflows:import", (_event, input: { name: string; runningHubWorkflowId: string; sourceUrl?: string; workflow: unknown }) => workflowView(backend.workflows.importApiJson(input)));
  ipcMain.handle("workflows:importPortable", (_event, input: unknown) => workflowView(backend.workflows.importPortablePackage(input)));
  ipcMain.handle("workflows:export", async (_event, id: string) => {
    const workflow = backend.workflows.get(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    const suggestedName = `${safeFilePart(workflow.name)}.rhworkflow.json`;
    const options = { title: "导出工作流配置包", defaultPath: path.join(app.getPath("downloads"), suggestedName), filters: [{ name: "RunningHub Runner 工作流", extensions: ["json"] }] };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    const portable = backend.workflows.exportPortablePackage(id, app.getVersion());
    await writeFile(result.filePath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
    return result.filePath;
  });
  ipcMain.handle("workflows:update", (_event, input: ReturnType<typeof workflowView>) => {
    const current = backend.workflows.get(input.id);
    if (!current) throw new Error(`Workflow not found: ${input.id}`);
    const profile: WorkflowProfile = {
      ...current.profile, name: input.name,
      functionDescription: input.functionDescription?.trim() || undefined,
      usageInstructions: input.usageInstructions?.trim() || undefined,
      parameters: input.parameters,
      genericParameters: input.parameters.filter(parameter => parameter.semanticType === "unknown"),
      outputs: input.outputs ?? [], needsReview: input.needsReview,
    };
    return workflowView(backend.workflows.updateProfile(input.id, profile, {
      name: input.name,
      runningHubWorkflowId: input.runningHubWorkflowId,
      sourceUrl: input.sourceUrl,
    }));
  });
  ipcMain.handle("workflows:remove", (_event, id: string) => { backend.workflows.remove(id); });

  ipcMain.handle("media:select", async (_event, type: "image" | "video" | "audio") => {
    const filters = type === "image" ? [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }]
      : type === "video" ? [{ name: "视频", extensions: ["mp4", "mov", "webm", "mkv"] }]
      : [{ name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "flac"] }];
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return { localPath: result.filePaths[0], fileName: path.basename(result.filePaths[0]), previewUrl: pathToFileURL(result.filePaths[0]).toString() };
  });
  ipcMain.handle("media:fromDroppedPath", (_event, localPath: string) => {
    if (typeof localPath !== "string" || !path.isAbsolute(localPath)) throw new Error("拖入文件路径无效。");
    return { localPath, fileName: path.basename(localPath), previewUrl: pathToFileURL(localPath).toString() };
  });

  ipcMain.handle("jobs:list", () => backend.jobs.list().map(jobView));
  ipcMain.handle("jobs:create", (_event, draft: RendererDraft) => jobView(backend.jobs.create(createJobInput(draft))));
  ipcMain.handle("jobs:createBatch", (_event, drafts: RendererDraft[]) => {
    if (!Array.isArray(drafts) || drafts.length === 0) throw new Error("批次中没有任务。");
    if (drafts.length > 500) throw new Error("单次最多提交 500 个任务。");
    const inputs = drafts.map(createJobInput);
    return inputs.map(input => jobView(backend.jobs.create(input)));
  });
  ipcMain.handle("jobs:cancel", async (_event, id: string) => jobView(await backend.scheduler.cancel(id)));
  ipcMain.handle("jobs:remove", (_event, id: string) => backend.jobs.remove(id));
  ipcMain.handle("downloads:directory", () => backend.config.outputDir);
  ipcMain.handle("downloads:openDirectory", async () => {
    await mkdir(backend.config.outputDir, { recursive: true });
    const error = await shell.openPath(backend.config.outputDir);
    if (error) throw new Error(`无法打开下载目录：${error}`);
  });
  ipcMain.handle("downloads:selectDirectory", async () => {
    const options = {
      title: "选择下载目录",
      defaultPath: backend.config.outputDir,
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return undefined;
    const resolved = path.resolve(selected);
    await mkdir(resolved, { recursive: true });
    backend.config.outputDir = resolved;
    await saveDesktopSettings({ outputDir: resolved });
    return resolved;
  });
  ipcMain.handle("downloads:resetDirectory", async () => {
    await mkdir(defaultOutputDir, { recursive: true });
    backend.config.outputDir = defaultOutputDir;
    await saveDesktopSettings({ outputDir: defaultOutputDir });
    return defaultOutputDir;
  });
  ipcMain.handle("downloads:reveal", async (_event, localPath: string) => {
    if (typeof localPath !== "string" || !path.isAbsolute(localPath)) throw new Error("保存的文件路径无效，无法定位文件。");
    const resolved = await realpath(localPath).catch(() => { throw new Error(`文件已经移动或删除：${localPath}`); });
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`该路径不是文件：${resolved}`);
    shell.showItemInFolder(resolved);
    return resolved;
  });
  ipcMain.handle("scheduler:start", async () => { await backend.start(); });
  ipcMain.handle("scheduler:stop", async () => { await backend.stop(); });
  ipcMain.handle("external:openApiKeys", async () => { await shell.openExternal(runningHubApiKeysUrl); });
}

function safeFilePart(value: string): string {
  const clean = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  return clean || "workflow";
}

async function createWindow(): Promise<BrowserWindow> {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const applicationRoot = await access(path.join(app.getAppPath(), "frontend", "dist", "index.html"))
    .then(() => app.getAppPath()).catch(() => moduleRoot);
  const preload = path.resolve(applicationRoot, "desktop", "preload.cjs");
  const window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 680,
    backgroundColor: "#080c12", show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(path.resolve(applicationRoot, "frontend", "dist", "index.html"));
  if (!smokeMode) window.once("ready-to-show", () => window.show());
  return window;
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  defaultOutputDir = path.join(userData, "downloads");
  desktopSettingsPath = path.join(userData, "settings.json");
  const desktopSettings = await readDesktopSettings();
  const outputDir = desktopSettings.outputDir ?? defaultOutputDir;
  await mkdir(outputDir, { recursive: true });
  const secretStore = smokeMode ? new InMemorySecretStore() : new PlainTextSecretStore();
  backend = new RunningHubBackend({
    databasePath: smokeMode ? ":memory:" : path.join(userData, "runninghub.sqlite"),
    secretStore,
    config: { apiHost: "https://www.runninghub.ai", outputDir },
  });
  await seedBundledWorkflows();
  registerHandlers();
  const window = await createWindow();
  mainWindow = window;
  // Never hold the window behind network-bound account checks or job recovery.
  // The bridge is already registered, so the UI can render while startup work proceeds.
  await backend.start();
  if (smokeMode) {
    const connected = await window.webContents.executeJavaScript(`(async () => {
      if (!window.runningHub?.jobs?.createBatch || !window.runningHub?.media || !window.runningHub?.downloads?.selectDirectory || !window.runningHub?.downloads?.resetDirectory) return false;
      const [accounts, workflows, jobs] = await Promise.all([
        window.runningHub.accounts.list(), window.runningHub.workflows.list(), window.runningHub.jobs.list()
      ]);
      return Array.isArray(accounts) && Array.isArray(workflows) && Array.isArray(jobs);
    })()`);
    console.log(connected ? "DESKTOP_BRIDGE_SMOKE_PASS" : "DESKTOP_BRIDGE_SMOKE_FAIL");
    await backend.close();
    backend = undefined as never;
    app.exit(connected ? 0 : 1);
  }
}).catch(async error => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  const logPath = path.join(app.getPath("userData"), "runninghub-startup-error.log");
  await appendFile(logPath, `[${new Date().toISOString()}]\n${message}\n\n`, "utf8").catch(() => undefined);
  dialog.showErrorBox("RunningHub Runner 启动失败", `程序启动时发生错误。\n\n${message}\n\n错误日志：${logPath}`);
  if (backend) await backend.close().catch(() => undefined);
  backend = undefined as never;
  app.exit(1);
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", event => {
  if (!backend) return;
  event.preventDefault();
  void backend.close().finally(() => { backend = undefined as never; app.exit(0); });
});
