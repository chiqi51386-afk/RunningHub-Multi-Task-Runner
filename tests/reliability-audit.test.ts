import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNodeInfoList, createPortableWorkflowPackage, createWorkflowProfile, materializePortableProfile,
  parseApiWorkflow, recognizeParameters, RunningHubBackend, RunningHubClient,
} from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const resolutionOptions = [
  "1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)",
  "4:3 (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)",
];

function resolutionProfile(rawDefault: string) {
  const parsed = parseApiWorkflow({
    "252": { class_type: "ResolutionSelector", inputs: { aspect_ratio: rawDefault, megapixels: 0.5, multiple: 32 } },
  });
  return createWorkflowProfile({ workflowId: "wf", name: "Resolution", version: 1, parameters: parsed.parameters, now: 1 });
}

test("ResolutionSelector always submits the Runner default even when raw is 16:9 or already 9:16", () => {
  for (const rawDefault of ["16:9 (Widescreen)", "9:16 (Portrait Widescreen)"]) {
    const profile = resolutionProfile(rawDefault);
    const aspect = profile.parameters.find(item => item.fieldName === "aspect_ratio")!;
    assert.equal(aspect.defaultValue, "9:16 (Portrait Widescreen)");
    assert.equal(aspect.submitDefault, true);
    assert.deepEqual(buildNodeInfoList(profile, { [aspect.id]: aspect.defaultValue }).find(item => item.fieldName === "aspect_ratio"), {
      nodeId: "252", fieldName: "aspect_ratio", fieldValue: "9:16 (Portrait Widescreen)",
    });
  }
});

test("every ResolutionSelector ratio, including switching back to 9:16, is submitted exactly", () => {
  const profile = resolutionProfile("16:9 (Widescreen)");
  const aspect = profile.parameters.find(item => item.fieldName === "aspect_ratio")!;
  assert.deepEqual(aspect.options, resolutionOptions);
  for (const value of resolutionOptions) {
    const list = buildNodeInfoList(profile, { [aspect.id]: value });
    assert.equal(list.find(item => item.fieldName === "aspect_ratio")?.fieldValue, value);
  }
  const values = { [aspect.id]: "9:16 (Portrait Widescreen)" };
  values[aspect.id] = "16:9 (Widescreen)";
  values[aspect.id] = "9:16 (Portrait Widescreen)";
  assert.equal(buildNodeInfoList(profile, values)[0]?.fieldValue, "9:16 (Portrait Widescreen)");
});

test("portable workflow round trip preserves the enforced aspect-ratio schema", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const workflow = backend.workflows.importApiJson({
      name: "Resolution", runningHubWorkflowId: "123456789012",
      workflow: { "252": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.5, multiple: 32 } } },
    });
    const portable = createPortableWorkflowPackage(workflow);
    const materialized = materializePortableProfile(portable, "imported", 2);
    const aspect = materialized.parameters.find(item => item.fieldName === "aspect_ratio")!;
    assert.equal(aspect.defaultValue, "9:16 (Portrait Widescreen)");
    assert.equal(aspect.submitDefault, true);
    assert.deepEqual(aspect.options, resolutionOptions);
  } finally { await backend.close(); }
});

test("saved H3 profiles missing a ResolutionSelector widget are repaired when listed", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const workflow = backend.workflows.importApiJson({
      name: "Old H3", runningHubWorkflowId: "123456789013",
      workflow: { "252": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.5, multiple: 32 } } },
    });
    const oldProfile = structuredClone(workflow.profile);
    oldProfile.parameters = oldProfile.parameters.filter(item => item.fieldName !== "multiple");
    oldProfile.genericParameters = oldProfile.genericParameters.filter(item => item.fieldName !== "multiple");
    backend.workflows.updateProfile(workflow.id, oldProfile);

    const repaired = backend.workflows.list().find(item => item.id === workflow.id)!;
    const multiple = repaired.profile.parameters.find(item => item.fieldName === "multiple");
    assert.equal(multiple?.semanticType, "resolution_multiple");
    assert.equal(multiple?.defaultValue, 32);
    assert.equal(multiple?.visible, true);
  } finally { await backend.close(); }
});

