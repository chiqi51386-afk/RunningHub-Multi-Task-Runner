import assert from "node:assert/strict";
import test from "node:test";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("three accounts run ten FIFO jobs with one remote task per account", async () => {
  const active = new Map<string, number>();
  const maxActive = new Map<string, number>();
  const tasks = new Map<string, { key: string; remaining: number }>();
  const submitOrder: string[] = [];
  let taskCounter = 0;
  const initialDurations = new Map([["key-a", 10], ["key-b", 2], ["key-c", 8]]);

  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) {
      const apiKey = String((init.headers as Record<string, string>).Authorization).replace(/^Bearer\s+/, "");
      const count = (active.get(apiKey) ?? 0) + 1;
      active.set(apiKey, count);
      maxActive.set(apiKey, Math.max(maxActive.get(apiKey) ?? 0, count));
      submitOrder.push(apiKey);
      const taskId = `task-${++taskCounter}`;
      tasks.set(taskId, { key: apiKey, remaining: initialDurations.get(apiKey) ?? 2 });
      initialDurations.delete(apiKey);
      return Response.json({ code: 0, data: { taskId } });
    }
    if (url.endsWith("/query")) {
      const { taskId } = JSON.parse(String(init.body)) as { taskId: string };
      const task = tasks.get(taskId)!;
      task.remaining -= 1;
      if (task.remaining > 0) return Response.json({ status: "RUNNING" });
      active.set(task.key, (active.get(task.key) ?? 1) - 1);
      return Response.json({ status: "SUCCESS", results: [{ url: `https://files/${taskId}.png`, outputType: "png" }] });
    }
    if (url.startsWith("https://files/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    throw new Error(`Unexpected URL ${url}`);
  };

  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 1_000, outputDir: "work/test-downloads" },
  });
  try {
    backend.accounts.add("A", "key-a");
    backend.accounts.add("B", "key-b");
    backend.accounts.add("C", "key-c");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    for (let index = 0; index < 10; index += 1) backend.jobs.create({ workflowId: wf.id, parameters: { prompt: `job-${index + 1}` } });
    await backend.start();
    await waitFor(() => backend.jobs.list().every(job => job.status === "COMPLETED"));
    assert.deepEqual([...maxActive.values()], [1, 1, 1]);
    assert.equal(submitOrder[0], "key-a");
    assert.equal(submitOrder[1], "key-b");
    assert.equal(submitOrder[2], "key-c");
    assert.equal(submitOrder[3], "key-b");
  } finally { await backend.close(); }
});

test("submit transport ambiguity becomes SUBMIT_UNKNOWN and is never resubmitted", async () => {
  let submitCalls = 0;
  const mockFetch: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) { submitCalls += 1; throw new TypeError("socket reset"); }
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({ databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(), config: { pollIntervalMs: 1 } });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "x" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "SUBMIT_UNKNOWN");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(submitCalls, 1);
    assert.equal(backend.accounts.list()[0]?.state, "BUSY");
  } finally { await backend.close(); }
});

test("account error 605 disables the account and requeues the job to another account", async () => {
  const submits: string[] = [];
  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) {
      const apiKey = String((init.headers as Record<string, string>).Authorization).replace(/^Bearer\s+/, "");
      submits.push(apiKey);
      if (apiKey === "key-a") return Response.json({ code: 605, msg: "余额不足" });
      return Response.json({ code: 0, data: { taskId: "task-b" } });
    }
    if (url.endsWith("/query")) return Response.json({ status: "SUCCESS", results: [{ text: "ok" }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 100 },
  });
  try {
    backend.accounts.add("A", "key-a");
    backend.accounts.add("B", "key-b");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "x" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.deepEqual(submits, ["key-a", "key-b"]);
    const accountA = backend.accounts.list().find(account => account.label === "A")!;
    assert.equal(accountA.state, "NO_BALANCE");
    assert.equal(accountA.autoDisabled, true);
  } finally { await backend.close(); }
});

