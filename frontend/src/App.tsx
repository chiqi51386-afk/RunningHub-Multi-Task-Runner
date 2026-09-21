import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowRight, BadgeCheck, Boxes, Check, ChevronDown, CircleDollarSign,
  Clock3, CloudUpload, Download, ExternalLink, FileJson, FolderOpen, Gauge, ImagePlus, KeyRound, LayoutDashboard, ListTodo,
  AlertTriangle, Link2, LoaderCircle, Menu, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Search, Server,
  Settings2, ShieldCheck, Square, Trash2, UsersRound, Workflow, X, Music2,
} from "lucide-react";
import { hasDesktopBridge } from "./bridge";
import type { UpdateInfo, UpdateProgress } from "./bridge";
import type { AccountState, AccountView, CreateJobDraft, JobOutputView, JobStatus, JobView, ViewId, WorkflowOutputView, WorkflowParameterView, WorkflowSemanticType, WorkflowView } from "./types";

const initialAccounts: AccountView[] = [];
const initialWorkflows: WorkflowView[] = [];
const initialJobs: JobView[] = [];

function loadSavedWorkflows(): WorkflowView[] {
  try {
    const saved = localStorage.getItem("rh-runner.workflows.v1");
    if (!saved) return initialWorkflows.map(migrateWorkflowView);
    const parsed = JSON.parse(saved) as WorkflowView[];
    return Array.isArray(parsed) && parsed.length ? parsed.map(migrateWorkflowView) : initialWorkflows.map(migrateWorkflowView);
  } catch { return initialWorkflows.map(migrateWorkflowView); }
}

function migrateWorkflowView(workflow: WorkflowView): WorkflowView {
  const source = workflow;
  let parameters = source.parameters.map(parameter => migrateParameterView(parameter, source.id === "wf-h3"));
  // Browser/demo builds can retain an older WorkflowView in localStorage and
  // do not have the raw API graph available for the backend migration. Repair
  // the one known historical omission locally so old H3 profiles immediately
  // show all three ResolutionSelector widgets without asking users to clear
  // their saved data or re-import the workflow.
  const resolutionAspect = parameters.find(parameter =>
    parameter.classType === "ResolutionSelector" && parameter.fieldName === "aspect_ratio");
  if (resolutionAspect && !parameters.some(parameter =>
    parameter.classType === "ResolutionSelector" && parameter.fieldName === "multiple")) {
    parameters = [...parameters, {
      key: `${resolutionAspect.nodeId}.multiple`,
      id: parameters.some(parameter => parameter.id === "resolution_multiple")
        ? `${resolutionAspect.nodeId}_multiple`
        : "resolution_multiple",
      nodeId: resolutionAspect.nodeId,
      fieldName: "multiple",
      classType: "ResolutionSelector",
      nodeTitle: resolutionAspect.nodeTitle,
      valueType: "integer",
      semanticType: "resolution_multiple",
      defaultValue: 32,
      confidence: 1,
      min: 1,
      step: 1,
      visible: true,
      label: "尺寸倍数",
      displayOrder: 35,
    }];
  }
  return {
    ...source,
    parameters: attachMediaControls(parameters),
    parameterCount: parameters.length,
    needsReview: parameters.some(parameter => parameter.visible !== false && (parameter.semanticType === "unknown" || parameter.confidence < .7)),
  };
}

function migrateParameterView(parameter: WorkflowParameterView, forceH3MediaToggle = false): WorkflowParameterView {
  const withWorkflowDefaults = forceH3MediaToggle && isMediaParameter(parameter) ? { ...parameter, showEnableToggle: true } : parameter;
  const badAspectGuess = withWorkflowDefaults.semanticType === "aspect_ratio" &&
    !isAspectRatioParameter(withWorkflowDefaults.fieldName, withWorkflowDefaults.classType, withWorkflowDefaults.nodeTitle ?? "");
  const base = badAspectGuess ? { ...withWorkflowDefaults, semanticType: "unknown" as const, confidence: .2 } : withWorkflowDefaults;
  if (base.semanticType !== "unknown") return withBuiltinSchema({ ...base, visible: base.visible ?? shouldExposeParameter(base) });
  const mediaType = inferMediaType(base.fieldName, base.classType, base.nodeTitle ?? "");
  const semanticType = mediaType ?? inferParameterType(base.fieldName, base.classType, base.nodeTitle ?? "", base.defaultValue);
  const recognized = semanticType ? { ...base, semanticType, valueType: mediaType ?? base.valueType, confidence: .86 } : base;
  return withBuiltinSchema({ ...recognized, visible: recognized.visible ?? shouldExposeParameter(recognized) });
}

const resolutionSelectorAspectOptions = [
  "1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)",
  "3:4 (Portrait Standard)", "4:3 (Standard)",
  "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)",
];

function withBuiltinSchema(parameter: WorkflowParameterView): WorkflowParameterView {
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "aspect_ratio") {
    return { ...parameter, semanticType: "aspect_ratio", valueType: "select", defaultValue: "9:16 (Portrait Widescreen)", submitDefault: true, options: resolutionSelectorAspectOptions, confidence: 1, displayOrder: 10 };
  }
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "megapixels") {
    return { ...parameter, semanticType: "resolution", valueType: "number", min: 0.1, max: 16, step: 0.1, confidence: 1, displayOrder: 30 };
  }
  if (parameter.classType === "ResolutionSelector" && parameter.fieldName === "multiple") {
    return { ...parameter, semanticType: "resolution_multiple", valueType: "integer", min: 1, step: 1, confidence: 1, displayOrder: 35 };
  }
  return parameter;
}

const nav: Array<{ id: ViewId; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "运行概览", icon: LayoutDashboard },
  { id: "accounts", label: "账号池", icon: UsersRound },
  { id: "workflows", label: "工作流", icon: Workflow },
  { id: "create", label: "创建任务", icon: Plus },
  { id: "jobs", label: "任务队列", icon: ListTodo },
];

const stateLabel: Record<AccountState, string> = {
  UNCHECKED: "未检测",
  SECRET_UNREADABLE: "密钥需重录",
  IDLE: "可用", BUSY: "执行中", REMOTE_BUSY: "远端忙碌", CHECKING: "检测中",
  COOLDOWN: "冷却中", NO_BALANCE: "余额不足", INVALID_KEY: "密钥无效",
  TEMP_UNAVAILABLE: "暂不可用", DISABLED: "已停用",
};

const statusLabel: Record<JobStatus, string> = {
  PENDING: "等待中", ASSIGNED: "已分配", UPLOADING: "上传中", SUBMITTING: "提交中",
  SUBMIT_UNKNOWN: "提交状态未知", REMOTE_QUEUED: "远端排队", RUNNING: "生成中",
  REMOTE_SUCCESS: "生成完成", DOWNLOAD_PENDING: "待下载", DOWNLOADING: "下载中",
  COMPLETED: "已完成", FAILED: "失败", RETRY_WAIT: "等待重试", CANCELLED: "已取消",
};

const generationParameterPriority: Partial<Record<WorkflowSemanticType, number>> = {
  aspect_ratio: 10,
  duration: 20,
  resolution: 30,
  resolution_multiple: 35,
  upscale_factor: 40,
};

function generationParameterOrder(parameter: WorkflowParameterView): number {
  return parameter.displayOrder ?? generationParameterPriority[parameter.semanticType] ?? 999;
}

const terminalJobStatuses = new Set<JobStatus>(["COMPLETED", "FAILED", "CANCELLED", "SUBMIT_UNKNOWN"]);
const activeJobStatuses = new Set<JobStatus>(["ASSIGNED", "UPLOADING", "SUBMITTING", "REMOTE_QUEUED", "RUNNING", "REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING", "RETRY_WAIT"]);

interface UiPreferences {
  notificationDurationMs: number;
  notificationSound: boolean;
}

const defaultUiPreferences: UiPreferences = { notificationDurationMs: 5_000, notificationSound: true };

function loadUiPreferences(): UiPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem("rh-runner.ui-preferences.v1") ?? "{}") as Partial<UiPreferences>;
    return {
      notificationDurationMs: [3_000, 5_000, 8_000].includes(saved.notificationDurationMs ?? 0) ? saved.notificationDurationMs! : defaultUiPreferences.notificationDurationMs,
      notificationSound: typeof saved.notificationSound === "boolean" ? saved.notificationSound : defaultUiPreferences.notificationSound,
    };
  } catch { return defaultUiPreferences; }
}

function localizedFailureReason(error?: string, status?: JobStatus): string {
  if (status === "SUBMIT_UNKNOWN") return "提交请求的响应丢失，无法确认远端是否已经接收。为避免重复扣费，系统没有自动重发。";
  if (!error) return "远端任务失败，但接口没有返回具体原因。";
  if (/^\s*(?:\{\}|\[\]|null|undefined|\[object Object\])\s*$/i.test(error)) return "任务状态查询暂时失败，软件会使用原 taskId 自动重试。";
  if (/NODE_INFO_MISMATCH|field_not_found/i.test(error)) return "工作流节点或字段映射不匹配，请重新导入当前版本的 API JSON。";
  if (/required_input_missing|Required input is missing/i.test(error)) return "工作流缺少必填输入，请检查图片、音频、视频或提示词是否已经上传。";
  if (/prompt_outputs_failed_validation|failed validation/i.test(error)) return "工作流参数校验失败，请检查必填输入和节点开关。";
  if (/insufficient|balance|余额|coins?/i.test(error)) return "账号余额不足，无法继续生成。";
  if (/timeout|timed out|超时/i.test(error)) return "请求或下载超时，请检查网络后重试。";
  if (/unauthorized|invalid.*key|401|403|密钥|API Key/i.test(error)) return "API Key 无效或没有权限，请重新检测账号。";
  if (/cancel/i.test(error)) return "任务已被取消。";
  if (/[一-鿿]/.test(error)) return error;
  return `远端返回错误：${error}`;
}

function playNotificationSound(tone: "success" | "error") {
  try {
    const context = new AudioContext();
    const notes = tone === "success" ? [660, 880] : [330, 220];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * .14;
      oscillator.type = tone === "success" ? "sine" : "triangle";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(.09, start + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + .2);
    });
    window.setTimeout(() => void context.close(), 700);
  } catch { /* Audio is optional when the system has no output device. */ }
}

function isTerminalJobStatus(status: JobStatus) {
  return terminalJobStatuses.has(status);
}

