import path from "node:path";

// This is a data format/migration contract, NOT a display name.
// ZIP releases and NSIS installations must resolve to the exact same directory.
export const legacyUserDataName = "runninghub-multi-task-runner-core";
export function existingUserDataPath(appData: string): string {
  return path.join(appData, legacyUserDataName);
}

export function hasUnfinishedWork(statuses: readonly string[], ttsCount: number): boolean {
  return ttsCount > 0 || statuses.some(status => !["COMPLETED", "FAILED", "CANCELLED"].includes(status));
}
