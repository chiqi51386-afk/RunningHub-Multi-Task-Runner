import { AlertTriangle, Boxes, Check, Gauge, LayoutDashboard, ListTodo, LoaderCircle, Menu, Play, Plus, Settings2, Square, UsersRound, Workflow, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmDialog } from "./ConfirmDialog";
import { CreateJob } from "./CreateTask";
import { activeJobStatuses, defaultUiPreferences, localizedFailureReason, playNotificationSound, type UiPreferences } from "./app-shared";
import { hasDesktopBridge } from "./bridge";
import { regenerateDraft } from "./regenerate-draft";
import { validTheme } from "./themes";
import type { AccountView, CreateJobDraft, JobView, ViewId, WorkflowView } from "./types";
import { useDebouncedSave } from "./useDebouncedSave";
import { useDialogFocus } from "./useDialogFocus";
import { useErrorQueue } from "./useErrorQueue";
import Accounts from "./views/Accounts";
import Jobs from "./views/Jobs";
import Overview from "./views/Overview";
import { migrateWorkflowView } from "./workflow-view";
const Workflows = lazy(() => import("./views/Workflows"));
const SettingsModal = lazy(() => import("./modals/SettingsModal"));
const TaskPreviewModal = lazy(() => import("./modals/TaskPreviewModal"));
const AddAccountModal = lazy(() => import("./modals/AccountModals").then(m => ({ default: m.AddAccountModal })));
const ReplaceAccountKeyModal = lazy(() => import("./modals/AccountModals").then(m => ({ default: m.ReplaceAccountKeyModal })));
export { discoverParameters } from "./workflow-view";

const initialAccounts: AccountView[] = [];
const initialWorkflows: WorkflowView[] = [];
const initialJobs: JobView[] = [];

function loadSavedWorkflows(): WorkflowView[] {
  if (window.runningHub) return [];
  try {
    const saved = localStorage.getItem("rh-runner.workflows.v1");
    if (!saved) return initialWorkflows.map(migrateWorkflowView);
    const parsed = JSON.parse(saved) as WorkflowView[];
    return Array.isArray(parsed) && parsed.length ? parsed.map(migrateWorkflowView) : initialWorkflows.map(migrateWorkflowView);
  } catch { return initialWorkflows.map(migrateWorkflowView); }
}

const nav: Array<{ id: ViewId; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "运行概览", icon: LayoutDashboard },
  { id: "accounts", label: "账号池", icon: UsersRound },
  { id: "workflows", label: "工作流", icon: Workflow },
  { id: "create", label: "创建任务", icon: Plus },
  { id: "jobs", label: "任务队列", icon: ListTodo },
];

function loadUiPreferences(): UiPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem("rh-runner.ui-preferences.v1") ?? "{}") as Partial<UiPreferences>;
    return {
      notificationDurationMs: [3_000, 5_000, 8_000].includes(saved.notificationDurationMs ?? 0) ? saved.notificationDurationMs! : defaultUiPreferences.notificationDurationMs,
      theme: validTheme(saved.theme),
      notificationSound: typeof saved.notificationSound === "boolean" ? saved.notificationSound : defaultUiPreferences.notificationSound,
    };
  } catch { return defaultUiPreferences; }
}

