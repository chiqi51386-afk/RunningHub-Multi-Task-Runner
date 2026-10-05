import assert from "node:assert/strict";
import test from "node:test";
import { CoreDatabase } from "../src/core/database.js";
import { BackendEvents } from "../src/core/events.js";
import { Jobs } from "../src/core/jobs/jobs.js";
import { InMemorySecretStore } from "../src/core/secretStore.js";
import { Workflows } from "../src/core/workflows/workflows.js";

test("production sequence survives database snapshots; resubmission receives a new group", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const events = new BackendEvents();
  const jobs = new Jobs(db, events);
  try {
    const wf = new Workflows(db, events).importApiJson({ name: "production", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "test" } } } });
    const inputs = [1, 2, 3].map(segmentIndex => ({workflowId: wf.id, taskName:'广告任务', parameters: {}, production: {groupId: 'client-group', segmentIndex}}));
    const first = jobs.createBatch(inputs), second = jobs.createBatch(inputs);
    assert.equal(new Set(first.map(job => job.profileSnapshot.production!.groupId)).size, 1);
    assert.deepEqual(first.map(job=>jobs.get(job.id)!.profileSnapshot.taskName), ['广告任务','广告任务','广告任务']);
    assert.notEqual(first[0]!.profileSnapshot.production!.groupId, second[0]!.profileSnapshot.production!.groupId);
    assert.deepEqual(first.map(job => jobs.get(job.id)!.profileSnapshot.production!.segmentIndex), [1, 2, 3]);
    assert.equal(new Set(first.map(job => job.profileSnapshot.downloadIdentity!.group)).size, 1);
    assert.notEqual(first[0]!.profileSnapshot.downloadIdentity!.group, second[0]!.profileSnapshot.downloadIdentity!.group);
    assert.equal(new Set([...first, ...second].map(job => job.profileSnapshot.downloadIdentity!.task)).size, 6);
    assert.throws(() => jobs.createBatch([inputs[0]!, inputs[0]!]), /段号重复/);
    assert.throws(() => jobs.createBatch([{...inputs[0]!, production: {groupId: 'bad', segmentIndex: 0}}]), /段落编号无效/);
    assert.equal(jobs.list().length, 6);
  } finally { db.close(); }
});

test("batch commits all four before publishing, rolls back a later failure", () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const events = new BackendEvents();
  const jobs = new Jobs(db, events);
  try {
    const wf = new Workflows(db, events).importApiJson({ name: "batch", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "test" } } } });
    const input = { workflowId: wf.id, parameters: {} };
    let updates = 0;
    events.on("job.updated", () => { updates++; assert.equal(jobs.list().length, 4); });
    assert.throws(() => jobs.createBatch([input, { ...input, workflowId: "missing" }, input]), /第 2 项/);
    assert.equal(jobs.list().length, 0);
    assert.equal(updates, 0);
    db.raw.exec("CREATE TRIGGER fail_second BEFORE INSERT ON jobs WHEN (SELECT count(*) FROM jobs) = 1 BEGIN SELECT RAISE(ABORT, 'test disk failure'); END");
    assert.throws(() => jobs.createBatch([input, input, input, input]), /第 2 项/);
    assert.equal(jobs.list().length, 0);
    assert.equal(updates, 0);
    db.raw.exec("DROP TRIGGER fail_second");
    const created = jobs.createBatch([input, input, input, input]);
    assert.equal(new Set(created.map(job => job.id)).size, 4);
    assert.equal(updates, 4);
    events.removeAllListeners("job.updated");
    events.on("job.updated", () => { throw new Error("UI disconnected"); });
    assert.equal(jobs.createBatch([input]).length, 1);
    assert.equal(jobs.list().length, 5);
  } finally { db.close(); }
});