test("805 without status is a terminal workflow failure", async () => {
  const client = new RunningHubClient("key", {
    apiHost: "https://example.test", pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 100,
    requestTimeoutMs: 100, uploadTimeoutMs: 100, downloadTimeoutMs: 100, maxQueryFailures: 1,
    accountFreshnessMs: 100, maxDownloads: 1, outputDir: ".", mediaCacheTtlMs: 100,
    retryDelayMs: 5, accountCooldownMs: 5,
  }, async () => Response.json({
    errorCode: "805", errorMessage: "工作流运行失败",
    failedReason: { node_id: "7", node_name: "AudioCrop", exception_message: "Required input is missing: audio" },
  }));
  await assert.rejects(() => client.pollTask("task-805"), (error: any) => {
    assert.equal(error.detail.code, "TASK_FAILED");
    assert.equal(error.detail.retryable, false);
    assert.equal(error.detail.nodeId, "7");
    return true;
  });
});

test("remote CANCELLED spelling is terminal and does not poll until timeout", async () => {
  let queries = 0;
  const client = new RunningHubClient("key", {
    apiHost: "https://example.test", pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 1_000,
    requestTimeoutMs: 100, uploadTimeoutMs: 100, downloadTimeoutMs: 100, maxQueryFailures: 1,
    accountFreshnessMs: 100, maxDownloads: 1, outputDir: ".", mediaCacheTtlMs: 100,
    retryDelayMs: 5, accountCooldownMs: 5,
  }, async () => { queries += 1; return Response.json({ status: "CANCELLED" }); });
  await assert.rejects(() => client.pollTask("cancelled-task"), (error: any) => {
    assert.equal(error.detail.code, "CANCEL_FAILED");
    assert.equal(error.detail.retryable, false);
    return true;
  });
  assert.equal(queries, 1);
});

test("download failure retries automatically and completes without resubmitting", async () => {
  let submits = 0;
  let downloads = 0;
  const fetchMock: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) { submits += 1; return Response.json({ code: 0, data: { taskId: "download-retry" } }); }
    if (url.endsWith("/query")) return Response.json({ status: "SUCCESS", results: [{ url: "https://files/retry.mp4", outputType: "mp4" }] });
    if (url === "https://files/retry.mp4") {
      downloads += 1;
      if (downloads === 1) throw new TypeError("fetch failed");
      return new Response(new Uint8Array([1, 2, 3]));
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({ databasePath: ":memory:", fetch: fetchMock, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, retryDelayMs: 5, maxPollingMs: 100 } });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {} });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.equal(downloads, 2);
    assert.equal(submits, 1);
  } finally { await backend.close(); }
});

test("missing local media fails the job without poisoning the account", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(),
    fetch: async input => String(input).endsWith("/accountStatus")
      ? Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } })
      : Promise.reject(new Error(`Unexpected URL ${String(input)}`)),
    config: { pollIntervalMs: 1 } });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({ name: "Image", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "LoadImage", inputs: { image: "x.png" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {}, media: [{ parameterId: "image", localPath: path.join(os.tmpdir(), "definitely-missing-rh.png") }] });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "FAILED");
    assert.equal(backend.jobs.get(job.id)?.lastError?.code, "MEDIA_INVALID");
    assert.equal(backend.accounts.get(account.id)?.state, "IDLE");
  } finally { await backend.close(); }
});

test("busy accounts reject disable and rekey; re-enable refreshes automatically", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(),
    fetch: async input => String(input).endsWith("/accountStatus")
      ? Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } })
      : Promise.reject(new Error(`Unexpected URL ${String(input)}`)) });
  try {
    const account = backend.accounts.add("A", "key-a");
    await backend.accounts.refresh(account.id);
    backend.database.updateAccount(account.id, { currentJobId: "active", state: "BUSY" });
    assert.throws(() => backend.accounts.disable(account.id), /正在执行任务/);
    assert.throws(() => backend.accounts.updateKey(account.id, "key-b"), /正在执行任务/);
    backend.database.updateAccount(account.id, { currentJobId: null, state: "IDLE" });
    backend.accounts.disable(account.id);
    backend.accounts.enable(account.id);
    await waitFor(() => backend.accounts.get(account.id)?.state === "IDLE");
  } finally { await backend.close(); }
});

