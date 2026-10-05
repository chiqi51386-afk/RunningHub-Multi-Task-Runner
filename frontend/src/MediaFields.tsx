import { Select } from "./Select";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ImagePlus, Music2, FileJson, Play } from "lucide-react";
import type { CreateJobDraft, WorkflowParameterView } from "./types";
import { parameterLabel, optionParts } from "./workflow-view";

export function DraftThumbnail({ draft }: { draft: CreateJobDraft }) {
  const replacements = Object.values(draft.mediaOverrides).filter(item => item.mode === "replace");
  const visual = replacements.find(item => item.file?.type.startsWith("image/") || item.file?.type.startsWith("video/") || /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|mkv)$/i.test(item.fileName ?? item.file?.name ?? ""));
  const audio = replacements.find(item => item.file?.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac)$/i.test(item.fileName ?? item.file?.name ?? ""));
  const [objectUrl, setObjectUrl] = useState<string>();
  useEffect(() => {
    if (!visual?.file || visual.previewUrl) { setObjectUrl(undefined); return; }
    const url = URL.createObjectURL(visual.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [visual?.file, visual?.previewUrl]);
  const source = visual?.previewUrl ?? objectUrl;
  const video = visual?.file?.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(visual?.fileName ?? "");
  if (source && video) return <div className="batch-thumbnail"><StaticVideoThumbnail localPath={visual?.localPath} /></div>;
  if (source) return <div className="batch-thumbnail"><img src={source} alt="批次媒体缩略图" /></div>;
  if (audio) return <div className="batch-thumbnail audio"><Music2 size={17} /></div>;
  return <div className="batch-thumbnail fallback"><FileJson size={16} /></div>;
}

export const ParameterField = memo(function ParameterField({ parameter, value, onValue, hideLabel = false }: { hideLabel?: boolean; parameter: WorkflowParameterView; value: unknown; onValue: (parameter: WorkflowParameterView, value: unknown) => void }) {
  const onChange = (next: unknown) => onValue(parameter, next);
  const label = parameterLabel(parameter);
  if (parameter.semanticType === "duration" && ["integer","number"].includes(parameter.valueType)) {
    const adjust=(delta:number)=>{
      const current=typeof value==="number"?value:Number(parameter.defaultValue);
      const next=Number((current+delta).toFixed(6));
      onChange(Math.max(parameter.min??0,Math.min(parameter.max??Infinity,next)));
    };
    return <label className="parameter-field"><span className="field-label">{label}</span><div className="duration-input"><button type="button" aria-label="减少 1 秒" onClick={()=>adjust(-1)}>−</button><input type="number" aria-label={label} value={typeof value==="number"?value:""} min={parameter.min} max={parameter.max} step={parameter.valueType==="integer"?1:"any"} onChange={event=>onChange(event.target.value===""?"":Number(event.target.value))} onKeyDown={event=>{if(event.key==="ArrowUp"||event.key==="ArrowDown"){event.preventDefault();adjust(event.key==="ArrowUp"?1:-1);}}}/><button type="button" aria-label="增加 1 秒" onClick={()=>adjust(1)}>+</button></div></label>;
  }
  if (parameter.valueType === "boolean") return <label className={`boolean-field ${parameter.fieldName === "highres_tiling" ? "highres-tiling-field" : ""}`}><span><strong>{label}</strong></span><button type="button" className={`switch ${value ? "checked" : ""}`} onClick={() => onChange(!value)} aria-label={label} aria-pressed={value === true}><span /></button></label>;
  if (parameter.valueType === "select" && parameter.options?.length) {
    const options = parameter.options ?? [];
    const selectedToken = JSON.stringify(value);
    return <label className="parameter-field"><span className="field-label">{label}</span><Select value={selectedToken} onChange={event => { const match = options.map(optionParts).find(option => JSON.stringify(option.value) === event.target.value); onChange(match?.value); }}>{options.map(option => { const item = optionParts(option); return <option key={JSON.stringify(item.value)} value={JSON.stringify(item.value)}>{item.label}</option>; })}</Select><ChevronDown size={16} /></label>;
  }
  if (parameter.valueType === "integer" || parameter.valueType === "number") return <label className="parameter-field"><span className="field-label">{label}</span><input type="number" value={typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) ? value : ""} min={parameter.min} max={parameter.max} step={parameter.step ?? (parameter.valueType === "integer" ? 1 : "any")} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} /></label>;
  if (parameter.valueType === "json") return <JsonParameterField label={label} value={value} onChange={onChange} />;
  if (parameter.semanticType === "negative_prompt") return <label className="parameter-field wide-field negative-prompt-field"><span className="field-label">{label}</span><textarea aria-label={label} rows={3} style={{minHeight:80,height:96,maxHeight:180}} value={String(value ?? parameter.defaultValue ?? "")} onChange={event=>onChange(event.target.value)}/></label>;
  const multiline = ["prompt", "negative_prompt"].includes(parameter.semanticType) || String(parameter.defaultValue ?? "").length > 80;
  return <label className={`parameter-field ${multiline ? "wide-field" : ""}`}>{!hideLabel && <span className="field-label">{label}</span>}{multiline ? <textarea aria-label={label} rows={4} value={String(value ?? "")} onChange={event => onChange(event.target.value)} /> : <input value={String(value ?? "")} onChange={event => onChange(event.target.value)} />}</label>;
});

