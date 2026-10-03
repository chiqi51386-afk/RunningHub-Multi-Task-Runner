import { AlertTriangle, ChevronDown, Download, ExternalLink, FolderOpen, LoaderCircle, RefreshCw, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateInfo, UpdateProgress } from "../bridge";
import { Select } from "../Select";
import { themes } from "../themes";

import { playNotificationSound, type UiPreferences } from "../app-shared";
export default function SettingsModal({ preferences, onPreferencesChange, onClose }: { preferences: UiPreferences; onPreferencesChange: (preferences: UiPreferences) => void; onClose: () => void }) {
  const [naming, setNaming] = useState({ rule: "workflow-date", preview: "正在读取…" });
  const [savingNaming, setSavingNaming] = useState(false);
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
    void bridge.downloads.naming().then(setNaming).catch(reason => setError(String(reason)));
    void bridge.downloads.directory().then(setDownloadDirectory).catch(reason => setError(reason instanceof Error ? reason.message : "读取下载目录失败"));
    return bridge.updates.onProgress(setUpdateProgress);
  }, []);

  async function openSettingsLink(action: (() => Promise<unknown>) | undefined) {
    try { await action?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
  }

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
    <div className="modal-head"><div><h2>应用设置</h2></div><button type="button" className="icon-button" disabled={installingUpdate} onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
    <div className="settings-scroll" tabIndex={0} aria-label="设置内容">
    <section className="settings-section"><div className="settings-section-title"><FolderOpen size={18} /><div><strong>下载目录</strong><span>新建任务使用此目录；已经创建的任务保留原下载目录。</span></div></div><div className="directory-path" title={downloadDirectory}>{downloadDirectory}</div><div className="settings-actions"><button type="button" className="secondary" disabled={!window.runningHub || working || installingUpdate} onClick={() => void chooseDirectory()}>{working ? "处理中…" : "选择文件夹"}</button><button type="button" className="secondary" disabled={!window.runningHub || working || installingUpdate} onClick={() => void openSettingsLink(window.runningHub?.downloads.openDirectory)}><FolderOpen size={15} />打开当前目录</button><button type="button" className="ghost" disabled={!window.runningHub || working || installingUpdate} onClick={() => void resetDirectory()}><RefreshCw size={14} />恢复默认</button></div></section>
    <section className="settings-section"><h3>命名规则</h3><label>自动重命名<Select value={naming.rule} disabled={!window.runningHub || savingNaming} onChange={async event => {
      const rule = event.target.value; setSavingNaming(true); setError(undefined);
      try { if (window.runningHub) setNaming(await window.runningHub.downloads.setNaming(rule)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "保存命名规则失败"); }
      finally { setSavingNaming(false); }
    }}><option value="workflow-date">日期时间 + 工作流 + 任务编号</option><option value="date">日期时间 + 任务编号</option><option value="original">远端原文件名 + 任务编号</option></Select></label><div className="naming-preview"><span>文件名预览</span><code>{naming.preview}</code></div><p>仅作用于新建任务；已有文件不改名。每个输出附加序号，重试保留相同名称。</p></section>
    <section className="settings-section"><div className="settings-section-title"><Settings2 size={18} /><div><strong>完成与失败提示</strong><span>顶部小提示不会阻塞操作，到时间后自动消失。</span></div></div><label>提示显示时间<Select value={preferences.notificationDurationMs} onChange={event => onPreferencesChange({ ...preferences, notificationDurationMs: Number(event.target.value) })}><option value={3000}>3 秒</option><option value={5000}>5 秒</option><option value={8000}>8 秒</option></Select><ChevronDown size={15} /></label><div className="notification-sound-row"><span><strong>成功 / 失败提示音</strong><small>任务状态变化时播放简短提示音</small></span><button type="button" className={`switch ${preferences.notificationSound ? "checked" : ""}`} onClick={() => { const next = !preferences.notificationSound; onPreferencesChange({ ...preferences, notificationSound: next }); if (next) playNotificationSound("success"); }} aria-pressed={preferences.notificationSound}><span /></button></div></section>
    <section className="settings-section"><h3>主题颜色</h3><div className="theme-presets">{themes.map(theme => <button type="button" key={theme.id} className={preferences.theme === theme.id ? "theme-card selected" : "theme-card"} aria-pressed={preferences.theme === theme.id} style={{ background: theme.colors[1], color: theme.colors[3] }} onClick={() => onPreferencesChange({ ...preferences, theme: theme.id })}><span className="theme-swatches">{theme.colors.map((color, index) => <i key={index} style={{ background: color }} />)}</span><strong>{theme.name}</strong></button>)}</div></section>
    <section className="settings-section"><div className="settings-section-title"><Download size={18} /><div><strong>软件更新</strong><span>更新源：chiqi51386-afk / RunningHub-Multi-Task-Runner</span></div></div>
      {updateInfo && <div className={`update-status ${updateInfo.updateAvailable ? "available" : "current"}`}><strong>{updateInfo.updateAvailable ? `发现新版本 v${updateInfo.latestVersion}` : "当前已经是最新版本"}</strong><span>当前 v{updateInfo.currentVersion} · 最新 v{updateInfo.latestVersion}</span></div>}
      {updateProgress && <div className="update-progress"><div><span>{updateProgress.message}</span><b>{updateProgress.percent}%</b></div><progress max={100} value={updateProgress.percent} /></div>}
      <div className="settings-actions"><button type="button" className="secondary" disabled={!window.runningHub || checkingUpdate || installingUpdate} onClick={() => void checkUpdate()}>{checkingUpdate ? "正在检查…" : "检查更新"}</button>{updateInfo?.updateAvailable && <button type="button" className="primary" disabled={installingUpdate} onClick={() => void installUpdate()}>{installingUpdate ? <><LoaderCircle className="spin" size={14} />正在更新…</> : <><Download size={14} />立即更新并重启</>}</button>}<button type="button" className="ghost" disabled={installingUpdate} onClick={() => void openSettingsLink(window.runningHub?.updates.openRepository)}>项目主页</button></div>
      <div className="update-data-note"><ShieldCheck size={16} /><span>更新包会从官方 GitHub Release 下载并校验 SHA-256，随后自动替换程序文件并重启。API Key、工作流、任务和设置保存在独立数据库中，不会被更新器删除。</span></div>
    </section>
    {error && <div className="import-feedback error modal-feedback"><AlertTriangle size={16} /><span>{error}</span>{updateInfo?.updateAvailable && <button type="button" className="ghost small" onClick={() => void openSettingsLink(window.runningHub?.updates.openLatestRelease)}><ExternalLink size={13} />手动下载</button>}</div>}
    </div>
    <div className="modal-actions"><button type="button" className="primary" disabled={installingUpdate} onClick={onClose}>完成</button></div>
  </div></div>;
}
