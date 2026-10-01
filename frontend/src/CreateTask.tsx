import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { WorkflowView, WorkflowParameterView, CreateJobDraft } from "./types";
import { WorkflowPicker } from "./WorkflowPicker";
import { MvWorkspace } from "./MvWorkspace";
import { isSavedDraft, readSaved, serializeDraft, restoreDraft } from "./draft-storage";
import { ParameterField, MediaField } from "./MediaFields";
import { createModeForWorkflow, generationParameterOrder, parameterLabel, isPromptOptimizationControl } from "./workflow-view";
import { clearDraftInputs, cloneDraft, createDraft, isMediaParameter, visibleMedia, expandedImageSlotCount, exchangeImages, transferDraft, prepareDraft, setDraftMedia, type CreateMode } from "./task-draft";

import { mergeSavedBatches, prepareProductionBatch, type CreateBatchItem } from "./production-batch";
import { ProductionBatchPanel } from "./ProductionBatchPanel";
type CreateJobProps = { requestRevision?: number; active?: boolean; workflows: WorkflowView[]; initialWorkflowId?: string; initialDraft?: CreateJobDraft; onCreate: (drafts: CreateJobDraft[], source: "single" | "batch") => Promise<boolean> };

export const CreateJob = memo(function CreateJob(props: CreateJobProps) {
  const initialWorkflow = props.workflows.find(item => item.id === props.initialWorkflowId) ?? props.workflows[0];
  const initialMode = createModeForWorkflow(initialWorkflow);
  const [activeMode, setActiveMode] = useState<CreateMode>(initialMode);
  const appliedRevision = useRef(props.requestRevision);
  const [visited, setVisited] = useState<CreateMode[]>([initialMode]);
  const [batch, setBatch] = useState<CreateBatchItem[]>(() => {
    const saved = readSaved("rh-runner.batch.v1");
    return mergeSavedBatches(saved, readSaved("rh-runner.mv-segments.v1.batch"));
  });
  const [storageError, setStorageError] = useState<string>();
  useEffect(() => {
    try {
      const legacy = localStorage.getItem("rh-runner.mv-segments.v1.batch");
      if (legacy !== null) localStorage.setItem("rh-runner.mv-batch-migration-backup", legacy);
      localStorage.setItem("rh-runner.batch.v1", serializeDraft(batch));
      if (legacy !== null) localStorage.removeItem("rh-runner.mv-segments.v1.batch");
      setStorageError(undefined);
    }
    catch { setStorageError("制作批次保存失败，请勿关闭软件。"); }
  }, [batch]);
  const [submitting, setSubmitting] = useState<"single" | "batch" | null>(null);
  const submissionLock = useRef(false);
  const [editRequest, setEditRequest] = useState<CreateBatchItem>();
  const [batchError, setBatchError] = useState<string>();
  async function submitBatch() {
    if (submissionLock.current || !batch.length) return;
    submissionLock.current = true; setSubmitting("batch"); setBatchError(undefined);
    const pending = [...batch];
    try {
      const prepared = prepareProductionBatch(pending, props.workflows);
      if (await props.onCreate(prepared, "batch")) {
        const ids = new Set(pending.map(item => item.id));
        setBatch(current => current.filter(item => !ids.has(item.id)));
      }
    } catch (error) { setBatchError(error instanceof Error ? error.message : "批量提交失败，任务已保留"); }
    finally { submissionLock.current = false; setSubmitting(null); }
  }
  const workspaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selector = props.active === false ? "audio, video" : ".create-mode-panel[hidden] audio, .create-mode-panel[hidden] video";
    workspaceRef.current?.querySelectorAll<HTMLMediaElement>(selector).forEach(media => media.pause());
  }, [activeMode, props.active]);
  const switchMode = useCallback((mode: CreateMode) => {
    setVisited(current => current.includes(mode) ? current : [...current, mode]);
    setActiveMode(mode);
  }, []);
  const editItem = useCallback((item: CreateBatchItem) => {
    switchMode(createModeForWorkflow(props.workflows.find(workflow => workflow.id === item.draft.workflowId)));
    setEditRequest({ ...item, draft: cloneDraft(item.draft) });
  }, [props.workflows, switchMode]);
  useEffect(() => {
    if (appliedRevision.current === props.requestRevision) return;
    appliedRevision.current = props.requestRevision;
    if (props.initialDraft) editItem({ id: "", draft: props.initialDraft });
    else if (props.initialWorkflowId) {
      const workflow = props.workflows.find(item => item.id === props.initialWorkflowId);
      if (workflow) switchMode(createModeForWorkflow(workflow));
    }
  }, [props.requestRevision, props.initialDraft, props.initialWorkflowId, props.workflows, editItem, switchMode]);
  return <div className="create-workspace" ref={workspaceRef}>
    {(storageError || batchError) && <div role="alert">{storageError || batchError}</div>}
    <nav className="create-mode-tabs" aria-label="制作功能">
      <button type="button" className={activeMode === "digital-human" ? "active" : ""} onClick={() => switchMode("digital-human")} aria-pressed={activeMode === "digital-human"}>数字人</button>
      <button type="button" className={activeMode === "h3-multi-reference" ? "active" : ""} onClick={() => switchMode("h3-multi-reference")} aria-pressed={activeMode === "h3-multi-reference"}>H3 多参考</button>
      <button type="button" className={activeMode === "h3-mv" ? "active" : ""} onClick={() => switchMode("h3-mv")} aria-pressed={activeMode === "h3-mv"}>H3 数字人 MV</button>
    </nav>
    {visited.map(mode => <div key={mode} hidden={activeMode !== mode} className="create-mode-panel">
      {mode === "h3-mv" ? (() => {
        const workflow = props.workflows.find(w => createModeForWorkflow(w) === "h3-mv");
        return workflow ? <MvWorkspace workflow={workflow} batch={batch} setBatch={setBatch}
          editRequest={editRequest?.draft.workflowId === workflow.id ? editRequest : undefined}
          batchPanel={activeMode === mode ? <ProductionBatchPanel batch={batch} workflows={props.workflows} busy={!!submitting} onEdit={editItem} onDelete={id => setBatch(current => current.filter(item => item.id !== id))} onSubmit={() => void submitBatch()} /> : null}
          initialDraft={props.initialDraft?.workflowId === workflow.id ? props.initialDraft : undefined}
          submitting={submitting} submissionLock={submissionLock} /> : <p>MV 工作流未加载，请重启桌面端。</p>;
      })() : <CreateWorkspace {...props} activeMode={mode}
        initialWorkflowId={mode === initialMode ? props.initialWorkflowId : undefined}
        initialDraft={mode === initialMode ? props.initialDraft : undefined}
        batch={batch} setBatch={setBatch} submitting={submitting} setSubmitting={setSubmitting} submissionLock={submissionLock}
        editRequest={editRequest} batchPanel={activeMode === mode ? <ProductionBatchPanel batch={batch} workflows={props.workflows} busy={!!submitting} onEdit={editItem} onDelete={id => setBatch(current => current.filter(item => item.id !== id))} onSubmit={() => void submitBatch()} /> : null} />}
    </div>)}
  </div>;
});

