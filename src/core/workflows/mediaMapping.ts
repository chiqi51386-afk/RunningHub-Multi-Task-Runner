import type { WorkflowParameter } from "../types.js";

/** Derive reference positions from this graph, never from loader IDs or titles. */
export function mapReferenceMedia(raw: Record<string, unknown>, parameters: WorkflowParameter[]): void {
  const nodes = raw as Record<string, { inputs?: Record<string, unknown> }>;
  const claims = new Map<string, Set<number>>();
  const ambiguous = new Set<string>();
  const slotSources = new Map<string, Set<string>>();
  const link = (v: unknown): v is [string | number, number] => Array.isArray(v) && v.length === 2 && Number.isInteger(v[1]) && !!nodes[String(v[0])];
  function sources(id: string, kind: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    const visited = new Set(seen).add(id);
    const own = parameters.filter(p => p.nodeId === id && p.fieldName === kind);
    if (own.length) return own.map(p => p.key);
    const result = new Set<string>();
    function visit(v: unknown): void {
      if (link(v)) sources(String(v[0]), kind, visited).forEach(key => result.add(key));
      else if (v && typeof v === "object") Object.values(v).forEach(visit);
    }
    visit(nodes[id]?.inputs);
    return [...result];
  }
  function visit(value: unknown, field: string): void {
    if (link(value)) {
      const match = field.match(/(?:ref|reference)[_-]?(image|audio|video)[_-](\d+)$/i);
      if (!match) return;
      const found = sources(String(value[0]), match[1]!.toLowerCase());
      const slot = `${match[1]!.toLowerCase()}:${Number(match[2])}`;
      const loaders = slotSources.get(slot) ?? new Set<string>();
      found.forEach(key => loaders.add(key));
      slotSources.set(slot, loaders);
      for (const key of found) {
        const indices = claims.get(key) ?? new Set<number>();
        indices.add(Number(match[2])); claims.set(key, indices);
        if (found.length !== 1) ambiguous.add(key);
      }
      return;
    }
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) visit(child, key);
  }
  for (const node of Object.values(nodes)) visit(node.inputs, "");
  for (const loaders of slotSources.values()) if (loaders.size > 1) loaders.forEach(key => ambiguous.add(key));
  for (const p of parameters) {
    const indices = claims.get(p.key);
    if (!indices) continue;
    if (indices.size === 1 && !ambiguous.has(p.key)) p.referenceIndex = [...indices][0];
    else p.mappingIssue = "参考输入存在多路或冲突连线，请确认工作流映射后再提交。";
  }
}
