import { AlertTriangle, ChevronDown, Download, ExternalLink, FolderOpen, LoaderCircle, RefreshCw, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateInfo, UpdateProgress } from "../bridge";
import { Select } from "../Select";
import { Feedback } from "../Feedback";
import { themes } from "../themes";

import { playNotificationSound, type UiPreferences } from "../app-shared";
export default function SettingsModal({ preferences, onPreferencesChange, onClose }: { preferences: UiPreferences; onPreferencesChange: (preferences: UiPreferences) => void; onClose: () => void }) {
  const [naming, setNaming] = useState({ rule: "workflow-date", preview: "正在读取…" });
  const [savingNaming, setSavingNaming] = useState(false);
  const [downloadDirectory, setDownloadDirectory] = useState("正在读取…");
  const [error, setError] = useState<string>();
  const [proxy, setProxy] = useState({ enabled: false, url: "" });
  const [proxyType, setProxyType] = useState("http");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [activeProxy, setActiveProxy] = useState({ enabled: false, url: "" });
  const [proxyReady, setProxyReady] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyMessage, setProxyMessage] = useState<string>();
  const [proxyResults, setProxyResults] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>();
  useEffect(() => {
    const bridge = window.runningHub;
    if (!bridge) { setDownloadDirectory("仅桌面应用支持自定义下载目录"); return; }
    void bridge.proxy.settings().then(value => {
      setProxy(value.saved); setActiveProxy(value.active);
      if (value.saved.url) { const parsed = new URL(value.saved.url); setProxyType(parsed.protocol.slice(0,-1)); setProxyHost(parsed.hostname); setProxyPort(parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "1080")); }
      setProxyReady(true);
    }).catch(reason => setError(String(reason)));
    void bridge.downloads.naming().then(setNaming).catch(reason => setError(String(reason)));
    void bridge.downloads.directory().then(setDownloadDirectory).catch(reason => setError(reason instanceof Error ? reason.message : "读取下载目录失败"));
    return bridge.updates.onProgress(setUpdateProgress);
  }, []);

  async function configureProxy(test: boolean) {
    if (!window.runningHub || proxyBusy) return;
    setProxyBusy(true); setError(undefined); setProxyMessage(undefined); setProxyResults([]);
    try {
      const host = proxyHost.trim();
      if ((proxy.enabled || host || proxyPort) && (!host || /[\s\/@?#;,]/.test(host) || !/^\d+$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535)) throw new Error("请填写有效的 IP／主机地址和 1–65535 的端口");
      const input = { enabled: proxy.enabled, url: host ? `${proxyType}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${proxyPort}` : "" };
      if (test) setProxyResults(await window.runningHub.proxy.test(input));
      else {
        const result = await window.runningHub.proxy.save(input);
        setProxy(result.saved); setActiveProxy(result.active);
        setProxyMessage(JSON.stringify(result.saved) === JSON.stringify(result.active) ? "已保存，新请求立即生效；已发出的请求继续使用原连接。" : "已保存，当前程序需重启才能切换连接。");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "代理设置失败"); }
    finally { setProxyBusy(false); }
  }

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
    <section className="settings-section">
      <div className="settings-section-title"><Settings2 size={18} /><div><strong>独立代理</strong><span>不跟随系统代理。用于 Gemini、RunningHub、文件下载和软件更新。</span></div></div>
      <div className="notification-sound-row"><span><strong>启用自定义代理</strong><small>关闭时直接连接；点击保存后立即用于新请求。</small></span><button type="button" aria-label="启用自定义代理" className={`switch ${proxy.enabled ? "checked" : ""}`} disabled={!proxyReady || proxyBusy} aria-pressed={proxy.enabled} onClick={() => { setProxy({ ...proxy, enabled: !proxy.enabled }); setProxyResults([]); setProxyMessage(undefined); }}><span /></button></div>
      <div className="proxy-fields">
        <label>类型<Select aria-label="代理类型" value={proxyType} disabled={!proxyReady || proxyBusy} onChange={e=>{setProxyType(e.target.value);setProxyResults([]);setProxyMessage(undefined);}}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></Select></label>
        <label>IP／主机地址<input aria-label="代理地址" value={proxyHost} disabled={!proxyReady || proxyBusy} autoComplete="off" spellCheck={false} placeholder="127.0.0.1" onChange={e=>{setProxyHost(e.target.value);setProxyResults([]);setProxyMessage(undefined);}} /></label>
        <label>端口<input aria-label="代理端口" type="text" inputMode="numeric" value={proxyPort} disabled={!proxyReady || proxyBusy} placeholder="7890" onChange={e=>{setProxyPort(e.target.value);setProxyResults([]);setProxyMessage(undefined);}} /></label>
      </div>
      <p>支持 HTTP、HTTPS、SOCKS5 无密码代理，请填写代理软件的实际端口。不会自动退回系统代理或直连。</p>
      <p>当前连接：{activeProxy.enabled ? activeProxy.url : "直连（不使用系统代理）"}</p>
      <div className="settings-actions"><button type="button" className="secondary" disabled={!proxyReady || proxyBusy} onClick={() => void configureProxy(true)}>{proxyBusy ? "处理中…" : "测试连接"}</button><button type="button" className="primary" disabled={!proxyReady || proxyBusy} onClick={() => void configureProxy(false)}>保存代理设置</button></div>
      {proxyMessage && <p role="status">{proxyMessage}</p>}
      {proxyResults.length > 0 && <div role="status">{proxyResults.map(result => <p key={result}>{result}</p>)}<small>仅测试网络连通性，不检测 API Key 或模型权限，也不产生生成费用。</small></div>}
    </section>
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
    <Feedback message={error} onClose={()=>setError(undefined)}>{updateInfo?.updateAvailable && <button type="button" className="ghost small" onClick={() => void openSettingsLink(window.runningHub?.updates.openLatestRelease)}><ExternalLink size={13} />手动下载</button>}</Feedback>
    </div>
    <div className="modal-actions"><button type="button" className="primary" disabled={installingUpdate} onClick={onClose}>完成</button></div>
  </div></div>;
}
