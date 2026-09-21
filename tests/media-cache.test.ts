import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("media cache reuses uploads per account and isolates different accounts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-media-cache-"));
  const image = path.join(dir, "same.png");
  await writeFile(image, new Uint8Array([1, 2, 3, 4]));
  let uploads = 0;
  let submits = 0;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.endsWith("/media/upload/binary")) return Response.json({ code: 0, data: { fileName: `cached-${++uploads}.png` } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: `task-${++submits}` } });
    if (url.endsWith("/query")) return Response.json({ status: "SUCCESS", results: [{ text: "ok" }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 100 },
  });
  try {
    const accountA = backend.accounts.add("A", "key-a");
    const workflow = backend.workflows.importApiJson({
      name: "Image", runningHubWorkflowId: "123456789012",
      workflow: { "10": { class_type: "LoadImage", inputs: { image: "default.png" }, _meta: { title: "Image 1" } } },
    });
    await backend.start();
    const first = backend.jobs.create({ workflowId: workflow.id, parameters: {}, media: [{ parameterId: "image", localPath: image }] });
    await waitFor(() => backend.jobs.get(first.id)?.status === "COMPLETED");
    const second = backend.jobs.create({ workflowId: workflow.id, parameters: {}, media: [{ parameterId: "image", localPath: image }] });
    await waitFor(() => backend.jobs.get(second.id)?.status === "COMPLETED");
    assert.equal(uploads, 1);

    backend.accounts.disable(accountA.id);
    const accountB = backend.accounts.add("B", "key-b");
    await backend.accounts.refresh(accountB.id);
    const third = backend.jobs.create({ workflowId: workflow.id, parameters: {}, media: [{ parameterId: "image", localPath: image }] });
    await waitFor(() => backend.jobs.get(third.id)?.status === "COMPLETED");
    assert.equal(uploads, 2);
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
