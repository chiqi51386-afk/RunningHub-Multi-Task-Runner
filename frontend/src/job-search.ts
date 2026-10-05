import type { JobView } from "./types.js";

export function taskDisplayName(job: JobView): string {
  return job.displayName || job.taskName || `任务 ${job.remoteTaskId || job.id}`;
}

/** Presentation only: keep the canonical filename intact for downloads/search. */
export function taskListName(job: JobView): string {
  return job.displayName ? job.displayName.replace(/\.[a-z0-9]{1,8}$/i, '') : taskDisplayName(job);
}

export function matchesJobSearch(job: JobView, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [
    taskDisplayName(job), job.taskName, job.id, job.remoteTaskId,
    ...job.inputs?.media.map(item => item.fileName ?? "") ?? [],
    ...job.inputs?.parameters.filter(item => item.semanticType === "prompt").map(item => String(item.value ?? "")) ?? [],
    job.optimizationTrace?.originalText, job.optimizationTrace?.finalText,
    ...job.outputs?.map(item => item.localPath ?? "") ?? [],
  ].join(" ").toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}
