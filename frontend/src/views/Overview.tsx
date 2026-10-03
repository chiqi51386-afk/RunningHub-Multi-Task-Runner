import { Activity, ArrowRight, CircleDollarSign, Clock3, Server, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { AccountView, JobView, ViewId } from "../types";

import { AccountPill, PageHeading } from "../app-shared";
import { JobRow } from "../components/JobRow";
export default function Overview({ stats, accounts, jobs, onView }: { stats: { available: number; running: number; queued: number; completed: number; coins: number }; accounts: AccountView[]; jobs: JobView[]; onView: (v: ViewId) => void }) {
  const recent = useMemo(() => jobs.filter(job => !["FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status)).sort((left, right) => right.createdAt - left.createdAt).slice(0, 100), [jobs]);
  return <>
    <PageHeading eyebrow="运行中心" title="运行概览" description="查看账号容量、任务执行和下载状态。" action={<button className="secondary" onClick={() => onView("jobs")}>查看全部任务<ArrowRight size={16} /></button>} />
    <section className="metric-grid">
      <Metric icon={Server} label="可用账号" value={`${stats.available} / ${accounts.length}`} tone="blue" />
      <Metric icon={Activity} label="正在执行" value={String(stats.running)} tone="violet" />
      <Metric icon={Clock3} label="队列等待" value={String(stats.queued)} tone="amber" />
      <Metric icon={CircleDollarSign} label="RH 币余额" value={stats.coins.toLocaleString()} tone="green" />
    </section>
    <section className="dashboard-grid">
      <div className="panel activity-panel">
        <div className="panel-head"><div><h2>任务活动</h2></div><button className="ghost" onClick={() => onView("jobs")}>任务队列<ArrowRight size={15} /></button></div>
        <div className="job-stack overview-scroll" tabIndex={0} role="region" aria-label="任务活动列表">{recent.map(job => <JobRow key={job.id} job={job} compact />)}{!recent.length && <div className="empty-parameters">暂无任务</div>}</div>
      </div>
      <div className="panel capacity-panel">
        <div className="panel-head"><div><h2>账号容量</h2></div><ShieldCheck size={20} /></div>
        <div className="account-stack overview-scroll" tabIndex={0} role="region" aria-label="账号容量列表">{accounts.map(account => <div className="mini-account" key={account.id}><div><strong>{account.label}</strong><span>{account.coins ?? "—"} RH 币</span></div><AccountPill state={account.state} remoteTaskCount={account.remoteTaskCount} /></div>)}</div>
        <button className="full-secondary" onClick={() => onView("accounts")}>管理账号池</button>
      </div>
    </section>
  </>;
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Server; label: string; value: string; tone: string }) {
  return <article className={`metric metric-${tone}`}><div className="metric-top"><span className="metric-icon"><Icon size={19} /></span></div><strong>{value}</strong><h3>{label}</h3></article>;
}
