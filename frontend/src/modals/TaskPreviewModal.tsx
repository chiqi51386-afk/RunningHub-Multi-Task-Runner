import { AlertTriangle, FileJson, FolderOpen, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MediaPreview } from "../MediaFields";
import type { JobOutputView, JobView } from "../types";

import { taskDisplayName } from "../job-search";
import { StatusPill } from "../app-shared";
function formatSnapshotValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export default function TaskPreviewModal({ job, onClose, onReveal }: { job: JobView; onClose: () => void; onReveal: (localPath: string) => void }) {
  const [section, setSection] = useState<"inputs" | "outputs">(() => job.status === "COMPLETED" ? "outputs" : "inputs");
  const [selected, setSelected] = useState(0);
  const outputs = job.outputs ?? [];
  const output = outputs[selected];
  const media = job.inputs?.media ?? [];
  const parameters = job.submission?.nodeInfoList.map(node => {
    const key = `${node.nodeId}.${node.fieldName}`;
    const original = job.inputs?.parameters.find(item => item.key === key);
    return { id: key, key, label: original?.label ?? node.fieldName, semanticType: original?.semanticType, value: node.fieldValue };
  }) ?? job.inputs?.parameters ?? [];
  return <div className="modal-backdrop" role="presentation"><div className="modal output-preview-modal task-preview-modal" role="dialog" aria-modal="true" aria-label="任务预览"><div className="modal-head"><div><h2>{taskDisplayName(job)}</h2><div className="preview-task-meta"><StatusPill status={job.status} /><span>{job.remoteTaskId ? `taskId ${job.remoteTaskId}` : `本地任务 ${job.id}`}</span></div></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="preview-section-tabs"><button className={section === "inputs" ? "active" : ""} onClick={() => setSection("inputs")}>提交参数 <span>{media.length + parameters.length}</span></button><button className={section === "outputs" ? "active" : ""} onClick={() => setSection("outputs")}>生成输出 <span>{outputs.length}</span></button></div>{section === "inputs" ? <div className="task-inputs"><section><h3>生成词</h3>{job.optimizationTrace ? <><p>{job.optimizationTrace.model} · {job.optimizationTrace.skillName ?? "内置官方 Skill"}</p><CopyablePrompt label="原始生成词" text={job.optimizationTrace.originalText ?? String(job.inputs?.parameters.find(p=>p.semanticType==="prompt")?.value ?? "")}/><CopyablePrompt label="优化后生成词" text={job.optimizationTrace.finalText} empty={["OPTIMIZE_PENDING","OPTIMIZING"].includes(job.status) ? "正在等待优化结果，完成后自动显示。" : "未产生优化结果。"} /></> : job.inputs?.parameters.filter(p=>p.semanticType==="prompt"||p.semanticType==="negative_prompt").map(p=><CopyablePrompt key={p.id} label={p.label} text={String(p.value??"")}/>)}</section><section><h3>媒体预览（本地素材）</h3>{media.length ? <div className="snapshot-media-grid">{media.map(item => <article key={item.parameterId}><div className="snapshot-media-head"><div><strong>{item.label}</strong><span>节点 {item.key}</span></div><b>{item.mode === "replace" ? "已替换" : item.mode === "clear" ? "已清空" : "工作流默认"}</b></div>{item.previewUrl ? <MediaPreview type={item.type} url={item.previewUrl} /> : <div className="snapshot-media-placeholder">{item.mode === "clear" ? "本次任务未向该节点传入媒体" : "使用工作流保存的默认媒体"}</div>}{item.fileName && <small className="snapshot-filename">{item.fileName}</small>}</article>)}</div> : <div className="empty-parameters">该任务没有媒体输入节点。</div>}</section><section><h3>{job.submission ? "实际 API 提交参数" : "任务参数快照（尚无实际请求记录）"}</h3>{job.submission ? <><p>记录时间：{new Date(job.submission.recordedAt).toLocaleString()} · Workflow ID：{job.submission.workflowId} · {job.submission.instanceType === "plus" ? "Plus" : "标准"}</p><p>发送前保存；不代表远端已接收。未列出的字段未覆盖，使用云端工作流配置。</p><details><summary>完整提交记录 JSON</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(job.submission, null, 2)}</pre></details></> : <p role="status">未记录实际请求，无法核实最终提交参数；保留的媒体预览不作为实际提交证明。</p>}{parameters.length ? <div className="snapshot-parameter-list">{parameters.map(item => <div className={item.semanticType === "prompt" ? "prompt" : ""} key={item.id}><span><strong>{item.label}</strong><small>节点 {item.key}</small></span><p>{formatSnapshotValue(item.value)}</p></div>)}</div> : <div className="empty-parameters">没有可显示的参数。</div>}</section></div> : <div className="task-outputs">{outputs.length ? <><div className="output-tabs">{outputs.map((item, index) => <button key={`${item.url}-${index}`} className={index === selected ? "active" : ""} onClick={() => setSelected(index)}><span>{item.stage ? `阶段 ${item.stage}` : `输出 ${index + 1}`}</span><strong>{item.label ?? item.type ?? `输出 ${index + 1}`}</strong></button>)}</div>{output && <OutputPlayer key={output.previewUrl ?? output.url} output={output} />}</> : <div className="output-waiting"><LoaderCircle size={30} /><strong>{["FAILED", "CANCELLED", "SUBMIT_UNKNOWN"].includes(job.status) ? "该任务没有可预览输出" : "输出尚未生成"}</strong><span>任务状态变化时，此窗口会自动读取最新任务记录。</span></div>}{job.texts?.length ? <section className="text-outputs"><h3>文本输出</h3>{job.texts.map((text, index) => <pre key={index}>{text}</pre>)}</section> : null}{job.errorDetail ? <section className="task-error-detail"><h3>错误详情</h3><span>类型：{job.errorDetail.code}</span><span>阶段：{job.errorDetail.phase}</span>{job.errorDetail.remoteCode && <span>RunningHub：{job.errorDetail.remoteCode}</span>}{job.errorDetail.nodeId && <span>节点：{job.errorDetail.nodeId}{job.errorDetail.nodeName ? `（${job.errorDetail.nodeName}）` : ""}</span>}<p>{job.errorDetail.message}</p></section> : null}</div>}<div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button>{section === "outputs" && output?.localPath && <button className="secondary" onClick={() => onReveal(output.localPath!)}><FolderOpen size={16} />显示文件</button>}</div></div></div>;
}

