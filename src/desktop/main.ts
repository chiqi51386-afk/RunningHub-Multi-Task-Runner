import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { focusExistingWindow } from "./windowLifecycle.js";
import { createHash } from "node:crypto";
import { resolveMediaInputs } from "../core/workflows/mediaInputs.js";
import { MV_WORKFLOW_ID, validateMvInput } from "../core/workflows/mvValidation.js";
import { syncBundledWorkflows } from "../core/workflows/bundled.js";
import { namingRule, shortOutputPath, type NamingRule } from "../core/downloads/naming.js";
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access, appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RunningHubBackend } from "../core/index.js";
import { InMemorySecretStore, PlainTextSecretStore } from "../core/secretStore.js";
import type { Account, CreateJobInput, InstanceType, Job, WorkflowProfile, WorkflowRecord } from "../core/types.js";
import { latestReleaseApiUrls, latestReleaseUrl, parseLatestRelease, trustedUpdateAssetPrefixes, updateRepositoryUrl } from "./updates.js";
import type { UpdateInfo, UpdateProgress } from "./updates.js";

interface RendererDraft {
  production?: { groupId: string; segmentIndex: number };
  workflowId: string;
  profileVersion: number;
  instanceType?: InstanceType;
  parameterValues: Record<string, unknown>;
  mediaOverrides: Record<string, { enabled: boolean; mode: "replace" | "clear"; localPath?: string }>;
}

let backend: RunningHubBackend;
const smokeMode = process.argv.includes("--smoke");
if (smokeMode) app.setPath("userData", mkdtempSync(path.join(app.getPath("temp"), "rh-desktop-smoke-")));
else app.setPath("userData", path.join(app.getPath("appData"), "runninghub-multi-task-runner-core"));
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let desktopSettingsPath = "";
let defaultOutputDir = "";
let thumbnailCacheDir = "";
let updateInProgress = false;
let applicationVersion = app.getVersion();
let thumbnailQueue: Promise<void> = Promise.resolve();
const thumbnailRequests = new Map<string, Promise<string | undefined>>();
const runningHubApiKeysUrl = "https://www.runninghub.ai/zh-cn/call-api/bill-task?tab=keys&type=consumer";

async function resolveApplicationVersion(): Promise<string> {
  if (app.isPackaged) return app.getVersion();
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "package.json"),
    path.join(app.getAppPath(), "package.json"),
    path.resolve(moduleDirectory, "..", "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.version)) return parsed.version;
    } catch {}
  }
  return app.getVersion();
}

async function checkForUpdate() {
  let lastError = "GitHub 更新服务暂不可用。";
  for (const apiUrl of latestReleaseApiUrls) {
    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `RunningHub-Runner/${applicationVersion}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return parseLatestRelease(await response.json(), applicationVersion);
      lastError = `GitHub 返回 HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`检查更新失败：${lastError}`);
}

function sendUpdateProgress(progress: UpdateProgress): void {
  if (!quitting && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("updates:progress", progress);
}

function registerRendererEvents(): void {
  backend.events.on("account.updated", account => {
    if (!quitting && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("accounts:updated", accountView(account));
  });
  backend.events.on("job.updated", job => {
    if (!quitting && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("jobs:updated", jobView(job));
  });
}

function runPowerShell(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { errorOutput = `${errorOutput}${String(chunk)}`.slice(-4000); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(errorOutput.trim() || `PowerShell 执行失败（退出码 ${code ?? "未知"}）。`)));
  });
}

function validateUpdateAsset(info: UpdateInfo): asserts info is UpdateInfo & Required<Pick<UpdateInfo, "assetName" | "assetUrl" | "assetDigest">> {
  if (!info.updateAvailable) throw new Error("当前已经是最新版本。");
  if (!info.assetName || !info.assetUrl) throw new Error("最新版本缺少 Windows x64 更新包，请稍后重试或打开项目主页。");
  if (!/^sha256:[a-f\d]{64}$/i.test(info.assetDigest ?? "")) throw new Error("更新包缺少 GitHub SHA-256 摘要，为安全起见已停止自动更新。");
  const assetUrl = new URL(info.assetUrl);
  if (assetUrl.protocol !== "https:" || assetUrl.hostname !== "github.com" ||
    !trustedUpdateAssetPrefixes.some(prefix => assetUrl.pathname.startsWith(prefix))) {
    throw new Error("更新包地址不是本项目的 GitHub Release，已停止自动更新。");
  }
}

