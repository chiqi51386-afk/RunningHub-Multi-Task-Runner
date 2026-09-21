import assert from "node:assert/strict";
import test from "node:test";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";

test("recovery blocks a pending job whose local media disappeared", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const workflow = backend.workflows.importApiJson({
      name: "Image", runningHubWorkflowId: "123456789012",
      workflow: { "10": { class_type: "LoadImage", inputs: { image: "default.png" }, _meta: { title: "Image" } } },
    });
    const job = backend.jobs.create({
      workflowId: workflow.id, parameters: {},
      media: [{ parameterId: "image", localPath: "Z:\\definitely-missing\\input.png" }],
    });
    await backend.start();
    const recovered = backend.jobs.get(job.id)!;
    assert.equal(recovered.status, "FAILED");
    assert.equal(recovered.lastError?.code, "MEDIA_INVALID");
    assert.equal(recovered.lastError?.phase, "recovery");
  } finally { await backend.close(); }
});

test("recovery blocks an invalid persisted profile snapshot", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const workflow = backend.workflows.importApiJson({
      name: "Text", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "hello" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: workflow.id, parameters: { prompt: "hello" } });
    backend.database.raw.prepare("UPDATE jobs SET profile_snapshot_json = ? WHERE id = ?").run("{}", job.id);
    await backend.start();
    assert.equal(backend.jobs.get(job.id)?.status, "FAILED");
    assert.equal(backend.jobs.get(job.id)?.lastError?.code, "WORKFLOW_VALIDATION");
  } finally { await backend.close(); }
});