function App() {
  useDialogFocus();
  const [view, setView] = useState<ViewId>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [schedulerRunning, setSchedulerRunning] = useState(false);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
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
  const [appError, setAppError] = useErrorQueue();
  const [copyNotice, setCopyNotice] = useState<string>();
  useEffect(() => { if (!copyNotice) return; const timer = setTimeout(() => setCopyNotice(undefined), 3000); return () => clearTimeout(timer); }, [copyNotice]);
  const { confirm, dialog: confirmationDialog } = useConfirmDialog();
  const cancelLocks = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [uiPreferences, setUiPreferences] = useState(loadUiPreferences);
  const uiPreferencesRef = useRef(uiPreferences);
  const [noticeQueue, setNoticeQueue] = useState<Array<{ id: string; jobId: string; tone: "success" | "error"; title: string; message: string }>>([]);
  const taskNotice = noticeQueue[0];
  const dismissNotice = () => setNoticeQueue(current => current.slice(1));
  const knownJobStatuses = useRef(new Map(initialJobs.map(job => [job.id, job.status])));
  const desktopConnected = hasDesktopBridge();

  useEffect(() => {
    if (window.runningHub) {
      void window.runningHub.scheduler.status().then(setSchedulerRunning).catch(error => setAppError(error instanceof Error ? error.message : "读取调度器状态失败，请重新打开桌面应用"));
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
      setJobs(current => current.some(item => item.id === job.id) ? current.map(item => item.id === job.id ? job : item) : [job, ...current]);
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
        setNoticeQueue(current => [...current, notice].slice(-5));
        if (uiPreferencesRef.current.notificationSound) playNotificationSound(notice.tone);
      }
      knownJobStatuses.current.set(job.id, job.status);
    });
    return () => { removeAccountListener(); removeJobListener(); };
  }, []);

  useEffect(() => {
    if (!taskNotice) return;
    const timer = window.setTimeout(() => dismissNotice(), uiPreferences.notificationDurationMs);
    return () => window.clearTimeout(timer);
  }, [taskNotice, uiPreferences.notificationDurationMs]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiPreferences.theme;
    uiPreferencesRef.current = uiPreferences;

  }, [uiPreferences]);

  useDebouncedSave(() => {
    try { if (!window.runningHub) localStorage.setItem("rh-runner.workflows.v1", JSON.stringify(workflows)); }
    catch { setAppError("工作流配置保存失败，请检查本地存储空间。"); }
  }, [workflows]);

  useDebouncedSave(() => {
    try { localStorage.setItem("rh-runner.ui-preferences.v1", JSON.stringify(uiPreferences)); }
    catch { setAppError("界面设置保存失败，请检查本地存储空间。"); }
  }, [uiPreferences]);

  const stats = useMemo(() => {
    const result = { available: 0, running: 0, queued: 0, completed: 0, coins: 0 };
    for (const account of accounts) {
      if (account.enabled && account.state === "IDLE") result.available++;
      result.coins += Number(account.coins) || 0;
    }
    for (const job of jobs) {
      if (activeJobStatuses.has(job.status)) result.running++;
      if (job.status === "PENDING") result.queued++;
      if (job.status === "COMPLETED") result.completed++;
    }
    return result;
  }, [accounts, jobs]);

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
      setAccounts(current => current.map(account => account.id === id && account.state === "CHECKING" ? { ...account, state: "TEMP_UNAVAILABLE" } : account));
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
      setAccounts(current => current.map(account => account.state === "CHECKING" ? { ...account, state: "TEMP_UNAVAILABLE" } : account));
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

  const createJobs = useCallback(async (drafts: CreateJobDraft[], source: "single" | "batch"): Promise<boolean> => {
    try {
      if (!drafts.length) return false;
      const created = window.runningHub
        ? await window.runningHub.jobs.createBatch(drafts, { source, requestId: crypto.randomUUID(), expectedCount: drafts.length })
        : drafts.map(draft => {
          const workflow = workflows.find(w => w.id === draft.workflowId) ?? workflows[0];
          return { id: crypto.randomUUID(), workflowName: workflow.name, status: "PENDING" as const, instanceType: draft.instanceType, createdAt: Date.now(), outputType: "MP4" };
        });
      if (created.length !== drafts.length) throw new Error("提交数量异常，请先核对任务队列，不要重复提交。");
      setJobs(current => [...created, ...current.filter(item => !created.some(job => job.id === item.id))]);
      setView("jobs");
      return true;
    } catch (error) { throw new Error(error instanceof Error ? error.message : "任务创建失败"); }
  }, [workflows]);

  async function toggleScheduler() {
    if (schedulerBusy) return;
    setSchedulerBusy(true);
    const next = !schedulerRunning;
    try {
      if (window.runningHub) await (next ? window.runningHub.scheduler.start() : window.runningHub.scheduler.stop());
      setSchedulerRunning(next);
    } catch (error) { setAppError(error instanceof Error ? error.message : "调度器操作失败"); }
    finally { setSchedulerBusy(false); }
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
    let draft: CreateJobDraft;
    try { draft = regenerateDraft(job.inputs, workflow); }
    catch (error) { setAppError(error instanceof Error ? error.message : "原任务输入恢复失败"); return; }
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
          <div className="connection-card"><span className={desktopConnected ? "connected" : "demo"} /><div><strong>{desktopConnected ? "桌面核心已连接" : "界面演示模式"}</strong></div></div>
          <button className="settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} />设置</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(v => !v)} aria-label="打开导航"><Menu /></button>
          <div className="topbar-title"><span>RUNNINGHUB / {nav.find(n => n.id === view)?.label}</span></div>
          <div className="topbar-actions">
            <div className="scheduler-state"><span className={schedulerRunning ? "on" : "off"} /><div><small>调度器</small><strong>{schedulerRunning ? "运行中" : "已暂停"}</strong></div></div>
            <button className={`icon-toggle ${schedulerRunning ? "stop" : "start"}`} disabled={schedulerBusy} title={schedulerRunning ? "暂停调度" : "启动调度"} onClick={() => void toggleScheduler()}>{schedulerRunning ? <Square size={15} /> : <Play size={16} />}</button>
            <button className="primary compact" onClick={() => openFreshCreate()}><Plus size={17} />新建任务</button>
          </div>
        </header>

        <div className={`page ${view === "overview" ? "overview-page" : ""}`}>
          {appError && <div className="import-feedback error"><AlertTriangle size={17} /><span>{appError}</span><button className="icon-button" onClick={() => setAppError(undefined)}><X size={15} /></button></div>}
          {view === "overview" && <Overview stats={stats} accounts={accounts} jobs={jobs} onView={setView} />}
          {view === "accounts" && <Accounts accounts={accounts} refreshing={refreshing} onRefresh={refreshAccount} onRefreshAll={refreshAllAccounts} onAdd={() => setAddAccountOpen(true)} onCopyApiKeysUrl={() => { const url = "https://www.runninghub.ai/zh-cn/call-api/bill-task?tab=keys&type=consumer"; void (window.runningHub ? window.runningHub.external.copyApiKeysUrl() : navigator.clipboard.writeText(url)).then(() => setCopyNotice("API 密钥页面链接已复制")).catch(error => setAppError(error instanceof Error ? error.message : "复制失败，请重试")); }} onRekey={setRekeyAccount} onToggle={id => { const account = accounts.find(item => item.id === id); if (!account) return; if (window.runningHub) void window.runningHub.accounts.setEnabled(id, !account.enabled).then(updated => setAccounts(list => list.map(item => item.id === id ? updated : item))).catch(error => setAppError(error instanceof Error ? error.message : "账号状态更新失败")); else setAccounts(list => list.map(a => a.id === id ? { ...a, enabled: !a.enabled, state: a.enabled ? "DISABLED" : "IDLE" } : a)); }} onRemove={async id => { const account = accounts.find(item => item.id === id); if (!account || !await confirm(`删除账号“${account.label}”？已保存的 API Key 将一并删除。`)) return; if (window.runningHub) void window.runningHub.accounts.remove(id).then(() => setAccounts(list => list.filter(item => item.id !== id))).catch(error => setAppError(error instanceof Error ? error.message : "账号删除失败")); else setAccounts(list => list.filter(item => item.id !== id)); }} />}
          <Suspense fallback={<div className="operation-toast" role="status">正在加载…</div>}>{view === "workflows" && <Workflows workflows={workflows} onImport={workflow => setWorkflows(current => [workflow, ...current.filter(item => item.id !== workflow.id)])} onUpdate={workflow => setWorkflows(current => current.map(item => item.id === workflow.id ? workflow : item))} onDelete={async workflowId => { if (window.runningHub) await window.runningHub.workflows.remove(workflowId); setWorkflows(current => current.filter(item => item.id !== workflowId)); if (createWorkflowId === workflowId) setCreateWorkflowId(workflows.find(item => item.id !== workflowId)?.id ?? ""); }} onUse={workflowId => openFreshCreate(workflowId)} />}</Suspense>
          <div hidden={view !== "create"}><CreateJob active={view === "create"} requestRevision={createRevision} workflows={workflows} initialWorkflowId={createWorkflowId} initialDraft={createDraftOverride} onCreate={createJobs} /></div>
          {view === "jobs" && <Jobs jobs={jobs} onReveal={revealFile} cancelling={cancelling} onCancel={async id => {
            if (cancelLocks.current.has(id)) return;
            const job = jobs.find(item => item.id === id);
            if (!job) return;
            cancelLocks.current.add(id);
            try {
              if (!(await confirm(`确定停止“${job.workflowName}”？已经产生的远端费用可能无法退回。`))) return;
              setCancelling(current => new Set(current).add(id));
              const updated = window.runningHub ? await window.runningHub.jobs.cancel(id) : { ...job, status: "CANCELLED" as const, error: "已由用户取消" };
              setJobs(list => list.map(item => item.id === id ? updated : item));
            } catch (error) { setAppError(error instanceof Error ? error.message : "取消失败，请稍后重试"); }
            finally { cancelLocks.current.delete(id); setCancelling(current => { const next = new Set(current); next.delete(id); return next; }); }
          }} onRegenerate={regenerateFrom} onDelete={async id => { const job = jobs.find(item => item.id === id); if (!job || !await confirm(`删除任务“${job.workflowName}”？下载到本地的媒体文件不会被删除。`)) return; if (window.runningHub) void window.runningHub.jobs.remove(id).then(() => setJobs(list => list.filter(item => item.id !== id))).catch(error => setAppError(error instanceof Error ? error.message : "任务删除失败")); else setJobs(list => list.filter(item => item.id !== id)); }} />}
        </div>
      </main>
      {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
      <Suspense fallback={<div className="operation-toast" role="status">正在加载…</div>}>{addAccountOpen && <AddAccountModal onClose={() => setAddAccountOpen(false)} onAdd={addAccounts} />}</Suspense>
      <Suspense fallback={<div className="operation-toast" role="status">正在加载…</div>}>{rekeyAccount && <ReplaceAccountKeyModal account={rekeyAccount} onClose={() => setRekeyAccount(undefined)} onSave={replaceAccountKey} />}</Suspense>
      {confirmationDialog}
      {copyNotice && <div className="operation-toast" role="status">{copyNotice}</div>}
      {cancelling.size > 0 && <div className="operation-toast" role="status"><LoaderCircle className="spin" size={17} />正在取消 {cancelling.size} 个任务，请稍候…</div>}
      <Suspense fallback={<div className="operation-toast" role="status">正在加载…</div>}>{settingsOpen && <SettingsModal preferences={uiPreferences} onPreferencesChange={setUiPreferences} onClose={() => setSettingsOpen(false)} />}</Suspense>
      <Suspense fallback={<div className="operation-toast" role="status">正在加载…</div>}>{noticePreviewJobId && jobs.find(job => job.id === noticePreviewJobId) && <TaskPreviewModal job={jobs.find(job => job.id === noticePreviewJobId)!} onReveal={revealFile} onClose={() => setNoticePreviewJobId(undefined)} />}</Suspense>
      {taskNotice && <div className={`task-toast ${taskNotice.tone}`} role="status"><div className="task-toast-icon">{taskNotice.tone === "success" ? <Check size={16} /> : <AlertTriangle size={16} />}</div><span><strong>{taskNotice.title}</strong><small>{taskNotice.message}</small></span>{taskNotice.tone === "success" && <button className="task-toast-preview" type="button" onClick={() => { dismissNotice(); setNoticePreviewJobId(taskNotice.jobId); }}>预览</button>}<button className="task-toast-close" type="button" onClick={() => dismissNotice()} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
  );
}


export default App;