test("media cache expires by TTL and rekey removes entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-audit-cache-"));
  const file = path.join(dir, "image.png");
  await writeFile(file, new Uint8Array([1, 2, 3]));
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const account = backend.accounts.add("A", "key-a");
    backend.database.saveMediaUploadCache({ accountId: account.id, fileHash: "hash", runningHubValue: "old.png", originalPath: file });
    assert.ok(backend.database.getMediaUploadCache(account.id, "hash", 10_000));
    assert.equal(backend.database.getMediaUploadCache(account.id, "hash", 0), undefined);
    backend.accounts.updateKey(account.id, "key-b");
    assert.equal(backend.database.getMediaUploadCache(account.id, "hash", 10_000), undefined);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ordinary profile save rejects invalid node and field mappings", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  try {
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const brokenNode = structuredClone(wf.profile);
    brokenNode.parameters[0]!.nodeId = "999999";
    assert.throws(() => backend.workflows.updateProfile(wf.id, brokenNode), /失效参数映射/);
    const brokenField = structuredClone(wf.profile);
    brokenField.parameters[0]!.fieldName = "fake_input";
    assert.throws(() => backend.workflows.updateProfile(wf.id, brokenField), /失效参数映射/);
    assert.throws(() => backend.workflows.updateProfile(wf.id, wf.profile, { runningHubWorkflowId: "999999999999" }), /不能.*改绑/);
  } finally { await backend.close(); }
});

test("cooldown expiry refreshes the account and automatically resumes the queue", async () => {
  let accountChecks = 0;
  const backend = new RunningHubBackend({
    databasePath: ":memory:", logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, accountCooldownMs: 20 },
    clientFactory: () => ({
      async accountStatus() { accountChecks += 1; return { valid: true, coins: "100", currentTaskCount: 0, raw: {} }; },
      async uploadMedia() { throw new Error("not used"); },
      async runWorkflow() { return "cooldown-task"; },
      async queryTask() { return { status: "SUCCESS" }; },
      async pollTask(taskId, options) {
        await options?.onStatus?.("RUNNING", { status: "RUNNING" });
        return { taskId, files: [], texts: ["done"], raw: { status: "SUCCESS" } };
      },
      async cancelTask() {},
    }),
  });
  try {
    const account = backend.accounts.add("A", "key-a");
    backend.database.updateAccount(account.id, { state: "COOLDOWN", cooldownUntil: Date.now() + 30 });
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {} });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.ok(accountChecks >= 1);
    assert.equal(backend.accounts.get(account.id)?.state, "IDLE");
  } finally { await backend.close(); }
});

test("partial uploads from account A are never reused after reassignment to account B", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-account-media-"));
  const files = await Promise.all(["one.png", "two.png", "three.png"].map(async name => {
    const file = path.join(dir, name); await writeFile(file, name); return file;
  }));
  let aUploads = 0;
  const submitted: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const key = auth.replace(/^Bearer\s+/, "");
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
    if (url.endsWith("/media/upload/binary")) {
      if (key === "key-a") {
        aUploads += 1;
        if (aUploads > 1) throw new TypeError("fetch failed");
        return Response.json({ code: 0, data: { fileName: "a-one.png" } });
      }
      const index = submitted.length;
      return Response.json({ code: 0, data: { fileName: `b-${index}-${Date.now()}.png` } });
    }
    if (url.includes("/run/workflow/")) {
      const body = JSON.parse(String(init.body)) as { nodeInfoList: typeof submitted };
      submitted.push(...body.nodeInfoList);
      return Response.json({ code: 0, data: { taskId: "media-owner-task" } });
    }
    if (url.endsWith("/query")) return Response.json({ status: "SUCCESS", results: [] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(), fetch: fetchMock,
    config: { pollIntervalMs: 1, pollJitterMs: 0, requestTimeoutMs: 20, uploadTimeoutMs: 20 } });
  try {
    backend.accounts.add("A", "key-a");
    const accountB = backend.accounts.add("B", "key-b");
    const wf = backend.workflows.importApiJson({ name: "Images", runningHubWorkflowId: "123456789012", workflow: {
      "1": { class_type: "LoadImage", inputs: { image: "one.png" } },
      "2": { class_type: "LoadImage", inputs: { image: "two.png" } },
      "3": { class_type: "LoadImage", inputs: { image: "three.png" } },
    } });
    const imageParameters = wf.profile.parameters.filter(item => item.valueType === "image");
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {}, media: imageParameters.map((item, index) => ({ parameterId: item.id, localPath: files[index]! })) });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED", 5_000);
    const completed = backend.jobs.get(job.id)!;
    assert.equal(completed.accountId, accountB.id);
    assert.equal(completed.media.every(item => item.uploadedAccountId === accountB.id), true);
    assert.equal(submitted.filter(item => item.fieldName === "image").length, 3);
    assert.equal(submitted.some(item => item.fieldValue === "a-one.png"), false);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

