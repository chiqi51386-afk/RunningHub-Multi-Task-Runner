import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunningHubBackend } from "../src/core/index.js";
import { InMemorySecretStore } from "../src/core/secretStore.js";

test("submission record survives reopening without inventing records for old jobs", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "rh-submission-test-"));
  const options = { databasePath: path.join(directory, "test.sqlite"), secretStore: new InMemorySecretStore() };
  let backend = new RunningHubBackend(options);
  try {
    const workflow = backend.workflows.importApiJson({ name: "test", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "" } } } });
    const job = backend.jobs.create({ workflowId: workflow.id, parameters: {} });
    const old = backend.jobs.create({ workflowId: workflow.id, parameters: {} });
    const submission = { recordedAt: 123, workflowId: "123456789012", nodeInfoList: [{ nodeId: "1", fieldName: "text", fieldValue: "actual request" }], instanceType: "plus" as const };
    backend.database.updateJob(job.id, { submission });
    submission.nodeInfoList[0]!.fieldValue = "later change";
    await backend.close();
    backend = new RunningHubBackend(options);
    assert.equal(backend.jobs.get(job.id)!.submission!.nodeInfoList[0]!.fieldValue, "actual request");
    assert.equal(backend.jobs.get(old.id)!.submission, undefined);
  } finally {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