test("parameter error 1007 fails the job without poisoning the account", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 1007, msg: "invalid parameter" });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({ databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger() });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "x" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "FAILED");
    assert.equal(backend.jobs.get(job.id)?.lastError?.code, "INVALID_PARAMETER");
    assert.equal(backend.accounts.list()[0]?.state, "IDLE");
    assert.equal(backend.accounts.list()[0]?.autoDisabled, false);
  } finally { await backend.close(); }
});

test("recovery resumes an existing taskId and never submits again", async () => {
  let submitCalls = 0;
  let queryCalls = 0;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) { submitCalls += 1; return Response.json({ code: 0, data: { taskId: "wrong" } }); }
    if (url.endsWith("/query")) { queryCalls += 1; return Response.json({ status: "SUCCESS", results: [{ text: "recovered" }] }); }
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 100 },
  });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "x" } });
    backend.database.updateJob(job.id, { status: "RUNNING", accountId: account.id, remoteTaskId: "existing-task" });
    backend.database.updateAccount(account.id, { state: "BUSY", currentJobId: job.id });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.equal(submitCalls, 0);
    assert.ok(queryCalls >= 1);
    assert.equal(backend.jobs.get(job.id)?.remoteTaskId, "existing-task");
  } finally { await backend.close(); }
});

test("graceful stop preserves a running task for recovery", async () => {
  let returnSuccess = false;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "task-live" } });
    if (url.endsWith("/query")) return Response.json(returnSuccess
      ? { status: "SUCCESS", results: [{ text: "done" }] }
      : { status: "RUNNING" });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 10, pollJitterMs: 0, maxPollingMs: 10_000 },
  });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "x" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "RUNNING");
    await backend.stop();
    assert.equal(backend.jobs.get(job.id)?.status, "RUNNING");
    assert.equal(backend.jobs.get(job.id)?.remoteTaskId, "task-live");
    returnSuccess = true;
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
  } finally { await backend.close(); }
});

test("user cancellation stops the remote RunningHub task before releasing the account", async () => {
  let cancelBody: Record<string, unknown> | undefined;
  let cancelAccepted = false;
  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "task-to-cancel" } });
    if (url.endsWith("/query")) return Response.json({ status: cancelAccepted ? "CANCEL" : "RUNNING" });
    if (url.endsWith("/task/openapi/cancel")) {
      cancelBody = JSON.parse(String(init.body));
      cancelAccepted = true;
      return Response.json({ code: 0, msg: "success", data: null });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 10, pollJitterMs: 0, maxPollingMs: 10_000 },
  });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "changed" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "RUNNING");
    const cancelled = await backend.scheduler.cancel(job.id);
    assert.equal(cancelled.status, "CANCELLED");
    assert.deepEqual(cancelBody, { apiKey: "key-a", taskId: "task-to-cancel" });
    assert.equal(backend.accounts.get(account.id)?.state, "IDLE");
    assert.equal(backend.accounts.get(account.id)?.currentJobId, undefined);
  } finally { await backend.close(); }
});

test("late cancel response cannot overwrite a successful remote result", async () => {
  let queryCalls = 0;
  let releaseCancel: (() => void) | undefined;
  const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  const mockFetch: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "task-race" } });
    if (url.endsWith("/query")) {
      queryCalls += 1;
      return Response.json(queryCalls === 1
        ? { status: "RUNNING" }
        : { status: "SUCCESS", results: [{ url: "https://files/task-race.mp4", outputType: "mp4", nodeId: "214" }] });
    }
    if (url.endsWith("/task/openapi/cancel")) {
      await cancelGate;
      return Response.json({ code: 0, msg: "success", data: null });
    }
    if (url === "https://files/task-race.mp4") return new Response("video");
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 5, pollJitterMs: 0, maxPollingMs: 10_000 },
  });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "changed" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "RUNNING");
    const cancelling = backend.scheduler.cancel(job.id);
    await waitFor(() => queryCalls >= 2);
    releaseCancel?.();
    const reconciled = await cancelling;
    assert.notEqual(reconciled.status, "CANCELLED");
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.equal(backend.jobs.get(job.id)?.outputs?.files[0]?.nodeId, "214");
  } finally { await backend.close(); }
});

