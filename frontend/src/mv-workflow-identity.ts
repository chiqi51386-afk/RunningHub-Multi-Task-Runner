/** Explicit audited successor: only highres_tiling changed; node targets are identical. */
export const MV_CURRENT_ID = "2104166509705986049";
export function isMvWorkflowId(id?: string): boolean {
  return id === MV_CURRENT_ID || id === "2104101064866140162";
}
export function isMvSuccessor(previous?: string, current?: string): boolean {
  return previous === "2104101064866140162" && current === MV_CURRENT_ID;
}