function JsonParameterField({ label, value, onChange }: { label: string; value: unknown; onChange: (value: unknown) => void }) {
  const serialized = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => { setText(serialized); setError(undefined); }, [serialized]);
  return <label className={`parameter-field wide-field json-parameter ${error ? "invalid" : ""}`}>
    <span className="field-label">{label}</span>
    <textarea ref={element => { element?.setCustomValidity(error ? "JSON 格式无效" : ""); }} rows={4} value={text} aria-invalid={Boolean(error)} onChange={event => {
      const next = event.target.value;
      setText(next);
      try {
        const parsed = JSON.parse(next);
        event.currentTarget.setCustomValidity("");
        onChange(parsed);
        setError(undefined);
      } catch (parseError) {
        event.currentTarget.setCustomValidity("JSON 格式无效");
        setError(parseError instanceof Error ? parseError.message : "JSON 格式无效");
      }
    }} />
    {error && <small className="json-error">JSON 尚未完成：请修正格式后再提交。</small>}
  </label>;
}

type MediaFieldProps = { numberedImage?: boolean; parameter: WorkflowParameterView; draft: CreateJobDraft["mediaOverrides"][string]; index: number; onPick?: () => void; onDrop: (file: File) => void; onMove: (sourceId: string) => void; onChange: (mode: "replace" | "clear", file?: File) => void };
export function MediaField(props: MediaFieldProps) {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const pick = useCallback(() => latest.current.onPick?.(), []);
  const drop = useCallback((file: File) => latest.current.onDrop(file), []);
  const move = useCallback((id: string) => latest.current.onMove(id), []);
  const change = useCallback((mode: "replace" | "clear", file?: File) => latest.current.onChange(mode, file), []);
  return <MediaFieldContent {...props} onPick={props.onPick ? pick : undefined} onDrop={drop} onMove={move} onChange={change} />;
}
const MediaFieldContent = memo(function MediaFieldContent({ parameter, draft, index, onPick, onDrop, onMove, onChange, numberedImage }: MediaFieldProps) {
  const baseLabel = parameterLabel(parameter);
  const mediaLabel = numberedImage ? `图片 ${index}` : ["图片", "音频", "视频"].includes(baseLabel) ? `${baseLabel} ${index}` : baseLabel;
  const accept = parameter.valueType === "image" ? "image/*" : parameter.valueType === "video" ? "video/*" : "audio/*";
  const [objectUrl, setObjectUrl] = useState<string>();
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!draft.file || draft.previewUrl) { setObjectUrl(undefined); return; }
    const url = URL.createObjectURL(draft.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.file, draft.previewUrl]);
  const previewUrl = draft.previewUrl ?? objectUrl;
  const choose = onPick
    ? <button type="button" className="dropzone compact-dropzone" aria-label={`选择或拖入${mediaLabel}`} onClick={onPick}>{parameter.valueType === "audio" ? <Music2 size={22} /> : <ImagePlus size={22} />}<strong>选择或拖入{mediaLabel}</strong></button>
    : <label className="dropzone compact-dropzone"><input type="file" aria-label={`选择或拖入${mediaLabel}`} accept={accept} onChange={event => { const file = event.target.files?.[0]; if (file) onChange("replace", file); event.currentTarget.value = ""; }} />{parameter.valueType === "audio" ? <Music2 size={22} /> : <ImagePlus size={22} />}<strong>选择或拖入{mediaLabel}</strong></label>;
  return <div className={`media-field media-${parameter.valueType} mode-${draft.mode} ${dragging ? "dragging" : ""}`}
    onDragEnter={event => { event.preventDefault(); setDragging(true); }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes("application/x-rh-image-slot") ? "move" : "copy"; setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); const sourceId = event.dataTransfer.getData("application/x-rh-image-slot"); if (sourceId) { onMove(sourceId); return; } const file = event.dataTransfer.files?.[0]; if (file) onDrop(file); }}>
    <div className="media-slot-index">{String(index).padStart(2, "0")}</div>
    <div className="media-head"><div><strong>{mediaLabel}</strong></div><b className={draft.mode === "replace" ? "uploaded" : "empty"}>{draft.mode === "replace" ? "已上传" : "未上传"}</b></div>
    {draft.mode === "clear" && choose}
    {draft.mode === "replace" && previewUrl && <div className="selected-media-preview" draggable={parameter.valueType === "image"} onDragStart={event => { if (parameter.valueType !== "image") return; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-rh-image-slot", parameter.id); }}><MediaPreview type={parameter.valueType as "image" | "video" | "audio"} url={previewUrl} /><div className="media-file-actions">{onPick && <button type="button" className="secondary small" onClick={onPick}>更换</button>}<button type="button" className="danger-button small" onClick={() => onChange("clear")}>移除</button></div></div>}
    {draft.mode === "replace" && !previewUrl && choose}
  </div>;
});

export const MediaPreview = memo(function MediaPreview({ type, url }: { type: "image" | "video" | "audio"; url: string }) {
  if (type === "image") return <img draggable={false} className="media-input-preview" src={url} alt="已选择的图片预览" />;
  if (type === "video") return <video className="media-input-preview" src={url} controls preload="metadata" />;
  return <audio className="media-input-audio" src={url} controls preload="metadata" />;
});

export function StaticVideoThumbnail({ localPath }: { localPath?: string }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    setThumbnailUrl(undefined);
    if (!localPath || !window.runningHub?.media.thumbnail) return;
    void window.runningHub.media.thumbnail(localPath).then(url => {
      if (active && url) setThumbnailUrl(url);
    }).catch(() => { if (active) setThumbnailUrl(undefined); });
    return () => { active = false; };
  }, [localPath]);
  return thumbnailUrl
    ? <div className="job-thumbnail"><img src={thumbnailUrl} alt="视频静态缩略图" /></div>
    : <div className="job-thumbnail fallback"><Play size={17} /></div>;
}