test("manual stop during query retry recovers remote SUCCESS instead of marking the job cancelled", async () => {
  let queryCalls = 0;
  const mockFetch: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "task-retry-success" } });
    if (url.endsWith("/query")) {
      queryCalls += 1;
      if (queryCalls <= 3) return Response.json({}, { status: 503 });
      return Response.json({
        status: "SUCCESS",
        results: [{ url: "https://files/task-retry-success.mp4", outputType: "mp4", nodeId: "214" }],
      });
    }
    if (url.endsWith("/task/openapi/cancel")) return Response.json({ code: 0, msg: "success", data: null });
    if (url === "https://files/task-retry-success.mp4") return new Response("video");
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, maxPollingMs: 10_000, maxQueryFailures: 1 },
  });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "changed" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "RETRY_WAIT");
    assert.match(backend.jobs.get(job.id)?.lastError?.message ?? "", /自动重试/);
    const reconciled = await backend.scheduler.cancel(job.id);
    assert.notEqual(reconciled.status, "CANCELLED");
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.equal(backend.jobs.get(job.id)?.outputs?.files[0]?.nodeId, "214");
  } finally { await backend.close(); }
});

test("cancel denial reconciles an already-failed remote task and releases the account", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "task-already-failed" } });
    if (url.endsWith("/task/openapi/cancel")) {
      return Response.json({ code: "APIKEY_TASK_CANCEL_NOT_ALLOWED", msg: "APIKEY_TASK_CANCEL_NOT_ALLOWED" });
    }
    if (url.endsWith("/query")) {
      return Response.json({
        status: "FAILED", errorCode: "805", errorMessage: "工作流运行失败",
        failedReason: { node_id: "392", node_name: "RTXVideoSuperResolution", exception_message: "CUDA error: out of memory" },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 10_000, pollJitterMs: 0, maxPollingMs: 20_000 },
  });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "changed" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "REMOTE_QUEUED");
    const reconciled = await backend.scheduler.cancel(job.id);
    assert.equal(reconciled.status, "FAILED");
    assert.equal(reconciled.lastError?.code, "TASK_FAILED");
    assert.match(reconciled.lastError?.message ?? "", /392.*显存不足/);
    assert.equal(backend.accounts.get(account.id)?.state, "IDLE");
    assert.equal(backend.accounts.get(account.id)?.currentJobId, undefined);
  } finally { await backend.close(); }
});

test("cancel treats remote 1004 as an already-stopped task instead of surfacing an IPC error", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "task-removed-after-cancel" } });
    if (url.endsWith("/task/openapi/cancel")) {
      return Response.json({ errorCode: "1004", errorMessage: "Task not found, please check the task ID" });
    }
    if (url.endsWith("/query")) return Response.json({ status: "RUNNING" });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 10_000, pollJitterMs: 0, maxPollingMs: 20_000 },
  });
  try {
    const account = backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "changed" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "REMOTE_QUEUED");
    const cancelled = await backend.scheduler.cancel(job.id);
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.lastError, undefined);
    assert.equal(backend.accounts.get(account.id)?.state, "IDLE");
    assert.equal(backend.accounts.get(account.id)?.currentJobId, undefined);
  } finally { await backend.close(); }
});