test("download recovery completes after its account has been deleted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-download-no-account-"));
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(), config: { outputDir: dir },
    fetch: async input => String(input) === "https://files/output.mp4"
      ? new Response(new Uint8Array([1, 2, 3]))
      : Promise.reject(new Error(`Unexpected URL ${String(input)}`)) });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {}, outputDir: dir });
    backend.jobs.recoverTransition(job.id, "DOWNLOAD_PENDING", { accountId: account.id, remoteTaskId: "done", outputs: {
      taskId: "done", files: [{ url: "https://files/output.mp4", type: "mp4" }], texts: [], raw: { status: "SUCCESS" },
    } });
    backend.accounts.remove(account.id);
    assert.equal(backend.jobs.get(job.id)?.accountId, undefined);
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.ok(backend.jobs.get(job.id)?.outputs?.files[0]?.localPath);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

test("recovery of download RETRY_WAIT downloads existing outputs without resubmitting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-download-recovery-"));
  let submits = 0;
  let downloads = 0;
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(),
    config: { outputDir: dir }, fetch: async input => {
      const url = String(input);
      if (url.includes("/run/workflow/")) { submits += 1; return Response.json({ code: 0, data: { taskId: "wrong" } }); }
      if (url === "https://files/recover.mp4") { downloads += 1; return new Response(new Uint8Array([4, 5, 6])); }
      throw new Error(`Unexpected URL ${url}`);
    } });
  try {
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {}, outputDir: dir });
    backend.jobs.recoverTransition(job.id, "RETRY_WAIT", { remoteTaskId: "already-successful", retryPhase: "download", retryAfter: Date.now() - 1,
      outputs: { taskId: "already-successful", files: [{ url: "https://files/recover.mp4", type: "mp4" }], texts: [], raw: { status: "SUCCESS" } } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.equal(submits, 0);
    assert.equal(downloads, 1);
    assert.equal(backend.jobs.get(job.id)?.remoteTaskId, "already-successful");
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

test("recovery converts an interrupted SUBMITTING state to SUBMIT_UNKNOWN without resending", async () => {
  let submits = 0;
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(),
    fetch: async input => { if (String(input).includes("/run/workflow/")) submits += 1; throw new Error(`Unexpected URL ${String(input)}`); } });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {} });
    backend.jobs.recoverTransition(job.id, "SUBMITTING", { accountId: account.id, submitStartedAt: Date.now() - 1_000 });
    backend.database.updateAccount(account.id, { state: "BUSY", currentJobId: job.id });
    await backend.start();
    assert.equal(backend.jobs.get(job.id)?.status, "SUBMIT_UNKNOWN");
    assert.equal(submits, 0);
    assert.equal(backend.accounts.get(account.id)?.state, "BUSY");
  } finally { await backend.close(); }
});

