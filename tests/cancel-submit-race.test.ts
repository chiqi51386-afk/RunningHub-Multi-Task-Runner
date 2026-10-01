import assert from "node:assert/strict";
import test from "node:test";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlainTextSecretStore } from "../src/core/secretStore.js";

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
for (const outcome of ["cancelled", "denied", "network", "unknown", "rejected"] as const) {
  test(`cancel during submit preserves affinity and handles ${outcome}`, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let submitted = 0, cancelled = 0, polled = 0;
    const backend: RunningHubBackend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(),
      config: { pollIntervalMs: 5, pollJitterMs: 0 },
      fetch: async input => {
        const url = String(input);
        if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
        if (url.includes("/run/workflow/")) {
          submitted++;
          await gate;
          if (outcome === "unknown") throw new TypeError("socket reset");
          if (outcome === "rejected") return Response.json({ code: 605, msg: "Your balance is insufficient" });
          return Response.json({ code: 0, data: { taskId: "remote-audit" } });
        }
        if (url.endsWith("/task/openapi/cancel")) {
          cancelled++;
          assert.equal(backend.jobs.list()[0]!.remoteTaskId, "remote-audit");
          assert.ok(backend.accounts.list()[0]!.currentJobId);
          if (outcome === "network") throw new TypeError("offline");
          if (outcome === "denied") return Response.json({ code: "APIKEY_TASK_CANCEL_NOT_ALLOWED", msg: "APIKEY_TASK_CANCEL_NOT_ALLOWED" });
          return Response.json({ code: 0 });
        }
        if (url.endsWith("/query")) { polled++; return Response.json({ status: outcome === "cancelled" ? "CANCELLED" : "RUNNING" }); }
        throw new Error("Unexpected mock request");
      } });
    try {
      const account = backend.accounts.add("test", "synthetic-key");
      const wf = backend.workflows.importApiJson({ name: "test", runningHubWorkflowId: "123456789012",
        workflow: { "1": { class_type: "Text", inputs: { text: "" }, _meta: { title: "Prompt" } } } });
      const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "test" } });
      await backend.start();
      await waitFor(() => submitted === 1);
      await Promise.all([backend.scheduler.cancel(job.id), backend.scheduler.cancel(job.id)]);
      assert.equal(backend.jobs.get(job.id)!.status, "SUBMITTING");
      assert.ok(backend.jobs.get(job.id)!.cancelRequestedAt);
      assert.equal(backend.accounts.get(account.id)!.currentJobId, job.id);
      release();
      if (outcome === "cancelled" || outcome === "rejected") {
        await waitFor(() => backend.jobs.get(job.id)!.status === "CANCELLED");
        assert.equal(backend.accounts.get(account.id)!.currentJobId, undefined);
        assert.equal(backend.jobs.get(job.id)!.cancelRequestedAt, undefined);
      } else if (outcome === "unknown") {
        await waitFor(() => backend.jobs.get(job.id)!.status === "SUBMIT_UNKNOWN");
        assert.equal(backend.accounts.get(account.id)!.currentJobId, job.id);
        assert.equal(backend.jobs.get(job.id)!.remoteTaskId, undefined);
      } else {
        await waitFor(() => polled > 0 && backend.jobs.get(job.id)!.lastError?.code === "CANCEL_FAILED");
        assert.equal(backend.jobs.get(job.id)!.remoteTaskId, "remote-audit");
        assert.equal(backend.jobs.get(job.id)!.cancelRequestedAt, undefined);
        assert.equal(backend.accounts.get(account.id)!.currentJobId, job.id);
      }
      assert.equal(submitted, 1);
      if (outcome === "cancelled") assert.equal(cancelled, 1);
    } finally { release(); await backend.close(); }
  });
}

test("restart keeps unknown submission occupied, even if local media has disappeared", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const account = backend.accounts.add("test", "synthetic-key");
    const wf = backend.workflows.importApiJson({ name: "test", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "LoadImage", inputs: { image: "" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {},
      media: [{ parameterId: "image", localPath: "Z:/missing.png" }] });
    backend.database.updateAccount(account.id, { state: "BUSY", currentJobId: job.id });
    backend.database.updateJob(job.id, { accountId: account.id, status: "SUBMITTING", cancelRequestedAt: 123 });
    await backend.start();
    assert.equal(backend.jobs.get(job.id)!.status, "SUBMIT_UNKNOWN");
    assert.equal(backend.jobs.get(job.id)!.cancelRequestedAt, 123);
    assert.equal(backend.accounts.get(account.id)!.currentJobId, job.id);
  } finally { await backend.close(); }
});

test("persisted cancellation resumes after reopening the database without resubmission", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rh-cancel-recovery-"));
  const options = { databasePath: path.join(dir, "test.sqlite"), secretStore: new PlainTextSecretStore(), logger: new NullLogger() };
  let backend = new RunningHubBackend(options);
  let jobId = "", accountId = "", cancels = 0;
  try {
    const account = backend.accounts.add("test", "synthetic-key"); accountId = account.id;
    const wf = backend.workflows.importApiJson({ name: "test", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "" }, _meta: { title: "Prompt" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "test" } }); jobId = job.id;
    backend.database.updateAccount(account.id, { state: "BUSY", currentJobId: job.id });
    backend.database.updateJob(job.id, { accountId: account.id, status: "REMOTE_QUEUED", remoteTaskId: "saved-id", cancelRequestedAt: 123 });
    await backend.close();
    backend = new RunningHubBackend({ ...options, fetch: async input => {
      const url = String(input);
      if (url.endsWith("/task/openapi/cancel")) { cancels++; return Response.json({ code: 0 }); }
      if (url.endsWith("/query")) return Response.json({ status: "CANCELLED" });
      if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
      throw new Error("Must not resubmit");
    } });
    assert.equal(backend.jobs.get(jobId)!.cancelRequestedAt, 123);
    await backend.start();
    await waitFor(() => backend.jobs.get(jobId)!.status === "CANCELLED");
    assert.equal(backend.jobs.get(jobId)!.remoteTaskId, "saved-id");
    assert.equal(backend.accounts.get(accountId)!.currentJobId, undefined);
    assert.equal(cancels, 1);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

test("cancellation during upload never reaches remote task creation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rh-upload-cancel-"));
  const file = path.join(dir, "test.png");
  await writeFile(file, "synthetic");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploads = 0, submits = 0;
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(), fetch: async input => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
    if (url.endsWith("/media/upload/binary")) { uploads++; await gate; return Response.json({ code: 0, data: { fileName: "uploaded/test.png" } }); }
    if (url.includes("/run/workflow/")) { submits++; throw new Error("Must not submit"); }
    throw new Error("Unexpected URL");
  } });
  try {
    const account = backend.accounts.add("test", "synthetic");
    const wf = backend.workflows.importApiJson({ name: "test", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "LoadImage", inputs: { image: "" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {}, media: [{ parameterId: "image", localPath: file }] });
    await backend.start(); await waitFor(() => uploads === 1);
    await backend.scheduler.cancel(job.id); release();
    await backend.stop();
    assert.equal(submits, 0);
    assert.equal(backend.jobs.get(job.id)!.status, "CANCELLED");
    assert.equal(backend.accounts.get(account.id)!.currentJobId, undefined);
  } finally { release(); await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
