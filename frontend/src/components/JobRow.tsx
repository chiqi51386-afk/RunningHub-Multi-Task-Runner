import { FileJson, FolderOpen, LoaderCircle, Music2, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { memo } from "react";
import { taskListName as taskDisplayName } from "../job-search";
import { StaticVideoThumbnail } from "../MediaFields";
import type { JobView } from "../types";

import { StatusPill, activeJobStatuses, isTerminalJobStatus, localizedFailureReason, relativeTime } from "../app-shared";
import { useSharedClock } from "../shared-clock";
export const JobRow = memo(function JobRow({ job, cancelling = false, compact, onCancel, onRegenerate, onDelete, onPreview, onReveal }: { job: JobView; cancelling?: boolean; compact?: boolean; onCancel?: (id: string) => void; onRegenerate?: (job: JobView) => void; onDelete?: (id: string) => void; onPreview?: (id: string) => void; onReveal?: (localPath: string) => void }) {
  cancelling = cancelling || Boolean(job.cancelRequestedAt && ["SUBMITTING", "REMOTE_QUEUED", "RUNNING", "RETRY_WAIT"].includes(job.status));
  const terminal = isTerminalJobStatus(job.status);
  const showElapsed = Boolean(job.generationStartedAt) && (activeJobStatuses.has(job.status) || job.status === "COMPLETED");
  return <article className={`job-row ${compact ? "compact" : ""}`}><JobThumbnail job={job} /><div className="job-main"><div className="job-title"><strong>{taskDisplayName(job)}</strong>{job.instanceType === "plus" && <b className="instance-badge">PLUS</b>}<StatusPill status={job.status} /></div><div className="job-meta"><span>{job.remoteTaskId ? `taskId ${job.remoteTaskId}` : (job.status === "OPTIMIZE_PENDING" || job.status === "OPTIMIZING") ? job.stageLabel : "等待分配远端任务"}</span><i /><span>{relativeTime(job.createdAt)}</span>{showElapsed && <><i /><ElapsedTime job={job} /></>}</div>{job.error && job.status !== "SUBMIT_UNKNOWN" && <><p className="job-error">{job.status === "FAILED" ? localizedFailureReason(job.error, job.status) : job.error}</p>{job.errorDetail && <details className="job-error-detail"><summary>查看错误详情</summary><span>类型：{job.errorDetail.code}</span><span>阶段：{job.errorDetail.phase}</span>{job.errorDetail.remoteCode && <span>RunningHub：{job.errorDetail.remoteCode}</span>}{job.errorDetail.nodeId && <span>节点：{job.errorDetail.nodeId}{job.errorDetail.nodeName ? `（${job.errorDetail.nodeName}）` : ""}</span>}</details>}</>}{job.status === "SUBMIT_UNKNOWN" && <p className="job-error">{localizedFailureReason(job.error, job.status)}</p>}{!compact && !terminal && <div className="progress indeterminate"><span /></div>}</div>{!compact && <div className="job-actions">{onPreview && <button className="primary small" onClick={() => onPreview(job.id)}><Play size={14} />提交参数预览</button>}{onRegenerate && job.inputs && <button className="secondary small" onClick={() => onRegenerate(job)}><RefreshCw size={14} />再次生成</button>}{job.outputs?.[0]?.localPath && onReveal && <button className="secondary small" onClick={() => onReveal(job.outputs![0]!.localPath!)}><FolderOpen size={14} />显示文件</button>}{!terminal && <button className="danger-button small" disabled={cancelling} aria-busy={cancelling} onClick={() => onCancel?.(job.id)}>{cancelling ? <LoaderCircle className="spin" size={13} /> : <Square size={13} />}{cancelling ? "正在取消…" : ["DOWNLOAD_PENDING", "DOWNLOADING"].includes(job.status) || (job.status === "RETRY_WAIT" && job.retryPhase === "download") ? "取消下载" : "停止生成"}</button>}{terminal && onDelete && <button className="icon-button danger" onClick={() => onDelete(job.id)} title="删除任务"><Trash2 size={15} /></button>}</div>}</article>;
});

function ElapsedTime({ job }: { job: JobView }) {
  const clock = useSharedClock(activeJobStatuses.has(job.status) && !job.generationCompletedAt);
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
  if (source && type === "image") return <div className="job-thumbnail"><img loading="lazy" decoding="async" src={source} alt="任务缩略图" /></div>;
  if (source && type === "video") return <StaticVideoThumbnail localPath={output?.localPath ?? input?.localPath} />;
  if (audio) return <div className="job-thumbnail audio" title={audio.fileName}><Music2 size={18} /><span>音频</span></div>;
  return <div className="job-thumbnail fallback">{job.outputType === "MP4" ? <Play size={17} /> : <FileJson size={17} />}</div>;
}
