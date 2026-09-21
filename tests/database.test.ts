import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CoreDatabase } from "../src/core/database.js";
import { BackendEvents } from "../src/core/events.js";
import { Jobs } from "../src/core/jobs/jobs.js";
import { InMemorySecretStore } from "../src/core/secretStore.js";
import { Workflows } from "../src/core/workflows/workflows.js";

const workflow = {
  "1": { class_type: "Text", inputs: { text: "original" }, _meta: { title: "Prompt" } },
};

test("job freezes workflow profile and account/job claim is atomic", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const events = new BackendEvents();
  const workflows = new Workflows(db, events);
  const jobs = new Jobs(db, events);
  try {
    const wf = workflows.importApiJson({ name: "A", runningHubWorkflowId: "123456789012", workflow });
    const job = jobs.create({ workflowId: wf.id, parameters: { prompt: "snapshot" } });
    const changed = structuredClone(wf.profile);
    changed.parameters[0]!.fieldName = "other";
    workflows.updateProfile(wf.id, changed);
    assert.equal(jobs.get(job.id)?.profileSnapshot.parameters[0]?.fieldName, "text");

    const account = db.addAccount("A", "key-a");
    db.updateAccount(account.id, { state: "IDLE" });
    const claimed = db.claimNextJob(account.id, 10);
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.status, "ASSIGNED");
    assert.equal(db.getAccount(account.id)?.currentJobId, job.id);
    assert.equal(db.claimNextJob(account.id, 11), undefined);

    db.releaseAccount(account.id, "another-job", true);
    assert.equal(db.getAccount(account.id)?.currentJobId, job.id);
    db.releaseAccount(account.id, job.id, true);
    assert.equal(db.getAccount(account.id)?.currentJobId, undefined);
    db.releaseAccount(account.id, job.id, true);
    assert.equal(db.getAccount(account.id)?.state, "IDLE");
  } finally {
    db.close();
  }
});

test("illegal job state transitions are rejected", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const events = new BackendEvents();
  const workflows = new Workflows(db, events);
  const jobs = new Jobs(db, events);
  try {
    const wf = workflows.importApiJson({ name: "A", runningHubWorkflowId: "123456789012", workflow });
    const job = jobs.create({ workflowId: wf.id, parameters: {} });
    assert.throws(() => jobs.transition(job.id, "COMPLETED"), /Illegal job transition/);
  } finally { db.close(); }
});

test("removing a referenced workflow preserves job history and hides the workflow", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const events = new BackendEvents();
  const workflows = new Workflows(db, events);
  const jobs = new Jobs(db, events);
  try {
    const wf = workflows.importApiJson({ name: "History", runningHubWorkflowId: "123456789012", workflow });
    const job = jobs.create({ workflowId: wf.id, parameters: { prompt: "keep me" } });

    assert.equal(workflows.remove(wf.id), true);
    assert.equal(workflows.list().some(item => item.id === wf.id), false);
    assert.equal(jobs.get(job.id)?.workflowName, "History");
    assert.equal(jobs.get(job.id)?.parameters.prompt, "keep me");
  } finally { db.close(); }
});

test("removing an unused workflow deletes it", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const workflows = new Workflows(db, new BackendEvents());
  try {
    const wf = workflows.importApiJson({ name: "Unused", runningHubWorkflowId: "123456789012", workflow });
    assert.equal(workflows.remove(wf.id), true);
    assert.equal(workflows.get(wf.id), undefined);
  } finally { db.close(); }
});

test("terminal jobs can be deleted but active jobs are protected", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const events = new BackendEvents();
    const workflows = new Workflows(db, events);
    const jobs = new Jobs(db, events);
  try {
    const wf = workflows.importApiJson({ name: "Jobs", runningHubWorkflowId: "123456789012", workflow });
    const active = jobs.create({ workflowId: wf.id, parameters: {} });
    assert.throws(() => jobs.remove(active.id), /不能直接删除/);
    const account = db.addAccount("Delete", "delete-key");
    db.updateAccount(account.id, { state: "IDLE" });
    db.claimNextJob(account.id);
    db.updateJob(active.id, { status: "FAILED" });
    assert.equal(jobs.remove(active.id), true);
    assert.equal(jobs.get(active.id), undefined);
    assert.equal(db.getAccount(account.id)?.state, "IDLE");
    assert.equal(db.getAccount(account.id)?.currentJobId, undefined);
  } finally { db.close(); }
});

test("the same API JSON cannot be silently bound to a different remote workflow", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const workflows = new Workflows(db, new BackendEvents());
  try {
    workflows.importApiJson({ name: "Original", runningHubWorkflowId: "111111111111", workflow });
    assert.throws(
      () => workflows.importApiJson({ name: "Wrong binding", runningHubWorkflowId: "222222222222", workflow }),
      /请从目标 RunningHub 工作流重新导出 API JSON/,
    );
  } finally { db.close(); }
});

test("legacy node mismatch submit errors are repaired to failed and release the account", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "rh-node-mismatch-"));
  const filename = path.join(directory, "runner.sqlite");
  let jobId = "";
  let accountId = "";
  try {
    const first = new CoreDatabase(filename, new InMemorySecretStore());
    const events = new BackendEvents();
    const workflows = new Workflows(first, events);
    const jobs = new Jobs(first, events);
    const wf = workflows.importApiJson({ name: "Mismatch", runningHubWorkflowId: "123456789012", workflow });
    const job = jobs.create({ workflowId: wf.id, parameters: {} });
    const account = first.addAccount("A", "key-a");
    first.updateAccount(account.id, { state: "IDLE" });
    first.claimNextJob(account.id);
    first.updateJob(job.id, {
      status: "SUBMIT_UNKNOWN",
      lastError: {
        code: "SUBMIT_UNKNOWN", phase: "submit", retryable: false, accountRelated: false, safeToReassign: false,
        message: "NODE_INFO_MISMATCH(nodeId=6, fieldName=audio, reason=field_not_found_in_node_inputs)",
      },
    });
    jobId = job.id;
    accountId = account.id;
    first.close();

    const repaired = new CoreDatabase(filename, new InMemorySecretStore());
    assert.equal(repaired.getJob(jobId)?.status, "FAILED");
    assert.equal(repaired.getJob(jobId)?.lastError?.code, "WORKFLOW_VALIDATION");
    assert.equal(repaired.getAccount(accountId)?.state, "IDLE");
    assert.equal(repaired.getAccount(accountId)?.currentJobId, undefined);
    repaired.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("orphaned account claims are cleared when their task record no longer exists", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "rh-orphan-claim-"));
  const filename = path.join(directory, "runner.sqlite");
  let accountId = "";
  try {
    const first = new CoreDatabase(filename, new InMemorySecretStore());
    const events = new BackendEvents();
    const workflows = new Workflows(first, events);
    const jobs = new Jobs(first, events);
    const wf = workflows.importApiJson({ name: "Orphan", runningHubWorkflowId: "123456789012", workflow });
    const job = jobs.create({ workflowId: wf.id, parameters: {} });
    const account = first.addAccount("A", "orphan-key");
    first.updateAccount(account.id, { state: "IDLE" });
    first.claimNextJob(account.id);
    first.removeJob(job.id);
    accountId = account.id;
    first.close();

    const repaired = new CoreDatabase(filename, new InMemorySecretStore());
    assert.equal(repaired.getAccount(accountId)?.state, "IDLE");
    assert.equal(repaired.getAccount(accountId)?.currentJobId, undefined);
    repaired.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
