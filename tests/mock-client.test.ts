import assert from "node:assert/strict";
import test from "node:test";
import { MockRunningHubClient, mockRunningHubError, RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("mock clients drive shared-queue scheduling without network access", async () => {
  const clients = new Map<string, MockRunningHubClient>();
  const delays = new Map([["key-fast", 1], ["key-mid", 4], ["key-slow", 10]]);
  const backend = new RunningHubBackend({
    databasePath: ":memory:", logger: new NullLogger(),
    clientFactory: apiKey => {
      const existing = clients.get(apiKey);
      if (existing) return existing;
      const client = new MockRunningHubClient({
        stepDelayMs: delays.get(apiKey),
        query: [{ status: "RUNNING" }, { status: "SUCCESS", results: [{ text: "done" }] }],
      });
      clients.set(apiKey, client);
      return client;
    },
  });
  try {
    backend.accounts.add("Fast", "key-fast");
    backend.accounts.add("Mid", "key-mid");
    backend.accounts.add("Slow", "key-slow");
    const workflow = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    for (let index = 0; index < 18; index += 1) backend.jobs.create({ workflowId: workflow.id, parameters: { prompt: `job-${index}` } });
    await backend.start();
    await waitFor(() => backend.jobs.list().every(job => job.status === "COMPLETED"));
    assert.ok(clients.get("key-fast")!.calls.submit > clients.get("key-slow")!.calls.submit);
    assert.equal([...clients.values()].reduce((sum, client) => sum + client.calls.submit, 0), 18);
  } finally { await backend.close(); }
});

test("mock client exposes deterministic RunningHub error scenarios", async () => {
  const invalid = new MockRunningHubClient({ submit: mockRunningHubError({ code: 1007, message: "invalid parameter", phase: "submit" }) });
  await assert.rejects(() => invalid.runWorkflow("wf", []), error => {
    assert.equal((error as { detail?: { code?: string } }).detail?.code, "INVALID_PARAMETER");
    return true;
  });
  const failed = new MockRunningHubClient({ query: [{ status: "FAILED", errorCode: 805, errorMessage: "node failed" }] });
  await assert.rejects(() => failed.pollTask("task"));
});