function CopyablePrompt({label,text,empty="未填写"}:{label:string;text?:string;empty?:string}) {
  const [feedback,setFeedback]=useState('');
  return <section className="preview-prompt"><div className="section-title-row"><h3>{label}</h3><button className="secondary small" disabled={!text} onClick={async()=>{try{await navigator.clipboard.writeText(text!);setFeedback('已复制');}catch{setFeedback('复制失败，请手动选择文本');}}}>复制</button></div><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:260,overflow:'auto'}}>{text || empty}</pre>{feedback&&<span role="status">{feedback}</span>}</section>;
}

function OutputPlayer({ output }: { output: JobOutputView }) {
  const [reload, setReload] = useState(0);
  const [mediaError, setMediaError] = useState<string>();
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const type = (output.type ?? "").toLowerCase();
  const url = output.previewUrl ?? output.url;
  useEffect(() => {
    const element = mediaRef.current;
    // StrictMode replays effects in development using the same DOM element.
    if (element && element.getAttribute("src") !== url) element.setAttribute("src", url);
    return () => { if (element) { element.pause(); element.removeAttribute("src"); element.load(); } };
  }, [url, type, reload, mediaError]);
  useEffect(() => { setMediaError(undefined); setReload(0); }, [url]);
  if (mediaError) return <div className="output-unknown"><AlertTriangle size={28} /><span>{mediaError}</span><button className="secondary small" onClick={() => { setMediaError(undefined); setReload(value => value + 1); }}>重新加载</button></div>;
  if (type.includes("video") || /\.(mp4|webm|mov)(?:$|\?)/i.test(url)) return <video ref={mediaRef as React.Ref<HTMLVideoElement>} key={reload} className="output-player" src={url} controls playsInline preload="metadata" onError={event => setMediaError(`视频加载失败（媒体错误 ${event.currentTarget.error?.code ?? "未知"}）`)} />;
  if (type.includes("audio") || /\.(mp3|wav|m4a|ogg)(?:$|\?)/i.test(url)) return <audio ref={mediaRef as React.Ref<HTMLAudioElement>} key={reload} className="output-audio" src={url} controls preload="metadata" onError={event => setMediaError(`音频加载失败（媒体错误 ${event.currentTarget.error?.code ?? "未知"}）`)} />;
  if (type.includes("image") || /\.(png|jpe?g|webp|gif)(?:$|\?)/i.test(url)) return <img className="output-image" src={url} alt={output.label ?? "任务输出"} />;
  return <div className="output-unknown"><FileJson size={28} /><span>该输出格式暂不支持内嵌预览。</span></div>;
}
