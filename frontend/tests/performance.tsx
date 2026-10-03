import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import Jobs from "../src/views/Jobs";
import TaskPreviewModal from "../src/modals/TaskPreviewModal";
import { useDebouncedSave } from "../src/useDebouncedSave";
import type { JobView } from "../src/types";
import "../src/styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const results: string[] = [];
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); results.push(message); };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const root = createRoot(document.getElementById("root")!);
const intervals = new Set<ReturnType<typeof setInterval>>();
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const id = originalInterval(...args); intervals.add(id); return id;
}) as typeof setInterval;
globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => { intervals.delete(id); originalClear(id); }) as typeof clearInterval;
const calls: string[] = [];
const job = (index: number): JobView => ({
  id: `test-${index}`, workflowName: `任务 ${index}`, status: index < 10 ? "RUNNING" : "COMPLETED",
  createdAt: 2000000 - index, remoteTaskId: `remote-${index}`, generationStartedAt: Date.now() - 5000,
  generationCompletedAt: index < 10 ? undefined : Date.now(), outputType: "MP4",
  inputs: { workflowId: "test", profileVersion: 1, media: [], parameters: [] },
} as JobView);
let jobs = Array.from({ length: 1000 }, (_, i) => job(i));
let firstRowReads = 0;
Object.defineProperty(jobs[0], "workflowName", { enumerable: true, get() { firstRowReads++; return "任务 0"; } });
const renderJobs = async (suffix = "") => {
  await act(async () => root.render(<Jobs jobs={jobs} cancelling={new Set()} onCancel={id => calls.push(`cancel:${id}${suffix}`)}
    onRegenerate={item => calls.push(`regenerate:${item.id}${suffix}`)} onDelete={id => calls.push(`delete:${id}${suffix}`)} onReveal={() => {}} />));
  await act(async () => { await wait(60); });
};
try {
  await renderJobs();
  const mounted = document.querySelectorAll(".job-row").length;
  check(mounted > 5 && mounted < 35, `1000 tasks mount ${mounted} rows`);
  check(intervals.size === 1, "10 running tasks share one timer");
  const readsBeforeUpdate = firstRowReads;
  // A new event-handler closure must be used even when memo skips the row.
  jobs = jobs.map((item, index) => index === 3 ? { ...item, error: "changed" } : item);
  await renderJobs(":updated");
  check(firstRowReads === readsBeforeUpdate, "unchanged JobRow skips rendering when a sibling updates");
  await act(async () => { (document.querySelector(".job-row .danger-button") as HTMLButtonElement).click(); });
  check(calls.at(-1) === "cancel:test-0:updated", "cancel uses latest callback and correct task ID");
  await act(async () => { (document.querySelector(".job-row .secondary") as HTMLButtonElement).click(); });
  check(calls.at(-1) === "regenerate:test-0:updated", "regenerate uses correct task snapshot");
  const scroller = document.querySelector(".virtual-job-list")!;
  await act(async () => { scroller.scrollTop = scroller.scrollHeight; scroller.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await act(async () => { await wait(80); });
  check(document.body.textContent?.includes("任务 999"), "virtual scrolling reaches final task");
  check(document.querySelectorAll(".job-row").length < 35, "scrolling keeps DOM bounded");
  await act(async () => { (Array.from(document.querySelectorAll(".segmented button")).find(e => e.textContent === "失败") as HTMLButtonElement).click(); });
  check(document.querySelectorAll(".job-row").length === 0 && document.body.textContent?.includes("没有符合条件"), "empty filter clears virtual list");
  check(intervals.size === 0, "unmounted timers release shared interval");
  await act(async () => root.render(<React.StrictMode><TaskPreviewModal job={{ ...job(11), outputs: [{ type: "video", url: "data:video/mp4;base64,", label: "test" }] }} onClose={() => {}} onReveal={() => {}} /></React.StrictMode>));
  const video = document.querySelector("video");
  // Even if Chromium rejects the intentionally empty media, cleanup must run.
  if (video) {
    check(video.hasAttribute("src"), "StrictMode replay retains media source");
    await act(async () => root.render(<div />));
    check(!video.hasAttribute("src"), "video source released on preview close");
  }
  let change: (value: string) => void = () => {};
  let saves = 0;
  let saved = "";
  function Editor() {
    const [value, setValue] = useState(""); change = setValue;
    useDebouncedSave(() => { saves++; saved = value; }, [value]);
    return <input value={value} onChange={e => setValue(e.target.value)} />;
  }
  await act(async () => root.render(<Editor />));
  for (const value of ["a", "ab", "abc"]) {
    await act(async () => change(value));
    await act(async () => { await wait(25); });
  }
  check(saves === 0, "typing does not synchronously save each keystroke");
  await act(async () => { await wait(350); });
  check(saves === 1 && saved === "abc", "debounce saves latest input once");
  await act(async () => change("latest-before-close"));
  window.dispatchEvent(new Event("pagehide"));
  check(saved === "latest-before-close", "pagehide flushes pending draft");
  await act(async () => change("latest-before-unmount"));
  await act(async () => root.unmount());
  check(saved === "latest-before-unmount", "unmount flushes pending draft");
  document.getElementById("result")!.textContent = JSON.stringify({ passed: results }, null, 2);
  document.title = "PASS";
} catch (error) {
  document.getElementById("result")!.textContent = JSON.stringify({ passed: results, error: String(error) }, null, 2);
  document.title = "FAIL";
}
