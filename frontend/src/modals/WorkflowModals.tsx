import { AlertTriangle, BadgeCheck, ChevronDown, FileJson, ImagePlus, Plus, Settings2, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { Select } from "../Select";
import { isMediaParameter } from "../task-draft";
import type { WorkflowOutputView, WorkflowParameterView, WorkflowSemanticType, WorkflowView } from "../types";
import { discoverOutputs, discoverParameters, migrateParameterView, parameterLabel, semanticLabels, shouldExposeParameter } from "../workflow-view";


function extractWorkflowId(value: string): string | undefined {
  const clean = value.trim();
  if (/^\d{8,}$/.test(clean)) return clean;
  const routeId = clean.match(/(?:^|\/)(?:run\/workflow|workflow|post)\/(\d{8,})(?:[/?#]|$)/i)?.[1];
  if (routeId) return routeId;
  try {
    const url = new URL(clean);
    for (const key of ["workflowId", "webappId", "id"]) {
      const candidate = url.searchParams.get(key);
      if (candidate && /^\d{8,}$/.test(candidate)) return candidate;
    }
    return url.pathname.match(/\d{8,}/g)?.at(-1);
  } catch { return undefined; }
}

export function ImportWorkflowModal({ onClose, onImport }: { onClose: () => void; onImport: (workflow: WorkflowView) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [raw, setRaw] = useState<Record<string, unknown>>();
  const [parameters, setParameters] = useState<WorkflowParameterView[]>([]);
  const [portable, setPortable] = useState<Record<string, unknown>>();
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const readRevision = useRef(0);
  const workflowId = extractWorkflowId(address);
  const media = parameters.filter(isMediaParameter);

  async function readWorkflow(file?: File) {
    if (!file) return;
    const revision = ++readRevision.current;
    setError(undefined);
    try {
      const text = await file.text();
      if (revision !== readRevision.current) return;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.format === "runninghub-runner-workflow") {
        const workflow = parsed.workflow as Record<string, unknown> | undefined;
        const profile = parsed.profile as Record<string, unknown> | undefined;
        if (!workflow || !profile || !workflow.apiJson || !Array.isArray(profile.parameters)) throw new Error("工作流配置包结构不完整。");
        const packagedParameters = (profile.parameters as WorkflowParameterView[]).map(parameter => migrateParameterView(parameter));
        setPortable(parsed);
        setRaw(workflow.apiJson as Record<string, unknown>);
        setParameters(packagedParameters);
        setName(typeof workflow.name === "string" ? workflow.name : file.name.replace(/\.rhworkflow\.json$/i, ""));
        setAddress(typeof workflow.sourceUrl === "string" ? workflow.sourceUrl : String(workflow.runningHubWorkflowId ?? ""));
        setFileName(file.name);
        return;
      }
      const detected = discoverParameters(parsed);
      if (!detected.length) throw new Error("没有检测到 API-format 节点。请从 ComfyUI 导出 API JSON，而不是普通 UI Workflow JSON。");
      setPortable(undefined);
      setRaw(parsed);
      setParameters(detected);
      setFileName(file.name);
      if (!name) setName(file.name.replace(/\.json$/i, ""));
    } catch (cause) {
      setRaw(undefined); setParameters([]); setPortable(undefined); setFileName("");
      setError(cause instanceof Error ? cause.message : "JSON 读取失败");
    }
  }

  async function submit() {
    if (saving) return;
    if (!workflowId) return setError("请输入有效的 RunningHub 工作流地址或 Workflow ID。");
    if (!name.trim()) return setError("请输入工作流名称。");
    if (!raw || !parameters.length) return setError("请上传对应的 API JSON。");
    setSaving(true);
    try {
      const portableProfile = portable?.profile as Record<string, unknown> | undefined;
      const base = window.runningHub
        ? portable
          ? await window.runningHub.workflows.importPortablePackage({ ...portable, workflow: { ...(portable.workflow as object), name: name.trim(), runningHubWorkflowId: workflowId, sourceUrl: /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined } })
          : await window.runningHub.workflows.importApiJson({ name: name.trim(), runningHubWorkflowId: workflowId, sourceUrl: /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined, workflow: raw })
        : { id: crypto.randomUUID(), name: name.trim(), runningHubWorkflowId: workflowId, parameterCount: parameters.length, parameters, outputs: portable && Array.isArray(portableProfile?.outputs) ? portableProfile.outputs as WorkflowOutputView[] : discoverOutputs(raw), needsReview: parameters.some(item => item.visible !== false && item.confidence < .7), profileVersion: 1, updatedAt: Date.now() } satisfies WorkflowView;
      onImport({ ...base, sourceUrl: /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工作流保存失败"); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" role="presentation"><div className="modal workflow-import-modal" role="dialog" aria-modal="true" aria-label="导入工作流"><div className="modal-head"><div><p>WORKFLOW IMPORT</p><h2>导入工作流</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="import-steps"><span className={address ? "done" : "active"}>1 地址</span><i /><span className={raw ? "done" : address ? "active" : ""}>2 工作流文件</span><i /><span className={raw && workflowId ? "active" : ""}>3 确认</span></div><div className="form-grid import-fields"><label>工作流名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：H3 多参考生视频" /></label><label>RunningHub 地址或 Workflow ID<input value={address} onChange={event => { setAddress(event.target.value); setError(undefined); }} placeholder="粘贴地址或输入数字 ID" />{address && <small className={workflowId ? "field-ok" : "field-error"}>{workflowId ? `识别到 ID：${workflowId}` : "没有从地址中识别到 Workflow ID"}</small>}</label></div><label className={`workflow-json-drop ${raw ? "loaded" : ""}`}><input type="file" accept="application/json,.json,.rhworkflow.json" onChange={event => void readWorkflow(event.target.files?.[0])} /><FileJson size={25} /><strong>{fileName || "选择 API JSON 或工作流配置包"}</strong><span>{raw ? portable ? "已识别配置包，将保留修正后的参数和媒体设置" : "已完成参数扫描，重新选择可替换" : "自动识别原始 API JSON 与 .rhworkflow.json 配置包"}</span></label>{raw && <div className="detection-result"><div className="detection-title"><BadgeCheck size={18} /><div><strong>{portable ? "已识别可移植配置包" : "检测完成"}</strong><span>{parameters.length} 个可编辑参数</span></div></div><div className="detection-counts"><span><b>{media.filter(item => item.valueType === "image").length}</b> 图片</span><span><b>{media.filter(item => item.valueType === "video").length}</b> 视频</span><span><b>{media.filter(item => item.valueType === "audio").length}</b> 音频</span><span><b>{parameters.filter(item => item.semanticType === "unknown").length}</b> 待确认</span></div><div className="detected-media-list">{media.length ? media.map(item => <span key={item.id}>{item.nodeTitle} <code>{item.key}</code></span>) : <span className="none">没有自动识别到媒体节点，可保存后在 Profile 编辑器手动指定。</span>}</div></div>}{error && <div className="import-feedback error modal-feedback"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void submit()} disabled={saving || !workflowId || !raw || !name.trim()}>{portable ? "导入已配置工作流" : "保存工作流"}</button></div></div></div>;
}

const semanticOptions: WorkflowSemanticType[] = ["prompt", "negative_prompt", "image", "video", "audio", "duration", "fps", "frames", "width", "height", "aspect_ratio", "resolution", "resolution_multiple", "upscale_factor", "seed", "steps", "cfg", "sampler", "scheduler", "denoise", "model", "lora", "unknown"];

export function ParameterVisibilityModal({ workflow, onClose, onSave }: { workflow: WorkflowView; onClose: () => void; onSave: (workflow: WorkflowView) => void | Promise<void> }) {
  const [parameters, setParameters] = useState(() => workflow.parameters.map(parameter => ({ ...parameter, visible: parameter.visible !== false })));
  const [filter, setFilter] = useState<"all" | "visible" | "hidden">("all");
  const shown = parameters.filter(parameter => filter === "all" || (filter === "visible" ? parameter.visible !== false : parameter.visible === false));
  function setVisible(id: string, visible: boolean) {
    setParameters(current => current.map(parameter => parameter.id === id ? { ...parameter, visible } : parameter));
  }
  function autoClean() {
    setParameters(current => current.map(parameter => ({ ...parameter, visible: shouldExposeParameter(parameter) })));
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal visibility-modal" role="dialog" aria-modal="true" aria-label="设置参数显示项"><div className="modal-head"><div><p>FORM VISIBILITY</p><h2>设置创建任务表单</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><p className="visibility-intro">隐藏参数不会从 Profile 删除，提交任务时仍使用它的默认值。这里只控制创建任务页面显示什么。</p><div className="editor-toolbar"><div className="segmented">{(["all", "visible", "hidden"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? `全部 ${parameters.length}` : value === "visible" ? `显示 ${parameters.filter(item => item.visible !== false).length}` : `隐藏 ${parameters.filter(item => item.visible === false).length}`}</button>)}</div><div className="visibility-bulk"><button className="secondary small" onClick={autoClean}>自动隐藏内部参数</button><button className="secondary small" onClick={() => setParameters(current => current.map(item => ({ ...item, visible: true })))}>全部显示</button></div></div><div className="visibility-list">{shown.map(parameter => <div className={`visibility-row ${parameter.visible === false ? "hidden" : ""}`} key={parameter.id}><div><strong>{parameterLabel(parameter)}</strong><span>{parameter.nodeTitle} · <code>{parameter.key}</code></span></div><span className="visibility-kind">{parameter.semanticType === "unknown" ? "内部 / 未识别" : semanticLabels[parameter.semanticType] ?? parameter.valueType}</span><button type="button" className={`switch ${parameter.visible !== false ? "checked" : ""}`} onClick={() => setVisible(parameter.id, parameter.visible === false)} aria-label={parameter.visible === false ? "显示参数" : "隐藏参数"}><span /></button></div>)}</div><div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void onSave({ ...workflow, parameters, needsReview: parameters.some(parameter => parameter.visible !== false && (parameter.semanticType === "unknown" || parameter.confidence < .7)), profileVersion: workflow.profileVersion + 1, updatedAt: Date.now() })}>保存显示设置</button></div></div></div>;
}

export function DeleteWorkflowModal({ workflow, onClose, onConfirm }: { workflow: WorkflowView; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    setBusy(true); setError(undefined);
    try { await onConfirm(); } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal delete-workflow-modal" role="alertdialog" aria-modal="true" aria-label="删除工作流"><div className="delete-icon"><Trash2 size={22} /></div><h2>删除“{workflow.name}”？</h2><p>该工作流将从工作流列表和创建任务页面移除。已有任务的快照、状态与输出仍会完整保留。</p>{error && <div className="import-feedback error modal-feedback"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="modal-actions"><button className="secondary" onClick={onClose} disabled={busy}>取消</button><button className="danger-button" onClick={() => void remove()} disabled={busy}>{busy ? "正在删除…" : "确认删除"}</button></div></div></div>;
}

export function WorkflowOutputEditorModal({ workflow, onClose, onSave }: { workflow: WorkflowView; onClose: () => void; onSave: (workflow: WorkflowView) => void | Promise<void> }) {
  const [outputs, setOutputs] = useState(() => structuredClone(workflow.outputs ?? []));
  function update(index: number, patch: Partial<WorkflowOutputView>) {
    setOutputs(current => current.map((output, itemIndex) => itemIndex === index ? { ...output, ...patch } : output));
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal output-editor-modal" role="dialog" aria-modal="true" aria-label="编辑输出节点"><div className="modal-head"><div><p>OUTPUT PROFILE</p><h2>输出与采样阶段</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="output-editor-list">{outputs.map((output, index) => <div className="output-editor-row" key={output.id}><div className="output-editor-index">{String(index + 1).padStart(2, "0")}</div><label>显示名称<input value={output.label} onChange={event => update(index, { label: event.target.value })} /></label><label>节点 ID<input value={output.nodeId} onChange={event => update(index, { nodeId: event.target.value })} /></label><label>类型<Select value={output.mediaType} onChange={event => update(index, { mediaType: event.target.value as WorkflowOutputView["mediaType"] })}><option value="video">视频</option><option value="image">图片</option><option value="audio">音频</option><option value="unknown">其他</option></Select><ChevronDown size={15} /></label><label>阶段<input type="number" min={1} value={output.stage} onChange={event => update(index, { stage: Math.max(1, Number(event.target.value) || 1) })} /></label><label className="inline-check"><input type="checkbox" checked={output.saveOutput ?? true} onChange={event => update(index, { saveOutput: event.target.checked })} />工作流保存该输出</label></div>)}</div><div className="output-review-note"><AlertTriangle size={16} /><p><strong>单工作流无法在一采处暂停</strong><span>输出是否保存取决于各工作流的输出节点配置；修改显示名称不会改变云端执行顺序。</span></p></div><div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void onSave({ ...workflow, outputs, profileVersion: workflow.profileVersion + 1, updatedAt: Date.now() })}>保存输出配置</button></div></div></div>;
}

export function WorkflowEditorModal({ workflow, onClose, onSave }: { workflow: WorkflowView; onClose: () => void; onSave: (workflow: WorkflowView) => void | Promise<void> }) {
  const [draft, setDraft] = useState<WorkflowView>(() => ({ ...workflow, parameters: workflow.parameters.map(parameter => ({ ...parameter })) }));
  const [filter, setFilter] = useState<"all" | "media" | "review">("all");
  const [error, setError] = useState<string>();
  const shown = draft.parameters.map((parameter, index) => ({ parameter, index })).filter(({ parameter }) => filter === "all" || (filter === "media" && isMediaParameter(parameter)) || (filter === "review" && (parameter.semanticType === "unknown" || parameter.confidence < .7)));
  const booleanParameters = draft.parameters.filter(parameter => parameter.valueType === "boolean");

  function updateParameter(index: number, patch: Partial<WorkflowParameterView>) {
    setDraft(current => ({ ...current, parameters: current.parameters.map((parameter, itemIndex) => itemIndex === index ? { ...parameter, ...patch } : parameter) }));
  }

  function addMedia() {
    const number = draft.parameters.filter(isMediaParameter).length + 1;
    const parameter: WorkflowParameterView = { id: `image_manual_${Date.now()}`, key: `.image`, nodeId: "", fieldName: "image", classType: "LoadImage", nodeTitle: `Image ${number}`, valueType: "image", semanticType: "image", defaultValue: "None", confidence: 1 };
    setDraft(current => ({ ...current, parameters: [...current.parameters, parameter] }));
    setFilter("media");
  }

  async function save() {
    const id = extractWorkflowId(draft.runningHubWorkflowId);
    if (!id) return setError("Workflow ID 无效。");
    if (draft.parameters.some(parameter => !parameter.nodeId.trim() || !parameter.fieldName.trim())) return setError("每个参数都必须填写 nodeId 和 fieldName。");
    const keys = new Set<string>();
    for (const parameter of draft.parameters) {
      const key = `${parameter.nodeId}.${parameter.fieldName}`;
      if (keys.has(key)) return setError(`节点映射重复：${key}`);
      keys.add(key);
      if (parameter.mediaControl && !draft.parameters.some(candidate => candidate.id === parameter.mediaControl?.parameterId && candidate.valueType === "boolean")) return setError(`媒体节点 ${parameter.nodeTitle ?? parameter.id} 的关联开关无效。`);
    }
    const parameters = draft.parameters.map(parameter => ({ ...parameter, key: `${parameter.nodeId}.${parameter.fieldName}` }));
    await onSave({ ...draft, runningHubWorkflowId: id, parameters, parameterCount: parameters.length, needsReview: parameters.some(parameter => parameter.visible !== false && (parameter.semanticType === "unknown" || parameter.confidence < .7)), profileVersion: draft.profileVersion + 1, updatedAt: Date.now() });
  }

  return <div className="modal-backdrop" role="presentation"><div className="modal profile-editor-modal" role="dialog" aria-modal="true" aria-label="编辑工作流 Profile"><div className="modal-head"><div><p>PROFILE EDITOR</p><h2>编辑参数映射</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="editor-summary"><label>工作流名称<input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label><label>Workflow ID<input value={draft.runningHubWorkflowId} readOnly title="更换 Workflow ID 需要重新导入对应 API JSON" /></label><label className="wide-field">RunningHub 地址（可选）<input value={draft.sourceUrl ?? ""} onChange={event => setDraft(current => ({ ...current, sourceUrl: event.target.value || undefined }))} placeholder="https://www.runninghub.ai/..." /></label></div><div className="editor-toolbar"><div className="segmented">{(["all", "media", "review"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? `全部 ${draft.parameters.length}` : value === "media" ? `媒体 ${draft.parameters.filter(isMediaParameter).length}` : `待确认 ${draft.parameters.filter(item => item.semanticType === "unknown" || item.confidence < .7).length}`}</button>)}</div><button className="secondary small" onClick={addMedia}><Plus size={15} />添加媒体节点</button></div><div className="parameter-editor-list">{shown.map(({ parameter, index }) => <div className={`parameter-editor-row ${isMediaParameter(parameter) ? "media" : ""}`} key={parameter.id}><div className="parameter-editor-title"><span className="parameter-kind">{isMediaParameter(parameter) ? <ImagePlus size={16} /> : <Settings2 size={16} />}</span><label>显示名称<input value={parameter.nodeTitle ?? ""} onChange={event => updateParameter(index, { nodeTitle: event.target.value })} /></label><button className="icon-button danger" onClick={() => setDraft(current => ({ ...current, parameters: current.parameters.filter((_, itemIndex) => itemIndex !== index) }))} title="移除参数"><Trash2 size={15} /></button></div><div className="parameter-editor-grid"><label>nodeId<input value={parameter.nodeId} onChange={event => updateParameter(index, { nodeId: event.target.value, key: `${event.target.value}.${parameter.fieldName}` })} /></label><label>fieldName<input value={parameter.fieldName} onChange={event => updateParameter(index, { fieldName: event.target.value, key: `${parameter.nodeId}.${event.target.value}` })} /></label><label>参数语义<Select value={parameter.semanticType} onChange={event => { const semanticType = event.target.value as WorkflowSemanticType; const mediaType = ["image", "video", "audio"].includes(semanticType) ? semanticType as "image" | "video" | "audio" : undefined; updateParameter(index, { semanticType, valueType: mediaType ?? parameter.valueType, confidence: 1 }); }}>{semanticOptions.map(value => <option key={value} value={value}>{semanticLabels[value] ?? "其他 / 未识别"}</option>)}</Select><ChevronDown size={15} /></label><label>控件类型<Select value={parameter.valueType} onChange={event => updateParameter(index, { valueType: event.target.value as WorkflowParameterView["valueType"] })}>{["string", "integer", "number", "boolean", "select", "json", "image", "video", "audio"].map(value => <option key={value}>{value}</option>)}</Select><ChevronDown size={15} /></label></div>{isMediaParameter(parameter) && <div className="media-control-editor"><label>关联启用开关<Select value={parameter.mediaControl?.parameterId ?? ""} onChange={event => updateParameter(index, { mediaControl: event.target.value ? { parameterId: event.target.value, activeValue: true, inactiveValue: false, autoEnableOnReplace: true, detected: false } : undefined })}><option value="">无关联开关</option>{booleanParameters.map(control => <option key={control.id} value={control.id}>{control.nodeTitle ?? control.fieldName} · {control.key}</option>)}</Select><ChevronDown size={15} /></label>{parameter.mediaControl && <><label className="inline-check"><input type="checkbox" checked={parameter.mediaControl.autoEnableOnReplace} onChange={event => updateParameter(index, { mediaControl: { ...parameter.mediaControl!, autoEnableOnReplace: event.target.checked } })} />上传替换时自动开启</label><button type="button" className="secondary small" onClick={() => updateParameter(index, { mediaControl: { ...parameter.mediaControl!, activeValue: !parameter.mediaControl!.activeValue, inactiveValue: parameter.mediaControl!.activeValue } })}>开启值：{String(parameter.mediaControl.activeValue)}</button></>}</div>}<div className="parameter-editor-meta"><code>{parameter.key || "尚未完成映射"}</code><span>{parameter.classType}</span><span className={parameter.confidence < .7 ? "low" : ""}>置信度 {Math.round(parameter.confidence * 100)}%</span>{parameter.mediaControl && <span className="linked-control">已关联开关</span>}</div></div>)}</div>{!shown.length && <div className="empty-parameters">当前筛选条件下没有参数。</div>}{error && <div className="import-feedback error modal-feedback"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="modal-actions editor-actions"><span>保存后 Profile 版本将升级至 v{draft.profileVersion + 1}</span><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => void save()}>保存 Profile</button></div></div></div>;
}
