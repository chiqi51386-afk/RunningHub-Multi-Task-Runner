import { Children, isValidElement, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, SelectHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";

/** App-rendered listbox: never opens Chromium's native select popup. */
export function Select({ children, value, onChange, disabled, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const options: { value: string; label: ReactNode; disabled: boolean }[] = [];
  function collect(nodes: ReactNode) { Children.forEach(nodes, node => {
    if (!isValidElement<{value?: unknown; children?: ReactNode; disabled?: boolean}>(node)) return;
    if (node.type === "option") options.push({value: String(node.props.value ?? node.props.children ?? ""), label: node.props.children, disabled: !!node.props.disabled});
    else collect(node.props.children);
  }); }
  collect(children);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState(0);
  const [position, setPosition] = useState({left:0, top:0, width:0, maxHeight:240});
  const selected = options.findIndex(o => o.value === String(value));
  function place() {
    if (disabled || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect(), below = innerHeight-r.bottom-12;
    const height = Math.min(240, Math.max(below, r.top-12));
    setPosition({left:Math.max(8, Math.min(r.left, innerWidth-r.width-8)), top:below >= Math.min(240, options.length*40+12) ? r.bottom+4 : Math.max(8,r.top-height-4), width:r.width, maxHeight:height});
  }
  function show() { place(); setCursor(Math.max(0, selected)); setOpen(true); }
  function choose(index: number) {
    const option = options[index]; if (!option || option.disabled) return;
    onChange?.({target:{value:option.value}, currentTarget:{value:option.value}} as ChangeEvent<HTMLSelectElement>);
    setOpen(false); trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {if (!root.current?.contains(e.target as Node) && !listbox.current?.contains(e.target as Node)) setOpen(false);};
    const close = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.app-select-options')) return;
      // Reposition instead of dismissing: background polling and focus can also
      // scroll panels, and must not cancel an in-progress keyboard selection.
      place();
    };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => {document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true);};
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const list = listbox.current;
    const option = list?.querySelector<HTMLElement>(`#${CSS.escape(id)}-${cursor}`);
    if (!list || !option) return;
    // Scroll only the listbox. scrollIntoView also moves ancestor panels,
    // whose scroll-to-close listener can immediately dismiss this dropdown.
    const listBounds = list.getBoundingClientRect(), bounds = option.getBoundingClientRect();
    if (bounds.top < listBounds.top) list.scrollTop -= listBounds.top - bounds.top;
    else if (bounds.bottom > listBounds.bottom) list.scrollTop += bounds.bottom - listBounds.bottom;
  }, [cursor, open, id]);
  return <div className="app-select" ref={root} onBlur={e => {if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);}}>
    <button ref={trigger} type="button" role="combobox" aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']} title={props.title} disabled={disabled} aria-expanded={open} aria-controls={id} aria-activedescendant={open ? `${id}-${cursor}` : undefined} onClick={() => open ? setOpen(false) : show()} onKeyDown={e => {
      if (e.key === 'Escape') {e.preventDefault(); e.stopPropagation(); setOpen(false);}
      if (e.key === 'Tab') setOpen(false);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {e.preventDefault(); if (!open) show(); else setCursor(i => Math.max(0,Math.min(options.length-1,i+(e.key==='ArrowDown'?1:-1))));}
      if (e.key === 'Home' && open) {e.preventDefault();setCursor(0);}
      if (e.key === 'End' && open) {e.preventDefault();setCursor(options.length-1);}
      if ((e.key === 'Enter' || e.key === ' ') && open) {e.preventDefault();choose(cursor);}
    }}><span>{options[selected]?.label ?? '请选择'}</span><span aria-hidden="true">⌄</span></button>
    {open && createPortal(<div ref={listbox} id={id} role="listbox" className="app-select-options" style={position}>{options.map((o,i) => <button type="button" role="option" id={`${id}-${i}`} key={`${o.value}-${i}`} tabIndex={-1} disabled={o.disabled} aria-selected={i===selected} className={cursor===i?'focused':''} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}>{o.label}</button>)}</div>, document.body)}
  </div>;
}
