import { AlertTriangle, KeyRound, Link2, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AccountView } from "../types";
import { useState } from "react";
import { Select } from "../Select";
import GeminiSettings from "../modals/GeminiSettings";

import { AccountPill, PageHeading, relativeTime } from "../app-shared";
export default function Accounts({ accounts, refreshing, onRefresh, onRefreshAll, onAdd, onRekey, onToggle, onRemove, onCopyApiKeysUrl }: { accounts: AccountView[]; refreshing: string | null; onRefresh: (id: string) => void; onRefreshAll: () => void; onAdd: () => void; onRekey: (account: AccountView) => void; onToggle: (id: string) => void; onRemove: (id: string) => void; onCopyApiKeysUrl: () => void }) {
  const [platform, setPlatform] = useState<"runninghub" | "gemini">("runninghub");
  const [concurrencyError,setConcurrencyError]=useState("");
  const [savingConcurrency,setSavingConcurrency]=useState<string>();
  return <>
    <div className="account-platform-tabs" role="tablist" aria-label="账号平台">
      <button type="button" role="tab" id="runninghub-tab" aria-controls="runninghub-panel" aria-selected={platform === "runninghub"} onClick={() => setPlatform("runninghub")}>RunningHub</button>
      <button type="button" role="tab" id="gemini-tab" aria-controls="gemini-panel" aria-selected={platform === "gemini"} onClick={() => setPlatform("gemini")}>Gemini</button>
    </div>
    <div id="runninghub-panel" role="tabpanel" aria-labelledby="runninghub-tab" hidden={platform !== "runninghub"}>
    <PageHeading eyebrow="账号管理" title="账号池" description="按账号实际权益设置最大并发，默认 1；降低并发不会中断正在运行的任务。" action={<div className="account-heading-actions"><button className="secondary" onClick={onCopyApiKeysUrl}><Link2 size={16} />复制 API 密钥页面链接</button><button className="secondary" onClick={onRefreshAll} disabled={Boolean(refreshing)}>{refreshing === "all" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}检测全部</button><button className="primary" onClick={onAdd}><Plus size={17} />添加账号</button></div>} />
    {concurrencyError && <p role="alert">{concurrencyError}</p>}
    <div className="panel table-panel">
      <div className="table-toolbar account-toolbar"><div className="toolbar-note"><AlertTriangle size={16} />API Key 已通过系统加密保存在本机</div></div>
      <div className="data-table account-table">
        <div className="table-header"><span>账号</span><span>状态</span><span>RH 币</span><span>并发</span><span>最近检测</span><span>操作</span></div>
        {accounts.map(account => <div className="table-row" key={account.id}>
          <div className="identity"><div><strong>{account.label}</strong><small>{account.id}</small></div></div>
          <AccountPill state={account.state} remoteTaskCount={account.remoteTaskCount} />
          <strong className="coin-value">{account.coins ?? "—"}</strong>
          <div className={`account-concurrency ${(account.maxConcurrency??1)>1?"multiple":""}`}>
            <Select aria-label={`${account.label} 最大并发`} value={String(account.maxConcurrency??1)} disabled={!!savingConcurrency||!window.runningHub} onChange={async e=>{const value=Number(e.target.value);setSavingConcurrency(account.id);setConcurrencyError("");try{await window.runningHub!.accounts.setConcurrency(account.id,value);}catch(error){setConcurrencyError(error instanceof Error?error.message:String(error));}finally{setSavingConcurrency(undefined);}}}>
              {Array.from(new Set([1,3,account.maxConcurrency??1])).sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n} 路</option>)}
            </Select>
            {!!((account.activeJobCount??0)+(account.externalTaskCount??0)) && <small title={`本机占用 ${account.activeJobCount??0}，远端其他占用 ${account.externalTaskCount??0}`}>占用 {(account.activeJobCount??0)+(account.externalTaskCount??0)}/{account.maxConcurrency??1}</small>}
          </div>

          <span className="muted">{relativeTime(account.lastCheckedAt)}</span>
          <div className="row-actions"><button className="icon-button" onClick={() => onRefresh(account.id)} disabled={Boolean(refreshing)} title="检测账号">{refreshing === account.id ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button><button className="icon-button" onClick={() => onRekey(account)} disabled={Boolean(account.currentJobId)} title={account.currentJobId ? "当前账号正在执行任务，不能更换 API Key" : "重新录入 API Key"}><KeyRound size={16} /></button><button className={`switch ${account.enabled ? "checked" : ""}`} onClick={() => onToggle(account.id)} disabled={Boolean(account.currentJobId)} title={account.currentJobId ? "当前账号正在执行任务，请任务结束后再停用" : undefined} aria-label={account.enabled ? "停用账号" : "启用账号"}><span /></button><button className="icon-button danger" onClick={() => onRemove(account.id)} title="删除账号"><Trash2 size={16} /></button></div>
        </div>)}
      </div>
    </div>
    </div>
    <div id="gemini-panel" role="tabpanel" aria-labelledby="gemini-tab" hidden={platform !== "gemini"}>
      <PageHeading eyebrow="账号管理" title="Gemini API 池" description="用于生成词优化 · 当前支持 Google Gemini" />
      <div className="panel gemini-account-panel"><GeminiSettings /></div>
    </div>
  </>;
}
