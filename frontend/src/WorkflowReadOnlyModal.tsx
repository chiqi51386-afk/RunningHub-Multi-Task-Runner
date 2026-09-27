import { useState } from "react";
import type { WorkflowView } from "./types";
import { parameterLabel, semanticLabels } from "./workflow-view";

export function WorkflowReadOnlyModal({ workflow, section, onClose }: {
  workflow: WorkflowView; section: "parameters" | "outputs" | "visibility"; onClose: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const title = section === "outputs" ? "输出" : section === "visibility" ? "显示项" : "参数";
  const parameters = workflow.parameters.filter(p => filter === "all" ||
    (filter === "visible" ? p.visible !== false : p.visible === false));
  return <div className="modal-backdrop" role="presentation">
    <div className="modal profile-editor-modal" role="dialog" aria-modal="true" aria-label={`查看默认工作流${title}`}>
      <div className="modal-head"><div><h2>{workflow.name} · {title}</h2><p>默认工作流 · 只读</p></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      {section !== "outputs" && <div className="editor-toolbar"><div className="segmented">{[
        ["all", "全部"], ["visible", "显示"], ["hidden", "隐藏"],
      ].map(([value, label]) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div></div>}
      <div className="parameter-editor-list">
        {section === "outputs" ? (workflow.outputs?.length ? workflow.outputs.map(output => <article className="parameter-editor-row" key={output.id}>
          <h3>{output.label}</h3><p>节点 {output.nodeId} · {output.classType}</p>
          <p>类型：{output.mediaType} · 阶段：{output.stage} · 保存：{output.saveOutput === undefined ? "未指定" : output.saveOutput ? "是" : "否"}</p>
          {output.filenamePrefix && <p>文件名前缀：{output.filenamePrefix}</p>}
        </article>) : <p>没有配置输出节点。</p>) : parameters.map(parameter => <article className="parameter-editor-row" key={parameter.id}>
          <h3>{parameterLabel(parameter)}</h3><p>节点 {parameter.key} · {parameter.classType}</p>
          <p>{parameter.visible === false ? "隐藏" : "显示"} · {semanticLabels[parameter.semanticType] ?? "内部参数"} · {parameter.valueType}</p>
          {section === "parameters" && <><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>默认值：{JSON.stringify(parameter.defaultValue) ?? "未指定"}</pre>
            {parameter.options?.length ? <pre style={{ whiteSpace: "pre-wrap" }}>可选值：{JSON.stringify(parameter.options)}</pre> : null}
            {parameter.referenceIndex !== undefined && <p>参考序号：{parameter.referenceIndex + 1}</p>}
            {parameter.mediaControl && <p>关联开关：{parameter.mediaControl.parameterId}</p>}</>}
        </article>)}
      </div>
      <div className="modal-actions"><button type="button" className="primary" onClick={onClose}>关闭</button></div>
    </div>
  </div>;
}
