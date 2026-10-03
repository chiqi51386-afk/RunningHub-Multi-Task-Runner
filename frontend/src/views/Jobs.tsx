import { FolderOpen } from "lucide-react";
import { Suspense, lazy, useMemo, useState } from "react";
import { VirtualList } from "../components/VirtualList";
import type { JobView } from "../types";
import { useLatestCallback } from "../useLatestCallback";

import { PageHeading, isTerminalJobStatus } from "../app-shared";
import { JobRow } from "../components/JobRow";
const TaskPreviewModal = lazy(() => import("../modals/TaskPreviewModal"));
export default function Jobs({ jobs, cancelling, onCancel, onRegenerate, onDelete, onReveal }: { jobs: JobView[]; cancelling: ReadonlySet<string>; onCancel: (id: string) => void; onRegenerate: (job: JobView) => void; onDelete: (id: string) => void; onReveal: (localPath: string) => void }) {
  const [filter, setFilter] = useState<"ALL" | "ACTIVE" | "COMPLETED" | "FAILED">("ALL");

  const [queueError, setQueueError] = useState<string>();
  const [previewingId, setPreviewingId] = useState<string>();

  const previewing = jobs.find(job => job.id === previewingId);
  const shown = useMemo(() => jobs.filter(job => (filter === "ALL" || (filter === "ACTIVE" && !isTerminalJobStatus(job.status)) || (filter === "FAILED" && ["FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status)) || job.status === filter))
    .sort((left, right) => right.createdAt - left.createdAt), [jobs, filter]);
  const cancel = useLatestCallback(onCancel);
  const regenerate = useLatestCallback(onRegenerate);
  const remove = useLatestCallback(onDelete);
  const reveal = useLatestCallback(onReveal);
  return <>
    <PageHeading eyebrow="任务管理" title="任务队列" description="已提交任务保留完整输入快照；生成完成后可预览全部视频、图片和音频输出。" action={window.runningHub ? <button className="secondary" onClick={() => void window.runningHub?.downloads.openDirectory().catch(error => setQueueError(error instanceof Error ? error.message : "打开下载目录失败"))}><FolderOpen size={16} />打开下载库</button> : undefined} />
    {queueError && <div className="import-feedback error" role="alert">{queueError}</div>}<div className="panel jobs-panel"><div className="jobs-toolbar"><div className="segmented">{(["ALL", "ACTIVE", "COMPLETED", "FAILED"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "ALL" ? "全部" : value === "ACTIVE" ? "进行中" : value === "COMPLETED" ? "已完成" : "失败"}</button>)}</div></div><div className="job-list">{shown.length ? <VirtualList key={filter} items={shown} label="任务列表" renderItem={job => <JobRow job={job} cancelling={cancelling.has(job.id)} onReveal={reveal} onCancel={cancel} onRegenerate={regenerate} onDelete={remove} onPreview={setPreviewingId} />} /> : <div className="job-list-empty">没有符合条件的任务。</div>}</div></div>
    <Suspense fallback={<div className="operation-toast" role="status">正在加载预览…</div>}>{previewing && <TaskPreviewModal job={previewing} onReveal={onReveal} onClose={() => setPreviewingId(undefined)} />}</Suspense>
  </>;
}