const CreateWorkspace = memo(function CreateWorkspace({ workflows, initialWorkflowId, initialDraft, requestRevision, onCreate, activeMode, batch, setBatch, submitting, setSubmitting, submissionLock, editRequest, batchPanel }: CreateJobProps & {
  activeMode: CreateMode;
  batchPanel: React.ReactNode;
  batch: CreateBatchItem[];
  setBatch: React.Dispatch<React.SetStateAction<CreateBatchItem[]>>;
  submitting: "single" | "batch" | null;
  setSubmitting: React.Dispatch<React.SetStateAction<"single" | "batch" | null>>;
  submissionLock: React.MutableRefObject<boolean>;
  editRequest?: CreateBatchItem;
}) {
  const initialWorkflow = workflows.find(workflow => workflow.id === initialWorkflowId && createModeForWorkflow(workflow) === activeMode) ?? workflows.find(workflow => createModeForWorkflow(workflow) === activeMode);
  const [draft, setDraft] = useState<CreateJobDraft>(() => {
    if (initialDraft) return cloneDraft(initialDraft);
    const saved = readSaved(`rh-runner.draft.v1.${activeMode}`);
    try {
      return restoreDraft(saved, workflows.filter(item => createModeForWorkflow(item) === activeMode), initialWorkflow,
        value => localStorage.setItem(`rh-runner.draft-backup.${activeMode}.${Date.now()}`, serializeDraft(value)));
    } catch { return isSavedDraft(saved) ? saved : createDraft(initialWorkflow); }
  });
  const [storageError, setStorageError] = useState<string>();
  useEffect(() => {
    if (!draft.workflowId) return;
    try { localStorage.setItem(`rh-runner.draft.v1.${activeMode}`, serializeDraft(draft)); setStorageError(undefined); }
    catch { setStorageError("输入保存失败，请勿关闭软件。"); }
  }, [draft, activeMode]);
  const [showGeneric, setShowGeneric] = useState(false);
  const [formError, setFormError] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const mediaEpoch = useRef(0);
  const mediaRequests = useRef(new Map<string, number>());
  const appliedRequest = useRef(requestRevision);
  const [editingBatchId, setEditingBatchId] = useState<string>();
  const appliedEdit = useRef<CreateBatchItem | undefined>(undefined);
  const modeWorkflows = useMemo(
    () => workflows.filter(workflow => createModeForWorkflow(workflow) === activeMode),
    [workflows, activeMode],
  );
  useEffect(() => {
    if (!editRequest || appliedEdit.current === editRequest || !modeWorkflows.some(workflow => workflow.id === editRequest.draft.workflowId)) return;
    appliedEdit.current = editRequest;
    setDraft(cloneDraft(editRequest.draft));
    mediaEpoch.current++;
    setEditingBatchId(editRequest.id || undefined);
  }, [editRequest, modeWorkflows]);
  useEffect(() => {
    if (editingBatchId && !batch.some(item => item.id === editingBatchId)) setEditingBatchId(undefined);
  }, [batch, editingBatchId]);
  useEffect(() => {
    if (!modeWorkflows.length) return;
    if (modeWorkflows.some(item => item.id === draft.workflowId && item.profileVersion === draft.profileVersion)) return;
    try {
      const restored = restoreDraft(draft, modeWorkflows, modeWorkflows[0],
        value => localStorage.setItem(`rh-runner.draft-backup.${activeMode}.${Date.now()}`, serializeDraft(value)));
      mediaEpoch.current++;
      setDraft(restored);
      setEditingBatchId(undefined);
      setStorageError(undefined);
    } catch { setStorageError("输入备份失败，请勿关闭软件。"); }
  }, [modeWorkflows, draft, activeMode]);
  const selected = modeWorkflows.find(w => w.id === draft.workflowId && w.profileVersion === draft.profileVersion);
  const visibleParameters = useMemo(() => selected?.parameters.filter(parameter => parameter.visible !== false) ?? [], [selected]);
  const recognized = visibleParameters.filter(parameter => parameter.semanticType !== "unknown");
  const promptOptimization = visibleParameters.find(isPromptOptimizationControl);
  const generic = visibleParameters.filter(parameter => parameter.semanticType === "unknown" && !isPromptOptimizationControl(parameter));
  const prompts = recognized.filter(parameter => parameter.semanticType === "prompt");
  const generationParameters = recognized
    .filter(parameter => !isMediaParameter(parameter) && !["prompt", "negative_prompt"].includes(parameter.semanticType))
    .sort((left, right) => generationParameterOrder(left) - generationParameterOrder(right));
  const media = useMemo(() => visibleMedia(selected, activeMode), [selected, activeMode]);
  useEffect(() => {
    if (appliedRequest.current === requestRevision) return;
    appliedRequest.current = requestRevision;
    if (!initialDraft && initialWorkflowId && modeWorkflows.some(item => item.id === initialWorkflowId)) chooseWorkflow(initialWorkflowId);
  }, [requestRevision, initialWorkflowId, initialDraft, modeWorkflows]);


  function chooseWorkflow(workflowId: string) {
    const workflow = modeWorkflows.find(item => item.id === workflowId);
    if (!workflow) return;
    if (!selected) {
      try { localStorage.setItem(`rh-runner.draft-backup.${activeMode}.${Date.now()}`, serializeDraft(draft)); }
      catch { setFormError("输入备份失败，请勿关闭软件。"); return; }
      mediaEpoch.current++;
      setDraft(createDraft(workflow));
      setEditingBatchId(undefined);
      setFormError(undefined);
      return;
    }
    if (workflowId === draft.workflowId) return;
    let transferred: CreateJobDraft;
    try { transferred = transferDraft(draft, selected, workflow, activeMode); }
    catch (error) { setFormError(error instanceof Error ? error.message : "工作流切换失败，输入已保留"); return; }
    mediaEpoch.current++;
    setDraft(transferred);
    setEditingBatchId(undefined);
    setFormError(undefined);
    setShowGeneric(false);
  }

  const setValue = useCallback((parameter: WorkflowParameterView, value: unknown) => {
    setDraft(current => ({ ...current, parameterValues: { ...current.parameterValues, [parameter.id]: value } }));
  }, []);

  function setMedia(parameter: WorkflowParameterView, mode: "replace" | "clear", file?: File, selectedFile?: { localPath: string; fileName: string; previewUrl?: string }) {
    invalidateMediaRequest(parameter.id);
    setDraft(current => setDraftMedia(current, parameter, { enabled: mode === "replace", mode, file, ...selectedFile }));
  }

  function invalidateMediaRequest(id: string) {
    const revision = (mediaRequests.current.get(id) ?? 0) + 1;
    mediaRequests.current.set(id, revision);
    return revision;
  }

  async function receiveMedia(parameter: WorkflowParameterView, file?: File) {
    const epoch = mediaEpoch.current;
    const revision = invalidateMediaRequest(parameter.id);
    const isCurrent = () => epoch === mediaEpoch.current && mediaRequests.current.get(parameter.id) === revision;
    const workflowId = draft.workflowId;
    setFormError(undefined);
    try {
      if (file?.type && !file.type.startsWith(parameter.valueType + "/")) throw new Error("文件类型不匹配，请选择" + parameterLabel(parameter));
      const selectedFile = window.runningHub
        ? file ? await window.runningHub.media.fromDroppedFile(file) : await window.runningHub.media.select(parameter.valueType as "image" | "video" | "audio")
        : undefined;
      if (!isCurrent() || (!selectedFile && !file)) return;
      setDraft(current => current.workflowId !== workflowId ? current : setDraftMedia(current, parameter, { enabled: true, mode: "replace", ...(selectedFile ?? { file }) }));
    } catch (error) {
      if (isCurrent()) setFormError(error instanceof Error ? error.message : "读取媒体失败");
    }
  }

  function clearAllMedia() {
    mediaEpoch.current++;
    if (selected) setDraft(current => clearDraftInputs(current, selected));
  }

  function moveImageMedia(sourceId: string, target: WorkflowParameterView) {
    const source = media.find(parameter => parameter.id === sourceId);
    if (source) {
      invalidateMediaRequest(sourceId);
      invalidateMediaRequest(target.id);
      setDraft(current => exchangeImages(current, source, target));
    }
  }

  function clearPrompts() {
    setDraft(current => ({
      ...current,
      parameterValues: prompts.reduce((values, parameter) => ({ ...values, [parameter.id]: "" }), current.parameterValues),
    }));
  }

  function saveDraftToBatch() {
    if (!selected || !formRef.current?.reportValidity()) return;
    const issue = media.find(parameter => parameter.mappingIssue);
    if (issue) { setFormError(issue.mappingIssue); return; }
    const snapshot = prepareDraft(draft, selected, activeMode);
    if (editingBatchId) {
      setBatch(current => current.map(item => item.id === editingBatchId ? { ...item, draft: snapshot } : item));
      setEditingBatchId(undefined);
    } else {
      setBatch(current => [...current, { id: crypto.randomUUID(), draft: snapshot }]);
    }
  }

  async function submitDrafts(drafts: CreateJobDraft[], source: "single") {
    if (!drafts.length || submitting || submissionLock.current) return;
    if (!formRef.current?.reportValidity()) return;
    submissionLock.current = true;
    setSubmitting(source);
    setFormError(undefined);
    try {
      const prepared = drafts.map((item, index) => {
        try {
        const workflow = workflows.find(workflow => workflow.id === item.workflowId);
        if (!workflow) throw new Error("工作流已删除，请重新选择工作流。");
        return prepareDraft(item, workflow, createModeForWorkflow(workflow));
        } catch (error) {
          throw new Error(`第 ${index + 1} 项校验失败，尚未提交：${error instanceof Error ? error.message : "输入不完整"}`);
        }
      });
      const submitted = await onCreate(prepared, source);
      if (submitted) {
        setEditingBatchId(undefined);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      submissionLock.current = false;
      setSubmitting(null);
    }
  }

  return <>
    {storageError && <div role="alert">{storageError}</div>}
    <div className="create-layout">
      <form ref={formRef} className="panel form-panel" onSubmit={e => { e.preventDefault(); }}>
        <div className="form-section"><div className="section-content"><h2>选择工作流</h2>{modeWorkflows.length ? <><WorkflowPicker workflows={modeWorkflows} value={draft.workflowId} onChange={chooseWorkflow} /></> : <div className="empty-parameters">当前功能下还没有可用工作流，请先到“工作流”页面导入。</div>}</div></div>
        {(prompts.length > 0 || media.length > 0) && <div className="form-section"><div className="section-content"><div className="section-title-row media-section-title"><div><h2>媒体输入</h2></div>{media.length > 0 && <div className="bulk-media-actions"><button type="button" onClick={clearAllMedia}>清空全部输入</button></div>}</div>{prompts.length > 0 && <div className="content-prompt-block"><div className="content-input-label"><span>生成词</span><div>{promptOptimization && <ParameterField parameter={promptOptimization} value={draft.parameterValues[promptOptimization.id] ?? false} onValue={setValue} />}<button type="button" onClick={clearPrompts}>清空生成词</button></div></div><div className={`dynamic-grid prompt-input-grid ${activeMode === "h3-multi-reference" ? "h3-prompt-input" : ""}`}>{prompts.map(parameter => <ParameterField hideLabel={prompts.length === 1} key={parameter.id} parameter={parameter} value={draft.parameterValues[parameter.id]} onValue={setValue} />)}</div></div>}{media.length > 0 && <div className={activeMode === "h3-multi-reference" ? "mv-media" : "media-stack"}>{media.map((parameter, index) => { if (activeMode === "h3-multi-reference" && index >= expandedImageSlotCount(media, draft)) return null; const mediaDraft = draft.mediaOverrides[parameter.id] ?? { enabled: false, mode: "clear" as const }; return <MediaField numberedImage={activeMode === "h3-multi-reference"} key={parameter.id} index={parameter.referenceIndex !== undefined ? parameter.referenceIndex + 1 : media.slice(0, index + 1).filter(item => item.valueType === parameter.valueType).length} parameter={parameter} draft={mediaDraft} onPick={window.runningHub ? () => void receiveMedia(parameter) : undefined} onDrop={file => receiveMedia(parameter, file)} onMove={sourceId => moveImageMedia(sourceId, parameter)} onChange={(mode, file) => setMedia(parameter, mode, file)} />; })}</div>}</div></div>}
        {activeMode === "h3-multi-reference" && generationParameters.length > 0 && <div className="form-section"><div className="section-content"><h2>生成参数</h2>{generationParameters.length > 0 ? <div className="dynamic-grid">{generationParameters.map(parameter => <ParameterField key={parameter.id} parameter={parameter} value={draft.parameterValues[parameter.id]} onValue={setValue} />)}</div> : <div className="empty-parameters">这个工作流没有其他生成参数。</div>}</div></div>}
        {activeMode === "h3-multi-reference" && generic.length > 0 && <div className="form-section generic-section"><div className="section-content"><div className="section-title-row"><div><h2>其他参数</h2></div><button type="button" className="secondary small" onClick={() => setShowGeneric(value => !value)}>{showGeneric ? "收起" : `展开 ${generic.length} 项`}</button></div>{showGeneric && <div className="dynamic-grid generic-grid">{generic.map(parameter => <ParameterField key={parameter.id} parameter={parameter} value={draft.parameterValues[parameter.id]} onValue={setValue} />)}</div>}</div></div>}
        {formError && <div className="import-feedback error" role="alert">{formError}</div>}<div className="submit-bar"><div className="instance-mode-control"><span><strong>Plus 高显存</strong></span><button type="button" className={`switch ${draft.instanceType === "plus" ? "checked" : ""}`} onClick={() => setDraft(current => ({ ...current, instanceType: current.instanceType === "plus" ? "default" : "plus" }))} aria-label="开启 Plus 高显存实例" aria-pressed={draft.instanceType === "plus"}><span /></button></div><div className="submit-actions"><button className="secondary" type="button" onClick={saveDraftToBatch} disabled={!selected || !!submitting}>{editingBatchId ? "保存批次修改" : "加入制作批次"}</button><button className="primary submit" type="button" onClick={() => void submitDrafts([draft], "single")} disabled={!selected || !!submitting}>{submitting === "single" ? "正在提交当前任务…" : "提交当前任务"}</button></div></div>
      </form>
      {batchPanel}
    </div>
  </>;
});
