import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { WorkflowView } from "./types";

export const WorkflowPicker = memo(function WorkflowPicker({ workflows, value, onChange }: { workflows: WorkflowView[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const selected = workflows.find(workflow => workflow.id === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div className="workflow-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" role="combobox" aria-label="工作流" aria-expanded={open} aria-controls={`workflow-list-${value}`} aria-activedescendant={open ? `workflow-option-${value}-${cursor}` : undefined}
      onClick={() => { setCursor(Math.max(0, workflows.findIndex(item => item.id === value))); setOpen(!open); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setCursor(index => Math.max(0, Math.min(workflows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
        if (event.key === "Enter" && open) { event.preventDefault(); if (workflows[cursor]) onChange(workflows[cursor].id); setOpen(false); }
      }}><span>{selected?.name ?? "选择工作流"}</span><ChevronDown size={17} /></button>
    {open && <div className="workflow-options" id={`workflow-list-${value}`} role="listbox" aria-label="可用工作流">{workflows.map((workflow, index) => <button type="button" role="option" id={`workflow-option-${value}-${index}`} key={workflow.id} aria-selected={workflow.id === value} className={index === cursor ? "focused" : ""} onMouseEnter={() => setCursor(index)} onClick={() => { onChange(workflow.id); setOpen(false); root.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus(); }}><span>{workflow.name}</span>{workflow.id === value && <Check size={16} />}</button>)}</div>}
  </div>;
});
