import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, nativeImage, shell, safeStorage, clipboard } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { focusExistingWindow } from "./windowLifecycle.js";
import { createHash, randomUUID } from "node:crypto";
import { resolveMediaInputs } from "../core/workflows/mediaInputs.js";
import { MV_WORKFLOW_ID, validateMvInput } from "../core/workflows/mvValidation.js";
import { syncBundledWorkflows } from "../core/workflows/bundled.js";
import { jobOutputPath, namingRule, shortOutputPath, type NamingRule } from "../core/downloads/naming.js";
import { spawn } from "node:child_process";
import { safeOutputExtension } from "../core/runninghub/client.js";
import { createWriteStream, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access, appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RunningHubBackend } from "../core/index.js";
import { InMemorySecretStore } from "../core/secretStore.js";
import { SystemSecretStore, migratePlaintextKeys } from "../core/secureSecrets.js";
import { GeminiStore } from "../core/gemini/store.js";
import { GeminiPool } from "../core/gemini/pool.js";
import {WorkflowSkillStore} from "../core/gemini/workflowSkills.js";
import { selectOptimization } from "../core/gemini/selection.js";
import { optimizeH3 } from "../core/gemini/h3Optimizer.js";
import { TTS_LANGUAGES, type TtsInput } from "../core/gemini/ttsTypes.js";
import type { Account, CreateJobInput, InstanceType, Job, WorkflowProfile, WorkflowRecord } from "../core/types.js";
import { latestReleaseApiUrls, latestReleaseUrl, parseLatestRelease, trustedUpdateAssetPrefixes, updateRepositoryUrl } from "./updates.js";
import type { UpdateInfo, UpdateProgress } from "./updates.js";

interface RendererDraft {
  taskName?: string;
  geminiOptimization?: boolean;
  promptOptimizationEnabled?: boolean;
  production?: { groupId: string; segmentIndex: number };
  workflowId: string;
  profileVersion: number;
  instanceType?: InstanceType;
  parameterValues: Record<string, unknown>;
  mediaOverrides: Record<string, { enabled: boolean; mode: "replace" | "clear"; localPath?: string }>;
}