function relativeTime(time?: number) {
  if (!time) return "从未";
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function StatusPill({ status }: { status: JobStatus }) {
  const active = activeJobStatuses.has(status);
  return <span className={`status status-${status.toLowerCase()}`}>{active && <span className="pulse-dot" />}{statusLabel[status]}</span>;
}

function AccountPill({ state, remoteTaskCount }: { state: AccountState; remoteTaskCount?: number }) {
  const label = state === "REMOTE_BUSY" && remoteTaskCount
    ? `远端任务 ${remoteTaskCount}`
    : stateLabel[state];
  return <span className={`account-state account-${state.toLowerCase()}`} title={state === "REMOTE_BUSY" ? "RunningHub 返回该 API Key 当前有远端任务，任务结束后会自动复查" : undefined}><span />{label}</span>;
}

function App() {
  const [view, setView] = useState<ViewId>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [schedulerRunning, setSchedulerRunning] = useState(true);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [workflows, setWorkflows] = useState<WorkflowView[]>(loadSavedWorkflows);
  const [createWorkflowId, setCreateWorkflowId] = useState(initialWorkflows[0]?.id ?? "");
  const [createDraftOverride, setCreateDraftOverride] = useState<CreateJobDraft>();
  const [createRevision, setCreateRevision] = useState(0);
  const [jobs, setJobs] = useState(initialJobs);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [rekeyAccount, setRekeyAccount] = useState<AccountView>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noticePreviewJobId, setNoticePreviewJobId] = useState<string>();
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [appError, setAppError] = useState<string>();
  const [uiPreferences, setUiPreferences] = useState(loadUiPreferences);
  const uiPreferencesRef = useRef(uiPreferences);
  const [taskNotice, setTaskNotice] = useState<{ id: string; jobId: string; tone: "success" | "error"; title: string; message: string }>();
  const knownJobStatuses = useRef(new Map(initialJobs.map(job => [job.id, job.status])));
  const desktopConnected = hasDesktopBridge();

  useEffect(() => {
    if (window.runningHub) {
      void Promise.all([window.runningHub.accounts.list(), window.runningHub.workflows.list(), window.runningHub.jobs.list()])
        .then(([accountRecords, workflowRecords, jobRecords]) => {
          setAccounts(accountRecords);
          setWorkflows(workflowRecords.map(migrateWorkflowView));
          setJobs(jobRecords);
          knownJobStatuses.current = new Map(jobRecords.map(job => [job.id, job.status]));
        })
        .catch(error => setAppError(error instanceof Error ? error.message : "桌面核心连接失败"));
    }
  }, []);

  useEffect(() => {
    if (!window.runningHub?.events) return;
    const removeAccountListener = window.runningHub.events.onAccountUpdated(account => {
      setAccounts(current => current.some(item => item.id === account.id)
        ? current.map(item => item.id === account.id ? account : item)
        : [...current, account]);
    });
    const removeJobListener = window.runningHub.events.onJobUpdated(job => {
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]
        .sort((left, right) => right.createdAt - left.createdAt));
      const previous = knownJobStatuses.current.get(job.id);
      if (previous && previous !== job.status && ["COMPLETED", "FAILED", "SUBMIT_UNKNOWN"].includes(job.status)) {
        const successful = job.status === "COMPLETED";
        const notice = {
          id: `${job.id}:${job.status}:${Date.now()}`,
          jobId: job.id,
          tone: successful ? "success" : "error",
          title: successful ? "任务已完成" : "任务失败",
          message: successful ? job.workflowName : `${job.workflowName}：${localizedFailureReason(job.error, job.status)}`,
        } as const;
        setTaskNotice(notice);
        if (uiPreferencesRef.current.notificationSound) playNotificationSound(notice.tone);
      }
      knownJobStatuses.current.set(job.id, job.status);
    });
    return () => { removeAccountListener(); removeJobListener(); };
  }, []);

  useEffect(() => {
    if (!taskNotice) return;
    const timer = window.setTimeout(() => setTaskNotice(undefined), uiPreferences.notificationDurationMs);
    return () => window.clearTimeout(timer);
  }, [taskNotice, uiPreferences.notificationDurationMs]);

  useEffect(() => {
    uiPreferencesRef.current = uiPreferences;
    localStorage.setItem("rh-runner.ui-preferences.v1", JSON.stringify(uiPreferences));
  }, [uiPreferences]);

  useEffect(() => {
    if (!window.runningHub) localStorage.setItem("rh-runner.workflows.v1", JSON.stringify(workflows));
  }, [workflows]);

  const stats = useMemo(() => ({
    available: accounts.filter(a => a.enabled && a.state === "IDLE").length,
    running: jobs.filter(j => activeJobStatuses.has(j.status)).length,
    queued: jobs.filter(j => j.status === "PENDING").length,
    completed: jobs.filter(j => j.status === "COMPLETED").length,
    coins: accounts.reduce((sum, account) => sum + (Number(account.coins) || 0), 0),
  }), [accounts, jobs]);

  async function refreshAccount(id: string) {
    setRefreshing(id);
    setAccounts(current => current.map(a => a.id === id ? { ...a, state: "CHECKING" } : a));
    try {
      if (window.runningHub) {
        const updated = await window.runningHub.accounts.refresh(id);
        setAccounts(current => current.map(a => a.id === id ? updated : a));
      } else {
        await new Promise(resolve => setTimeout(resolve, 650));
        setAccounts(current => current.map(a => a.id === id ? { ...a, state: a.enabled ? "IDLE" : "DISABLED", lastCheckedAt: Date.now() } : a));
      }
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "账号检测失败");
    } finally { setRefreshing(null); }
  }

  async function addAccounts(label: string, apiKeys: string[], detect: boolean) {
    const uniqueKeys = [...new Set(apiKeys.map(key => key.trim()).filter(Boolean))];
    if (!label.trim() || !uniqueKeys.length) return;
    const added: AccountView[] = [];
    const errors: string[] = [];
    for (const [index, apiKey] of uniqueKeys.entries()) {
      try {
        const accountLabel = uniqueKeys.length === 1 ? label.trim() : `${label.trim()} ${String(index + 1).padStart(2, "0")}`;
        const account = window.runningHub
          ? await window.runningHub.accounts.add({ label: accountLabel, apiKey })
          : { id: crypto.randomUUID(), label: accountLabel, state: "UNCHECKED" as const, enabled: true };
        added.push(account);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `第 ${index + 1} 个账号添加失败`);
      }
    }
    if (added.length) setAccounts(current => [...added.slice().reverse(), ...current.filter(item => !added.some(account => account.id === item.id))]);
    setAddAccountOpen(false);
    if (errors.length) setAppError(errors.join("；"));
    if (detect && window.runningHub) {
      for (const account of added) await refreshAccount(account.id);
    }
  }

  async function refreshAllAccounts() {
    if (!window.runningHub || refreshing) return;
    setRefreshing("all");
    setAccounts(current => current.map(account => account.enabled ? { ...account, state: "CHECKING" } : account));
    try {
      const refreshed = await window.runningHub.accounts.refreshAll();
      setAccounts(current => current.map(account => refreshed.find(item => item.id === account.id) ?? account));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "批量检测失败");
    } finally {
      setRefreshing(null);
    }
  }

  async function replaceAccountKey(id: string, apiKey: string) {
    if (!window.runningHub || !apiKey.trim()) return;
    try {
      const updated = await window.runningHub.accounts.updateKey({ id, apiKey: apiKey.trim() });
      setAccounts(current => current.map(account => account.id === id ? updated : account));
      setRekeyAccount(undefined);
      await refreshAccount(id);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "API Key 更新失败");
    }
  }

  const createJobs = useCallback(async (drafts: CreateJobDraft[]): Promise<boolean> => {
    try {
      if (!drafts.length) return false;
      const created = window.runningHub
        ? await window.runningHub.jobs.createBatch(drafts)
        : drafts.map(draft => {
          const workflow = workflows.find(w => w.id === draft.workflowId) ?? workflows[0];
          return { id: crypto.randomUUID(), workflowName: workflow.name, status: "PENDING" as const, createdAt: Date.now(), outputType: "MP4" };
        });
      setJobs(current => [...created, ...current.filter(item => !created.some(job => job.id === item.id))]);
      setView("jobs");
      return true;
    } catch (error) { setAppError(error instanceof Error ? error.message : "任务创建失败"); return false; }
  }, [workflows]);

  async function toggleScheduler() {
    const next = !schedulerRunning;
    try {
      if (window.runningHub) await (next ? window.runningHub.scheduler.start() : window.runningHub.scheduler.stop());
      setSchedulerRunning(next);
    } catch (error) { setAppError(error instanceof Error ? error.message : "调度器操作失败"); }
  }

  async function revealFile(localPath: string) {
    try {
      if (!window.runningHub) throw new Error("只有桌面应用可以定位本地文件。");
      await window.runningHub.downloads.reveal(localPath);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "无法定位本地文件");
    }
  }

  function openFreshCreate(workflowId = createWorkflowId) {
    setCreateWorkflowId(workflowId);
    setCreateDraftOverride(undefined);
    setCreateRevision(value => value + 1);
    setView("create");
  }

  function regenerateFrom(job: JobView) {
    const workflow = workflows.find(item => item.id === job.inputs?.workflowId);
    if (!workflow || !job.inputs) {
      setAppError("原任务对应的工作流已删除或缺少输入快照，无法建立新的编辑任务。");
      return;
    }
    const draft = createDraft(workflow);
    for (const parameter of job.inputs.parameters) {
      if (workflow.parameters.some(item => item.id === parameter.id)) draft.parameterValues[parameter.id] = parameter.value;
    }
    for (const media of job.inputs.media) {
      if (!workflow.parameters.some(item => item.id === media.parameterId)) continue;
      const mode = media.mode === "replace" ? "replace" : "clear";
      draft.mediaOverrides[media.parameterId] = {
        enabled: mode === "replace",
        mode,
        localPath: media.localPath,
        fileName: media.fileName,
        previewUrl: media.previewUrl,
      };
    }
    setCreateWorkflowId(workflow.id);
    setCreateDraftOverride(draft);
    setCreateRevision(value => value + 1);
    setView("create");
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand"><div className="brand-mark"><Boxes size={21} /></div><div><strong>RH Runner</strong><span>本地任务调度</span></div></div>
        <nav className="nav-list" aria-label="主导航">
          <p className="nav-kicker">工作区</p>
          {nav.map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMobileNav(false); }}><item.icon size={18} /><span>{item.label}</span>{item.id === "jobs" && stats.queued > 0 && <b>{stats.queued}</b>}</button>)}
        </nav>
        <div className="sidebar-footer">
          <div className="connection-card"><span className={desktopConnected ? "connected" : "demo"} /><div><strong>{desktopConnected ? "桌面核心已连接" : "界面演示模式"}</strong><small>{desktopConnected ? "IPC bridge ready" : "等待 Electron IPC"}</small></div></div>
          <button className="settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} />设置</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(v => !v)} aria-label="打开导航"><Menu /></button>
          <div className="topbar-title"><span>RUNNINGHUB / {nav.find(n => n.id === view)?.label}</span></div>
          <div className="topbar-actions">
            <div className="scheduler-state"><span className={schedulerRunning ? "on" : "off"} /><div><small>调度器</small><strong>{schedulerRunning ? "运行中" : "已暂停"}</strong></div></div>
            <button className={`icon-toggle ${schedulerRunning ? "stop" : "start"}`} title={schedulerRunning ? "暂停调度" : "启动调度"} onClick={() => void toggleScheduler()}>{schedulerRunning ? <Square size={15} /> : <Play size={16} />}</button>
            <button className="primary compact" onClick={() => openFreshCreate()}><Plus size={17} />新建任务</button>
          </div>
        </header>

        <div className="page">
          {appError && <div className="import-feedback error"><AlertTriangle size={17} /><span>{appError}</span><button className="icon-button" onClick={() => setAppError(undefined)}><X size={15} /></button></div>}
          {view === "overview" && <Overview stats={stats} accounts={accounts} jobs={jobs} onView={setView} schedulerRunning={schedulerRunning} />}
          {view === "accounts" && <Accounts accounts={accounts} refreshing={refreshing} onRefresh={refreshAccount} onRefreshAll={refreshAllAccounts} onAdd={() => setAddAccountOpen(true)} onOpenApiKeys={() => { const url = "https://www.runninghub.ai/zh-cn/call-api/bill-task?tab=keys&type=consumer"; if (window.runningHub) void window.runningHub.external.openApiKeys().catch(error => setAppError(error instanceof Error ? error.message : "无法打开 API Key 页面")); else window.open(url, "_blank", "noopener,noreferrer"); }} onRekey={setRekeyAccount} onToggle={id => { const account = accounts.find(item => item.id === id); if (!account) return; if (window.runningHub) void window.runningHub.accounts.setEnabled(id, !account.enabled).then(updated => setAccounts(list => list.map(item => item.id === id ? updated : item))).catch(error => setAppError(error instanceof Error ? error.message : "账号状态更新失败")); else setAccounts(list => list.map(a => a.id === id ? { ...a, enabled: !a.enabled, state: a.enabled ? "DISABLED" : "IDLE" } : a)); }} onRemove={id => { const account = accounts.find(item => item.id === id); if (!account || !window.confirm(`删除账号“${account.label}”？已保存的 API Key 将一并删除。`)) return; if (window.runningHub) void window.runningHub.accounts.remove(id).then(() => setAccounts(list => list.filter(item => item.id !== id))).catch(error => setAppError(error instanceof Error ? error.message : "账号删除失败")); else setAccounts(list => list.filter(item => item.id !== id)); }} />}
          {view === "workflows" && <Workflows workflows={workflows} onImport={workflow => setWorkflows(current => [workflow, ...current.filter(item => item.id !== workflow.id)])} onUpdate={workflow => setWorkflows(current => current.map(item => item.id === workflow.id ? workflow : item))} onDelete={async workflowId => { if (window.runningHub) await window.runningHub.workflows.remove(workflowId); setWorkflows(current => current.filter(item => item.id !== workflowId)); if (createWorkflowId === workflowId) setCreateWorkflowId(workflows.find(item => item.id !== workflowId)?.id ?? ""); }} onUse={workflowId => openFreshCreate(workflowId)} />}
          <div hidden={view !== "create"}><CreateJob key={`${createWorkflowId}:${createRevision}`} workflows={workflows} initialWorkflowId={createWorkflowId} initialDraft={createDraftOverride} onCreate={createJobs} /></div>
          {view === "jobs" && <Jobs jobs={jobs} onReveal={revealFile} onCancel={id => { const job = jobs.find(item => item.id === id); if (!job || !window.confirm(`确定停止“${job.workflowName}”的生成任务？已经产生的远端费用可能无法退回。`)) return; if (window.runningHub) void window.runningHub.jobs.cancel(id).then(updated => setJobs(list => list.map(item => item.id === id ? updated : item))).catch(error => setAppError(error instanceof Error ? error.message : "停止远端生成失败")); else setJobs(list => list.map(item => item.id === id ? { ...item, status: "CANCELLED", error: "已由用户取消" } : item)); }} onRegenerate={regenerateFrom} onDelete={id => { const job = jobs.find(item => item.id === id); if (!job || !window.confirm(`删除任务“${job.workflowName}”？下载到本地的媒体文件不会被删除。`)) return; if (window.runningHub) void window.runningHub.jobs.remove(id).then(() => setJobs(list => list.filter(item => item.id !== id))).catch(error => setAppError(error instanceof Error ? error.message : "任务删除失败")); else setJobs(list => list.filter(item => item.id !== id)); }} />}
        </div>
      </main>
      {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
      {addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onAdd={addAccounts} />}
      {rekeyAccount && <ReplaceAccountKeyModal account={rekeyAccount} onClose={() => setRekeyAccount(undefined)} onSave={replaceAccountKey} />}
      {settingsOpen && <SettingsModal preferences={uiPreferences} onPreferencesChange={setUiPreferences} onClose={() => setSettingsOpen(false)} />}
      {noticePreviewJobId && jobs.find(job => job.id === noticePreviewJobId) && <TaskPreviewModal job={jobs.find(job => job.id === noticePreviewJobId)!} onReveal={revealFile} onClose={() => setNoticePreviewJobId(undefined)} />}
      {taskNotice && <div className={`task-toast ${taskNotice.tone}`} role="status"><div className="task-toast-icon">{taskNotice.tone === "success" ? <Check size={16} /> : <AlertTriangle size={16} />}</div><span><strong>{taskNotice.title}</strong><small>{taskNotice.message}</small></span>{taskNotice.tone === "success" && <button className="task-toast-preview" type="button" onClick={() => { setTaskNotice(undefined); setNoticePreviewJobId(taskNotice.jobId); }}>预览</button>}<button className="task-toast-close" type="button" onClick={() => setTaskNotice(undefined)} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><p>{eyebrow}</p><h1>{title}</h1><span>{description}</span></div>{action}</div>;
}

function Overview({ stats, accounts, jobs, onView, schedulerRunning }: { stats: { available: number; running: number; queued: number; completed: number; coins: number }; accounts: AccountView[]; jobs: JobView[]; onView: (v: ViewId) => void; schedulerRunning: boolean }) {
  const recent = jobs.filter(job => !["FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status)).sort((left, right) => right.createdAt - left.createdAt).slice(0, 4);
  return <>
    <PageHeading eyebrow="运行中心" title="运行概览" description="查看账号容量、任务执行和下载状态。" action={<button className="secondary" onClick={() => onView("jobs")}>查看全部任务<ArrowRight size={16} /></button>} />
    <section className="metric-grid">
      <Metric icon={Server} label="可用账号" value={`${stats.available} / ${accounts.length}`} note="每个账号同时执行 1 个任务" tone="blue" />
      <Metric icon={Activity} label="正在执行" value={String(stats.running)} note={schedulerRunning ? "调度器正在分配任务" : "调度器已暂停"} tone="violet" />
      <Metric icon={Clock3} label="队列等待" value={String(stats.queued)} note={stats.queued ? "将按创建顺序执行" : "当前没有等待任务"} tone="amber" />
      <Metric icon={CircleDollarSign} label="RH 币余额" value={stats.coins.toLocaleString()} note="来自最近一次账号检测" tone="green" />
    </section>
    <section className="dashboard-grid">
      <div className="panel activity-panel">
        <div className="panel-head"><div><h2>任务活动</h2><p>全局队列与远端执行进度</p></div><button className="ghost" onClick={() => onView("jobs")}>任务队列<ArrowRight size={15} /></button></div>
        <div className="job-stack">{recent.map(job => <JobRow key={job.id} job={job} compact />)}</div>
      </div>
      <div className="panel capacity-panel">
        <div className="panel-head"><div><h2>账号容量</h2><p>本地占用优先于远端状态</p></div><ShieldCheck size={20} /></div>
        <div className="account-stack">{accounts.map(account => <div className="mini-account" key={account.id}><div className="avatar">{account.label.slice(0, 1)}</div><div><strong>{account.label}</strong><span>{account.apiType ?? "未检测"} · {account.coins ?? "—"} RH 币</span></div><AccountPill state={account.state} remoteTaskCount={account.remoteTaskCount} /></div>)}</div>
        <button className="full-secondary" onClick={() => onView("accounts")}>管理账号池</button>
      </div>
    </section>
  </>;
}

function Metric({ icon: Icon, label, value, note, tone }: { icon: typeof Server; label: string; value: string; note: string; tone: string }) {
  return <article className={`metric metric-${tone}`}><div className="metric-top"><span className="metric-icon"><Icon size={19} /></span><MoreHorizontal size={18} /></div><strong>{value}</strong><h3>{label}</h3><p>{note}</p></article>;
}

function Accounts({ accounts, refreshing, onRefresh, onRefreshAll, onAdd, onRekey, onToggle, onRemove, onOpenApiKeys }: { accounts: AccountView[]; refreshing: string | null; onRefresh: (id: string) => void; onRefreshAll: () => void; onAdd: () => void; onRekey: (account: AccountView) => void; onToggle: (id: string) => void; onRemove: (id: string) => void; onOpenApiKeys: () => void }) {
  return <>
    <PageHeading eyebrow="账号管理" title="账号池" description="检测余额与远端占用状态，调度时每个账号只领取一个任务。" action={<div className="account-heading-actions"><button className="secondary" onClick={onOpenApiKeys}><ExternalLink size={16} />获取 API Key</button><button className="secondary" onClick={onRefreshAll} disabled={Boolean(refreshing)}>{refreshing === "all" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}检测全部</button><button className="primary" onClick={onAdd}><Plus size={17} />添加账号</button></div>} />
    <div className="panel table-panel">
      <div className="table-toolbar account-toolbar"><div className="toolbar-note"><AlertTriangle size={16} />API Key 明文保存在本机数据库</div></div>
      <div className="data-table account-table">
        <div className="table-header"><span>账号</span><span>状态</span><span>RH 币</span><span>API 类型</span><span>最近检测</span><span>操作</span></div>
        {accounts.map(account => <div className="table-row" key={account.id}>
          <div className="identity"><div className="avatar large">{account.label.slice(0, 1)}</div><div><strong>{account.label}</strong><small>{account.id}</small></div></div>
          <AccountPill state={account.state} remoteTaskCount={account.remoteTaskCount} />
          <strong className="coin-value">{account.coins ?? "—"}</strong>
          <span className="mono-label">{account.apiType ?? "—"}</span>
          <span className="muted">{relativeTime(account.lastCheckedAt)}</span>
          <div className="row-actions"><button className="icon-button" onClick={() => onRefresh(account.id)} disabled={Boolean(refreshing)} title="检测账号">{refreshing === account.id ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button><button className="icon-button" onClick={() => onRekey(account)} disabled={Boolean(account.currentJobId)} title={account.currentJobId ? "当前账号正在执行任务，不能更换 API Key" : "重新录入 API Key"}><KeyRound size={16} /></button><button className={`switch ${account.enabled ? "checked" : ""}`} onClick={() => onToggle(account.id)} disabled={Boolean(account.currentJobId)} title={account.currentJobId ? "当前账号正在执行任务，请任务结束后再停用" : undefined} aria-label={account.enabled ? "停用账号" : "启用账号"}><span /></button><button className="icon-button danger" onClick={() => onRemove(account.id)} title="删除账号"><Trash2 size={16} /></button></div>
        </div>)}
      </div>
    </div>
  </>;
}

function Workflows({ workflows, onImport, onUpdate, onDelete, onUse }: { workflows: WorkflowView[]; onImport: (workflow: WorkflowView) => void; onUpdate: (workflow: WorkflowView) => void; onDelete: (workflowId: string) => void | Promise<void>; onUse: (workflowId: string) => void }) {
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowView>();
  const [editingOutputs, setEditingOutputs] = useState<WorkflowView>();
  const [editingVisibility, setEditingVisibility] = useState<WorkflowView>();
  const [deleting, setDeleting] = useState<WorkflowView>();
  const [feedback, setFeedback] = useState<string>();
  const [exporting, setExporting] = useState<string>();
  async function exportWorkflow(workflow: WorkflowView) {
    if (!window.runningHub) return setFeedback("工作流配置包只能在桌面版中导出。");
    setExporting(workflow.id);
    try {
      const savedPath = await window.runningHub.workflows.exportPackage(workflow.id);
      if (savedPath) setFeedback(`已导出“${workflow.name}”：${savedPath}`);
    } catch (cause) {
      setFeedback(cause instanceof Error ? `导出失败：${cause.message}` : "工作流导出失败");
    } finally { setExporting(undefined); }
  }
  return <>
    <PageHeading eyebrow="工作流管理" title="工作流" description="保存 RunningHub 地址，扫描 API JSON，并在 Profile 编辑器中确认所有节点。" action={<button className="primary" onClick={() => setImportOpen(true)}><CloudUpload size={17} />导入工作流</button>} />
    {feedback && <div className="import-feedback success"><Check size={17} /><span>{feedback}</span></div>}
    <div className="workflow-grid">{workflows.map(workflow => {
      const mediaCount = workflow.parameters.filter(isMediaParameter).length;
      const unknownCount = workflow.parameters.filter(parameter => parameter.semanticType === "unknown").length;
      return <article className="workflow-card" key={workflow.id}>
      <div className="workflow-card-top"><span className="workflow-icon"><Workflow size={22} /></span><div className="workflow-card-actions"><button className="icon-button" onClick={() => void exportWorkflow(workflow)} disabled={exporting === workflow.id} title="导出可移植工作流包">{exporting === workflow.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</button><button className="icon-button" onClick={() => setEditing(workflow)} title="编辑 Profile"><Pencil size={16} /></button><button className="icon-button danger" onClick={() => setDeleting(workflow)} title="删除工作流"><Trash2 size={16} /></button></div></div>
      <div className="workflow-copy"><div className="workflow-title"><h2>{workflow.name}</h2>{workflow.needsReview ? <span className="review-badge">待检查</span> : <span className="ready-badge"><Check size={12} />可运行</span>}</div><p>ID {workflow.runningHubWorkflowId}</p>{workflow.functionDescription && <p className="workflow-description">{workflow.functionDescription}</p>}{workflow.usageInstructions && <p className="workflow-usage"><strong>使用：</strong>{workflow.usageInstructions}</p>}{workflow.sourceUrl && <a className="workflow-link" href={workflow.sourceUrl} target="_blank" rel="noreferrer"><Link2 size={12} />打开 RunningHub 工作流</a>}</div>
      <div className="workflow-breakdown"><span>{workflow.parameterCount} 个参数</span><span>{mediaCount} 个媒体</span><span>{workflow.parameters.filter(parameter => parameter.showEnableToggle || parameter.mediaControl).length} 个媒体开关</span><span>{workflow.outputs?.length ?? 0} 个输出</span><span className={unknownCount ? "warn" : ""}>{unknownCount} 个待确认</span></div>
      <div className="workflow-stats"><span><b>v{workflow.profileVersion}</b> Profile</span><span><b>{mediaCount}</b> 上传槽</span><span>{relativeTime(workflow.updatedAt)}</span></div>
      <div className="workflow-footer"><span className="workflow-health"><span className={workflow.needsReview ? "review" : "ready"} />{workflow.needsReview ? "需要人工确认" : "参数映射完整"}</span>{workflow.outputs?.length ? <button className="secondary small" onClick={() => setEditingOutputs(workflow)}><Play size={14} />输出</button> : null}<button className="secondary small" onClick={() => setEditingVisibility(workflow)}><Settings2 size={14} />显示项</button><button className="secondary small" onClick={() => setEditing(workflow)}><Pencil size={14} />参数</button><button className="primary small" onClick={() => onUse(workflow.id)}>创建任务<ArrowRight size={15} /></button></div>
    </article>})}</div>
    {importOpen && <ImportWorkflowModal onClose={() => setImportOpen(false)} onImport={workflow => { onImport(workflow); setFeedback(importSummary(workflow)); setImportOpen(false); }} />}
    {editing && <WorkflowEditorModal workflow={editing} onClose={() => setEditing(undefined)} onSave={async workflow => { const saved = window.runningHub ? await window.runningHub.workflows.updateProfile(workflow) : workflow; onUpdate(saved); setFeedback(`已保存 ${saved.name} Profile v${saved.profileVersion}：${saved.parameters.length} 个参数，${saved.parameters.filter(isMediaParameter).length} 个媒体节点。`); setEditing(undefined); }} />}
    {editingOutputs && <WorkflowOutputEditorModal workflow={editingOutputs} onClose={() => setEditingOutputs(undefined)} onSave={async workflow => { const saved = window.runningHub ? await window.runningHub.workflows.updateProfile(workflow) : workflow; onUpdate(saved); setFeedback(`已保存 ${saved.outputs?.length ?? 0} 个输出节点配置。`); setEditingOutputs(undefined); }} />}
    {editingVisibility && <ParameterVisibilityModal workflow={editingVisibility} onClose={() => setEditingVisibility(undefined)} onSave={async workflow => { const saved = window.runningHub ? await window.runningHub.workflows.updateProfile(workflow) : workflow; onUpdate(saved); setFeedback(`已更新表单显示项：显示 ${saved.parameters.filter(item => item.visible !== false).length} 项，隐藏 ${saved.parameters.filter(item => item.visible === false).length} 项。`); setEditingVisibility(undefined); }} />}
    {deleting && <DeleteWorkflowModal workflow={deleting} onClose={() => setDeleting(undefined)} onConfirm={async () => { await onDelete(deleting.id); setFeedback(`已删除工作流：${deleting.name}`); setDeleting(undefined); }} />}
  </>;
}

function importSummary(workflow: WorkflowView) {
  const count = (type: "image" | "video" | "audio") => workflow.parameters.filter(item => item.valueType === type).length;
  const switches = workflow.parameters.filter(item => item.showEnableToggle || item.mediaControl).length;
  return `检测完成：${workflow.parameters.length} 个参数，图片 ${count("image")} 个，视频 ${count("video")} 个，音频 ${count("audio")} 个，关联开关 ${switches} 个。`;
}

function extractWorkflowId(value: string): string | undefined {
  const clean = value.trim();
  if (/^\d{8,}$/.test(clean)) return clean;
  const routeId = clean.match(/(?:^|\/)(?:run\/workflow|workflow|post)\/(\d{8,})(?:[/?#]|$)/i)?.[1];
  if (routeId) return routeId;
  try {
    const url = new URL(clean);
    for (const key of ["workflowId", "webappId", "id"]) {
      const candidate = url.searchParams.get(key);
      if (candidate && /^\d{8,}$/.test(candidate)) return candidate;
    }
    return url.pathname.match(/\d{8,}/g)?.at(-1);
  } catch { return undefined; }
}

function ImportWorkflowModal({ onClose, onImport }: { onClose: () => void; onImport: (workflow: WorkflowView) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [raw, setRaw] = useState<Record<string, unknown>>();
  const [parameters, setParameters] = useState<WorkflowParameterView[]>([]);
  const [portable, setPortable] = useState<Record<string, unknown>>();
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string>();
  const workflowId = extractWorkflowId(address);
  const media = parameters.filter(isMediaParameter);

  async function readWorkflow(file?: File) {
    if (!file) return;
    setError(undefined);
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      if (parsed.format === "runninghub-runner-workflow") {
        const workflow = parsed.workflow as Record<string, unknown> | undefined;
        const profile = parsed.profile as Record<string, unknown> | undefined;
        if (!workflow || !profile || !workflow.apiJson || !Array.isArray(profile.parameters)) throw new Error("工作流配置包结构不完整。");
        const packagedParameters = (profile.parameters as WorkflowParameterView[]).map(parameter => migrateParameterView(parameter));
        setPortable(parsed);
        setRaw(workflow.apiJson as Record<string, unknown>);
        setParameters(packagedParameters);
        setName(typeof workflow.name === "string" ? workflow.name : file.name.replace(/\.rhworkflow\.json$/i, ""));
        setAddress(typeof workflow.sourceUrl === "string" ? workflow.sourceUrl : String(workflow.runningHubWorkflowId ?? ""));
        setFileName(file.name);
        return;
      }
      const detected = discoverParameters(parsed);
      if (!detected.length) throw new Error("没有检测到 API-format 节点。请从 ComfyUI 导出 API JSON，而不是普通 UI Workflow JSON。");
      setPortable(undefined);
      setRaw(parsed);
      setParameters(detected);
      setFileName(file.name);
      if (!name) setName(file.name.replace(/\.json$/i, ""));
    } catch (cause) {
      setRaw(undefined); setParameters([]); setPortable(undefined); setFileName("");
      setError(cause instanceof Error ? cause.message : "JSON 读取失败");
    }
  }

  async function submit() {
    if (!workflowId) return setError("请输入有效的 RunningHub 工作流地址或 Workflow ID。");
    if (!name.trim()) return setError("请输入工作流名称。");
    if (!raw || !parameters.length) return setError("请上传对应的 API JSON。");
    try {
      const portableProfile = portable?.profile as Record<string, unknown> | undefined;
      const base = window.runningHub
        ? portable
          ? await window.runningHub.workflows.importPortablePackage(portable)
          : await window.runningHub.workflows.importApiJson({ name: name.trim(), runningHubWorkflowId: workflowId, sourceUrl: /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined, workflow: raw })
        : { id: crypto.randomUUID(), name: name.trim(), runningHubWorkflowId: workflowId, parameterCount: parameters.length, parameters, outputs: portable && Array.isArray(portableProfile?.outputs) ? portableProfile.outputs as WorkflowOutputView[] : discoverOutputs(raw), needsReview: parameters.some(item => item.visible !== false && item.confidence < .7), profileVersion: 1, updatedAt: Date.now() } satisfies WorkflowView;
      onImport({ ...base, sourceUrl: /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工作流保存失败"); }
  }

  return <div className="modal-backdrop" role="presentation"><div className="modal workflow-import-modal" role="dialog" aria-modal="true" aria-label="导入工作流"><div className="modal-head"><div><p>WORKFLOW IMPORT</p><h2>导入工作流</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="import-steps"><span className={address ? "done" : "active"}>1 地址</span><i /><span className={raw ? "done" : address ? "active" : ""}>2 工作流文件</span><i /><span className={raw && workflowId ? "active" : ""}>3 确认</span></div><div className="form-grid import-fields"><label>工作流名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：H3 多参考生视频" /></label><label>RunningHub 地址或 Workflow ID<input value={address} onChange={event => { setAddress(event.target.value); setError(undefined); }} placeholder="粘贴地址或输入数字 ID" />{address && <small className={workflowId ? "field-ok" : "field-error"}>{workflowId ? `识别到 ID：${workflowId}` : "没有从地址中识别到 Workflow ID"}</small>}</label></div><label className={`workflow-json-drop ${raw ? "loaded" : ""}`}><input type="file" accept="application/json,.json,.rhworkflow.json" onChange={event => void readWorkflow(event.target.files?.[0])} /><FileJson size={25} /><strong>{fileName || "选择 API JSON 或工作流配置包"}</strong><span>{raw ? portable ? "已识别配置包，将保留修正后的参数和媒体设置" : "已完成参数扫描，重新选择可替换" : "自动识别原始 API JSON 与 .rhworkflow.json 配置包"}</span></label>{raw && <div className="detection-result"><div className="detection-title"><BadgeCheck size={18} /><div><strong>{portable ? "已识别可移植配置包" : "检测完成"}</strong><span>{parameters.length} 个可编辑参数</span></div></div><div className="detection-counts"><span><b>{media.filter(item => item.valueType === "image").length}</b> 图片</span><span><b>{media.filter(item => item.valueType === "video").length}</b> 视频</span><span><b>{media.filter(item => item.valueType === "audio").length}</b> 音频</span><span><b>{parameters.filter(item => item.semanticType === "unknown").length}</b> 待确认</span></div><div className="detected-media-list">{media.length ? media.map(item => <span key={item.id}>{item.nodeTitle} <code>{item.key}</code></span>) : <span className="none">没有自动识别到媒体节点，可保存后在 Profile 编辑器手动指定。</span>}</div></div>}{error && <div className="import-feedback error modal-feedback"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void submit()} disabled={!workflowId || !raw || !name.trim()}>{portable ? "导入已配置工作流" : "保存工作流"}</button></div></div></div>;
}

const semanticOptions: WorkflowSemanticType[] = ["prompt", "negative_prompt", "image", "video", "audio", "duration", "fps", "frames", "width", "height", "aspect_ratio", "resolution", "resolution_multiple", "upscale_factor", "seed", "steps", "cfg", "sampler", "scheduler", "denoise", "model", "lora", "unknown"];

function ParameterVisibilityModal({ workflow, onClose, onSave }: { workflow: WorkflowView; onClose: () => void; onSave: (workflow: WorkflowView) => void | Promise<void> }) {
  const [parameters, setParameters] = useState(() => workflow.parameters.map(parameter => ({ ...parameter, visible: parameter.visible !== false })));
  const [filter, setFilter] = useState<"all" | "visible" | "hidden">("all");
  const shown = parameters.filter(parameter => filter === "all" || (filter === "visible" ? parameter.visible !== false : parameter.visible === false));
  function setVisible(id: string, visible: boolean) {
    setParameters(current => current.map(parameter => parameter.id === id ? { ...parameter, visible } : parameter));
  }
  function autoClean() {
    setParameters(current => current.map(parameter => ({ ...parameter, visible: shouldExposeParameter(parameter) })));
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal visibility-modal" role="dialog" aria-modal="true" aria-label="设置参数显示项"><div className="modal-head"><div><p>FORM VISIBILITY</p><h2>设置创建任务表单</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><p className="visibility-intro">隐藏参数不会从 Profile 删除，提交任务时仍使用它的默认值。这里只控制创建任务页面显示什么。</p><div className="editor-toolbar"><div className="segmented">{(["all", "visible", "hidden"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? `全部 ${parameters.length}` : value === "visible" ? `显示 ${parameters.filter(item => item.visible !== false).length}` : `隐藏 ${parameters.filter(item => item.visible === false).length}`}</button>)}</div><div className="visibility-bulk"><button className="secondary small" onClick={autoClean}>自动隐藏内部参数</button><button className="secondary small" onClick={() => setParameters(current => current.map(item => ({ ...item, visible: true })))}>全部显示</button></div></div><div className="visibility-list">{shown.map(parameter => <div className={`visibility-row ${parameter.visible === false ? "hidden" : ""}`} key={parameter.id}><div><strong>{parameterLabel(parameter)}</strong><span>{parameter.nodeTitle} · <code>{parameter.key}</code></span></div><span className="visibility-kind">{parameter.semanticType === "unknown" ? "内部 / 未识别" : semanticLabels[parameter.semanticType] ?? parameter.valueType}</span><button type="button" className={`switch ${parameter.visible !== false ? "checked" : ""}`} onClick={() => setVisible(parameter.id, parameter.visible === false)} aria-label={parameter.visible === false ? "显示参数" : "隐藏参数"}><span /></button></div>)}</div><div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void onSave({ ...workflow, parameters, needsReview: parameters.some(parameter => parameter.visible !== false && (parameter.semanticType === "unknown" || parameter.confidence < .7)), profileVersion: workflow.profileVersion + 1, updatedAt: Date.now() })}>保存显示设置</button></div></div></div>;
}

function DeleteWorkflowModal({ workflow, onClose, onConfirm }: { workflow: WorkflowView; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    setBusy(true); setError(undefined);
    try { await onConfirm(); } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal delete-workflow-modal" role="alertdialog" aria-modal="true" aria-label="删除工作流"><div className="delete-icon"><Trash2 size={22} /></div><h2>删除“{workflow.name}”？</h2><p>该工作流将从工作流列表和创建任务页面移除。已有任务的快照、状态与输出仍会完整保留。</p>{error && <div className="import-feedback error modal-feedback"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="modal-actions"><button className="secondary" onClick={onClose} disabled={busy}>取消</button><button className="danger-button" onClick={() => void remove()} disabled={busy}>{busy ? "正在删除…" : "确认删除"}</button></div></div></div>;
}

function WorkflowOutputEditorModal({ workflow, onClose, onSave }: { workflow: WorkflowView; onClose: () => void; onSave: (workflow: WorkflowView) => void | Promise<void> }) {
  const [outputs, setOutputs] = useState(() => structuredClone(workflow.outputs ?? []));
  function update(index: number, patch: Partial<WorkflowOutputView>) {
    setOutputs(current => current.map((output, itemIndex) => itemIndex === index ? { ...output, ...patch } : output));
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal output-editor-modal" role="dialog" aria-modal="true" aria-label="编辑输出节点"><div className="modal-head"><div><p>OUTPUT PROFILE</p><h2>输出与采样阶段</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="output-editor-list">{outputs.map((output, index) => <div className="output-editor-row" key={output.id}><div className="output-editor-index">{String(index + 1).padStart(2, "0")}</div><label>显示名称<input value={output.label} onChange={event => update(index, { label: event.target.value })} /></label><label>节点 ID<input value={output.nodeId} onChange={event => update(index, { nodeId: event.target.value })} /></label><label>类型<select value={output.mediaType} onChange={event => update(index, { mediaType: event.target.value as WorkflowOutputView["mediaType"] })}><option value="video">视频</option><option value="image">图片</option><option value="audio">音频</option><option value="unknown">其他</option></select><ChevronDown size={15} /></label><label>阶段<input type="number" min={1} value={output.stage} onChange={event => update(index, { stage: Math.max(1, Number(event.target.value) || 1) })} /></label><label className="inline-check"><input type="checkbox" checked={output.saveOutput ?? true} onChange={event => update(index, { saveOutput: event.target.checked })} />工作流保存该输出</label></div>)}</div><div className="output-review-note"><AlertTriangle size={16} /><p><strong>单工作流无法在一采处暂停</strong><span>当前 H3 JSON 的一采节点 264 设置为不保存，二采节点 214 设置为保存。若要一采预览后决定是否二采，需要在 RunningHub 拆成两个工作流，再由软件建立阶段验收队列。</span></p></div><div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void onSave({ ...workflow, outputs, profileVersion: workflow.profileVersion + 1, updatedAt: Date.now() })}>保存输出配置</button></div></div></div>;
}

function WorkflowEditorModal({ workflow, onClose, onSave }: { workflow: WorkflowView; onClose: () => void; onSave: (workflow: WorkflowView) => void | Promise<void> }) {
  const [draft, setDraft] = useState<WorkflowView>(() => ({ ...workflow, parameters: workflow.parameters.map(parameter => ({ ...parameter })) }));
  const [filter, setFilter] = useState<"all" | "media" | "review">("all");
  const [error, setError] = useState<string>();
  const shown = draft.parameters.map((parameter, index) => ({ parameter, index })).filter(({ parameter }) => filter === "all" || (filter === "media" && isMediaParameter(parameter)) || (filter === "review" && (parameter.semanticType === "unknown" || parameter.confidence < .7)));
  const booleanParameters = draft.parameters.filter(parameter => parameter.valueType === "boolean");

  function updateParameter(index: number, patch: Partial<WorkflowParameterView>) {
    setDraft(current => ({ ...current, parameters: current.parameters.map((parameter, itemIndex) => itemIndex === index ? { ...parameter, ...patch } : parameter) }));
  }

  function addMedia() {
    const number = draft.parameters.filter(isMediaParameter).length + 1;
    const parameter: WorkflowParameterView = { id: `image_manual_${Date.now()}`, key: `.image`, nodeId: "", fieldName: "image", classType: "LoadImage", nodeTitle: `Image ${number}`, valueType: "image", semanticType: "image", defaultValue: "None", confidence: 1 };
    setDraft(current => ({ ...current, parameters: [...current.parameters, parameter] }));
    setFilter("media");
  }

  async function save() {
    const id = extractWorkflowId(draft.runningHubWorkflowId);
    if (!id) return setError("Workflow ID 无效。");
    if (draft.parameters.some(parameter => !parameter.nodeId.trim() || !parameter.fieldName.trim())) return setError("每个参数都必须填写 nodeId 和 fieldName。");
    const keys = new Set<string>();
    for (const parameter of draft.parameters) {
      const key = `${parameter.nodeId}.${parameter.fieldName}`;
      if (keys.has(key)) return setError(`节点映射重复：${key}`);
      keys.add(key);
      if (parameter.mediaControl && !draft.parameters.some(candidate => candidate.id === parameter.mediaControl?.parameterId && candidate.valueType === "boolean")) return setError(`媒体节点 ${parameter.nodeTitle ?? parameter.id} 的关联开关无效。`);
    }
    const parameters = draft.parameters.map(parameter => ({ ...parameter, key: `${parameter.nodeId}.${parameter.fieldName}` }));
    await onSave({ ...draft, runningHubWorkflowId: id, parameters, parameterCount: parameters.length, needsReview: parameters.some(parameter => parameter.visible !== false && (parameter.semanticType === "unknown" || parameter.confidence < .7)), profileVersion: draft.profileVersion + 1, updatedAt: Date.now() });
  }

  return <div className="modal-backdrop" role="presentation"><div className="modal profile-editor-modal" role="dialog" aria-modal="true" aria-label="编辑工作流 Profile"><div className="modal-head"><div><p>PROFILE EDITOR</p><h2>编辑参数映射</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="editor-summary"><label>工作流名称<input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label><label>Workflow ID<input value={draft.runningHubWorkflowId} readOnly title="更换 Workflow ID 需要重新导入对应 API JSON" /></label><label className="wide-field">RunningHub 地址（可选）<input value={draft.sourceUrl ?? ""} onChange={event => setDraft(current => ({ ...current, sourceUrl: event.target.value || undefined }))} placeholder="https://www.runninghub.ai/..." /></label></div><div className="editor-toolbar"><div className="segmented">{(["all", "media", "review"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? `全部 ${draft.parameters.length}` : value === "media" ? `媒体 ${draft.parameters.filter(isMediaParameter).length}` : `待确认 ${draft.parameters.filter(item => item.semanticType === "unknown" || item.confidence < .7).length}`}</button>)}</div><button className="secondary small" onClick={addMedia}><Plus size={15} />添加媒体节点</button></div><div className="parameter-editor-list">{shown.map(({ parameter, index }) => <div className={`parameter-editor-row ${isMediaParameter(parameter) ? "media" : ""}`} key={parameter.id}><div className="parameter-editor-title"><span className="parameter-kind">{isMediaParameter(parameter) ? <ImagePlus size={16} /> : <Settings2 size={16} />}</span><label>显示名称<input value={parameter.nodeTitle ?? ""} onChange={event => updateParameter(index, { nodeTitle: event.target.value })} /></label><button className="icon-button danger" onClick={() => setDraft(current => ({ ...current, parameters: current.parameters.filter((_, itemIndex) => itemIndex !== index) }))} title="移除参数"><Trash2 size={15} /></button></div><div className="parameter-editor-grid"><label>nodeId<input value={parameter.nodeId} onChange={event => updateParameter(index, { nodeId: event.target.value, key: `${event.target.value}.${parameter.fieldName}` })} /></label><label>fieldName<input value={parameter.fieldName} onChange={event => updateParameter(index, { fieldName: event.target.value, key: `${parameter.nodeId}.${event.target.value}` })} /></label><label>参数语义<select value={parameter.semanticType} onChange={event => { const semanticType = event.target.value as WorkflowSemanticType; const mediaType = ["image", "video", "audio"].includes(semanticType) ? semanticType as "image" | "video" | "audio" : undefined; updateParameter(index, { semanticType, valueType: mediaType ?? parameter.valueType, confidence: 1 }); }}>{semanticOptions.map(value => <option key={value} value={value}>{semanticLabels[value] ?? "其他 / 未识别"}</option>)}</select><ChevronDown size={15} /></label><label>控件类型<select value={parameter.valueType} onChange={event => updateParameter(index, { valueType: event.target.value as WorkflowParameterView["valueType"] })}>{["string", "integer", "number", "boolean", "select", "json", "image", "video", "audio"].map(value => <option key={value}>{value}</option>)}</select><ChevronDown size={15} /></label></div>{isMediaParameter(parameter) && <div className="media-control-editor"><label>关联启用开关<select value={parameter.mediaControl?.parameterId ?? ""} onChange={event => updateParameter(index, { mediaControl: event.target.value ? { parameterId: event.target.value, activeValue: true, inactiveValue: false, autoEnableOnReplace: true, detected: false } : undefined })}><option value="">无关联开关</option>{booleanParameters.map(control => <option key={control.id} value={control.id}>{control.nodeTitle ?? control.fieldName} · {control.key}</option>)}</select><ChevronDown size={15} /></label>{parameter.mediaControl && <><label className="inline-check"><input type="checkbox" checked={parameter.mediaControl.autoEnableOnReplace} onChange={event => updateParameter(index, { mediaControl: { ...parameter.mediaControl!, autoEnableOnReplace: event.target.checked } })} />上传替换时自动开启</label><button type="button" className="secondary small" onClick={() => updateParameter(index, { mediaControl: { ...parameter.mediaControl!, activeValue: !parameter.mediaControl!.activeValue, inactiveValue: parameter.mediaControl!.activeValue } })}>开启值：{String(parameter.mediaControl.activeValue)}</button></>}</div>}<div className="parameter-editor-meta"><code>{parameter.key || "尚未完成映射"}</code><span>{parameter.classType}</span><span className={parameter.confidence < .7 ? "low" : ""}>置信度 {Math.round(parameter.confidence * 100)}%</span>{parameter.mediaControl && <span className="linked-control">已关联开关</span>}</div></div>)}</div>{!shown.length && <div className="empty-parameters">当前筛选条件下没有参数。</div>}{error && <div className="import-feedback error modal-feedback"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="modal-actions editor-actions"><span>保存后 Profile 版本将升级至 v{draft.profileVersion + 1}</span><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void save()}>保存 Profile</button></div></div></div>;
}

const semanticLabels: Partial<Record<WorkflowSemanticType, string>> = {
  prompt: "提示词", negative_prompt: "负面提示词", image: "图片", video: "视频", audio: "音频",
  duration: "时长", fps: "帧率", frames: "帧数", width: "宽度", height: "高度",
  aspect_ratio: "画面比例", resolution: "分辨率", resolution_multiple: "尺寸倍数", upscale_factor: "二采放大倍数", seed: "随机种子", steps: "采样步数",
  cfg: "CFG", sampler: "采样器", scheduler: "调度器", denoise: "降噪强度", model: "模型", lora: "LoRA",
};

export function discoverParameters(raw: Record<string, unknown>): WorkflowParameterView[] {
  const found: WorkflowParameterView[] = [];
  const semanticCounts = new Map<string, number>();
  const optionalReferenceMedia = detectOptionalReferenceMedia(raw);
  const nodeIds = new Set(Object.keys(raw));
  for (const [nodeId, candidate] of Object.entries(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const node = candidate as Record<string, unknown>;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    const meta = node._meta && typeof node._meta === "object" && !Array.isArray(node._meta) ? node._meta as Record<string, unknown> : {};
    const classType = typeof node.class_type === "string" ? node.class_type : "UnknownNode";
    const nodeTitle = typeof meta.title === "string" ? meta.title : classType;
    for (const [fieldName, defaultValue] of Object.entries(inputs as Record<string, unknown>)) {
      if (Array.isArray(defaultValue) && defaultValue.length === 2 && nodeIds.has(String(defaultValue[0])) && Number.isInteger(defaultValue[1])) continue;
      const primitive = typeof defaultValue;
      if (!["string", "number", "boolean", "object"].includes(primitive) || defaultValue === null) continue;
      const inferredMedia = inferMediaType(fieldName, classType, nodeTitle);
      const inferred = inferredMedia ?? inferParameterType(fieldName, classType, nodeTitle, defaultValue);
      const valueType = inferredMedia ?? (primitive === "boolean" ? "boolean" : primitive === "number" ? (Number.isInteger(defaultValue) ? "integer" : "number") : primitive === "object" ? "json" : "string");
      const semanticType = inferred ?? "unknown";
      const idBase = inferred ?? `${nodeId}_${fieldName}`;
      const occurrence = (semanticCounts.get(idBase) ?? 0) + 1;
      semanticCounts.set(idBase, occurrence);
      const parameter: WorkflowParameterView = { id: occurrence === 1 ? idBase : `${idBase}_${occurrence}`, key: `${nodeId}.${fieldName}`, nodeId, fieldName, classType, nodeTitle, valueType, semanticType, defaultValue, confidence: inferred ? .9 : 0, showEnableToggle: optionalReferenceMedia.has(nodeId) && /^(image|audio|video)$/i.test(fieldName) };
      const complete = withBuiltinSchema(parameter);
      found.push({ ...complete, visible: shouldExposeParameter(complete) });
    }
  }
  return attachMediaControls(found);
}

function detectOptionalReferenceMedia(raw: Record<string, unknown>): Set<string> {
  const sources = new Set<string>();
  const isLink = (value: unknown): value is [string | number, number] => Array.isArray(value) && value.length === 2
    && (typeof value[0] === "string" || typeof value[0] === "number") && Number.isInteger(value[1]);
  const visit = (value: unknown, path: string[]): void => {
    if (isLink(value)) {
      if (/ref(?:erence)?[_-]?(?:images?|audios?|videos?)/i.test(path.join("."))) sources.add(String(value[0]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key]);
  };
  for (const candidate of Object.values(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const inputs = (candidate as Record<string, unknown>).inputs;
    if (inputs && typeof inputs === "object") visit(inputs, []);
  }
  return sources;
}

function inferParameterType(fieldName: string, classType: string, nodeTitle: string, value: unknown): WorkflowSemanticType | undefined {
  const field = normalizeToken(fieldName);
  const context = normalizeToken(`${classType} ${nodeTitle}`);
  if (["prompt", "positiveprompt", "positive", "textprompt"].includes(field)) return "prompt";
  if (["negativeprompt", "negative", "negprompt"].includes(field)) return "negative_prompt";
  if (typeof value === "string" && field === "text" && /^(text|string|primitive|stringmultiline|multilinetext)+$/.test(context)
    && (value.length >= 80 || /subjectdefinitions|scenedescription|prompt|镜头|画面|主体/.test(normalizeToken(value)))) return "prompt";
  if (typeof value === "string" && /negative|负面|反向/.test(context) && /text|prompt/.test(field + context)) return "negative_prompt";
  if (/prompt|提示词|生成词|描述词|正向|cliptext/.test(context) && /text|string|value/.test(field)) return "prompt";
  if (/duration|seconds|时长/.test(field + context)) return "duration";
  if (isAspectRatioParameter(fieldName, classType, nodeTitle)) return "aspect_ratio";
  if (/resolutionselector/.test(normalizeToken(classType)) && field === "multiple") return "resolution_multiple";
  if (/resolution|分辨率|megapixels/.test(field + context)) return "resolution";
  if (/seed|随机种子/.test(field + context)) return "seed";
  return undefined;
}

function isAspectRatioParameter(fieldName: string, classType: string, nodeTitle: string): boolean {
  const field = normalizeToken(fieldName);
  const context = normalizeToken(`${classType} ${nodeTitle}`);
  return field === "aspectratio" || ((field === "ratio" || field === "value") && /aspectratio|宽高比|画幅|分辨率选择/.test(context));
}

function shouldExposeParameter(parameter: Pick<WorkflowParameterView, "semanticType" | "valueType">): boolean {
  return parameter.semanticType !== "unknown" || ["image", "video", "audio"].includes(parameter.valueType);
}

function discoverOutputs(raw: Record<string, unknown>): WorkflowOutputView[] {
  const outputs: WorkflowOutputView[] = [];
  for (const [nodeId, candidate] of Object.entries(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const node = candidate as Record<string, unknown>;
    const inputs = node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs) ? node.inputs as Record<string, unknown> : {};
    const meta = node._meta && typeof node._meta === "object" && !Array.isArray(node._meta) ? node._meta as Record<string, unknown> : {};
    const classType = typeof node.class_type === "string" ? node.class_type : "UnknownNode";
    const nodeTitle = typeof meta.title === "string" ? meta.title : classType;
    const context = `${classType} ${nodeTitle}`.toLowerCase();
    const mediaType = /video.*combine|save.*video|video.*output|视频.*输出|合成.*视频/.test(context) ? "video" : /save.*image|preview.*image|image.*output|图片.*输出/.test(context) ? "image" : /save.*audio|preview.*audio|audio.*output|音频.*输出/.test(context) ? "audio" : undefined;
    if (!mediaType) continue;
    const filenamePrefix = typeof inputs.filename_prefix === "string" ? inputs.filename_prefix : undefined;
    const label = filenamePrefix || nodeTitle;
    const normalized = label.toLowerCase();
    const stage = /一采|第一次|first|stage\s*1|pass\s*1/.test(normalized) ? 1 : /二采|第二次|second|stage\s*2|pass\s*2/.test(normalized) ? 2 : Number(normalized.match(/(?:stage|pass|采样|输出)[^0-9]*([0-9]+)/)?.[1] ?? 1);
    outputs.push({ id: `output_${nodeId}`, nodeId, classType, nodeTitle, mediaType, label, filenamePrefix, saveOutput: typeof inputs.save_output === "boolean" ? inputs.save_output : undefined, stage });
  }
  return outputs.sort((a, b) => a.stage - b.stage || Number(a.nodeId) - Number(b.nodeId));
}

function attachMediaControls(parameters: WorkflowParameterView[]): WorkflowParameterView[] {
  const switches = parameters.filter(parameter => parameter.valueType === "boolean");
  return parameters.map(media => {
    if (!isMediaParameter(media)) return media;
    const mediaContext = normalizeToken(`${media.fieldName} ${media.classType} ${media.nodeTitle ?? ""}`);
    const mediaNumber = mediaContext.match(/\d+/)?.[0];
    const candidates = switches.map(control => {
      const field = normalizeToken(control.fieldName);
      const context = normalizeToken(`${control.fieldName} ${control.classType} ${control.nodeTitle ?? ""}`);
      if (!/enable|enabled|use|active|upload|switch|toggle|启用|开启|使用|上传/.test(context)) return { control, score: -1 };
      let score = control.nodeId === media.nodeId ? 100 : 0;
      if (context.includes(media.valueType) || (media.valueType === "image" && /图片|图像|参考图/.test(context)) || (media.valueType === "video" && /视频/.test(context)) || (media.valueType === "audio" && /音频|声音/.test(context))) score += 30;
      if (mediaNumber && context.includes(mediaNumber)) score += 20;
      if (/^(enable|enabled|use|active|upload|switch|toggle)$/.test(field)) score += 10;
      return { control, score };
    }).filter(candidate => candidate.score >= 30).sort((a, b) => b.score - a.score);
    if (!candidates[0] || (candidates[1] && candidates[0].score === candidates[1].score)) return media;
    return { ...media, showEnableToggle: true, mediaControl: { parameterId: candidates[0].control.id, activeValue: true, inactiveValue: false, autoEnableOnReplace: true, detected: true } };
  });
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function inferMediaType(fieldName: string, classType: string, nodeTitle: string): "image" | "video" | "audio" | undefined {
  const field = fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const context = `${classType} ${nodeTitle}`.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  if ((field === "image" || /^image\d+$/.test(field)) && /image|参考图|首帧|尾帧|图片|图像/.test(context)) return "image";
  if ((field === "video" || /^video\d+$/.test(field)) && /video|参考视频|视频/.test(context)) return "video";
  if ((field === "audio" || /^audio\d+$/.test(field)) && /audio|音频|声音/.test(context)) return "audio";
  return undefined;
}

function createDraft(workflow?: WorkflowView): CreateJobDraft {
  const parameters = workflow?.parameters ?? [];
  const parameterValues = Object.fromEntries(parameters.map(parameter => [parameter.id, parameter.defaultValue]));
  const mediaParameters = parameters.filter(isMediaParameter);
  const mediaOverrides = Object.fromEntries(mediaParameters.map(parameter => [parameter.id, { enabled: false, mode: "clear" as const }]));
  for (const parameter of mediaParameters) {
    if (parameter.mediaControl?.autoEnableOnReplace) parameterValues[parameter.mediaControl.parameterId] = parameter.mediaControl.inactiveValue;
  }
  return { workflowId: workflow?.id ?? "", profileVersion: workflow?.profileVersion ?? 0, parameterValues, mediaOverrides };
}

function cloneDraft(draft: CreateJobDraft): CreateJobDraft {
  return {
    ...draft,
    parameterValues: { ...draft.parameterValues },
    mediaOverrides: Object.fromEntries(Object.entries(draft.mediaOverrides).map(([id, media]) => [id, { ...media }])),
  };
}

function isMediaParameter(parameter: WorkflowParameterView) {
  return ["image", "video", "audio"].includes(parameter.valueType);
}

function parameterLabel(parameter: WorkflowParameterView) {
  return parameter.label ?? semanticLabels[parameter.semanticType] ?? parameter.nodeTitle ?? parameter.fieldName;
}

function optionParts(option: unknown) {
  if (option && typeof option === "object" && !Array.isArray(option) && "value" in option) {
    const item = option as { label?: unknown; value: unknown };
    return { label: String(item.label ?? item.value), value: item.value };
  }
  return { label: String(option ?? ""), value: option };
}

const CreateJob = memo(function CreateJob({ workflows, initialWorkflowId, initialDraft, onCreate }: { workflows: WorkflowView[]; initialWorkflowId?: string; initialDraft?: CreateJobDraft; onCreate: (drafts: CreateJobDraft[]) => Promise<boolean> }) {
  const initialWorkflow = workflows.find(workflow => workflow.id === initialWorkflowId) ?? workflows[0];
  const [draft, setDraft] = useState<CreateJobDraft>(() => initialDraft ? cloneDraft(initialDraft) : createDraft(initialWorkflow));
  const [showGeneric, setShowGeneric] = useState(false);
  const [batch, setBatch] = useState<Array<{ id: string; draft: CreateJobDraft }>>([]);
  const [editingBatchId, setEditingBatchId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (workflows.length && !workflows.some(workflow => workflow.id === draft.workflowId)) {
      setDraft(createDraft(workflows[0]));
      setEditingBatchId(undefined);
    }
  }, [workflows, draft.workflowId]);
  const selected = workflows.find(w => w.id === draft.workflowId) ?? workflows[0];
  const visibleParameters = selected?.parameters.filter(parameter => parameter.visible !== false) ?? [];
  const recognized = visibleParameters.filter(parameter => parameter.semanticType !== "unknown");
  const generic = visibleParameters.filter(parameter => parameter.semanticType === "unknown");
  const prompts = recognized
    .filter(parameter => ["prompt", "negative_prompt"].includes(parameter.semanticType))
    .sort((left, right) => Number(left.semanticType === "negative_prompt") - Number(right.semanticType === "negative_prompt"));
  const generationParameters = recognized
    .filter(parameter => !isMediaParameter(parameter) && !["prompt", "negative_prompt"].includes(parameter.semanticType))
    .sort((left, right) => generationParameterOrder(left) - generationParameterOrder(right));
  const mediaOrder: Record<string, number> = { image: 0, audio: 1, video: 2 };
  const media = visibleParameters
    .filter(isMediaParameter)
    .sort((left, right) => (mediaOrder[left.valueType] ?? 99) - (mediaOrder[right.valueType] ?? 99));

  function chooseWorkflow(workflowId: string) {
    const workflow = workflows.find(item => item.id === workflowId);
    setDraft(createDraft(workflow));
    setShowGeneric(false);
  }

  function setValue(parameter: WorkflowParameterView, value: unknown) {
    setDraft(current => ({ ...current, parameterValues: { ...current.parameterValues, [parameter.id]: value } }));
  }

  function setMedia(parameter: WorkflowParameterView, mode: "replace" | "clear", file?: File, selectedFile?: { localPath: string; fileName: string; previewUrl?: string }) {
    setDraft(current => {
      const parameterValues = { ...current.parameterValues };
      if (parameter.mediaControl?.autoEnableOnReplace) {
        if (mode === "replace") parameterValues[parameter.mediaControl.parameterId] = parameter.mediaControl.activeValue;
        if (mode === "clear") parameterValues[parameter.mediaControl.parameterId] = parameter.mediaControl.inactiveValue;
      }
      return { ...current, parameterValues, mediaOverrides: { ...current.mediaOverrides, [parameter.id]: { enabled: mode === "replace", mode, file, ...selectedFile } } };
    });
  }

  async function pickDesktopMedia(parameter: WorkflowParameterView) {
    if (!window.runningHub) return;
    const selectedFile = await window.runningHub.media.select(parameter.valueType as "image" | "video" | "audio");
    if (selectedFile) setMedia(parameter, "replace", undefined, selectedFile);
  }

  async function acceptDroppedMedia(parameter: WorkflowParameterView, file: File) {
    const expected = parameter.valueType;
    if (file.type && !file.type.startsWith(`${expected}/`)) return;
    if (window.runningHub) {
      const selectedFile = await window.runningHub.media.fromDroppedFile(file);
      setMedia(parameter, "replace", undefined, selectedFile);
    } else {
      setMedia(parameter, "replace", file);
    }
  }

  function clearAllMedia() {
    setDraft(current => ({
      ...current,
      parameterValues: media.reduce((values, parameter) => {
        if (!parameter.mediaControl?.autoEnableOnReplace) return values;
        return { ...values, [parameter.mediaControl.parameterId]: parameter.mediaControl.inactiveValue };
      }, current.parameterValues),
      mediaOverrides: { ...current.mediaOverrides, ...Object.fromEntries(media.map(parameter => [parameter.id, { enabled: false, mode: "clear" as const }])) },
    }));
  }

  function moveImageMedia(sourceId: string, target: WorkflowParameterView) {
    if (sourceId === target.id || target.valueType !== "image") return;
    const source = selected?.parameters.find(parameter => parameter.id === sourceId);
    if (!source || source.valueType !== "image") return;
    setDraft(current => {
      const sourceDraft = current.mediaOverrides[sourceId];
      if (!sourceDraft || sourceDraft.mode !== "replace") return current;
      const parameterValues = { ...current.parameterValues };
      if (source.mediaControl?.autoEnableOnReplace) parameterValues[source.mediaControl.parameterId] = source.mediaControl.inactiveValue;
      if (target.mediaControl?.autoEnableOnReplace) parameterValues[target.mediaControl.parameterId] = target.mediaControl.activeValue;
      return {
        ...current,
        parameterValues,
        mediaOverrides: {
          ...current.mediaOverrides,
          [sourceId]: { enabled: false, mode: "clear" },
          [target.id]: { ...sourceDraft, enabled: true, mode: "replace" },
        },
      };
    });
  }

  function clearPrompts() {
    setDraft(current => ({
      ...current,
      parameterValues: prompts.reduce((values, parameter) => ({ ...values, [parameter.id]: "" }), current.parameterValues),
    }));
  }

  function saveDraftToBatch() {
    const snapshot = cloneDraft(draft);
    if (editingBatchId) {
      setBatch(current => current.map(item => item.id === editingBatchId ? { ...item, draft: snapshot } : item));
      setEditingBatchId(undefined);
    } else {
      setBatch(current => [...current, { id: crypto.randomUUID(), draft: snapshot }]);
    }
  }

  function editBatchItem(id: string) {
    const item = batch.find(entry => entry.id === id);
    if (!item) return;
    setDraft(cloneDraft(item.draft));
    setEditingBatchId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitDrafts(drafts: CreateJobDraft[]) {
    if (!drafts.length || submitting) return;
    setSubmitting(true);
    const submitted = await onCreate(drafts.map(cloneDraft));
    if (submitted) {
      setBatch([]);
      setEditingBatchId(undefined);
    }
    setSubmitting(false);
  }

  return <>
    <PageHeading eyebrow="新建任务" title="创建任务" description="生成表单由当前 Workflow Profile 动态构建，切换工作流时参数会随之变化。" />
    {selected && (selected.functionDescription || selected.usageInstructions) && <div className="workflow-guide panel"><div><strong>功能说明</strong><p>{selected.functionDescription ?? "暂无说明"}</p></div><div><strong>使用说明</strong><p>{selected.usageInstructions ?? "暂无说明"}</p></div></div>}
    <div className="create-layout">
      <form className="panel form-panel" onSubmit={e => { e.preventDefault(); void submitDrafts([draft]); }}>
        <div className="form-section"><div className="section-index">01</div><div className="section-content"><h2>选择工作流</h2><p>每个工作流使用自己的版本化 Profile，不共享固定字段。</p><label>工作流<select value={draft.workflowId} onChange={e => chooseWorkflow(e.target.value)}>{workflows.map(w => <option value={w.id} key={w.id}>{w.name}</option>)}</select><ChevronDown size={16} /></label><div className="profile-scan"><div><BadgeCheck size={17} /><span><strong>Profile v{selected?.profileVersion}</strong><small>已检测 {selected?.parameters.length ?? 0} 个参数</small></span></div><div className="scan-counts"><span>{recognized.length} 已识别</span><span>{media.length} 媒体</span><span className={generic.length ? "warn" : ""}>{generic.length} 待确认</span></div></div>{selected?.needsReview && <div className="profile-warning"><AlertTriangle size={17} /><span>该 Profile 含低置信度参数，请检查“其他参数”后再提交。</span></div>}</div></div>
        {(prompts.length > 0 || media.length > 0) && <div className="form-section"><div className="section-index">02</div><div className="section-content"><div className="section-title-row media-section-title"><div><h2>媒体输入</h2><p>按生成词、图片、音频、视频排序；未上传的媒体会在提交时清空，避免误用工作流内置素材。</p></div>{media.length > 0 && <div className="bulk-media-actions"><button type="button" onClick={clearAllMedia}>清空全部媒体</button></div>}</div>{prompts.length > 0 && <div className="content-prompt-block"><div className="content-input-label"><span>生成词</span><div><small>优先输入</small><button type="button" onClick={clearPrompts}>清空生成词</button></div></div><div className="dynamic-grid prompt-input-grid">{prompts.map(parameter => <ParameterField key={parameter.id} parameter={parameter} value={draft.parameterValues[parameter.id]} onChange={value => setValue(parameter, value)} />)}</div></div>}{media.length > 0 && <div className="media-stack">{media.map((parameter, index) => { const mediaDraft = draft.mediaOverrides[parameter.id] ?? { enabled: false, mode: "clear" as const }; return <MediaField key={parameter.id} index={index + 1} parameter={parameter} draft={mediaDraft} onPick={window.runningHub ? () => void pickDesktopMedia(parameter) : undefined} onDrop={file => acceptDroppedMedia(parameter, file)} onMove={sourceId => moveImageMedia(sourceId, parameter)} onChange={(mode, file) => setMedia(parameter, mode, file)} />; })}</div>}</div></div>}
        <div className="form-section"><div className="section-index">03</div><div className="section-content"><h2>生成参数设置</h2><p>这里只显示时长、画面比例、分辨率、种子等设置，不再重复显示提示词和媒体文件。</p>{generationParameters.length > 0 ? <div className="dynamic-grid">{generationParameters.map(parameter => <ParameterField key={parameter.id} parameter={parameter} value={draft.parameterValues[parameter.id]} onChange={value => setValue(parameter, value)} />)}</div> : <div className="empty-parameters">这个工作流没有其他生成参数。</div>}</div></div>
        {generic.length > 0 && <div className="form-section generic-section"><div className="section-index">04</div><div className="section-content"><div className="section-title-row"><div><h2>其他参数</h2><p>未识别参数不会丢弃，仍按 nodeId.fieldName 原样进入 Job Snapshot。</p></div><button type="button" className="secondary small" onClick={() => setShowGeneric(value => !value)}>{showGeneric ? "收起" : `展开 ${generic.length} 项`}</button></div>{showGeneric && <div className="dynamic-grid generic-grid">{generic.map(parameter => <ParameterField key={parameter.id} parameter={parameter} value={draft.parameterValues[parameter.id]} onChange={value => setValue(parameter, value)} />)}</div>}</div></div>}
        <div className="submit-bar"><div className="submit-hint"><ShieldCheck size={17} /><span>可先加入制作批次，检查完成后一次入队</span></div><div className="submit-actions"><button className="secondary" type="button" onClick={saveDraftToBatch} disabled={!selected || submitting}>{editingBatchId ? "保存批次修改" : "加入制作批次"}</button><button className="primary submit" type="submit" disabled={!selected || submitting}>{submitting ? "正在创建…" : "提交当前任务"}</button></div></div>
      </form>
      <aside className="create-sidebar"><div className="panel batch-panel"><div className="batch-head"><div><p className="summary-kicker">制作批次</p><h2>待提交任务</h2></div><span>{batch.length}</span></div>{batch.length === 0 ? <div className="batch-empty">调整好当前任务后点击“加入制作批次”。每项都会保留自己的参数和媒体文件。</div> : <div className="batch-list">{batch.map((item, index) => { const workflow = workflows.find(entry => entry.id === item.draft.workflowId); const mediaCount = Object.values(item.draft.mediaOverrides).filter(entry => entry.mode === "replace").length; return <article className={editingBatchId === item.id ? "editing" : ""} key={item.id}><DraftThumbnail draft={item.draft} /><div><strong>{workflow?.name ?? "未知工作流"}</strong><small>任务 {String(index + 1).padStart(2, "0")} · {mediaCount} 个媒体文件</small></div><div className="batch-actions"><button type="button" onClick={() => editBatchItem(item.id)} aria-label="编辑批次任务"><Pencil size={14} /></button><button type="button" onClick={() => { setBatch(current => current.filter(entry => entry.id !== item.id)); if (editingBatchId === item.id) setEditingBatchId(undefined); }} aria-label="删除批次任务"><Trash2 size={14} /></button></div></article>; })}</div>}<button className="primary batch-submit" type="button" disabled={!batch.length || submitting} onClick={() => void submitDrafts(batch.map(item => item.draft))}>{submitting ? "正在批量创建…" : `批量提交 ${batch.length} 个任务`}<ArrowRight size={16} /></button></div></aside>
    </div>
  </>;
});

function DraftThumbnail({ draft }: { draft: CreateJobDraft }) {
  const replacements = Object.values(draft.mediaOverrides).filter(item => item.mode === "replace");
  const visual = replacements.find(item => item.file?.type.startsWith("image/") || item.file?.type.startsWith("video/") || /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|mkv)$/i.test(item.fileName ?? item.file?.name ?? ""));
  const audio = replacements.find(item => item.file?.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac)$/i.test(item.fileName ?? item.file?.name ?? ""));
  const [objectUrl, setObjectUrl] = useState<string>();
  useEffect(() => {
    if (!visual?.file) { setObjectUrl(undefined); return; }
    const url = URL.createObjectURL(visual.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [visual?.file]);
  const source = visual?.previewUrl ?? objectUrl;
  const video = visual?.file?.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(visual?.fileName ?? "");
  if (source && video) return <div className="batch-thumbnail"><video src={source} muted playsInline preload="metadata" /></div>;
  if (source) return <div className="batch-thumbnail"><img src={source} alt="批次媒体缩略图" /></div>;
  if (audio) return <div className="batch-thumbnail audio"><Music2 size={17} /></div>;
  return <div className="batch-thumbnail fallback"><FileJson size={16} /></div>;
}

function ParameterField({ parameter, value, onChange }: { parameter: WorkflowParameterView; value: unknown; onChange: (value: unknown) => void }) {
  const label = parameterLabel(parameter);
  const meta = `节点 ${parameter.key} · ${parameter.classType}`;
  if (parameter.valueType === "boolean") return <label className="boolean-field"><span><strong>{label}</strong><small>{meta}</small></span><button type="button" className={`switch ${value ? "checked" : ""}`} onClick={() => onChange(!value)} aria-pressed={Boolean(value)}><span /></button></label>;
  if (parameter.valueType === "select" && parameter.options?.length) {
    const options = parameter.options ?? [];
    const selectedToken = JSON.stringify(value);
    return <label className="parameter-field"><span className="field-label">{label}<small>{meta}</small></span><select value={selectedToken} onChange={event => { const match = options.map(optionParts).find(option => JSON.stringify(option.value) === event.target.value); onChange(match?.value); }}>{options.map(option => { const item = optionParts(option); return <option key={JSON.stringify(item.value)} value={JSON.stringify(item.value)}>{item.label}</option>; })}</select><ChevronDown size={16} /></label>;
  }
  if (parameter.valueType === "integer" || parameter.valueType === "number") return <label className="parameter-field"><span className="field-label">{label}<small>{meta}</small></span><input type="number" value={typeof value === "number" ? value : ""} min={parameter.min} max={parameter.max} step={parameter.step ?? (parameter.valueType === "integer" ? 1 : "any")} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} /></label>;
  if (parameter.valueType === "json") return <JsonParameterField label={label} meta={meta} value={value} onChange={onChange} />;
  const multiline = ["prompt", "negative_prompt"].includes(parameter.semanticType) || String(value ?? "").length > 80;
  return <label className={`parameter-field ${multiline ? "wide-field" : ""}`}><span className="field-label">{label}<small>{meta}</small></span>{multiline ? <textarea rows={4} value={String(value ?? "")} onChange={event => onChange(event.target.value)} /> : <input value={String(value ?? "")} onChange={event => onChange(event.target.value)} />}</label>;
}

function JsonParameterField({ label, meta, value, onChange }: { label: string; meta: string; value: unknown; onChange: (value: unknown) => void }) {
  const serialized = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => { setText(serialized); setError(undefined); }, [serialized]);
  return <label className={`parameter-field wide-field json-parameter ${error ? "invalid" : ""}`}>
    <span className="field-label">{label}<small>{meta}</small></span>
    <textarea rows={4} value={text} aria-invalid={Boolean(error)} onChange={event => {
      const next = event.target.value;
      setText(next);
      try {
        onChange(JSON.parse(next));
        setError(undefined);
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : "JSON 格式无效");
      }
    }} />
    {error && <small className="json-error">JSON 尚未完成：请修正格式后再提交。</small>}
  </label>;
}

function MediaField({ parameter, draft, index, onPick, onDrop, onMove, onChange }: { parameter: WorkflowParameterView; draft: CreateJobDraft["mediaOverrides"][string]; index: number; onPick?: () => void; onDrop: (file: File) => void; onMove: (sourceId: string) => void; onChange: (mode: "replace" | "clear", file?: File) => void }) {
  const accept = parameter.valueType === "image" ? "image/*" : parameter.valueType === "video" ? "video/*" : "audio/*";
  const isDemo = parameter.nodeId.startsWith("demo-");
  const [objectUrl, setObjectUrl] = useState<string>();
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!draft.file) { setObjectUrl(undefined); return; }
    const url = URL.createObjectURL(draft.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.file]);
  const previewUrl = draft.previewUrl ?? objectUrl;
  const choose = onPick
    ? <button type="button" className="dropzone compact-dropzone" onClick={onPick}><ImagePlus size={22} /><strong>选择或拖入{parameterLabel(parameter)}</strong><span>未上传时提交为清空</span></button>
    : <label className="dropzone compact-dropzone"><input type="file" accept={accept} onChange={event => { const file = event.target.files?.[0]; if (file) onChange("replace", file); event.currentTarget.value = ""; }} /><ImagePlus size={22} /><strong>选择或拖入{parameterLabel(parameter)}</strong><span>未上传时提交为清空</span></label>;
  return <div className={`media-field media-${parameter.valueType} mode-${draft.mode} ${dragging ? "dragging" : ""}`}
    onDragEnter={event => { event.preventDefault(); setDragging(true); }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes("application/x-rh-image-slot") ? "move" : "copy"; setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); const sourceId = event.dataTransfer.getData("application/x-rh-image-slot"); if (sourceId) { onMove(sourceId); return; } const file = event.dataTransfer.files?.[0]; if (file) onDrop(file); }}>
    <div className="media-slot-index">{String(index).padStart(2, "0")}</div>
    <div className="media-head"><div><strong>{parameter.nodeTitle ?? parameterLabel(parameter)}</strong><span>{isDemo ? "演示槽 · 导入 API JSON 后使用真实节点" : `节点 ${parameter.key}`}</span></div><b className={draft.mode === "replace" ? "uploaded" : "empty"}>{draft.mode === "replace" ? "已上传" : "未上传"}</b></div>
    {draft.mode === "clear" && choose}
    {draft.mode === "replace" && previewUrl && <div className="selected-media-preview" draggable={parameter.valueType === "image"} onDragStart={event => { if (parameter.valueType !== "image") return; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-rh-image-slot", parameter.id); }}><MediaPreview type={parameter.valueType as "image" | "video" | "audio"} url={previewUrl} /><div className="media-file-actions">{parameter.valueType === "image" && <span>可拖到其他图片槽移动</span>}{onPick && <button type="button" className="secondary small" onClick={onPick}>更换</button>}<button type="button" className="danger-button small" onClick={() => onChange("clear")}>移除</button></div></div>}
    {draft.mode === "replace" && !previewUrl && choose}
  </div>;
}

function MediaPreview({ type, url }: { type: "image" | "video" | "audio"; url: string }) {
  if (type === "image") return <img className="media-input-preview" src={url} alt="已选择的图片预览" />;
  if (type === "video") return <video className="media-input-preview" src={url} controls preload="metadata" />;
  return <audio className="media-input-audio" src={url} controls preload="metadata" />;
}

function Jobs({ jobs, onCancel, onRegenerate, onDelete, onReveal }: { jobs: JobView[]; onCancel: (id: string) => void; onRegenerate: (job: JobView) => void; onDelete: (id: string) => void; onReveal: (localPath: string) => void }) {
  const [filter, setFilter] = useState<"ALL" | "ACTIVE" | "COMPLETED" | "FAILED">("ALL");
  const [previewingId, setPreviewingId] = useState<string>();
  const [search, setSearch] = useState("");
  const previewing = jobs.find(job => job.id === previewingId);
  const needle = search.trim().toLowerCase();
  const shown = jobs.filter(job => (filter === "ALL" || (filter === "ACTIVE" && !isTerminalJobStatus(job.status)) || (filter === "FAILED" && ["FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status)) || job.status === filter)
    && (!needle || job.workflowName.toLowerCase().includes(needle) || job.remoteTaskId?.toLowerCase().includes(needle) || job.id.toLowerCase().includes(needle)))
    .sort((left, right) => right.createdAt - left.createdAt);
  return <>
    <PageHeading eyebrow="任务管理" title="任务队列" description="已提交任务保留完整输入快照；生成完成后可预览全部视频、图片和音频输出。" action={window.runningHub ? <button className="secondary" onClick={() => void window.runningHub?.downloads.openDirectory()}><FolderOpen size={16} />打开下载库</button> : undefined} />
    <div className="panel jobs-panel"><div className="jobs-toolbar"><div className="segmented">{(["ALL", "ACTIVE", "COMPLETED", "FAILED"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "ALL" ? "全部" : value === "ACTIVE" ? "进行中" : value === "COMPLETED" ? "已完成" : "失败"}</button>)}</div><div className="search"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索 taskId 或工作流" /></div></div><div className="job-list">{shown.length ? shown.map(job => <JobRow key={job.id} job={job} onReveal={onReveal} onCancel={onCancel} onRegenerate={() => onRegenerate(job)} onDelete={() => onDelete(job.id)} onPreview={() => setPreviewingId(job.id)} />) : <div className="job-list-empty">没有符合条件的任务。</div>}</div></div>
    {previewing && <TaskPreviewModal job={previewing} onReveal={onReveal} onClose={() => setPreviewingId(undefined)} />}
  </>;
}

function JobRow({ job, compact, onCancel, onRegenerate, onDelete, onPreview, onReveal }: { job: JobView; compact?: boolean; onCancel?: (id: string) => void; onRegenerate?: () => void; onDelete?: () => void; onPreview?: () => void; onReveal?: (localPath: string) => void }) {
  const terminal = isTerminalJobStatus(job.status);
  const showElapsed = Boolean(job.generationStartedAt) && (activeJobStatuses.has(job.status) || job.status === "COMPLETED");
  return <article className={`job-row ${compact ? "compact" : ""}`}><JobThumbnail job={job} /><div className="job-main"><div className="job-title"><strong>{job.workflowName}</strong><StatusPill status={job.status} /></div><div className="job-meta"><span>{job.remoteTaskId ? `taskId ${job.remoteTaskId}` : "等待分配远端任务"}</span>{job.accountLabel && <><i /><span>{job.accountLabel}</span></>}<i /><span>{relativeTime(job.createdAt)}</span>{job.stageLabel && <><i /><span>{job.stageLabel}</span></>}{showElapsed && <><i /><ElapsedTime job={job} /></>}{job.inputs?.media.length ? <><i /><span>{job.inputs.media.length} 个媒体槽</span></> : null}{job.outputs?.length ? <><i /><span>{job.outputs.length} 个输出</span></> : null}</div>{job.error && job.status !== "SUBMIT_UNKNOWN" && <><p className="job-error">{job.status === "FAILED" ? localizedFailureReason(job.error, job.status) : job.error}</p>{job.errorDetail && <details className="job-error-detail"><summary>查看错误详情</summary><span>类型：{job.errorDetail.code}</span><span>阶段：{job.errorDetail.phase}</span>{job.errorDetail.remoteCode && <span>RunningHub：{job.errorDetail.remoteCode}</span>}{job.errorDetail.nodeId && <span>节点：{job.errorDetail.nodeId}{job.errorDetail.nodeName ? `（${job.errorDetail.nodeName}）` : ""}</span>}</details>}</>}{job.status === "SUBMIT_UNKNOWN" && <p className="job-error">{localizedFailureReason(job.error, job.status)}</p>}{!compact && !terminal && <div className="progress indeterminate"><span /></div>}</div>{!compact && <div className="job-actions">{job.status === "COMPLETED" && onPreview && <button className="primary small" onClick={onPreview}><Play size={14} />任务预览</button>}{onRegenerate && job.inputs && <button className="secondary small" onClick={onRegenerate}><RefreshCw size={14} />再次生成</button>}{job.outputs?.[0]?.localPath && onReveal && <button className="secondary small" onClick={() => onReveal(job.outputs![0]!.localPath!)}><FolderOpen size={14} />显示文件</button>}{!terminal && <button className="danger-button small" onClick={() => onCancel?.(job.id)}><Square size={13} />{["DOWNLOAD_PENDING", "DOWNLOADING"].includes(job.status) || (job.status === "RETRY_WAIT" && job.retryPhase === "download") ? "取消下载" : "停止生成"}</button>}{terminal && onDelete && <button className="icon-button danger" onClick={onDelete} title="删除任务"><Trash2 size={15} /></button>}</div>}</article>;
}

function ElapsedTime({ job }: { job: JobView }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!activeJobStatuses.has(job.status)) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job.status]);
  const startedAt = job.generationStartedAt;
  if (!startedAt) return null;
  const endedAt = job.generationCompletedAt ?? (job.status === "COMPLETED" ? job.completedAt : undefined) ?? clock;
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return <span className="elapsed-time">{job.status === "COMPLETED" ? "生成耗时" : "已运行"} {hours ? `${hours}:` : ""}{String(minutes).padStart(2, "0")}:{String(remainder).padStart(2, "0")}</span>;
}

function JobThumbnail({ job }: { job: JobView }) {
  const output = job.outputs?.find(item => {
    const source = item.previewUrl ?? item.url;
    return /image|video/i.test(item.type ?? "") || /\.(png|jpe?g|webp|gif|mp4|webm|mov)(?:$|\?)/i.test(source);
  });
  const input = job.inputs?.media.find(item => item.mode === "replace" && item.previewUrl && ["image", "video"].includes(item.type));
  const audio = job.inputs?.media.find(item => item.mode === "replace" && item.type === "audio");
  const source = output?.previewUrl ?? output?.url ?? input?.previewUrl;
  const type = output ? ((/video/i.test(output.type ?? "") || /\.(mp4|webm|mov)(?:$|\?)/i.test(source ?? "")) ? "video" : "image") : input?.type;
  if (source && type === "image") return <div className="job-thumbnail"><img src={source} alt="任务缩略图" /></div>;
  if (source && type === "video") return <div className="job-thumbnail"><video src={source} muted playsInline preload="metadata" onLoadedMetadata={event => { const video = event.currentTarget; if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(.15, video.duration / 2); }} /></div>;
  if (audio) return <div className="job-thumbnail audio" title={audio.fileName}><Music2 size={18} /><span>音频</span></div>;
  return <div className="job-thumbnail fallback">{job.outputType === "MP4" ? <Play size={17} /> : <FileJson size={17} />}</div>;
}

function formatSnapshotValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function TaskPreviewModal({ job, onClose, onReveal }: { job: JobView; onClose: () => void; onReveal: (localPath: string) => void }) {
  const [section, setSection] = useState<"inputs" | "outputs">(job.outputs?.length ? "outputs" : "inputs");
  const [selected, setSelected] = useState(0);
  const outputs = job.outputs ?? [];
  const output = outputs[selected];
  const media = job.inputs?.media ?? [];
  const parameters = job.inputs?.parameters ?? [];
  return <div className="modal-backdrop" role="presentation"><div className="modal output-preview-modal task-preview-modal" role="dialog" aria-modal="true" aria-label="任务预览"><div className="modal-head"><div><p>TASK PREVIEW</p><h2>{job.workflowName}</h2><div className="preview-task-meta"><StatusPill status={job.status} /><span>{job.remoteTaskId ? `taskId ${job.remoteTaskId}` : `本地任务 ${job.id}`}</span></div></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="preview-section-tabs"><button className={section === "inputs" ? "active" : ""} onClick={() => setSection("inputs")}>输入快照 <span>{media.length + parameters.length}</span></button><button className={section === "outputs" ? "active" : ""} onClick={() => setSection("outputs")}>生成输出 <span>{outputs.length}</span></button></div>{section === "inputs" ? <div className="task-inputs"><section><h3>媒体输入</h3>{media.length ? <div className="snapshot-media-grid">{media.map(item => <article key={item.parameterId}><div className="snapshot-media-head"><div><strong>{item.label}</strong><span>节点 {item.key}</span></div><b>{item.mode === "replace" ? "已替换" : item.mode === "clear" ? "已清空" : "工作流默认"}</b></div>{item.previewUrl ? <MediaPreview type={item.type} url={item.previewUrl} /> : <div className="snapshot-media-placeholder">{item.mode === "clear" ? "本次任务未向该节点传入媒体" : "使用工作流保存的默认媒体"}</div>}{item.fileName && <small className="snapshot-filename">{item.fileName}</small>}</article>)}</div> : <div className="empty-parameters">该任务没有媒体输入节点。</div>}</section><section><h3>提示词与参数</h3>{parameters.length ? <div className="snapshot-parameter-list">{parameters.map(item => <div className={item.semanticType === "prompt" ? "prompt" : ""} key={item.id}><span><strong>{item.label}</strong><small>节点 {item.key}</small></span><p>{formatSnapshotValue(item.value)}</p></div>)}</div> : <div className="empty-parameters">没有可显示的参数。</div>}</section></div> : <div className="task-outputs">{outputs.length ? <><div className="output-tabs">{outputs.map((item, index) => <button key={`${item.url}-${index}`} className={index === selected ? "active" : ""} onClick={() => setSelected(index)}><span>{item.stage ? `阶段 ${item.stage}` : `输出 ${index + 1}`}</span><strong>{item.label ?? item.type ?? `输出 ${index + 1}`}</strong></button>)}</div>{output && <OutputPlayer output={output} />}</> : <div className="output-waiting"><LoaderCircle size={30} /><strong>{["FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status) ? "该任务没有可预览输出" : "输出尚未生成"}</strong><span>任务状态变化时，此窗口会自动读取最新任务记录。</span></div>}{job.texts?.length ? <section className="text-outputs"><h3>文本输出</h3>{job.texts.map((text, index) => <pre key={index}>{text}</pre>)}</section> : null}{job.errorDetail ? <section className="task-error-detail"><h3>错误详情</h3><span>类型：{job.errorDetail.code}</span><span>阶段：{job.errorDetail.phase}</span>{job.errorDetail.remoteCode && <span>RunningHub：{job.errorDetail.remoteCode}</span>}{job.errorDetail.nodeId && <span>节点：{job.errorDetail.nodeId}{job.errorDetail.nodeName ? `（${job.errorDetail.nodeName}）` : ""}</span>}<p>{job.errorDetail.message}</p></section> : null}</div>}<div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button>{section === "outputs" && output?.localPath && <button className="secondary" onClick={() => onReveal(output.localPath!)}><FolderOpen size={16} />显示文件</button>}</div></div></div>;
}

function SettingsModal({ preferences, onPreferencesChange, onClose }: { preferences: UiPreferences; onPreferencesChange: (preferences: UiPreferences) => void; onClose: () => void }) {
  const [downloadDirectory, setDownloadDirectory] = useState("正在读取…");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>();
  useEffect(() => {
    const bridge = window.runningHub;
    if (!bridge) { setDownloadDirectory("仅桌面应用支持自定义下载目录"); return; }
    void bridge.downloads.directory().then(setDownloadDirectory).catch(reason => setError(reason instanceof Error ? reason.message : "读取下载目录失败"));
    return bridge.updates.onProgress(setUpdateProgress);
  }, []);

  async function chooseDirectory() {
    if (!window.runningHub || working) return;
    setWorking(true);
    setError(undefined);
    try {
      const selected = await window.runningHub.downloads.selectDirectory();
      if (selected) setDownloadDirectory(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "设置下载目录失败"); }
    finally { setWorking(false); }
  }

  async function resetDirectory() {
    if (!window.runningHub || working) return;
    setWorking(true);
    setError(undefined);
    try { setDownloadDirectory(await window.runningHub.downloads.resetDirectory()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "恢复默认下载目录失败"); }
    finally { setWorking(false); }
  }

  async function checkUpdate() {
    if (!window.runningHub || checkingUpdate || installingUpdate) return;
    setCheckingUpdate(true);
    setError(undefined);
    try { setUpdateInfo(await window.runningHub.updates.check()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "检查更新失败"); }
    finally { setCheckingUpdate(false); }
  }

  async function installUpdate() {
    if (!window.runningHub || installingUpdate) return;
    setInstallingUpdate(true);
    setError(undefined);
    setUpdateProgress({ stage: "downloading", percent: 0, message: "正在准备下载…" });
    try { await window.runningHub.updates.downloadAndInstall(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "自动更新失败");
      setInstallingUpdate(false);
      setUpdateProgress(undefined);
    }
  }

  return <div className="modal-backdrop" role="presentation"><div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
    <div className="modal-head"><div><p>应用设置</p><h2>下载、通知与更新</h2></div><button type="button" className="icon-button" disabled={installingUpdate} onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
    <section className="settings-section"><div className="settings-section-title"><FolderOpen size={18} /><div><strong>下载目录</strong><span>新完成的任务会下载到这个文件夹；历史任务仍保留原来的实际文件路径。</span></div></div><div className="directory-path" title={downloadDirectory}>{downloadDirectory}</div><div className="settings-actions"><button type="button" className="secondary" disabled={!window.runningHub || working || installingUpdate} onClick={() => void chooseDirectory()}>{working ? "处理中…" : "选择文件夹"}</button><button type="button" className="secondary" disabled={!window.runningHub || working || installingUpdate} onClick={() => void window.runningHub?.downloads.openDirectory()}><FolderOpen size={15} />打开当前目录</button><button type="button" className="ghost" disabled={!window.runningHub || working || installingUpdate} onClick={() => void resetDirectory()}><RefreshCw size={14} />恢复默认</button></div></section>
    <section className="settings-section"><div className="settings-section-title"><Settings2 size={18} /><div><strong>完成与失败提示</strong><span>顶部小提示不会阻塞操作，到时间后自动消失。</span></div></div><label>提示显示时间<select value={preferences.notificationDurationMs} onChange={event => onPreferencesChange({ ...preferences, notificationDurationMs: Number(event.target.value) })}><option value={3000}>3 秒</option><option value={5000}>5 秒</option><option value={8000}>8 秒</option></select><ChevronDown size={15} /></label><div className="notification-sound-row"><span><strong>成功 / 失败提示音</strong><small>任务状态变化时播放简短提示音</small></span><button type="button" className={`switch ${preferences.notificationSound ? "checked" : ""}`} onClick={() => { const next = !preferences.notificationSound; onPreferencesChange({ ...preferences, notificationSound: next }); if (next) playNotificationSound("success"); }} aria-pressed={preferences.notificationSound}><span /></button></div></section>
    <section className="settings-section"><div className="settings-section-title"><Download size={18} /><div><strong>软件更新</strong><span>更新源：GitHub Release（组织主页优先，公开镜像备用）</span></div></div>
      {updateInfo && <div className={`update-status ${updateInfo.updateAvailable ? "available" : "current"}`}><strong>{updateInfo.updateAvailable ? `发现新版本 v${updateInfo.latestVersion}` : "当前已经是最新版本"}</strong><span>当前 v{updateInfo.currentVersion} · 最新 v{updateInfo.latestVersion}</span></div>}
      {updateProgress && <div className="update-progress"><div><span>{updateProgress.message}</span><b>{updateProgress.percent}%</b></div><progress max={100} value={updateProgress.percent} /></div>}
      <div className="settings-actions"><button type="button" className="secondary" disabled={!window.runningHub || checkingUpdate || installingUpdate} onClick={() => void checkUpdate()}>{checkingUpdate ? "正在检查…" : "检查更新"}</button>{updateInfo?.updateAvailable && <button type="button" className="primary" disabled={installingUpdate} onClick={() => void installUpdate()}>{installingUpdate ? <><LoaderCircle className="spin" size={14} />正在更新…</> : <><Download size={14} />立即更新并重启</>}</button>}<button type="button" className="ghost" disabled={installingUpdate} onClick={() => void window.runningHub?.updates.openRepository()}>项目主页</button></div>
      <div className="update-data-note"><ShieldCheck size={16} /><span>更新包会从官方 GitHub Release 下载并校验 SHA-256，随后自动替换程序文件并重启。API Key、工作流、任务和设置保存在独立数据库中，不会被更新器删除。</span></div>
    </section>
    {error && <div className="import-feedback error modal-feedback"><AlertTriangle size={16} /><span>{error}</span>{updateInfo?.updateAvailable && <button type="button" className="ghost small" onClick={() => void window.runningHub?.updates.openLatestRelease()}><ExternalLink size={13} />手动下载</button>}</div>}
    <div className="modal-actions"><button type="button" className="primary" disabled={installingUpdate} onClick={onClose}>完成</button></div>
  </div></div>;
}

function OutputPlayer({ output }: { output: JobOutputView }) {
  const [reload, setReload] = useState(0);
  const [mediaError, setMediaError] = useState<string>();
  const type = (output.type ?? "").toLowerCase();
  const url = output.previewUrl ?? output.url;
  useEffect(() => { setMediaError(undefined); setReload(0); }, [url]);
  if (mediaError) return <div className="output-unknown"><AlertTriangle size={28} /><span>{mediaError}</span><button className="secondary small" onClick={() => { setMediaError(undefined); setReload(value => value + 1); }}>重新加载</button></div>;
  if (type.includes("video") || /\.(mp4|webm|mov)(?:$|\?)/i.test(url)) return <video key={reload} className="output-player" src={url} controls playsInline preload="auto" onError={event => setMediaError(`视频加载失败（媒体错误 ${event.currentTarget.error?.code ?? "未知"}）`)} />;
  if (type.includes("audio") || /\.(mp3|wav|m4a|ogg)(?:$|\?)/i.test(url)) return <audio key={reload} className="output-audio" src={url} controls preload="auto" onError={event => setMediaError(`音频加载失败（媒体错误 ${event.currentTarget.error?.code ?? "未知"}）`)} />;
  if (type.includes("image") || /\.(png|jpe?g|webp|gif)(?:$|\?)/i.test(url)) return <img className="output-image" src={url} alt={output.label ?? "任务输出"} />;
  return <div className="output-unknown"><FileJson size={28} /><span>该输出格式暂不支持内嵌预览。</span></div>;
}

function AddAccountModal({ onClose, onAdd }: { onClose: () => void; onAdd: (label: string, keys: string[], detect: boolean) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [keysText, setKeysText] = useState("");
  const [saving, setSaving] = useState(false);
  const keys = [...new Set(keysText.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))];
  async function submit(detect: boolean) {
    if (!label.trim() || !keys.length || saving) return;
    setSaving(true);
    try { await onAdd(label, keys, detect); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={e => { e.preventDefault(); void submit(true); }}><div className="modal-head"><div><p>ACCOUNT POOL</p><h2>添加 RunningHub 账号</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div><label>账号名称<input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：海外账号（批量时自动追加序号）" /></label><label>API Key（支持批量）<textarea className="api-key-list" value={keysText} onChange={e => setKeysText(e.target.value)} placeholder="每行粘贴一个 API Key；重复项会自动去除" rows={5} spellCheck={false} /></label><div className="security-note plaintext-warning"><AlertTriangle size={18} /><span>已输入 {keys.length} 个唯一 Key。Key 将明文保存在本机数据库，请保护电脑和数据文件。</span></div><div className="modal-actions account-modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="secondary" disabled={saving || !label.trim() || !keys.length} onClick={() => void submit(false)}>仅保存</button><button type="submit" className="primary" disabled={saving || !label.trim() || !keys.length}>{saving ? "正在保存…" : "保存并后台检测"}</button></div></form></div>;
}

function ReplaceAccountKeyModal({ account, onClose, onSave }: { account: AccountView; onClose: () => void; onSave: (id: string, apiKey: string) => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    try { await onSave(account.id, apiKey); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={event => { event.preventDefault(); void submit(); }}><div className="modal-head"><div><p>ACCOUNT SECURITY</p><h2>重新录入 API Key</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="rekey-account"><span className="avatar">{account.label.slice(0, 1)}</span><div><strong>{account.label}</strong><small>{account.id}</small></div></div><label>新的 API Key<input autoFocus type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="重新输入该账号的完整 API Key" /></label><div className="security-note"><ShieldCheck size={18} /><span>保存后只检测这个账号，不会触发其他账号检测，也不会删除任务历史。</span></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={!apiKey.trim() || saving}>{saving ? "保存中…" : "保存并检测此账号"}</button></div></form></div>;
}

export default App;
