import { useEffect, useRef, useState } from "react";
import { useDebouncedSave } from "./useDebouncedSave";
import { Plus, Trash2, ArrowRight } from "lucide-react";
import type { CreateJobDraft, WorkflowView, WorkflowParameterView, MediaParameterDraft } from "./types";
import { MediaField, ParameterField } from "./MediaFields";
import { cloneDraft, exchangeImages, setDraftMedia, visibleMedia, taskOptimizationEnabled } from "./task-draft";
import { isSavedDraft, readSaved, serializeDraft, restoreDraft } from "./draft-storage";
import { applyMvShared, mvParameter, newMvDraft, prepareMvBatch } from "./mv-draft";

type Segment = { id: string; draft: CreateJobDraft; slots: number };
import type { CreateBatchItem } from "./production-batch";
type Props = {
  workflow: WorkflowView; initialDraft?: CreateJobDraft;
  batch: CreateBatchItem[]; setBatch: React.Dispatch<React.SetStateAction<CreateBatchItem[]>>;
  editRequest?: CreateBatchItem;
  submissionLock: React.MutableRefObject<boolean>;
  submitting: "single" | "batch" | null;
};
const storageKey = "rh-runner.mv-segments.v1";
export function MvWorkspace({ workflow, initialDraft, batch, setBatch, editRequest, submissionLock, submitting }: Props) {
  const makeSegment = (draft: CreateJobDraft): Segment => ({ id: crypto.randomUUID(), draft: cloneDraft(draft), slots: 2 });
  const [segments, setSegments] = useState<Segment[]>(() => {
    if (initialDraft) return [makeSegment(initialDraft)];
    const saved = readSaved(storageKey);
    if (Array.isArray(saved) && saved.length && saved.every(s => s && typeof s.id === "string" && isSavedDraft(s.draft))) return saved.map(s => {
      try {
        const draft = restoreDraft(s.draft, [workflow], workflow, old => localStorage.setItem("rh-runner.mv-backup." + s.id + "." + Date.now(), serializeDraft(old)));
        return { id: s.id, draft, slots: 2 };
      } catch { return { id: s.id, draft: s.draft, slots: 2 }; }
    });
    return [makeSegment(newMvDraft(workflow))];
  });
  const [shared, setShared] = useState<CreateJobDraft>(() => {
    const saved = readSaved(storageKey + ".shared");
    if (!initialDraft && isSavedDraft(saved)) {
      try { return restoreDraft(saved, [workflow], workflow, old => localStorage.setItem(storageKey + ".shared.backup", serializeDraft(old))); }
      catch { return cloneDraft(saved); }
    }
    return cloneDraft(segments[0].draft);
  });
  const applied = useRef<CreateBatchItem | undefined>(undefined);
  const editorBackup = useRef<{ segments: Segment[]; shared: CreateJobDraft } | undefined>(undefined);
  const [editingId, setEditingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [storageError, setStorageError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const pickerLock = useRef(false);
  useEffect(() => {
    if (!editRequest || applied.current === editRequest) return;
    applied.current = editRequest;
    if (editRequest.id) {
      let restored: CreateJobDraft;
      try { restored = restoreDraft(editRequest.draft, [workflow], workflow, old => localStorage.setItem(storageKey + ".edit.backup", serializeDraft(old))); }
      catch { setStorageError("批次输入备份失败，未打开编辑"); return; }
      editorBackup.current ??= { segments, shared };
      setEditingId(editRequest.id);
      setSegments([makeSegment(restored)]);
      setShared(cloneDraft(restored));
    } else {
      editorBackup.current = undefined; setEditingId(undefined);
      setSegments([makeSegment(editRequest.draft)]);
      setShared(cloneDraft(editRequest.draft));
    }
  }, [editRequest]);
  function finishEditing() {
    if (editorBackup.current) {
      setSegments(editorBackup.current.segments); setShared(editorBackup.current.shared);
      editorBackup.current = undefined;
    }
    setEditingId(undefined);
  }
  useEffect(() => {
    if (editingId && !batch.some(item => item.id === editingId)) finishEditing();
  }, [batch, editingId]);
  useDebouncedSave(() => {
    try {
      // Editing a queued snapshot must not overwrite the user's multi-segment draft.
      localStorage.setItem(storageKey, serializeDraft(editorBackup.current?.segments ?? segments));
      localStorage.setItem(storageKey + ".shared", serializeDraft(editorBackup.current?.shared ?? shared));
      setStorageError(undefined);
    }
    catch { setStorageError("MV 草稿保存失败，请勿关闭软件。"); }
  }, [segments, shared]);
  const images = visibleMedia(workflow, "h3-mv").filter(p => p.valueType === "image");
  const audio = mvParameter(workflow, "34.audio");
  function changeShared(update: (draft: CreateJobDraft) => CreateJobDraft) {
    if (submissionLock.current || pickerLock.current) return;
    setShared(current => update(current));
    setSegments(current => current.map(s => ({ ...s, draft: update(s.draft) })));
  }
  function clearAllInputs() {
    if (submissionLock.current || pickerLock.current) return;
    const empty = newMvDraft(workflow);
    for (const key of ["61.aspect_ratio", "61.megapixels"]) {
      const p = mvParameter(workflow, key);
      empty.parameterValues[p.id] = shared.parameterValues[p.id];
    }
    empty.instanceType = shared.instanceType;
    empty.promptOptimizationEnabled = taskOptimizationEnabled(segments[0].draft);
    editorBackup.current = undefined;
    setEditingId(undefined);
    setShared(cloneDraft(empty));
    setSegments([makeSegment(empty)]);
    setError(undefined);
  }
  function addSegment() {
    setSegments(current => {
      const last = current.at(-1)!.draft;
      const start = Number(last.parameterValues[mvParameter(workflow, "85.start_index").id]) + Number(last.parameterValues[mvParameter(workflow, "85.duration").id]);
      const draft = newMvDraft(workflow, Number.isFinite(start) ? start : 0);
      for (const key of ["61.aspect_ratio", "61.megapixels"]) {
        const p = mvParameter(workflow, key);
        draft.parameterValues[p.id] = shared.parameterValues[p.id];
      }
      draft.mediaOverrides[audio.id] = { ...shared.mediaOverrides[audio.id] };
      draft.instanceType = shared.instanceType;
      draft.promptOptimizationEnabled = taskOptimizationEnabled(last);
      return [...current, makeSegment(draft)];
    });
  }
  const busy = Boolean(submitting) || picking;
  function change(id: string, update: (draft: CreateJobDraft) => CreateJobDraft) {
    if (submissionLock.current || pickerLock.current) return;
    setSegments(current => current.map(s => s.id === id ? { ...s, draft: update(s.draft) } : s));
  }
  async function pick(id: string | undefined, parameter: WorkflowParameterView, file?: File) {
    if (submissionLock.current || pickerLock.current) return;
    if (parameter.valueType !== "audio" && parameter.valueType !== "image" && parameter.valueType !== "video") return;
    pickerLock.current = true; setPicking(true);
    try {
      const selected = window.runningHub ? (file ? await window.runningHub.media.fromDroppedFile(file) : await window.runningHub.media.select(parameter.valueType)) : file ? { file } : undefined;
      if (selected) {
        if (id === undefined) setShared(d => setDraftMedia(d, parameter, { ...selected, mode: "replace", enabled: true }));
        setSegments(current => current.map(s => id === undefined || s.id === id
          ? { ...s, draft: setDraftMedia(s.draft, parameter, { ...selected, mode: "replace", enabled: true }) } : s));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "素材选择失败"); }
    finally { pickerLock.current = false; setPicking(false); }
  }
  async function dropImages(id: string, offset: number, files: File[]) {
    if (submissionLock.current || pickerLock.current || !files.length) return;
    if (files.length + offset > images.length) { setError("每段最多 6 张图片，本次未添加。"); return; }
    if (files.some(file => !file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name))) { setError("这里只能拖入图片。"); return; }
    pickerLock.current = true; setPicking(true); setError(undefined);
    try {
      const selected: Array<Partial<MediaParameterDraft> | undefined> = [];
      for (const file of files) selected.push(window.runningHub ? await window.runningHub.media.fromDroppedFile(file) : { file });
      if (selected.some(file => !file)) throw new Error("图片读取失败，本次未添加。");
      setSegments(current => current.map(segment => {
        if (segment.id !== id) return segment;
        let draft = segment.draft;
        selected.forEach((file, index) => { draft = setDraftMedia(draft, images[offset + index], { ...file, mode: "replace", enabled: true }); });
        return { ...segment, draft };
      }));
    } catch (e) { setError(e instanceof Error ? e.message : "图片读取失败"); }
    finally { pickerLock.current = false; setPicking(false); }
  }
  const stagingLock = useRef(false);
  const stageFeedback = useRef<HTMLDivElement>(null);
  const [stagedCount,setStagedCount] = useState(0);
  function stage() {
    if (submissionLock.current || pickerLock.current || stagingLock.current) return;
    stagingLock.current = true; setError(undefined); setStagedCount(0);
    try {
      const pending = segments;
      const drafts = prepareMvBatch(pending.map(s => applyMvShared(s.draft, shared, workflow)), workflow);
      const groupId = crypto.randomUUID();
      const entries = drafts.map((draft, i) => ({ id: crypto.randomUUID(), draft: { ...draft, production: { groupId, segmentIndex: drafts.length === 1 ? draft.production?.segmentIndex ?? 1 : i + 1 } } }));
      if (editingId) {
        const snapshot = drafts[0];
        setBatch(current => current.map(item => item.id === editingId ? { ...item, draft: { ...snapshot, production: item.draft.production } } : item));
        finishEditing();
        return;
      }
      setBatch(current => [...current, ...entries]);
      setStagedCount(entries.length);
    } catch (e) { setError(e instanceof Error ? e.message : "加入批次失败"); }
    finally { queueMicrotask(() => { stagingLock.current = false; }); requestAnimationFrame(()=>stageFeedback.current?.scrollIntoView({block:'nearest'})); }
  }
  return <div className="mv-workspace">
    {(error || storageError) && <div role="alert">{error || storageError}</div>}
    <fieldset disabled={busy} className="mv-controls">
      <div className="mv-editor">
      <div className="mv-global-actions bulk-media-actions">
        <button type="button" onClick={clearAllInputs}>清空全部输入</button>
      </div>
      <section className="panel form-panel mv-global">
        <div className="form-section"><div className="section-content"><label className="parameter-field"><span className="field-label">任务名称（选填）</span><input aria-label="H3数字人任务名称" maxLength={80} value={shared.taskName ?? ""} onChange={e=>changeShared(d=>({...d,taskName:e.target.value}))}/></label></div></div>
        <div className="form-section"><div className="section-content mv-global-audio">
          <div className="section-title-row"><h2>音频</h2></div>
          <MediaField parameter={audio} index={1} draft={shared.mediaOverrides[audio.id] ?? { enabled: false, mode: "clear" }}
            onPick={window.runningHub ? () => void pick(undefined, audio) : undefined}
            onDrop={file => void pick(undefined, audio, file)} onMove={() => {}}
            onChange={(mode, file) => mode === "replace" ? void pick(undefined, audio, file) : changeShared(d => setDraftMedia(d, audio, { enabled: false, mode: "clear" }))} />
        </div></div>
      </section>
      {segments.map((segment, index) => <section className="mv-segment" key={segment.id}>
        <div className="mv-toolbar"><h3>第 {index + 1} 段</h3>
          <button type="button" className="icon-button" aria-label={`移除第 ${index + 1} 段`} disabled={segments.length === 1} onClick={() => setSegments(current => current.filter(s => s.id !== segment.id))}><Trash2 size={17} /></button>
        </div>
        <div className="mv-segment-body">
        <div className="content-prompt-block"><div className="content-input-label"><span>生成词</span><div><label className="boolean-field"><span><strong>中文生成词优化</strong></span><button type="button" className={`switch ${taskOptimizationEnabled(segment.draft) ? "checked" : ""}`} aria-label={`第 ${index + 1} 段中文生成词优化`} aria-pressed={taskOptimizationEnabled(segment.draft)} onClick={()=>change(segment.id,d=>({...d,promptOptimizationEnabled:!taskOptimizationEnabled(d)}))}><span/></button></label><button type="button" onClick={() => change(segment.id, d => ({ ...d, parameterValues: { ...d.parameterValues, [mvParameter(workflow, "87.value").id]: "" } }))}>清空生成词</button></div></div>
          <div className="dynamic-grid prompt-input-grid h3-prompt-input"><ParameterField hideLabel parameter={mvParameter(workflow, "87.value")} value={segment.draft.parameterValues[mvParameter(workflow, "87.value").id]} onValue={(p, value) => change(segment.id, d => ({ ...d, parameterValues: { ...d.parameterValues, [p.id]: value } }))} /></div>
        </div>
        <div className="mv-parameters">{(() => {
          const start = mvParameter(workflow, "85.start_index"), duration = mvParameter(workflow, "85.duration");
          const startValue = segment.draft.parameterValues[start.id], durationValue = segment.draft.parameterValues[duration.id];
          const end = typeof startValue === "number" && typeof durationValue === "number" ? Number((startValue + durationValue).toFixed(2)) : "";
          return <>
            <label className="parameter-field"><span className="field-label">音频起点（秒）</span><input aria-label={`第 ${index + 1} 段音频起点`} type="number" min={0} step={0.01} value={typeof startValue === "number" ? startValue : ""} onChange={e => {
              const value = e.target.value === "" ? "" : Number(e.target.value);
              change(segment.id, d => ({ ...d, parameterValues: { ...d.parameterValues, [start.id]: value, [duration.id]: typeof value === "number" && typeof end === "number" ? Number((end - value).toFixed(2)) : "" } }));
            }} /></label>
            <label className="parameter-field"><span className="field-label">音频结束（秒）</span><input aria-label={`第 ${index + 1} 段音频结束`} type="number" min={0} step={0.01} value={end} onChange={e => {
              const value = e.target.value === "" ? "" : Number(e.target.value);
              change(segment.id, d => ({ ...d, parameterValues: { ...d.parameterValues, [duration.id]: typeof value === "number" && typeof startValue === "number" ? Number((value - startValue).toFixed(2)) : "" } }));
            }} /></label>
          </>;
        })()}</div>
        <div className="mv-media" onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
          onDropCapture={e => {
            // Internal slot drags belong to MediaField's swap handler, even if
            // Chromium also exposes a file/URL representation of the image.
            if (e.dataTransfer.types.includes("application/x-rh-image-slot")) return;
            const files = Array.from(e.dataTransfer.files);
            if (!files.length) return;
            e.preventDefault(); e.stopPropagation();
            const tile = (e.target as HTMLElement).closest(".media-field");
            const offset = tile ? Array.from(e.currentTarget.children).indexOf(tile) : images.findIndex(p => segment.draft.mediaOverrides[p.id]?.mode !== "replace");
            if (offset >= 0) void dropImages(segment.id, offset, files);
            else setError("每段最多 6 张图片。");
          }}>{images.slice(0, Math.min(6, Math.max(2, segment.slots, ...images.map((p, i) => segment.draft.mediaOverrides[p.id]?.mode === "replace" ? i + 2 : 0)))).map((p, i) =>
          <MediaField key={p.id} parameter={{ ...p, id: segment.id + ":" + p.id }} index={p.valueType === "audio" ? 1 : i + 1}
            draft={segment.draft.mediaOverrides[p.id] ?? { enabled: false, mode: "clear" }}
            onPick={window.runningHub ? () => void pick(segment.id, p) : undefined}
            onDrop={file => void pick(segment.id, p, file)}
            onChange={(mode, file) => mode === "replace" ? void pick(segment.id, p, file) : change(segment.id, d => setDraftMedia(d, p, { enabled: false, mode: "clear" }))}
            onMove={source => { const from = images.find(item => source === segment.id + ":" + item.id); if (from) change(segment.id, d => exchangeImages(d, from, p)); }} />
        )}</div>
        </div>
      </section>)}
      {!editingId && <button type="button" className="mv-add-segment" onClick={addSegment}><Plus size={20} />增加段落</button>}
      <section className="panel form-panel mv-generation">
        <div className="form-section"><div className="section-content">
          <h2>生成参数</h2><div className="dynamic-grid">
            {["61.aspect_ratio", "61.megapixels"].map(key => {
              const p = mvParameter(workflow, key);
              return <ParameterField key={key} parameter={p} value={shared.parameterValues[p.id]} onValue={(_, value) => changeShared(d => ({ ...d, parameterValues: { ...d.parameterValues, [p.id]: value } }))} />;
            })}
          </div>
        </div></div>
        <div ref={stageFeedback} aria-live="polite">
          {(error || storageError) && <div className="import-feedback error" role="alert">{error || storageError}</div>}
          {!error && stagedCount>0 && <p role="status">已加入 {stagedCount} 个任务，请在右侧制作批次提交。</p>}
        </div>
        <div className="submit-bar">
          <div className="instance-mode-control"><span><strong>Plus 高显存</strong></span><button type="button" aria-label="MV Plus 高显存" className={`switch ${shared.instanceType === "plus" ? "checked" : ""}`} aria-pressed={shared.instanceType === "plus"} onClick={() => { const tier = shared.instanceType === "plus" ? "default" : "plus"; changeShared(d => ({ ...d, instanceType: tier })); }}><span /></button></div>
          <button type="button" className="primary" disabled={!segments.length} onClick={stage}>{editingId ? "保存批次修改" : "加入制作批次"}<ArrowRight size={18} /></button>
          {editingId && <button type="button" onClick={finishEditing}>取消编辑</button>}
        </div>
      </section>
      </div>
    </fieldset>
  </div>;
}