async function downloadAndInstallUpdate(): Promise<{ started: true }> {
  if (updateInProgress) throw new Error("更新正在进行，请勿重复操作。");
  if (process.platform !== "win32" || !app.isPackaged) throw new Error("自动更新仅支持已打包的 Windows 应用。");
  updateInProgress = true;
  try {
    const info = await checkForUpdate();
    validateUpdateAsset(info);
    const updateRoot = path.join(app.getPath("userData"), "updates", `v${info.latestVersion}`);
    const stagingDir = path.join(updateRoot, "staging");
    const partialArchive = path.join(updateRoot, `${info.assetName}.part`);
    const archivePath = path.join(updateRoot, info.assetName);
    await rm(updateRoot, { recursive: true, force: true });
    await mkdir(updateRoot, { recursive: true });

    sendUpdateProgress({ stage: "downloading", percent: 0, message: `正在下载 v${info.latestVersion}…` });
    const response = await fetch(info.assetUrl, {
      headers: { Accept: "application/octet-stream", "User-Agent": `RunningHub-Runner/${applicationVersion}` },
      redirect: "follow",
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`下载更新失败：GitHub 返回 HTTP ${response.status}`);
    const expectedBytes = info.assetSize ?? (Number(response.headers.get("content-length")) || 0);
    let receivedBytes = 0;
    const hash = createHash("sha256");
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        hash.update(chunk);
        const percent = expectedBytes > 0 ? Math.min(99, Math.round(receivedBytes / expectedBytes * 100)) : 0;
        sendUpdateProgress({ stage: "downloading", percent, message: expectedBytes > 0 ? `正在下载 v${info.latestVersion}：${percent}%` : `正在下载 v${info.latestVersion}…` });
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), progress, createWriteStream(partialArchive));

    sendUpdateProgress({ stage: "verifying", percent: 100, message: "正在校验更新包…" });
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest.toLowerCase() !== info.assetDigest.toLowerCase()) {
      await rm(partialArchive, { force: true });
      throw new Error("更新包 SHA-256 校验失败，文件可能不完整，已停止更新。");
    }
    if (info.assetSize && receivedBytes !== info.assetSize) {
      await rm(partialArchive, { force: true });
      throw new Error(`更新包大小校验失败：应为 ${info.assetSize} 字节，实际为 ${receivedBytes} 字节。`);
    }
    await rename(partialArchive, archivePath);

    sendUpdateProgress({ stage: "extracting", percent: 100, message: "正在解压并准备更新…" });
    await mkdir(stagingDir, { recursive: true });
    const extractorPath = path.join(updateRoot, "extract-update.ps1");
    await writeFile(extractorPath, String.raw`param(
  [Parameter(Mandatory=$true)][string]$ArchivePath,
  [Parameter(Mandatory=$true)][string]$DestinationPath
)
$ErrorActionPreference = "Stop"
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force
`, "utf8");
    try {
      await runPowerShell(["-File", extractorPath, "-ArchivePath", archivePath, "-DestinationPath", stagingDir]);
    } finally {
      await rm(extractorPath, { force: true });
    }
    const executableName = path.basename(process.execPath);
    await access(path.join(stagingDir, executableName)).catch(() => { throw new Error("更新包结构无效：找不到应用程序文件。"); });

    const updaterPath = path.join(updateRoot, "apply-update.ps1");
    const installDir = path.dirname(process.execPath);
    const updaterScript = String.raw`param(
  [Parameter(Mandatory=$true)][int]$ParentProcessId,
  [Parameter(Mandatory=$true)][string]$SourceDir,
  [Parameter(Mandatory=$true)][string]$TargetDir,
  [Parameter(Mandatory=$true)][string]$ExecutablePath,
  [Parameter(Mandatory=$true)][string]$ArchivePath
)
$ErrorActionPreference = "Stop"
Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
& robocopy.exe $SourceDir $TargetDir /E /COPY:DAT /DCOPY:DAT /R:5 /W:1 /NFL /NDL /NJH /NJS /NP
$copyExitCode = $LASTEXITCODE
if ($copyExitCode -gt 7) { throw "更新文件替换失败，Robocopy 退出码：$copyExitCode" }
Remove-Item -LiteralPath $SourceDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $ExecutablePath -WorkingDirectory $TargetDir
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`;
    await writeFile(updaterPath, updaterScript, "utf8");
    const updater = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", updaterPath,
      "-ParentProcessId", String(process.pid), "-SourceDir", stagingDir, "-TargetDir", installDir,
      "-ExecutablePath", process.execPath, "-ArchivePath", archivePath,
    ], { detached: true, windowsHide: true, stdio: "ignore" });
    updater.unref();
    sendUpdateProgress({ stage: "restarting", percent: 100, message: "更新已准备完成，正在重启…" });
    setTimeout(() => app.quit(), 300);
    return { started: true };
  } catch (error) {
    updateInProgress = false;
    throw error;
  }
}

interface DesktopSettings { outputDir?: string; namingRule?: NamingRule }

async function readDesktopSettings(): Promise<DesktopSettings> {
  if (!desktopSettingsPath) return {};
  try {
    const parsed = JSON.parse(await readFile(desktopSettingsPath, "utf8")) as DesktopSettings;
    return { outputDir: typeof parsed.outputDir === "string" && path.isAbsolute(parsed.outputDir) ? parsed.outputDir : undefined, namingRule: namingRule(parsed.namingRule) };
  } catch { return {}; }
}

