export type NamingRule = "workflow-date" | "date" | "original";
export function shortOutputPath(input: { identity: {task:number; group?:number; date:string}; production?: {segmentIndex:number}; rule: NamingRule; workflow:string; index:number; total:number; url:string; extension:string }): string {
  const {identity} = input;
  if (!Number.isSafeInteger(identity.task) || identity.task < 1 || !/^\d{8}$/.test(identity.date)) throw new Error('下载编号无效');
  const ext = /^[a-z0-9]{1,8}$/i.test(input.extension) ? input.extension.toLowerCase() : 'bin';
  const output = input.total > 1 ? `_${String(input.index+1).padStart(2,'0')}` : '';
  if (input.production) {
    if (!Number.isSafeInteger(identity.group) || identity.group! < 1 || !Number.isInteger(input.production.segmentIndex) || input.production.segmentIndex < 1) throw new Error('制作编号无效');
    return `MV_${identity.date}_${String(identity.group).padStart(3,'0')}/${String(input.production.segmentIndex).padStart(3,'0')}${output}.${ext}`;
  }
  let prefix = input.rule === 'date' ? identity.date : `${identity.date}_${clean(input.workflow,20)}`;
  if (input.rule === 'original') {try {prefix=clean(decodeURIComponent(new URL(input.url).pathname.split('/').pop()||'output').replace(/\.[^.]+$/,''),32);} catch {prefix='output';}}
  return `${prefix}_${String(identity.task).padStart(3,'0')}${output}.${ext}`;
}
/** Stable sequence metadata is independent of completion/download order. */
export function productionOutputPath(production: { groupId: string; segmentIndex: number }, jobId: string, outputIndex: number, extension: string): string {
  if (!/^[a-z0-9-]{1,100}$/i.test(production.groupId) || !Number.isInteger(production.segmentIndex) || production.segmentIndex < 1 || production.segmentIndex > 9999) throw new Error("制作批次命名信息无效");
  const segment = String(production.segmentIndex).padStart(4, "0");
  const ext = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "bin";
  return `MV_${production.groupId}/${segment}_第${segment}段_输出${String(outputIndex + 1).padStart(2, "0")}_${clean(jobId, 40)}.${ext}`;
}
export function namingRule(value: unknown): NamingRule {
  return value === "date" || value === "original" ? value : "workflow-date";
}
function clean(value: string, limit = 48): string {
  const result = value.normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, limit).replace(/[. ]+$/g, "");
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result || "output";
}
export function outputFilename(input: { rule: NamingRule; createdAt: number; workflow: string; jobId: string; index: number; url: string; extension: string }): string {
  const date = new Date(input.createdAt);
  const pad = (v: number) => String(v).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  let prefix = input.rule === "workflow-date" ? `${stamp}_${clean(input.workflow)}` : stamp;
  if (input.rule === "original") {
    try { prefix = clean(decodeURIComponent(new URL(input.url).pathname.split("/").pop() || "output").replace(/\.[^.]+$/, ""), 80); }
    catch { prefix = "output"; }
  }
  const ext = /^[a-z0-9]{1,8}$/i.test(input.extension) ? input.extension.toLowerCase() : "bin";
  return `${prefix}_${clean(input.jobId, 40)}_${pad(input.index+1)}.${ext}`;
}
