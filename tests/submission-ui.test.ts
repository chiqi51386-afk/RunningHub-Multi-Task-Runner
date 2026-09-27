import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("single and batch have explicit button actions; form submission cannot create a job", () => {
  const source = readFileSync("frontend/src/CreateTask.tsx", "utf8");
  assert.ok(source.includes('onSubmit={e => { e.preventDefault(); }}'));
  assert.ok(source.includes('className="primary submit" type="button"'));
  assert.ok(source.includes('submitDrafts([draft], "single")'));
  assert.ok(source.includes('prepareProductionBatch(pending, props.workflows)'));
  assert.ok(source.includes('props.onCreate(prepared, "batch")'));
  const panel = readFileSync("frontend/src/ProductionBatchPanel.tsx", "utf8");
  assert.ok(panel.includes('className="primary batch-submit" type="button"'));
  assert.ok(panel.includes('onClick={onSubmit}'));
  assert.ok(source.includes('submitting === "single"'));
  assert.ok(source.includes('setSubmitting("batch")'));
  assert.ok(source.includes('const submissionLock = useRef(false)'));
  assert.ok(source.includes('submissionLock.current = true'));
  assert.ok(source.includes('submissionLock.current = false'));
  assert.ok(!source.includes('void submitDrafts([draft]);'));
});

test("submission source and requested count cross preload and IPC, committed IDs are audited", () => {
  const app = readFileSync("frontend/src/App.tsx", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const main = readFileSync("src/desktop/main.ts", "utf8");
  assert.ok(app.includes('expectedCount: drafts.length'));
  assert.ok(app.includes('created.length !== drafts.length'));
  assert.ok(preload.includes('ipcRenderer.invoke("jobs:createBatch", inputs, context)'));
  assert.ok(main.includes('context.expectedCount !== drafts.length'));
  assert.ok(main.includes('await audit("committed", created.map(job => job.id))'));
});