async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  await writeFile(desktopSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function videoThumbnail(localPath: string): Promise<string | undefined> {
  const existing = thumbnailRequests.get(localPath);
  if (existing) return existing;
  const request = thumbnailQueue.then(async () => {
    if (!path.isAbsolute(localPath)) return undefined;
    const resolved = await realpath(localPath).catch(() => undefined);
    if (!resolved) return undefined;
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    const fingerprint = createHash("sha256")
      .update(`${resolved}\0${info.size}\0${info.mtimeMs}`)
      .digest("hex");
    await mkdir(thumbnailCacheDir, { recursive: true });
    const cached = path.join(thumbnailCacheDir, `${fingerprint}.png`);
    if (await access(cached).then(() => true).catch(() => false)) return pathToFileURL(cached).toString();
    const thumbnail = await nativeImage.createThumbnailFromPath(resolved, { width: 180, height: 320 });
    if (thumbnail.isEmpty()) return undefined;
    await writeFile(cached, thumbnail.toPNG());
    return pathToFileURL(cached).toString();
  }).catch(() => undefined);
  thumbnailQueue = request.then(() => undefined, () => undefined);
  const tracked = request.finally(() => thumbnailRequests.delete(localPath));
  thumbnailRequests.set(localPath, tracked);
  return tracked;
}

// Keep one desktop window per user. A second shortcut click focuses the
// existing app instead of launching another instance that competes for files.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function accountView(account: Account) {
  return { id: account.id, label: account.label, state: account.state, coins: account.coins ?? account.balance, apiType: account.apiType, enabled: account.enabled, lastCheckedAt: account.lastCheckedAt, currentJobId: account.currentJobId, remoteTaskCount: account.lastRemoteTaskCount };
}

function workflowView(workflow: WorkflowRecord) {
  return {
    builtIn: backend.workflows.isBundled(workflow.id),
    id: workflow.id, name: workflow.name, runningHubWorkflowId: workflow.runningHubWorkflowId, sourceUrl: workflow.sourceUrl,
    parameterCount: workflow.profile.parameters.length, needsReview: workflow.profile.needsReview,
    profileVersion: workflow.profileVersion, updatedAt: workflow.updatedAt,
    functionDescription: workflow.profile.functionDescription,
    usageInstructions: workflow.profile.usageInstructions,
    parameters: workflow.profile.parameters, outputs: workflow.profile.outputs,
  };
}