test("REMOTE_BUSY accounts are rechecked and newly-created jobs auto-schedule", async () => {
  let statusChecks = 0;
  let submitCalls = 0;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) {
      statusChecks += 1;
      return Response.json({ code: 0, data: { remainMoney: "100", currentTaskCounts: statusChecks === 1 ? 1 : 0 } });
    }
    if (url.includes("/run/workflow/")) { submitCalls += 1; return Response.json({ code: 0, data: { taskId: `task-${submitCalls}` } }); }
    if (url.endsWith("/query")) return Response.json({ status: "SUCCESS", results: [{ text: "ok" }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 1, pollJitterMs: 0, accountFreshnessMs: 10, maxPollingMs: 100 },
  });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Mock", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    await backend.start();
    assert.equal(backend.accounts.list()[0]?.state, "REMOTE_BUSY");
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "created-after-start" } });
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    assert.ok(statusChecks >= 2);
    assert.equal(submitCalls, 1);
  } finally { await backend.close(); }
});

test("REMOTE_BUSY accounts recover automatically even when the local queue is empty", async () => {
  let statusChecks = 0;
  const mockFetch: typeof fetch = async input => {
    if (String(input).endsWith("/accountStatus")) {
      statusChecks += 1;
      return Response.json({ code: 0, data: {
        remainCoins: "37",
        currentTaskCounts: statusChecks === 1 ? 1 : 0,
        apiType: "NORMAL",
      } });
    }
    throw new Error(`Unexpected URL ${String(input)}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { accountFreshnessMs: 10 },
  });
  try {
    backend.accounts.add("Remote", "remote-key");
    await backend.start();
    assert.equal(backend.accounts.list()[0]?.state, "REMOTE_BUSY");
    assert.equal(backend.accounts.list()[0]?.lastRemoteTaskCount, 1);
    await waitFor(() => backend.accounts.list()[0]?.state === "IDLE");
    assert.ok(statusChecks >= 2);
    assert.equal(backend.accounts.list()[0]?.lastRemoteTaskCount, 0);
  } finally { await backend.close(); }
});

test("zero remainCoins marks an account as insufficient even when remainMoney is positive", async () => {
  const mockFetch: typeof fetch = async input => {
    if (String(input).endsWith("/accountStatus")) {
      return Response.json({ code: 0, data: { remainMoney: "100", remainCoins: "0", currentTaskCounts: 0 } });
    }
    throw new Error(`Unexpected URL ${String(input)}`);
  };
  const backend = new RunningHubBackend({ databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger() });
  try {
    const account = backend.accounts.add("Empty", "empty-key");
    await backend.start();
    await waitFor(() => backend.accounts.get(account.id)?.state === "NO_BALANCE");
    assert.equal(backend.accounts.get(account.id)?.autoDisabled, true);
    assert.equal(backend.accounts.available().length, 0);
  } finally { await backend.close(); }
});

test("generation duration starts only when RunningHub first reports RUNNING", async () => {
  let queryCalls = 0;
  const mockFetch: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/accountStatus")) return Response.json({ code: 0, data: { remainCoins: "100", currentTaskCounts: 0 } });
    if (url.includes("/run/workflow/")) return Response.json({ code: 0, data: { taskId: "timed-task" } });
    if (url.endsWith("/query")) {
      queryCalls += 1;
      return Response.json(queryCalls === 1
        ? { status: "RUNNING" }
        : { status: "SUCCESS", results: [{ text: "done" }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const backend = new RunningHubBackend({
    databasePath: ":memory:", fetch: mockFetch, logger: new NullLogger(),
    config: { pollIntervalMs: 5, pollJitterMs: 0, maxPollingMs: 1_000 },
  });
  try {
    backend.accounts.add("A", "key-a");
    const wf = backend.workflows.importApiJson({
      name: "Timed", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "default" }, _meta: { title: "Prompt" } } },
    });
    const job = backend.jobs.create({ workflowId: wf.id, parameters: { prompt: "x" } });
    await backend.start();
    await waitFor(() => backend.jobs.get(job.id)?.status === "COMPLETED");
    const completed = backend.jobs.get(job.id)!;
    assert.ok(completed.generationStartedAt);
    assert.ok(completed.submitStartedAt);
    assert.ok(completed.generationStartedAt! >= completed.submitStartedAt!);
    assert.ok(completed.remoteCompletedAt! >= completed.generationStartedAt!);
  } finally { await backend.close(); }
});