let backend: RunningHubBackend;
let gemini: GeminiPool;
let workflowSkills: WorkflowSkillStore;
const ttsRequests = new Map<string, AbortController>();
const smokeMode = process.argv.includes("--smoke");
if (smokeMode) app.setPath("userData", mkdtempSync(path.join(app.getPath("temp"), "rh-desktop-smoke-")));
else app.setPath("userData", path.join(app.getPath("appData"), "runninghub-multi-task-runner-core"));
let mainWindow: BrowserWindow | undefined;
let rendererUrl = "";
const ipcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) {
    electronIpcMain.handle(channel, (event, ...args) => {
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
          event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame?.url !== rendererUrl) {
        throw new Error("拒绝来自非应用主页面的请求。");
      }
      return listener(event, ...args);
    });
  },
};
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
      if (response.status === 404) throw new Error("个人仓库尚无可公开访问的 Release，或仓库为私有；请联系发布者确认更新权限。");
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
    const finalAssetUrl = new URL(response.url || info.assetUrl);
    if (finalAssetUrl.protocol !== "https:") throw new Error("更新下载被重定向到非 HTTPS 地址，已停止更新。");
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
$destinationRoot = [IO.Path]::GetFullPath($DestinationPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
  foreach ($entry in $zip.Entries) {
    $entryPath = [IO.Path]::GetFullPath([IO.Path]::Combine($DestinationPath, $entry.FullName))
    if (-not $entryPath.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "更新包包含越界路径，已停止解压。"
    }
  }
} finally {
  $zip.Dispose()
}
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
  return { id: account.id, maxConcurrency:account.maxConcurrency??1,activeJobCount:account.activeJobCount??0,externalTaskCount:account.externalTaskCount??0,label: account.label, state: account.state, coins: account.coins ?? account.balance, apiType: account.apiType, enabled: account.enabled, lastCheckedAt: account.lastCheckedAt, currentJobId: account.currentJobId, remoteTaskCount: account.lastRemoteTaskCount };
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
  OPTIMIZE_PENDING: "等待生成词优化", OPTIMIZING: "正在优化生成词",
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
    id: job.id, displayName: path.basename(job.outputs?.files[0]?.localPath || jobOutputPath(job,0,job.outputs?.files.length || 1,job.outputs?.files[0]?.url || "",job.outputs?.files[0] ? safeOutputExtension(job.outputs.files[0]) : "mp4")), taskName: job.profileSnapshot.taskName, workflowName: job.workflowName, status: job.status, accountLabel: account?.label,
    cancelRequestedAt: job.cancelRequestedAt,
    optimizationTrace: job.profileSnapshot.promptOptimization ? {model:job.profileSnapshot.promptOptimization.model,skillName:job.profileSnapshot.promptOptimization.skill?.name,skillHash:job.profileSnapshot.promptOptimization.skill?.hash,originalText:job.profileSnapshot.promptOptimization.originalText,firstStageText:job.profileSnapshot.promptOptimization.firstStageText,finalText:job.profileSnapshot.promptOptimization.finalText}:undefined,
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
      taskName: job.profileSnapshot.taskName,
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
    "minimax-h3-sharp.rhworkflow.json",
    "h3-digital-human-mv.rhworkflow.json",
    "infinitetalk-digital-human.rhworkflow.json",
    "h3-first-last.rhworkflow.json",
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
  const settings=gemini.store.settings();
  const selection=selectOptimization(workflow,resolved.parameters,draft.promptOptimizationEnabled ?? draft.geminiOptimization,settings.optimizationEnabled,settings.model);
  const referenceMode=workflow.runningHubWorkflowId!=="2106994828660080641" && resolved.media.length>0;
  const prompt=workflow.profile.parameters.find(p=>p.semanticType==='prompt'&&p.visible!==false);
  const promptOptimization=selection ? {...selection,skill:workflowSkills.snapshot(workflow.runningHubWorkflowId,referenceMode),originalText:String(prompt?resolved.parameters[prompt.id]??'':'')} : undefined;
  return { workflowId: draft.workflowId, taskName:draft.taskName, ...resolved, promptOptimization, production: draft.production, instanceType: draft.instanceType === "plus" ? "plus" : "default", outputDir };
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
  ipcMain.handle("accounts:setConcurrency", (_event,id:string,value:unknown)=>accountView(backend.accounts.setConcurrency(id,value)));
  ipcMain.handle("accounts:list", () => backend.accounts.list().map(accountView));
  ipcMain.handle("gemini:setOptimizationEnabled", (_event, enabled: unknown) => gemini.store.setOptimizationEnabled(enabled));
  const skillWorkflow=(id:unknown)=>{
    if(typeof id!=='string')throw Error('工作流无效');
    const workflow=backend.workflows.get(id);
    if(!workflow)throw Error('工作流不存在');
    return workflow.runningHubWorkflowId;
  };
  ipcMain.handle("skills:settings", (_event,id:unknown)=>workflowSkills.settings(skillWorkflow(id)));
  ipcMain.handle("skills:select", (_event,id:unknown,skillId:unknown)=>workflowSkills.select(skillWorkflow(id),skillId));
  ipcMain.handle("skills:import", async (_event,id:unknown)=>{
    const workflowId=skillWorkflow(id);
    workflowSkills.settings(workflowId);
    const options={title:'加载生成词 Skill',properties:['openFile'] as ('openFile')[],filters:[{name:'Skill 文本',extensions:['md','txt']}]};
    const result=mainWindow?await dialog.showOpenDialog(mainWindow,options):await dialog.showOpenDialog(options);
    if(result.canceled||!result.filePaths[0])return undefined;
    const file=result.filePaths[0],info=await stat(file);
    if(!info.isFile()||info.size>256*1024||!['.md','.txt'].includes(path.extname(file).toLowerCase()))throw Error('请选择 256 KB 以内的 .md/.txt 文件');
    const content=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(file));
    return workflowSkills.import(workflowId,path.basename(file),content);
  });
  ipcMain.handle("gemini:settings", () => gemini.store.settings());
  ipcMain.handle("tts:generate", async (_event, id: string, input: TtsInput, preview: boolean) => {
    if(typeof id!=="string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || ttsRequests.has(id) || ttsRequests.size>=2)throw new Error("语音请求正在处理，请稍后再试。");
    const request=structuredClone(input);
    if(preview===true){
      const language=TTS_LANGUAGES.find(l=>l.id===request.language);
      if(!language)throw new Error("请选择语言。");
      request.text=language.sample;request.style="";
    }
    const controller=new AbortController();ttsRequests.set(id,controller);
    try{
      const directory=path.join(app.getPath("userData"),"tts-audio");
      const name=preview===true?`sample-${createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0,24)}.wav`:`tts-${randomUUID()}.wav`;
      const localPath=path.join(directory,name);
      const cached=preview===true && await stat(localPath).then(s=>s.size>44).catch(()=>false);
      if(!cached){
        const result=await gemini.speech(request,controller.signal);
        controller.signal.throwIfAborted();
        await mkdir(directory,{recursive:true});
        await writeFile(localPath,Buffer.from(result.text,"base64"));
      }
      return {localPath,fileName:name,previewUrl:pathToFileURL(localPath).toString()};
    }finally{ttsRequests.delete(id);}
  });
  ipcMain.handle("tts:cancel", (_event, id:string) => {ttsRequests.get(id)?.abort();});
  ipcMain.handle("tts:save", async (_event, localPath:string) => {
    const directory=await realpath(path.join(app.getPath("userData"),"tts-audio"));
    if(typeof localPath!=="string")throw new Error("音频路径无效。");
    const source=await realpath(localPath);
    if(path.dirname(source)!==directory || !/^tts-[a-f0-9-]+\.wav$/.test(path.basename(source)))throw new Error("请选择已生成的音频。");
    const options={defaultPath:path.join(app.getPath("downloads"),path.basename(source)),filters:[{name:"WAV 音频",extensions:["wav"]}]};
    const result=mainWindow?await dialog.showSaveDialog(mainWindow,options):await dialog.showSaveDialog(options);
    if(result.canceled || !result.filePath)return false;
    await writeFile(result.filePath,await readFile(source));return true;
  });
  ipcMain.handle("gemini:addKeys", (_event, keys: unknown) => gemini.store.add(keys));
  ipcMain.handle("gemini:setModel", (_event, model: unknown) => gemini.store.setModel(model));
  ipcMain.handle("gemini:setEnabled", (_event, id: string, enabled: boolean) => gemini.store.setEnabled(id,enabled));
  ipcMain.handle("gemini:remove", (_event, id: string) => gemini.store.remove(id));
  ipcMain.handle("gemini:test", (_event, id?: string) => {
    if (id !== undefined && (typeof id !== "string" || !id)) throw new Error("无效的 Key 编号。");
    return gemini.test(id);
  });
  ipcMain.handle("gemini:copyKeysUrl", () => clipboard.writeText("https://aistudio.google.com/apikey"));
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
  ipcMain.handle("external:copyApiKeysUrl", async () => { await clipboard.writeText(runningHubApiKeysUrl); if (await clipboard.readText() !== runningHubApiKeysUrl) throw new Error("复制失败，请重试"); });
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
    icon: path.join(applicationRoot, "desktop", "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    width: 1440, height: 940, minWidth: 980, minHeight: 680,
    backgroundColor: "#080c12", show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  rendererUrl = pathToFileURL(path.resolve(applicationRoot, "frontend", "dist", "index.html")).href;
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
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
  const secretStore = smokeMode ? new InMemorySecretStore() : new SystemSecretStore(safeStorage);
  backend = new RunningHubBackend({
    databasePath: smokeMode ? ":memory:" : path.join(userData, "runninghub.sqlite"),
    secretStore,
    config: { apiHost: "https://www.runninghub.ai", outputDir },
  });
  if (secretStore instanceof SystemSecretStore) migratePlaintextKeys(backend.database.raw, secretStore);
  gemini = new GeminiPool(new GeminiStore(backend.database.raw,secretStore));
  workflowSkills = new WorkflowSkillStore(backend.database.raw);
  backend.scheduler.optimizePrompt = async (job,signal) => {
    const optimization=job.profileSnapshot.promptOptimization;
    if(!optimization)throw new Error('任务缺少优化配置');
    const workflow: WorkflowRecord={id:job.workflowId,name:job.workflowName,runningHubWorkflowId:job.runningHubWorkflowId,raw:optimization.raw,profile:job.profileSnapshot,profileVersion:job.profileVersion,workflowHash:'snapshot',createdAt:job.createdAt,updatedAt:job.createdAt};
    return optimizeH3(workflow,{workflowId:job.workflowId,parameters:job.parameters,media:job.media},gemini,async localPath=>{
      signal.throwIfAborted();
      if(!path.isAbsolute(localPath))throw new Error('图片路径无效');
      const info=await stat(localPath);
      if(!info.isFile()||info.size>20*1024*1024)throw new Error('参考图过大或不是文件');
      const image=nativeImage.createFromBuffer(await readFile(localPath));
      if(image.isEmpty())throw new Error('无法读取参考图片');
      const size=image.getSize(),scale=Math.min(1,1280/Math.max(size.width,size.height));
      const resized=scale<1?image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))}):image;
      return {mimeType:'image/jpeg',data:resized.toJPEG(85).toString('base64')};
    },signal,optimization.model,async state=>{
      signal.throwIfAborted();
      const current=backend.jobs.get(job.id);
      if(current?.status!=="OPTIMIZING")throw new Error("任务已停止");
      backend.database.updateJob(job.id,{profileSnapshot:{...current.profileSnapshot,promptOptimization:structuredClone(state)}});
      backend.events.emit('job.updated',backend.jobs.get(job.id)!);
    },async localPath=>{
      signal.throwIfAborted();
      if(!path.isAbsolute(localPath))throw new Error('音频路径无效');
      const info=await stat(localPath);
      if(!info.isFile()||info.size>13*1024*1024)throw new Error('优化音频过大，请转换为 MP3 后再试；未提交视频任务。');
      const mimeTypes:Record<string,string>={'.wav':'audio/wav','.mp3':'audio/mpeg','.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg','.m4a':'audio/mp4'};
      const mimeType=mimeTypes[path.extname(localPath).toLowerCase()];
      if(!mimeType)throw new Error('生成词优化暂不支持此音频格式，请使用 MP3 或 WAV。');
      const data=await readFile(localPath,{signal});
      return {mimeType,data:data.toString('base64')};
    });
  };
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
      // Settings are loaded as a separate chunk; wait for the dialog, not a fixed frame delay.
      for (let i = 0; i < 100 && !document.querySelector('.settings-scroll'); i++) await wait();
      const scroll = document.querySelector('.settings-scroll');
      if (!scroll || document.querySelectorAll('.theme-card').length !== 4) return false;
      scroll.scrollTop = scroll.scrollHeight;
      const bounds = document.querySelector('.settings-modal').getBoundingClientRect();
      return (scroll.scrollHeight <= scroll.clientHeight || scroll.scrollTop > 0) && bounds.top >= 0 && bounds.bottom <= innerHeight;
    })()`);
    console.log(settingsScroll ? "DESKTOP_SETTINGS_SCROLL_PASS" : "DESKTOP_SETTINGS_SCROLL_FAIL");
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(r => setTimeout(r, 450));
      const modal = document.querySelector('.settings-modal');
      if (modal.querySelector('select')) throw new Error('Native settings select remains');
      const buttons = modal.querySelectorAll('.app-select > button');
      if (buttons.length !== 2) throw new Error('Settings dropdowns missing');
      buttons[0].scrollIntoView({block:'center',behavior:'instant'}); buttons[0].focus({preventScroll:true}); await wait(); buttons[0].click(); await wait();
      const list = document.querySelector('.app-select-options');
      if (!list || list.querySelectorAll('[role="option"]').length !== 3) throw new Error('Dropdown did not open');
      const r = list.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight + 1) throw new Error('Dropdown outside viewport');
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); await wait();
      if (!document.querySelector('.settings-modal') || document.querySelector('.app-select-options')) throw new Error('Escape incorrectly closes settings');
      buttons[1].scrollIntoView({block:'center',behavior:'instant'}); buttons[1].focus({preventScroll:true}); await wait(); buttons[1].click(); await wait();
      const debugOpen = buttons[1].getAttribute('aria-expanded');
      const scrollEvents = [];
      const trackScroll = e => scrollEvents.push(e.target?.className ?? e.target?.nodeName);
      window.addEventListener('scroll', trackScroll, true);
      buttons[1].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true})); await wait();
      const debugEnd = buttons[1].getAttribute('aria-activedescendant');
      window.removeEventListener('scroll', trackScroll, true);
      buttons[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); await wait();
      if (!buttons[1].textContent.includes('8 秒')) throw new Error('Keyboard selection failed: ' + buttons[1].textContent + ', expanded=' + buttons[1].getAttribute('aria-expanded') + ', opened=' + debugOpen + ', end=' + debugEnd + ', scroll=' + JSON.stringify(scrollEvents));
    })()`);
    console.log('DESKTOP_DROPDOWN_PASS');
    const googleSettings = await window.webContents.executeJavaScript(`(async () => {
      const api = window.runningHub.gemini;
      if (!api || (await api.settings()).model !== 'gemini-3.5-flash-lite') throw new Error('Google settings bridge missing');
      if(document.querySelector('.settings-modal .gemini-settings'))throw new Error('Gemini must not be in settings');
      document.querySelector('.settings-modal button[aria-label="关闭"]').click();
      [...document.querySelectorAll('.nav-list button')].find(b=>b.textContent==='账号池').click();
      await new Promise(r=>setTimeout(r,150));
      document.querySelector('#gemini-tab').click();
      const testAccount=await window.runningHub.accounts.add({label:'并发界面测试',apiKey:'smoke-concurrency-not-a-real-key'});
      document.querySelector('#runninghub-tab').click();
      await new Promise(r=>setTimeout(r,150));
      const concurrency=document.querySelector('[aria-label="并发界面测试 最大并发"]');
      if(!concurrency || document.querySelectorAll('.account-table .table-header > span').length!==6)throw Error('Concurrency column missing');
      concurrency.click();await new Promise(r=>setTimeout(r,100));
      [...document.querySelectorAll('.app-select-options [role="option"]')].find(b=>b.textContent==='3 路').click();
      await new Promise(r=>setTimeout(r,200));
      if((await window.runningHub.accounts.list()).find(a=>a.id===testAccount.id).maxConcurrency!==3)throw Error('Concurrency setting did not persist');
      await window.runningHub.accounts.remove(testAccount.id);
      document.querySelector('#gemini-tab').click();
      await new Promise(r=>setTimeout(r,150));
      if(!document.querySelector('#runninghub-panel').hidden || document.querySelector('#gemini-panel').hidden)throw new Error('Account platform tabs failed');
      const root = document.querySelector('.gemini-settings');
      if (!root) throw new Error('Google settings UI missing');
      const globalSwitch=root.querySelector('button[aria-label="开启 Gemini 生成词优化"]');
      if(globalSwitch)throw new Error('Obsolete global optimizer switch remains');
      const select=root.querySelector('[aria-label="Gemini 模型"]');
      const skillSelect=root.querySelector('[aria-label="第一阶段 Skill"]');
      if(skillSelect)throw new Error('Obsolete first-stage selector remains');
      for(const [label,id] of [['Gemini 3.8 Flash','gemini-3.8-flash'],['Gemini 3.7 Flash','gemini-3.7-flash'],['Gemini 3.5 Flash-Lite','gemini-3.5-flash-lite']]) {
        select.click(); await new Promise(r=>setTimeout(r,100));
        const options=[...document.querySelectorAll('.app-select-options [role="option"]')];
        if(options.length!==3)throw new Error('Gemini model choices missing');
        options.find(b=>b.textContent===label).click(); await new Promise(r=>setTimeout(r,100));
        if((await api.settings()).model===id)throw new Error('Model changed before save');
        [...root.querySelectorAll('button')].find(b=>b.textContent==='保存模型').click();
        for(let i=0;i<50&&((await api.settings()).model!==id || select.disabled);i++)await new Promise(r=>setTimeout(r,100));
        if((await api.settings()).model!==id || !select.textContent.includes(label))throw new Error('Model selection persistence failed');
      }
      const input = root.querySelector('textarea');
      const value = 'AIza-smoke-not-a-real-key-123456789';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value+'\\n'+value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      [...root.querySelectorAll('button')].find(b=>b.textContent==='添加').click();
      for(let i=0;i<50&&!root.querySelector('.gemini-key-row');i++)await new Promise(r=>setTimeout(r,100));
      if(root.querySelectorAll('.gemini-key-row').length!==1 || root.textContent.includes(value))throw new Error('Google add/dedup/masking failed');
      if(input.value!=='')throw new Error('Google input not cleared after save');
      const row=root.querySelector('.gemini-key-row');
      row.querySelector('.switch').click();
      for(let i=0;i<50&&(await api.settings()).keys[0].enabled;i++)await new Promise(r=>setTimeout(r,100));
      if((await api.settings()).keys[0].enabled)throw new Error('Google disable failed');
      root.scrollIntoView({block:'start',behavior:'instant'});
      return true;
    })()`);
    console.log(googleSettings ? 'DESKTOP_GOOGLE_SETTINGS_PASS' : 'DESKTOP_GOOGLE_SETTINGS_FAIL');
    if (process.argv.includes('--preview-gemini')) {
      window.show();
      window.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await writeFile(path.join(app.getPath('temp'),'rh-google-settings.png'),(await window.webContents.capturePage()).toPNG());
    }
    await window.webContents.executeJavaScript(`(async () => {
      const root=document.querySelector('.gemini-settings');
      for(let i=0;i<50&&root.querySelector('.gemini-key-row .icon-button').disabled;i++)await new Promise(r=>setTimeout(r,100));
      root.querySelector('.gemini-key-row .icon-button').click();
      for(let i=0;i<50&&(await window.runningHub.gemini.settings()).keys.length;i++)await new Promise(r=>setTimeout(r,100));
      if((await window.runningHub.gemini.settings()).keys.length)throw new Error('Google remove failed');
      document.querySelector('.settings-button').click();
      for(let i=0;i<50&&!document.querySelector('.settings-modal');i++)await new Promise(r=>setTimeout(r,100));
    })()`);
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
      [...document.querySelectorAll('.create-mode-tabs button')].find(button => button.textContent === 'H3多参考')?.click();
      await wait();
      const workspace = document.querySelector('.create-mode-panel:not([hidden])');
      if(workspace.textContent.includes('选择工作流'))throw Error('Fixed workflow picker still visible');
      if(document.querySelectorAll('.create-mode-tabs button').length!==5)throw Error('Personal workflow module must be hidden without imports');
      const moduleNames=[...document.querySelectorAll('.create-mode-tabs button')].map(button=>button.textContent);
      if(moduleNames[4]!=='Gemini TTS')throw Error('Module order incorrect');
      const optimizationSwitch=workspace.querySelector('button[aria-label="中文生成词优化"]');
      if(!optimizationSwitch || optimizationSwitch.getAttribute('aria-pressed')!=='true')throw new Error('Gemini optimization switch missing or not default on');
      if(workspace.querySelectorAll('button[aria-label="中文生成词优化"]').length!==1)throw new Error('Duplicate prompt optimization switches');
      optimizationSwitch.click();await wait();
      if(optimizationSwitch.getAttribute('aria-pressed')!=='false')throw new Error('Optimization switch cannot disable');
      optimizationSwitch.click();await wait();
      if(workspace.querySelectorAll('.media-image').length!==2)throw new Error('Sharp initial media slots mismatch');
      const sharp=(await window.runningHub.workflows.list()).find(w=>w.runningHubWorkflowId==='2106577322987307010');
      if(!sharp||sharp.parameters.filter(p=>p.valueType==='image'&&p.visible!==false).length!==9)throw new Error('Sharp nine-image bridge missing');
      const durationField=[...workspace.querySelectorAll('.parameter-field')].find(p=>p.textContent.includes('视频时长'))?.querySelector('input');
      if(!durationField)throw new Error('Sharp duration input missing');
      const previousDuration=durationField.value;
      for(const value of ['1','10','10.1','60']){
        durationField.value=value;
        if(!durationField.checkValidity())throw new Error('Sharp duration rejects '+value);
      }
      durationField.value=previousDuration;
      const nativeSet=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      nativeSet.call(durationField,'12');durationField.dispatchEvent(new Event('input',{bubbles:true}));await wait();
      workspace.querySelector('button[aria-label="增加 1 秒"]').click();await wait();
      if(durationField.value!=='13')throw new Error('Duration increment is not one second');
      optimizationSwitch.click();await wait();
      workspace.querySelector('button[aria-label="中文生成词优化"]').click();await wait();
      [...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='H3首尾帧').click();await wait();
      const firstLast=document.querySelector('.create-mode-panel:not([hidden])');
      const labels=[...firstLast.querySelectorAll('.media-head strong')].map(n=>n.textContent);
      if(JSON.stringify(labels)!==JSON.stringify(['首帧','尾帧']))throw Error('First/last labels: '+JSON.stringify(labels));
      [...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='Inf数字人').click();await wait();
      const avatar=document.querySelector('.create-mode-panel:not([hidden])');
      const negative=avatar.querySelector('.negative-prompt-field textarea');
      if(!negative || !negative.value || negative.getBoundingClientRect().height>180)throw Error('INF negative prompt missing or too large');
      if(avatar.textContent.includes('选择工作流'))throw Error('Avatar picker still visible');
      if(sharp.parameters.some(p=>['145.strength_model','147.extra_steps','193.seed','193.transition_step'].includes(p.key)&&p.visible!==false))throw new Error('Sharp hidden controls exposed');
      if (!Object.keys(localStorage).some(key => key.startsWith('rh-runner.draft-backup.h3-multi-reference.') && localStorage.getItem(key).includes('legacy input must be backed up'))) throw new Error('Legacy draft backup missing');
      return true;
    })()`);
    console.log(generationLayout ? "DESKTOP_H3_LAYOUT_PASS" : "DESKTOP_H3_LAYOUT_FAIL");
    const mvLayout = await window.webContents.executeJavaScript(`(async () => {
      // Persistence is debounced by 300 ms; storage assertions must wait for it.
      const wait = () => new Promise(resolve => setTimeout(resolve, 450));
      [...document.querySelectorAll('.create-mode-tabs button')].find(b => b.textContent === 'H3 数字人')?.click();
      await wait();
      const root = document.querySelector('.mv-workspace');
      const taskName=root?.querySelector('input[aria-label="H3数字人任务名称"]');
      if(!taskName || root.querySelector('.mv-segment input[aria-label*="任务名称"]'))throw Error('MV must have one shared task name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(taskName,'测试整体任务');
      taskName.dispatchEvent(new Event('input',{bubbles:true}));await wait();
      if(JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1.shared')).taskName!=='测试整体任务')throw Error('Shared task name not saved');
      const optimizer=root?.querySelector('button[aria-label="第 1 段中文生成词优化"]');
      if(!optimizer || !optimizer.closest('.content-input-label') || root.querySelectorAll('.mv-segment').length!==1)throw Error('MV segment optimizer/default missing');
      if(optimizer.getAttribute('aria-pressed')!=='true')throw Error('MV optimization default is not enabled');
      await wait();
      if(!JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1'))[0].draft.promptOptimizationEnabled)throw Error('MV optimization not persisted');
      root.querySelector('.mv-add-segment').click();await wait();
      if(root.querySelector('button[aria-label="第 2 段中文生成词优化"]').getAttribute('aria-pressed')!=='true')throw Error('New segment did not inherit optimization');
      optimizer.click();await wait();
      if(root.querySelector('button[aria-label="第 2 段中文生成词优化"]').getAttribute('aria-pressed')!=='true')throw Error('Segment switches are not independent');
      if (!root || root.querySelectorAll('.mv-segment').length !== 2) return false;
      if (root.querySelectorAll('.media-image').length !== 4 || root.querySelectorAll('.media-audio').length !== 1) return false;
      if (root.querySelectorAll('.mv-generation .app-select').length !== 1 || root.querySelectorAll('.mv-segment .app-select').length !== 0) return false;
      if (root.querySelectorAll('button[aria-label="MV Plus 高显存"]').length !== 1 || root.querySelectorAll('.mv-segment .switch').length !== 2) return false;
      const plus = root.querySelector('button[aria-label="MV Plus 高显存"]');
      const standardPlus = document.querySelector('.create-mode-panel[hidden] .instance-mode-control .switch');
      if (!plus.closest('.instance-mode-control') || (standardPlus && (getComputedStyle(plus).height !== getComputedStyle(standardPlus).height || getComputedStyle(plus).width !== getComputedStyle(standardPlus).width))) throw new Error('MV Plus differs from standard control');
      const stage = [...root.querySelectorAll('button')].find(b => b.textContent === '加入制作批次');
      stage.click(); await wait();
      if (![...document.querySelectorAll('#app-notifications [role="alert"]')].some(e => e.textContent.includes('未填写生成词')) || document.querySelectorAll('.batch-list article').length) return false;
      if (!document.querySelector('.batch-submit').disabled) return false;
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
      const wait = () => new Promise(resolve => setTimeout(resolve, 450));
      for (let i = 0; i < 30 && !document.querySelector('.create-mode-tabs'); i++) {
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建任务'))?.click();
        await wait();
      }
      const selectMode = async name => { [...document.querySelectorAll('.create-mode-tabs button')].find(b => b.textContent === name)?.click(); await wait(); };
      const visible = () => document.querySelector('.create-mode-panel:not([hidden])');
      for (const mode of ['Inf数字人', 'H3多参考', 'H3 数字人', 'H3首尾帧']) {
        await selectMode(mode);
        if (document.querySelectorAll('.create-sidebar').length !== 1 || document.querySelectorAll('.batch-list article').length !== 1) throw new Error('Shared batch missing in ' + mode);
      }
      if (localStorage.getItem('rh-runner.mv-segments.v1.batch') !== null || !localStorage.getItem('rh-runner.mv-batch-migration-backup')) throw new Error('Migration backup failed');
      const before = localStorage.getItem('rh-runner.mv-segments.v1');
      document.querySelector('button[aria-label="编辑批次任务"]').click(); await wait();
      if (visible().querySelectorAll('.mv-segment').length !== 1) throw new Error('MV edit not isolated');
      const prompt = visible().querySelector('.mv-segment textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'edited queued snapshot');
      prompt.dispatchEvent(new Event('input', {bubbles:true})); await wait();
      [...visible().querySelectorAll('button')].find(b => b.textContent.includes('保存批次修改')).click(); await wait();
      const batch = JSON.parse(localStorage.getItem('rh-runner.batch.v1'));
      const key = batch[0].draft.workflowSnapshot.parameters.find(p => p.key === '87.value').id;
      if (batch.length !== 1 || batch[0].id !== 'smoke-mv-legacy' || batch[0].draft.parameterValues[key] !== 'edited queued snapshot') throw new Error('MV edit duplicated or lost snapshot');
      if (localStorage.getItem('rh-runner.mv-segments.v1') !== before) throw new Error('MV edit overwrote editor draft');
      await selectMode('H3多参考');
      document.querySelector('button[aria-label="删除批次任务"]').click(); await wait();
      await selectMode('H3 数字人');
      if (document.querySelectorAll('.batch-list article').length || !document.querySelector('.batch-submit').disabled) throw new Error('Shared deletion failed');
      const stage = () => [...visible().querySelectorAll('button')].find(b => b.textContent.includes('加入制作批次'));
      const count = visible().querySelectorAll('.mv-segment').length;
      stage().click(); await wait(); stage().click(); await wait();
      const repeated = JSON.parse(localStorage.getItem('rh-runner.batch.v1'));
      if (repeated.length !== count * 2 || stage().disabled) throw new Error('Repeated staging is still locked');
      if ([...visible().querySelectorAll('.mv-toolbar')].some(e => /已提交|已加入批次/.test(e.textContent))) throw new Error('Obsolete segment status still visible');
      if (repeated[0].draft.production.groupId === repeated[count].draft.production.groupId) throw new Error('Repeated production reused group');
      for (let i = 0; i < count; i++) if (repeated[i].draft.production.segmentIndex !== i + 1) throw new Error('Segment order missing');
      [...visible().querySelectorAll('button')].find(b => b.textContent === '清空全部输入').click(); await wait();
      if (visible().querySelectorAll('.mv-segment').length !== 1) throw new Error('Clear did not reset segment count');
      if ([...visible().querySelectorAll('textarea')].some(t => t.value !== '')) throw new Error('Clear left prompt text');
      const cleared = JSON.parse(localStorage.getItem('rh-runner.mv-segments.v1'));
      for (const segment of cleared) if (Object.values(segment.draft.mediaOverrides).some(m => m.mode === 'replace')) throw new Error('Clear left media');
      if (JSON.parse(localStorage.getItem('rh-runner.batch.v1')).length !== repeated.length) throw new Error('Clear changed queued snapshots');
      if ([...visible().querySelectorAll('button')].some(b => b.textContent.includes('恢复重新生成前'))) throw new Error('Removed restore feature still present');
      return true;
    })()`);
    console.log(sharedBatch ? 'DESKTOP_SHARED_BATCH_PASS' : 'DESKTOP_SHARED_BATCH_FAIL');
    // Isolated smoke database + synthetic WAV: verify IPC, file playback and handoff without a cloud task.
    const ttsWav=Buffer.alloc(4844);
    ttsWav.write('RIFF');ttsWav.writeUInt32LE(4836,4);ttsWav.write('WAVEfmt ',8);ttsWav.writeUInt32LE(16,16);
    ttsWav.writeUInt16LE(1,20);ttsWav.writeUInt16LE(1,22);ttsWav.writeUInt32LE(24000,24);ttsWav.writeUInt32LE(48000,28);
    ttsWav.writeUInt16LE(2,32);ttsWav.writeUInt16LE(16,34);ttsWav.write('data',36);ttsWav.writeUInt32LE(4800,40);
    gemini.store.add(['AIza-tts-smoke-key-123456789']);
    gemini=new GeminiPool(gemini.store,{fetch:async(_url,options)=>{
      return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/wav',data:ttsWav.toString('base64')}]}]});
    }});
    await window.webContents.executeJavaScript(`(async()=>{
      [...document.querySelectorAll('.nav-list button')].find(b=>b.textContent==='创建任务').click();
      await new Promise(r=>setTimeout(r,200));
      [...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='Gemini TTS').click();
      await new Promise(r=>setTimeout(r,300));
      const root=document.querySelector('.tts-workspace');
      if(!window.runningHub.tts || !root || root.querySelectorAll('textarea').length!==2)throw Error('TTS workspace missing');
      if(!root.textContent.includes('越南语')||!root.textContent.includes('女声'))throw Error('TTS defaults missing');
      const button=[...root.querySelectorAll('button')].find(b=>b.textContent==='生成音频');
      if(!button.disabled)throw Error('Empty TTS submission enabled');
      root.querySelector('[aria-label="配音音色"]').click();
      await new Promise(r=>setTimeout(r,100));
      const options=document.querySelectorAll('[role="option"]');
      if(options.length!==30 || ![...options].some(o=>o.textContent.includes('男声')))throw Error('TTS voice list incomplete');
      options[0].click();
      [...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='Inf数字人').click();
      await new Promise(r=>setTimeout(r,200));
      if(!document.querySelector('.tts-workspace').closest('.create-mode-panel').hidden)throw Error('TTS navigation failed');
      [...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='Gemini TTS').click();
      await new Promise(r=>setTimeout(r,200));
      const bounds=document.querySelector('.tts-workspace').getBoundingClientRect();
      if(bounds.width<100||bounds.height<100)throw Error('TTS workspace not visible');
      const mvBefore=localStorage.getItem('rh-runner.mv-segments.v1');
      const text=root.querySelector('textarea[aria-label="配音文本"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(text,'Xin chào');
      text.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      const style=root.querySelector('textarea[aria-label="风格指令"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(style,'温柔');
      style.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      [...root.querySelectorAll('button')].find(b=>b.textContent==='清空文本').click();
      await new Promise(r=>setTimeout(r,100));
      if(text.value||style.value||!button.disabled||window.runningHub.tts.optimize)throw Error('TTS clear/removal failed');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(text,'Xin chào');
      text.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      button.click();
      for(let i=0;i<50&&!root.querySelector('.tts-result');i++)await new Promise(r=>setTimeout(r,100));
      const audio=root.querySelector('.tts-result audio');
      if(!audio)throw Error('TTS IPC did not produce audio');
      for(let i=0;i<30&&!Number.isFinite(audio.duration);i++)await new Promise(r=>setTimeout(r,100));
      if(!(audio.duration>0))throw Error('TTS generated file cannot be played');
      const source=audio.src;
      [...root.querySelectorAll('button')].find(b=>b.textContent==='发送到数字人').click();
      await new Promise(r=>setTimeout(r,450));
      const active=[...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.getAttribute('aria-pressed')==='true');
      if(active?.textContent!=='Inf数字人')throw Error('TTS handoff went to wrong workspace');
      const draft=JSON.parse(localStorage.getItem('rh-runner.draft.v1.digital-human'));
      const audioParameter=draft.workflowSnapshot.parameters.find(p=>p.valueType==='audio'&&p.visible!==false);
      if(!audioParameter || draft.mediaOverrides[audioParameter.id]?.previewUrl!==source)throw Error('TTS audio did not reach ordinary avatar draft');
      if(localStorage.getItem('rh-runner.mv-segments.v1')!==mvBefore)throw Error('TTS changed MV draft');
      [...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='Gemini TTS').click();
      await new Promise(r=>setTimeout(r,200));
    })()`);
    window.showInactive();
    await new Promise(r=>setTimeout(r,600));
    await writeFile(path.join(app.getPath("temp"),"rh-tts-ui.png"),(await window.webContents.capturePage()).toPNG());
    console.log('DESKTOP_TTS_PASS');
    for(const width of [980,1200,1440]){
      window.setSize(width,940);
      await new Promise(r=>setTimeout(r,150));
      await window.webContents.executeJavaScript(`(async()=>{
        for(const tab of document.querySelectorAll('.create-mode-tabs button')){
          tab.click();await new Promise(r=>setTimeout(r,100));
          const root=document.querySelector('.create-workspace');
          if(['H3多参考','H3首尾帧'].includes(tab.textContent)){
            const panel=document.querySelector('.create-mode-panel:not([hidden])');
            const prompt=panel.querySelector('.h3-prompt-input textarea');
            if(!prompt || prompt.getBoundingClientRect().height<280)throw Error('H3 prompt height mismatch');
            if(panel.querySelector('.generic-section'))throw Error('Obsolete extra parameters');
            if(!panel.textContent.includes('高分辨率分块') || !panel.textContent.includes('目标分辨率'))throw Error('Resolution controls missing');
          }
          if(root.scrollWidth>root.clientWidth+2)throw Error('Workspace overflow '+tab.textContent+' '+root.scrollWidth+'/'+root.clientWidth);
          const nav=document.querySelector('.create-mode-tabs');
          const bounds=nav.getBoundingClientRect(), selected=tab.getBoundingClientRect();
          const editor=document.querySelector('.create-editor-column').getBoundingClientRect();
          if(bounds.right>editor.right+2 || selected.left<bounds.left-2 || selected.right>bounds.right+2)throw Error('Navigation or selected module outside editor');
          const audio=document.querySelector('.mv-global-audio');
          if(audio?.querySelector('.switch') || audio?.textContent.includes('清空全部输入'))throw Error('Global controls inside audio');
        }
      })()`);
    }
    console.log('DESKTOP_RESPONSIVE_MODULES_PASS');
    await window.webContents.executeJavaScript(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,400));
      [...document.querySelectorAll('.nav-list button')].find(b=>b.textContent==='工作流').click();await wait();
      const group=document.querySelector('[aria-label="默认工作流"]');
      if(!group || group.querySelector('.workflow-breakdown') || group.querySelector('.workflow-card-actions'))throw Error('Default workflow clutter remains');
      const buttons=[...group.querySelectorAll('button')].filter(b=>b.textContent==='Skill');
      if(buttons.length!==3)throw Error('Expected three H3 Skill entries, no Inf entry');
      buttons[0].click();await wait();
      const modal=document.querySelector('[aria-label="工作流 Skill"]');
      if(!modal?.querySelector('[aria-label="加载 Skill"]') || !modal.textContent.includes('上传自定义 Skill'))throw Error('Skill UI missing');
      modal.querySelector('button[aria-label="关闭"]').click();
    })()`);
    await backend.stop();
    const previewWorkflow=backend.workflows.list().find(w=>w.runningHubWorkflowId==='2106577322987307010')!;
    const previewParameters=Object.fromEntries(previewWorkflow.profile.parameters.map(p=>[p.id,p.defaultValue]));
    const previewPrompt=previewWorkflow.profile.parameters.find(p=>p.semanticType==='prompt')!;
    previewParameters[previewPrompt.id]='smoke original prompt';
    const previewJob=backend.jobs.create({workflowId:previewWorkflow.id,taskName:'预览命名测试',parameters:previewParameters,promptOptimization:{model:'gemini-test',skill:workflowSkills.snapshot(previewWorkflow.runningHubWorkflowId,false),originalText:'smoke original prompt'}});
    backend.jobs.transition(previewJob.id,'OPTIMIZING');
    await window.webContents.executeJavaScript(`(async()=>{
      [...document.querySelectorAll('.nav-list button')].find(b=>b.textContent==='任务队列').click();
      await new Promise(r=>setTimeout(r,450));
      const button=[...document.querySelectorAll('.job-actions button')].find(b=>b.textContent.trim()==='预览');
      if(!document.querySelector('.job-title')?.textContent.includes('预览命名测试'))throw Error('Task title not connected');
      if(!button)throw Error('Active task preview unavailable');button.click();await new Promise(r=>setTimeout(r,450));
      const modal=document.querySelector('[aria-label="任务预览"]');
      if(!modal?.textContent.includes('smoke original prompt') || !modal.textContent.includes('正在等待优化结果'))throw Error('Pending optimization preview missing');
    })()`);
    const previewState=backend.jobs.get(previewJob.id)!.profileSnapshot;
    previewState.promptOptimization!.finalText='smoke optimized prompt';
    backend.database.updateJob(previewJob.id,{profileSnapshot:previewState});
    backend.jobs.transition(previewJob.id,'FAILED');
    await window.webContents.executeJavaScript(`(async()=>{
      await new Promise(r=>setTimeout(r,450));
      const modal=document.querySelector('[aria-label="任务预览"]');
      if(!modal?.textContent.includes('smoke optimized prompt') || modal.querySelectorAll('.preview-prompt button:not(:disabled)').length!==2)throw Error('Failed/live optimized preview or copy missing');
      modal.querySelector('button[aria-label="关闭"]').click();
      [...document.querySelectorAll('.nav-list button')].find(b=>b.textContent==='创建任务').click();await new Promise(r=>setTimeout(r,200));
    })()`);
    console.log('DESKTOP_WORKFLOW_SKILL_AND_LIVE_PREVIEW_PASS');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.create-mode-tabs button')].find(b=>b.textContent==='Inf数字人').click()`);
    await new Promise(r=>setTimeout(r,150));
    await writeFile(path.join(app.getPath('temp'),'rh-fixed-modules.png'),(await window.webContents.capturePage()).toPNG());
    await backend.close();
    backend = undefined as never;
    app.exit(connected && overviewScroll && settingsScroll && themesPassed && generationLayout && mvLayout && sharedBatch ? 0 : 1);
  }
}).catch(async error => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  const logPath = path.join(app.getPath("userData"), "runninghub-startup-error.log");
  await appendFile(logPath, `[${new Date().toISOString()}]\n${message}\n\n`, "utf8").catch(() => undefined);
  if (smokeMode) { console.error(message); app.exit(1); return; }
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