test("cancelling an active download aborts it, removes the part file, and stays CANCELLED", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-download-cancel-"));
  let aborted = false;
  const fetchMock: typeof fetch = async (_input, init = {}) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      init.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
    },
  }));
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(), fetch: fetchMock,
    config: { outputDir: dir, downloadTimeoutMs: 5_000 } });
  try {
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {}, outputDir: dir });
    backend.jobs.recoverTransition(job.id, "DOWNLOAD_PENDING", { remoteTaskId: "done", outputs: {
      taskId: "done", files: [{ url: "https://files/slow.mp4", type: "mp4" }], texts: [], raw: { status: "SUCCESS" },
    } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "DOWNLOADING");
    await backend.scheduler.cancel(job.id);
    await waitFor(() => aborted);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(backend.jobs.get(job.id)?.status, "CANCELLED");
    await assert.rejects(() => import("node:fs/promises").then(fs => fs.stat(path.join(dir, `job_${job.id}_01.mp4.part`))));
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

test("empty recognized choices fall back to text and complex values remain editable JSON", () => {
  const parsed = parseApiWorkflow({
    "1": { class_type: "CustomSampler", inputs: { sampler_name: "custom", tuple_value: ["not-a-node", 0], object_value: { mode: "x" } } },
  });
  const recognized = recognizeParameters(parsed.parameters);
  const sampler = recognized.find(item => item.fieldName === "sampler_name")!;
  assert.equal(sampler.semanticType, "sampler");
  assert.equal(sampler.valueType, "string");
  assert.equal(recognized.find(item => item.fieldName === "tuple_value")?.valueType, "json");
  assert.deepEqual(recognized.find(item => item.fieldName === "tuple_value")?.defaultValue, ["not-a-node", 0]);
  assert.equal(recognized.find(item => item.fieldName === "object_value")?.valueType, "json");
});

test("poll sleeps remove every external abort listener after normal resolution", async () => {
  let queries = 0;
  const client = new RunningHubClient("key", {
    apiHost: "https://example.test", pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 1_000,
    requestTimeoutMs: 100, uploadTimeoutMs: 100, downloadTimeoutMs: 100, maxQueryFailures: 1,
    accountFreshnessMs: 100, maxDownloads: 1, outputDir: ".", mediaCacheTtlMs: 100,
    retryDelayMs: 5, accountCooldownMs: 5,
  }, async input => {
    if (!String(input).endsWith("/query")) throw new Error(`Unexpected URL ${String(input)}`);
    queries += 1;
    return Response.json(queries < 8 ? { status: "RUNNING" } : { status: "SUCCESS", results: [] });
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;
  Object.defineProperty(signal, "addEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
    if (type === "abort") added += 1;
    return originalAdd(type, listener, options);
  } });
  Object.defineProperty(signal, "removeEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
    if (type === "abort") removed += 1;
    return originalRemove(type, listener, options);
  } });
  await client.pollTask("listener-task", { signal, intervalMs: 1 });
  assert.equal(added, removed);
  assert.ok(added >= 7);
});

test("confirmed queue-capacity submit error reassigns safely and never becomes SUBMIT_UNKNOWN", async () => {
  const submissions: string[] = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) {
      const key = String((init.headers as Record<string, string>).Authorization).replace(/^Bearer\s+/, "");
      submissions.push(key);
      if (key === "key-a") return Response.json({ code: 9001, message: "queue capacity is full" });
      return Response.json({ code: 0, data: { taskId: "capacity-reassigned" } });
    }
    if (url.endsWith("/query")) return Response.json({ status: "SUCCESS", results: [] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(), fetch: fetchMock,
    config: { pollIntervalMs: 1, pollJitterMs: 0 } });
  try {
    backend.accounts.add("A", "key-a");
    backend.accounts.add("B", "key-b");
    const wf = backend.workflows.importApiJson({ name: "W", runningHubWorkflowId: "123456789012", workflow: { "1": { class_type: "Text", inputs: { text: "x" } } } });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: {} });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.deepEqual(submissions, ["key-a", "key-b"]);
    assert.notEqual(backend.jobs.get(job.id)?.status, "SUBMIT_UNKNOWN");
  } finally { await backend.close(); }
});
