import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { DraftThumbnail } from "./MediaFields";
import type { WorkflowView } from "./types";
import type { CreateBatchItem } from "./production-batch";

export function ProductionBatchPanel({ batch, workflows, busy, onEdit, onDelete, onSubmit }: {
  batch: CreateBatchItem[]; workflows: WorkflowView[]; busy: boolean;
  onEdit: (item: CreateBatchItem) => void; onDelete: (id: string) => void; onSubmit: () => void;
}) {
  return <aside className="create-sidebar"><div className="panel batch-panel">
    <div className="batch-head"><h2>制作批次</h2><span>{batch.length}</span></div>
    {!batch.length ? <div className="batch-empty">暂无任务</div> : <div className="batch-list">{batch.map((item, index) => <article key={item.id}>
      <DraftThumbnail draft={item.draft} /><div><strong>{workflows.find(w => w.id === item.draft.workflowId)?.name ?? "未知工作流"}{item.draft.instanceType === "plus" && <b className="instance-badge">PLUS</b>}</strong><small>任务 {String(index + 1).padStart(2, "0")}</small></div>
      <div className="batch-actions"><button type="button" disabled={busy} onClick={() => onEdit(item)} aria-label="编辑批次任务"><Pencil size={14} /></button><button type="button" disabled={busy} onClick={() => onDelete(item.id)} aria-label="删除批次任务"><Trash2 size={14} /></button></div>
    </article>)}</div>}
    <button className="primary batch-submit" type="button" disabled={!batch.length || busy} onClick={onSubmit}>{busy ? "正在提交…" : `批量提交 ${batch.length} 个任务`}<ArrowRight size={16} /></button>
  </div></aside>;
}
