import { ArrowRight, Check, CloudUpload, Download, Link2, LoaderCircle, Pencil, Play, Settings2, Trash2, Workflow } from "lucide-react";
import { Suspense, lazy, useRef, useState } from "react";
import { Feedback, Notice } from "../Feedback";
import { isMediaParameter } from "../task-draft";
import type { WorkflowView } from "../types";
import { importSummary } from "../workflow-summary";

import { PageHeading, relativeTime } from "../app-shared";
import WorkflowSkillModal from "../modals/WorkflowSkillModal";
import { WorkflowReadOnlyModal } from "../WorkflowReadOnlyModal";
const ImportWorkflowModal = lazy(() => import("../modals/WorkflowModals").then(m => ({ default: m.ImportWorkflowModal })));
const ParameterVisibilityModal = lazy(() => import("../modals/WorkflowModals").then(m => ({ default: m.ParameterVisibilityModal })));
const DeleteWorkflowModal = lazy(() => import("../modals/WorkflowModals").then(m => ({ default: m.DeleteWorkflowModal })));
const WorkflowOutputEditorModal = lazy(() => import("../modals/WorkflowModals").then(m => ({ default: m.WorkflowOutputEditorModal })));
const WorkflowEditorModal = lazy(() => import("../modals/WorkflowModals").then(m => ({ default: m.WorkflowEditorModal })));
export default function Workflows({ workflows, onImport, onUpdate, onDelete, onUse }: { workflows: WorkflowView[]; onImport: (workflow: WorkflowView) => void; onUpdate: (workflow: WorkflowView) => void; onDelete: (workflowId: string) => void | Promise<void>; onUse: (workflowId: string) => void }) {
  const [skillWorkflow, setSkillWorkflow] = useState<WorkflowView>();
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowView>();
  const [editingOutputs, setEditingOutputs] = useState<WorkflowView>();
  const [editingVisibility, setEditingVisibility] = useState<WorkflowView>();
  const [deleting, setDeleting] = useState<WorkflowView>();
  const [feedback, setFeedback] = useState<string>();
  const [exporting, setExporting] = useState<string>();
  const feedbackFailed = Boolean(feedback?.includes("失败"));
  const savingProfile = useRef(false);
  async function persistProfile(workflow: WorkflowView, complete: (saved: WorkflowView) => void) {
    if (savingProfile.current) return;
    savingProfile.current = true;
    try {
      const saved = window.runningHub ? await window.runningHub.workflows.updateProfile(workflow) : workflow;
      onUpdate(saved);
      complete(saved);
    } catch (error) {
      setFeedback("保存失败：" + (error instanceof Error ? error.message : "请重试"));
    } finally { savingProfile.current = false; }
  }
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
    <Feedback message={feedback} tone={feedbackFailed ? "error" : "success"} onClose={()=>setFeedback(undefined)}/>
    {[true, false].map(builtIn => <section className="workflow-group" key={String(builtIn)} aria-label={builtIn ? "默认工作流" : "个人工作流"}>
    <div className="workflow-group-heading"><h2>{builtIn ? "默认工作流" : "个人工作流"}</h2><span>{workflows.filter(workflow => Boolean(workflow.builtIn) === builtIn).length}</span></div>
    <p className="workflow-group-description">{builtIn ? "节点映射随软件更新；H3 工作流可单独加载生成词 Skill。" : "自行导入的工作流，可编辑参数、显示项和输出。"}</p>
    {!workflows.some(workflow => Boolean(workflow.builtIn) === builtIn) && <div className="empty-parameters">{builtIn ? "暂无默认工作流" : "暂无个人工作流，点击右上角“导入工作流”添加。"}</div>}
    <div className="workflow-grid">{workflows.filter(workflow => Boolean(workflow.builtIn) === builtIn).map(workflow => {
      const mediaCount = workflow.parameters.filter(isMediaParameter).length;
      const unknownCount = workflow.parameters.filter(parameter => parameter.semanticType === "unknown").length;
      return <article className="workflow-card" key={workflow.id}>
      <div className="workflow-card-top"><span className="workflow-icon"><Workflow size={22} /></span>{!builtIn && <div className="workflow-card-actions"><button className="icon-button" onClick={() => void exportWorkflow(workflow)} disabled={exporting === workflow.id} title="导出可移植工作流包">{exporting === workflow.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</button><button className="icon-button" onClick={() => setEditing(workflow)} title="编辑 Profile"><Pencil size={16} /></button><button className="icon-button danger" disabled={workflow.builtIn} onClick={() => setDeleting(workflow)} title="删除工作流"><Trash2 size={16} /></button></div>}</div>
      <div className="workflow-copy"><div className="workflow-title"><h2>{workflow.name}</h2>{workflow.needsReview ? <span className="review-badge">待检查</span> : <span className="ready-badge"><Check size={12} />可运行</span>}</div><p>ID {workflow.runningHubWorkflowId}</p>{workflow.functionDescription && <p className="workflow-description">{workflow.functionDescription}</p>}{workflow.usageInstructions && <p className="workflow-usage"><strong>使用：</strong>{workflow.usageInstructions}</p>}{workflow.sourceUrl && <a className="workflow-link" href={workflow.sourceUrl} target="_blank" rel="noreferrer"><Link2 size={12} />打开 RunningHub 工作流</a>}</div>
{!builtIn && (<div className="workflow-breakdown"><span>{workflow.parameterCount} 个参数</span><span>{mediaCount} 个媒体</span><span>{workflow.parameters.filter(parameter => parameter.showEnableToggle || parameter.mediaControl).length} 个媒体开关</span><span>{workflow.outputs?.length ?? 0} 个输出</span><span className={unknownCount ? "warn" : ""}>{unknownCount} 个待确认</span></div>)}
{!builtIn && (<div className="workflow-stats"><span><b>v{workflow.profileVersion}</b> Profile</span><span><b>{mediaCount}</b> 上传槽</span><span>{relativeTime(workflow.updatedAt)}</span></div>)}
      <div className="workflow-footer"><span className="workflow-health"><span className={workflow.needsReview ? "review" : "ready"} />{workflow.needsReview ? "需要人工确认" : "参数映射完整"}</span>{!builtIn && <>{workflow.outputs?.length ? <button className="secondary small" onClick={() => setEditingOutputs(workflow)}><Play size={14} />输出</button> : null}<button className="secondary small" onClick={() => setEditingVisibility(workflow)}><Settings2 size={14} />显示项</button><button className="secondary small" onClick={() => setEditing(workflow)}><Pencil size={14} />参数</button></>}{["2106577322987307010","2106994828660080641","2107063778012905474"].includes(workflow.runningHubWorkflowId) && <button className="secondary small" onClick={()=>setSkillWorkflow(workflow)}><Settings2 size={14}/>Skill</button>}<button className="primary small" onClick={() => onUse(workflow.id)}>创建任务<ArrowRight size={15} /></button></div>
    </article>})}</div></section>)}
    <Suspense fallback={<Notice><div className="operation-toast" role="status">正在加载…</div></Notice>}>{importOpen && <ImportWorkflowModal onClose={() => setImportOpen(false)} onImport={workflow => { onImport(workflow); setFeedback(importSummary(workflow)); setImportOpen(false); }} />}
    {editing && (editing.builtIn ? <WorkflowReadOnlyModal workflow={editing} section="parameters" onClose={() => setEditing(undefined)} /> : <WorkflowEditorModal workflow={editing} onClose={() => setEditing(undefined)} onSave={workflow => persistProfile(workflow, saved => { setFeedback(`已保存 ${saved.name} Profile v${saved.profileVersion}：${saved.parameters.length} 个参数，${saved.parameters.filter(isMediaParameter).length} 个媒体节点。`); setEditing(undefined); })} />)}
    {editingOutputs && (editingOutputs.builtIn ? <WorkflowReadOnlyModal workflow={editingOutputs} section="outputs" onClose={() => setEditingOutputs(undefined)} /> : <WorkflowOutputEditorModal workflow={editingOutputs} onClose={() => setEditingOutputs(undefined)} onSave={workflow => persistProfile(workflow, saved => { setFeedback(`已保存 ${saved.outputs?.length ?? 0} 个输出节点配置。`); setEditingOutputs(undefined); })} />)}
    {editingVisibility && (editingVisibility.builtIn ? <WorkflowReadOnlyModal workflow={editingVisibility} section="visibility" onClose={() => setEditingVisibility(undefined)} /> : <ParameterVisibilityModal workflow={editingVisibility} onClose={() => setEditingVisibility(undefined)} onSave={workflow => persistProfile(workflow, saved => { setFeedback(`已更新表单显示项：显示 ${saved.parameters.filter(item => item.visible !== false).length} 项，隐藏 ${saved.parameters.filter(item => item.visible === false).length} 项。`); setEditingVisibility(undefined); })} />)}
    {skillWorkflow && <WorkflowSkillModal workflow={skillWorkflow} onClose={()=>setSkillWorkflow(undefined)}/>}
    {deleting && <DeleteWorkflowModal workflow={deleting} onClose={() => setDeleting(undefined)} onConfirm={async () => { await onDelete(deleting.id); setFeedback(`已删除工作流：${deleting.name}`); setDeleting(undefined); }} />}
    </Suspense>
  </>;
}
