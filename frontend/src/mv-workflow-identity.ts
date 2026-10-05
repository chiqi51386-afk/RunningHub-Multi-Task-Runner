/** Audited successor: visible input targets are unchanged; hidden defaults use the new graph. */
export const MV_CURRENT_ID = "2107063778012905474";
export function isMvWorkflowId(id?: string): boolean {
  return id === MV_CURRENT_ID || id === "2104166509705986049" || id === "2104101064866140162";
}
export function isMvSuccessor(previous?: string, current?: string): boolean {
  return (previous === "2104101064866140162" || previous === "2104166509705986049") && current === MV_CURRENT_ID;
}