const stageByStatus: Record<Job["status"], string> = {
  PENDING: "等待调度", ASSIGNED: "已分配账号", UPLOADING: "上传媒体", SUBMITTING: "提交任务",
  SUBMIT_UNKNOWN: "提交状态未知", REMOTE_QUEUED: "远端排队", RUNNING: "生成中", REMOTE_SUCCESS: "远端已完成",
  DOWNLOAD_PENDING: "等待下载", DOWNLOADING: "下载中", COMPLETED: "已完成", FAILED: "失败",
  RETRY_WAIT: "等待重试", CANCELLED: "已取消",
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
    submission: job.submission,
    instanceType: job.instanceType,
    remoteTaskId: job.remoteTaskId, createdAt: job.createdAt, startedAt: job.assignedAt, completedAt: job.completedAt,
    generationStartedAt: job.generationStartedAt,
    generationCompletedAt: job.remoteCompletedAt ?? (job.status === "COMPLETED" ? job.completedAt : undefined),
    stageLabel: stageByStatus[job.status],
    retryPhase: job.retryPhase,
    outputType: job.outputs?.files[0]?.type,
    error: job.lastError?.message,
    errorDetail: job.lastError ? {
      code: job.lastError.code, message: job.lastError.message, phase: job.lastError.phase,
      remoteCode: job.lastError.remoteCode, retryable: job.lastError.retryable,
      nodeId: job.lastError.nodeId, nodeName: job.lastError.nodeName,
    } : undefined,
    texts: job.outputs?.texts,
    inputs: {
      production: job.profileSnapshot.production,
      workflowId: job.workflowId,
      profileVersion: job.profileVersion,
      instanceType: job.instanceType,
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
  const files = [
    "minimax-h3-multi-reference.rhworkflow.json",
    "minimax-h3-selflift.rhworkflow.json",
    "h3-digital-human-mv.rhworkflow.json",
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
  const bundles = await Promise.all(files.map(async file => ({ key: file,
    value: JSON.parse(await readFile(path.join(directory!, file), "utf8")) as unknown,
  })));
  syncBundledWorkflows(backend.database, bundles);
}

function createJobInput(draft: RendererDraft, outputDir: string): CreateJobInput {
  const workflow = backend.workflows.get(draft.workflowId);
  if (!workflow) throw new Error("工作流尚未导入桌面核心，请重新导入 API JSON。");
  if (workflow.profileVersion !== draft.profileVersion) throw new Error("工作流 Profile 已更新，请重新打开创建任务页面。");
  const parameters = { ...draft.parameterValues };
  const mappingIssue = workflow.profile.parameters.find(parameter => parameter.visible !== false && parameter.mappingIssue);
  if (mappingIssue) throw new Error(mappingIssue.mappingIssue);
  const parameterIds = new Set(workflow.profile.parameters.map(parameter => parameter.id));
  for (const parameterId of Object.keys(parameters)) {
    if (!parameterIds.has(parameterId)) throw new Error(`参数 ${parameterId} 不属于当前工作流 Profile。`);
  }
  // Old renderer drafts may contain values copied from a different workflow.
  // Hidden internal widgets belong to this profile, not to the shared form.
  for (const parameter of workflow.profile.parameters) {
    if (parameter.visible === false && !["image", "audio", "video"].includes(parameter.valueType)) {
      parameters[parameter.id] = parameter.defaultValue;
    }
  }
  const resolved = resolveMediaInputs(workflow.profile, parameters, draft.mediaOverrides ?? {});
  if (workflow.runningHubWorkflowId === MV_WORKFLOW_ID) validateMvInput(workflow.profile, resolved.parameters, resolved.media);
  // Freeze the selected download directory into the job snapshot. Relying
  // only on the process-wide setting makes recovered jobs vulnerable to a
  // restart or a later settings change and can silently fall back to the
  // Electron user-data downloads folder.
  return { workflowId: draft.workflowId, ...resolved, production: draft.production, instanceType: draft.instanceType === "plus" ? "plus" : "default", outputDir };
}

async function currentOutputDir(): Promise<string> {
  // The settings file is the durable source of truth. Re-read it when jobs
  // are created so a stale process value can never route new output back to
  // Electron's private user-data directory.
  const settings = await readDesktopSettings();
  const outputDir = settings.outputDir ?? defaultOutputDir;
  await mkdir(outputDir, { recursive: true });
  backend.config.outputDir = outputDir;
  return outputDir;
}

function registerHandlers(): void {
  const namingPreview = (rule: NamingRule) => ({ rule, preview: shortOutputPath({ rule, identity:{task:1,date:new Date().toISOString().slice(0,10).replaceAll('-','')},workflow: "H3多参考", index: 0,total:1, url: "https://example.invalid/video.mp4", extension: "mp4" }) });
  ipcMain.handle("downloads:naming", async () => namingPreview(namingRule((await readDesktopSettings()).namingRule)));
  ipcMain.handle("downloads:setNaming", async (_event, value: unknown) => {
    if (!["workflow-date", "date", "original"].includes(String(value))) throw new Error("未知命名规则");
    const rule = namingRule(value);
    await saveDesktopSettings({ ...(await readDesktopSettings()), namingRule: rule });
    return namingPreview(rule);
  });
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
    const portable = backend.workflows.exportPortablePackage(id, applicationVersion);
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
  ipcMain.handle("media:thumbnail", (_event, localPath: string) => videoThumbnail(localPath));

  ipcMain.handle("jobs:list", () => backend.jobs.list().map(jobView));
  ipcMain.handle("jobs:create", async (_event, draft: RendererDraft) => {
    const outputDir = await currentOutputDir();
    return jobView(backend.jobs.create({ ...createJobInput(draft, outputDir), namingRule: namingRule((await readDesktopSettings()).namingRule) }));
  });
  ipcMain.handle("jobs:createBatch", async (_event, drafts: RendererDraft[], context?: { source: string; requestId: string; expectedCount: number }) => {
    if (!Array.isArray(drafts) || drafts.length === 0) throw new Error("批次中没有任务。");
    if (drafts.length > 500) throw new Error("单次最多提交 500 个任务。");
    if (context && (context.expectedCount !== drafts.length || !["single", "batch"].includes(context.source)
      || (context.source === "single" && drafts.length !== 1))) throw new Error("提交来源或任务数量不一致，尚未创建任务。");
    // Only operational metadata: never record API keys, prompts or media paths.
    const audit = async (stage: string, jobIds: string[] = []) => {
      try { await appendFile(path.join(app.getPath("userData"), "submission-audit.jsonl"), JSON.stringify({
        time: new Date().toISOString(), stage, source: context?.source ?? "legacy",
        requestId: typeof context?.requestId === "string" ? context.requestId.slice(0, 64) : undefined,
        requestedCount: drafts.length, createdCount: jobIds.length, jobIds,
      }) + "\n"); } catch { console.error("Submission audit write failed"); }
    };
    await audit("received");
    try {
    const outputDir = await currentOutputDir();
    const inputs = drafts.map(draft => createJobInput(draft, outputDir));
    const rule = namingRule((await readDesktopSettings()).namingRule);
    const created = backend.jobs.createBatch(inputs.map(input => ({ ...input, namingRule: rule })));
    await audit("committed", created.map(job => job.id));
    return created.map(jobView);
    } catch (error) { await audit("failed"); throw error; }
  });
  ipcMain.handle("jobs:cancel", async (_event, id: string) => jobView(await backend.scheduler.cancel(id)));
  ipcMain.handle("jobs:retry-download", async (_event, id: string) => jobView(backend.downloads.retryNow(id)));
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
    await saveDesktopSettings({ ...(await readDesktopSettings()), outputDir: resolved });
    return resolved;
  });
  ipcMain.handle("downloads:resetDirectory", async () => {
    await mkdir(defaultOutputDir, { recursive: true });
    backend.config.outputDir = defaultOutputDir;
    await saveDesktopSettings({ ...(await readDesktopSettings()), outputDir: defaultOutputDir });
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
  ipcMain.handle("scheduler:status", () => backend.scheduler.isRunning());
  ipcMain.handle("scheduler:start", async () => { await backend.start(); });
  ipcMain.handle("scheduler:stop", async () => { await backend.stop(); });
  ipcMain.handle("external:openApiKeys", async () => { await shell.openExternal(runningHubApiKeysUrl); });
  ipcMain.handle("updates:check", () => checkForUpdate());
  ipcMain.handle("updates:downloadAndInstall", () => downloadAndInstallUpdate());
  ipcMain.handle("updates:openRepository", async () => { await shell.openExternal(updateRepositoryUrl); });
  ipcMain.handle("updates:openLatestRelease", async () => { await shell.openExternal(latestReleaseUrl); });
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
  // `ready-to-show` can fire before loadFile() resolves. Registering its
  // listener afterwards races with Chromium and leaves a healthy process with
  // a permanently hidden window. At this point the document is loaded, so
  // showing directly is deterministic and keeps startup independent of
  // network-bound backend recovery.
  if (!smokeMode) window.show();
  return window;
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  applicationVersion = await resolveApplicationVersion();
  const userData = app.getPath("userData");
  defaultOutputDir = path.join(userData, "downloads");
  thumbnailCacheDir = path.join(userData, "thumbnail-cache");
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
  window.once("closed", () => { if (mainWindow === window) mainWindow = undefined; });
  registerRendererEvents();
  // Never hold the window behind network-bound account checks or job recovery.
  // The bridge is already registered, so the UI can render while startup work proceeds.
  await backend.start();
  if (smokeMode) {
    window.webContents.setBackgroundThrottling(false);
    const connected = await window.webContents.executeJavaScript(`(async () => {
      if (!window.runningHub?.jobs?.createBatch || !window.runningHub?.media?.thumbnail || !window.runningHub?.downloads?.selectDirectory || !window.runningHub?.downloads?.resetDirectory || !window.runningHub?.updates?.check || !window.runningHub?.updates?.downloadAndInstall) return false;
      const [accounts, workflows, jobs] = await Promise.all([
        window.runningHub.accounts.list(), window.runningHub.workflows.list(), window.runningHub.jobs.list()
      ]);
      return Array.isArray(accounts) && Array.isArray(workflows) && Array.isArray(jobs);
    })()`);
    console.log(connected ? "DESKTOP_BRIDGE_SMOKE_PASS" : "DESKTOP_BRIDGE_SMOKE_FAIL");
    const overviewScroll = await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 30 && !document.querySelector('.overview-scroll'); i++) await new Promise(resolve => setTimeout(resolve, 100));
      const lists = [...document.querySelectorAll('.overview-scroll')];
      if (lists.length !== 2) return false;
      const fixtures = [];
      try {
        for (const list of lists) {
          const fixture = document.createElement('div');
          fixture.style.height = '3000px';
          list.append(fixture);
          fixtures.push(fixture);
        }
        lists[0].scrollTop = 150;
        if (lists[0].scrollTop !== 150 || lists[1].scrollTop !== 0) return false;
        lists[1].scrollTop = 250;
        return lists[1].scrollTop === 250 && lists[0].scrollTop === 150;
      } finally { fixtures.forEach(element => element.remove()); }
    })()`);
    console.log(overviewScroll ? "DESKTOP_OVERVIEW_SCROLL_PASS" : "DESKTOP_OVERVIEW_SCROLL_FAIL");
    const settingsScroll = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 100));
      for (let i = 0; i < 30 && !document.querySelector('.settings-button'); i++) await wait();
      document.querySelector('.settings-button')?.click();
      await wait();
      const scroll = document.querySelector('.settings-scroll');
      if (!scroll || document.querySelectorAll('.theme-card').length !== 4) return false;
      scroll.scrollTop = scroll.scrollHeight;
      const bounds = document.querySelector('.settings-modal').getBoundingClientRect();
      return (scroll.scrollHeight <= scroll.clientHeight || scroll.scrollTop > 0) && bounds.top >= 0 && bounds.bottom <= innerHeight;
    })()`);
    console.log(settingsScroll ? "DESKTOP_SETTINGS_SCROLL_PASS" : "DESKTOP_SETTINGS_SCROLL_FAIL");
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(r => setTimeout(r, 120));
      const modal = document.querySelector('.settings-modal');
      if (modal.querySelector('select')) throw new Error('Native settings select remains');
      const buttons = modal.querySelectorAll('.app-select > button');
      if (buttons.length !== 2) throw new Error('Settings dropdowns missing');
      buttons[0].scrollIntoView({block:'center'}); await wait(); buttons[0].click(); await wait();
      const list = modal.querySelector('.app-select-options');
      if (!list || list.querySelectorAll('[role="option"]').length !== 3) throw new Error('Dropdown did not open');
      const r = list.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight + 1) throw new Error('Dropdown outside viewport');
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await wait();
      if (!document.querySelector('.settings-modal') || modal.querySelector('.app-select-options')) throw new Error('Escape incorrectly closes settings');
      buttons[1].scrollIntoView({block:'center'}); await wait(); buttons[1].click(); await wait();
      buttons[1].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await wait();
      buttons[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await wait();
      if (!buttons[1].textContent.includes('8 秒')) throw new Error('Keyboard selection failed');
    })()`);
    console.log('DESKTOP_DROPDOWN_PASS');
    const themesPassed = await window.webContents.executeJavaScript(`(async () => {
      const ids = ['light', 'dark', 'eye', 'midnight'];
      const cards = [...document.querySelectorAll('.theme-card')];
      for (let i = 0; i < cards.length; i++) {
        cards[i].click();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (document.documentElement.dataset.theme !== ids[i]) return false;
        if (cards[i].getAttribute('aria-pressed') !== 'true') return false;
        const style = getComputedStyle(document.querySelector('.settings-modal'));
        if (style.backgroundColor === style.color) return false;
      }
      return cards.length === 4;
    })()`);
    console.log(themesPassed ? "DESKTOP_THEMES_PASS" : "DESKTOP_THEMES_FAIL");
    const generationLayout = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 150));
      localStorage.setItem('rh-runner.draft.v1.h3-multi-reference', JSON.stringify({
        workflowId: 'removed-legacy-workflow', profileVersion: 19, instanceType: 'default',
        parameterValues: { prompt: 'legacy input must be backed up', resolution: 'bad-old-value' },
        mediaOverrides: { image_1: { mode: 'replace', enabled: true, localPath: 'C:/legacy/photo.png' } }
      }));
      document.querySelector('.settings-modal .modal-head button')?.click();
      [...document.querySelectorAll('.nav-list button')].find(button => button.textContent.includes('创建任务'))?.click();
      await wait();
      [...document.querySelectorAll('.create-mode-tabs button')].find(button => button.textContent.includes('H3'))?.click();
      await wait();
      for (let index = 0; index < 2; index++) {
        const workspace = document.querySelector('.create-mode-panel:not([hidden])');
        if (!workspace) return false;
        workspace.querySelector('[role="combobox"]')?.click();
        await wait();
        const options = workspace.querySelectorAll('[role="option"]');
        if (options.length !== 2) return false;
        options[index].click();
        await wait();
        const optimization = workspace.querySelector('button[aria-label="中文生成词优化"]');
        if (!optimization || optimization.getAttribute('aria-pressed') !== 'false') return false;
        const section = [...workspace.querySelectorAll('.form-section')].find(element => element.querySelector('h2')?.textContent === '生成参数');
        const labels = [...(section?.querySelectorAll('.dynamic-grid > label') ?? [])];
        const names = labels.map(element => element.textContent);
        if (names.length !== 4 || !names[0].includes('画面比例') || !names[1].includes('时长') || !names[2].includes('分辨率') || !/倍率|倍数|低分辨率阶段比例/.test(names[3])) throw new Error('H3 layout mismatch: ' + JSON.stringify(names));
        if (labels.some(label => { const input = label.querySelector('input'); return input && input.value === ''; })) throw new Error('Upgrade left generation parameters empty');
      }
      if (!Object.keys(localStorage).some(key => key.startsWith('rh-runner.draft-backup.h3-multi-reference.') && localStorage.getItem(key).includes('legacy input must be backed up'))) throw new Error('Legacy draft backup missing');
      return true;
    })()`);
    console.log(generationLayout ? "DESKTOP_H3_LAYOUT_PASS" : "DESKTOP_H3_LAYOUT_FAIL");
    const mvLayout = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 150));
      [...document.querySelectorAll('.create-mode-tabs button')].find(b => b.textContent === 'H3 数字人 MV')?.click();
      await wait();
      const root = document.querySelector('.mv-workspace');
      if (!root || root.querySelectorAll('.mv-segment').length !== 2) return false;
      if (root.querySelectorAll('.media-image').length !== 4 || root.querySelectorAll('.media-audio').length !== 1) return false;
      if (root.querySelectorAll('.mv-generation .app-select').length !== 1 || root.querySelectorAll('.mv-segment .app-select').length !== 0) return false;
      if (root.querySelectorAll('button[aria-label="MV Plus 高显存"]').length !== 1 || root.querySelectorAll('.mv-segment .switch').length) return false;
      const plus = root.querySelector('button[aria-label="MV Plus 高显存"]');
      const standardPlus = document.querySelector('.create-mode-panel[hidden] .instance-mode-control .switch');
      if (!plus.closest('.instance-mode-control') || (standardPlus && (getComputedStyle(plus).height !== getComputedStyle(standardPlus).height || getComputedStyle(plus).width !== getComputedStyle(standardPlus).width))) throw new Error('MV Plus differs from standard control');
      const stage = [...root.querySelectorAll('button')].find(b => b.textContent === '加入制作批次');
      stage.click(); await wait();
      if (!root.querySelector('[role="alert"]')?.textContent.includes('未填写生成词') || root.querySelectorAll('.batch-list article').length) return false;
      if (!root.querySelector('.batch-submit').disabled) return false;
      const segments = root.querySelectorAll('.mv-segment');
      if ([...segments].some(s => s.querySelectorAll('textarea').length !== 1)) return false;
      const prompt = segments[0].querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'MV segment one');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      await wait();
      if (segments[1].querySelector('textarea').value !== '') return false;
      const end = segments[0].querySelector('input[aria-label="第 1 段音频结束"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(end, '12.5');
      end.dispatchEvent(new Event('input', { bubbles: true }));
      await wait();
      const start = segments[0].querySelector('input[aria-label="第 1 段音频起点"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(start, '2');
      start.dispatchEvent(new Event('input', { bubbles: true }));
      await wait();
      const edited = JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1'));
      const durationId = edited[0].draft.workflowSnapshot.parameters.find(p => p.key === '85.duration').id;
      if (edited[0].draft.parameterValues[durationId] !== 10.5 || edited[1].draft.parameterValues[durationId] !== 10 || end.value !== '12.5') return false;
      const add = root.querySelector('.mv-add-segment');
      const last = [...root.querySelectorAll('.mv-segment')].at(-1);
      if (!add || !last || !(last.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      [...root.querySelectorAll('button')].find(b => b.textContent === '增加段落')?.click();
      await wait();
      if (root.querySelectorAll('.mv-segment').length !== 3) return false;
      const saved = JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1'));
      if (saved.length !== 3 || saved[0].draft.parameterValues.prompt !== 'MV segment one') return false;
      return true;
    })()`);
    console.log(mvLayout ? "DESKTOP_MV_LAYOUT_PASS" : "DESKTOP_MV_LAYOUT_FAIL");
    if (mvLayout && process.argv.includes("--preview-mv")) {
      window.setSize(1280, 1100);
      window.webContents.setZoomFactor(0.85);
      window.showInactive();
      await window.webContents.executeJavaScript(`(() => {
        const segments = document.querySelectorAll('.mv-segment');
        segments[segments.length - 1].querySelector('.icon-button')?.click();
        const textarea = segments[0].querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '');
        textarea.dispatchEvent(new Event('input', {bubbles: true}));
        document.querySelector('.mv-global')?.scrollIntoView({block:'start'});
      })()`);
      await new Promise(resolve => setTimeout(resolve, 700));
      await writeFile(path.join(app.getPath("temp"), "rh-mv-ui-top.png"), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript("document.querySelector('.mv-generation .submit-bar')?.scrollIntoView({block:'end'})");
      await new Promise(resolve => setTimeout(resolve, 400));
      await writeFile(path.join(app.getPath("temp"), "rh-mv-ui-bottom.png"), (await window.webContents.capturePage()).toPNG());
    }
    // Isolated smoke storage only: exercise migration and shared UI without a paid job.
    await window.webContents.executeJavaScript(`(() => {
      const segments = JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1'));
      const draft = structuredClone(segments[0].draft);
      const p = key => draft.workflowSnapshot.parameters.find(item => item.key === key).id;
      draft.parameterValues[p('87.value')] = 'shared batch smoke';
      draft.mediaOverrides[p('34.audio')] = { enabled: true, mode: 'replace', localPath: 'smoke-audio.wav', fileName: 'smoke-audio.wav' };
      for (const segment of segments) {
        segment.draft.parameterValues[p('87.value')] = 'repeatable segment';
        segment.draft.mediaOverrides[p('34.audio')] = {...draft.mediaOverrides[p('34.audio')]};
      }
      localStorage.setItem('rh-runner.mv-segments.v1', JSON.stringify(segments));
      localStorage.setItem('rh-runner.mv-segments.v1.shared', JSON.stringify(draft));
      localStorage.setItem('rh-runner.mv-segments.v1.batch', JSON.stringify([{id: 'smoke-mv-legacy', sourceId: segments[0].id, draft}]));
    })()`);
    await new Promise<void>(resolve => {
      window.webContents.once('did-finish-load', () => resolve());
      window.webContents.reload();
    });
    const sharedBatch = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 200));
      for (let i = 0; i < 30 && !document.querySelector('.create-mode-tabs'); i++) {
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建任务'))?.click();
        await wait();
      }
      const selectMode = async name => { [...document.querySelectorAll('.create-mode-tabs button')].find(b => b.textContent === name)?.click(); await wait(); };
      const visible = () => document.querySelector('.create-mode-panel:not([hidden])');
      for (const mode of ['数字人', 'H3 多参考', 'H3 数字人 MV']) {
        await selectMode(mode);
        if (visible()?.querySelectorAll('.batch-list article').length !== 1) throw new Error('Shared batch missing in ' + mode);
      }
      if (localStorage.getItem('rh-runner.mv-segments.v1.batch') !== null || !localStorage.getItem('rh-runner.mv-batch-migration-backup')) throw new Error('Migration backup failed');
      const before = localStorage.getItem('rh-runner.mv-segments.v1');
      visible().querySelector('button[aria-label="编辑批次任务"]').click(); await wait();
      if (visible().querySelectorAll('.mv-segment').length !== 1) throw new Error('MV edit not isolated');
      const prompt = visible().querySelector('.mv-segment textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'edited queued snapshot');
      prompt.dispatchEvent(new Event('input', {bubbles:true})); await wait();
      [...visible().querySelectorAll('button')].find(b => b.textContent.includes('保存批次修改')).click(); await wait();
      const batch = JSON.parse(localStorage.getItem('rh-runner.batch.v1'));
      const key = batch[0].draft.workflowSnapshot.parameters.find(p => p.key === '87.value').id;
      if (batch.length !== 1 || batch[0].id !== 'smoke-mv-legacy' || batch[0].draft.parameterValues[key] !== 'edited queued snapshot') throw new Error('MV edit duplicated or lost snapshot');
      if (localStorage.getItem('rh-runner.mv-segments.v1') !== before) throw new Error('MV edit overwrote editor draft');
      await selectMode('H3 多参考');
      visible().querySelector('button[aria-label="删除批次任务"]').click(); await wait();
      await selectMode('H3 数字人 MV');
      if (visible().querySelectorAll('.batch-list article').length || !visible().querySelector('.batch-submit').disabled) throw new Error('Shared deletion failed');
      const stage = () => [...visible().querySelectorAll('button')].find(b => b.textContent.includes('加入制作批次'));
      const count = visible().querySelectorAll('.mv-segment').length;
      stage().click(); await wait(); stage().click(); await wait();
      const repeated = JSON.parse(localStorage.getItem('rh-runner.batch.v1'));
      if (repeated.length !== count * 2 || stage().disabled) throw new Error('Repeated staging is still locked');
      if ([...visible().querySelectorAll('.mv-toolbar')].some(e => /已提交|已加入批次/.test(e.textContent))) throw new Error('Obsolete segment status still visible');
      if (repeated[0].draft.production.groupId === repeated[count].draft.production.groupId) throw new Error('Repeated production reused group');
      for (let i = 0; i < count; i++) if (repeated[i].draft.production.segmentIndex !== i + 1) throw new Error('Segment order missing');
      [...visible().querySelectorAll('button')].find(b => b.textContent === '清空全部输入').click(); await wait();
      if (visible().querySelectorAll('.mv-segment').length !== 2) throw new Error('Clear did not reset segment count');
      if ([...visible().querySelectorAll('textarea')].some(t => t.value !== '')) throw new Error('Clear left prompt text');
      const cleared = JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1'));
      for (const segment of cleared) if (Object.values(segment.draft.mediaOverrides).some(m => m.mode === 'replace')) throw new Error('Clear left media');
      if (JSON.parse(localStorage.getItem('rh-runner.batch.v1')).length !== repeated.length) throw new Error('Clear changed queued snapshots');
      if ([...visible().querySelectorAll('button')].some(b => b.textContent.includes('恢复重新生成前'))) throw new Error('Removed restore feature still present');
      return true;
    })()`);
    console.log(sharedBatch ? 'DESKTOP_SHARED_BATCH_PASS' : 'DESKTOP_SHARED_BATCH_FAIL');
    await backend.close();
    backend = undefined as never;
    app.exit(connected && overviewScroll && settingsScroll && themesPassed && generationLayout && mvLayout && sharedBatch ? 0 : 1);
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
  focusExistingWindow(mainWindow, quitting);
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
// macOS keeps the process alive after closing its last window. Reopen the UI
// from the Dock without starting a second backend or scheduler.
app.on("activate", () => {
  if (quitting || !backend) return;
  if (mainWindow && !mainWindow.isDestroyed()) focusExistingWindow(mainWindow, quitting);
  else void createWindow().then(window => { mainWindow = window; }).catch(error => {
    console.error("Failed to reopen macOS window", error);
  });
});
app.on("before-quit", event => {
  if (!backend) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void backend.close().catch(error => {
    console.error("RunningHub shutdown failed", error);
  }).finally(() => { backend = undefined as never; app.exit(0); });
});
