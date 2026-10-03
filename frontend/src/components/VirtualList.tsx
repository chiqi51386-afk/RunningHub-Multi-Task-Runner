import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Item = { id: string };
/** Variable-height rows: errors and responsive actions are measured, never clipped. */
export function VirtualList<T extends Item>({ items, renderItem, label }: {
  items: T[]; renderItem: (item: T) => ReactNode; label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [focused, setFocused] = useState<string>();
  const offsets = useMemo(() => {
    const result = [0];
    for (const item of items) result.push(result[result.length - 1] + (heights.current.get(item.id) ?? 130));
    return result;
  }, [items, revision]);
  const measure = useCallback((id: string, height: number) => {
    if (height <= 0 || heights.current.get(id) === height) return;
    heights.current.set(id, height);
    setRevision(value => value + 1);
  }, []);
  useLayoutEffect(() => {
    const ids = new Set(items.map(item => item.id));
    for (const id of heights.current.keys()) if (!ids.has(id)) heights.current.delete(id);
  }, [items]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    let width = element.clientWidth;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(() => {
      if (width !== element.clientWidth) {
        width = element.clientWidth;
        heights.current.clear();
        setRevision(value => value + 1);
      }
      update();
    });
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  const total = offsets[offsets.length - 1];
  // Clamp after deleting/filtering items at the end of the list.
  const top = Math.min(viewport.top, Math.max(0, total - viewport.height));
  const start = Math.max(0, offsets.findIndex(offset => offset >= top) - 5);
  let end = offsets.findIndex(offset => offset > top + viewport.height);
  if (end < 0) end = items.length;
  end = Math.min(items.length, end + 5);
  const visible = items.slice(start, end).map((item, index) => ({ item, index: start + index }));
  const focusIndex = focused ? items.findIndex(item => item.id === focused) : -1;
  if (focusIndex >= 0 && (focusIndex < start || focusIndex >= end)) visible.push({ item: items[focusIndex], index: focusIndex });
  visible.sort((a, b) => a.index - b.index);
  return <div className="virtual-job-list" ref={container} role="region" aria-label={label} tabIndex={0}
    onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
    <div style={{ height: total, position: "relative" }}>
      {visible.map(({ item, index }) => <MeasuredRow key={item.id} id={item.id} top={offsets[index]} onMeasure={measure} onFocus={setFocused}>
        {renderItem(item)}
      </MeasuredRow>)}
    </div>
  </div>;
}

function MeasuredRow({ id, top, onMeasure, onFocus, children }: {
  id: string; top: number; onMeasure: (id: string, height: number) => void;
  onFocus: (id: string) => void; children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = element.current;
    if (!row) return;
    const measure = () => onMeasure(id, row.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [id, onMeasure]);
  return <div ref={element} onFocus={() => onFocus(id)} style={{ position: "absolute", top, width: "100%" }}>{children}</div>;
}
