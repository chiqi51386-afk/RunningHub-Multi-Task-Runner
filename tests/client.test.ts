import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunningHubError, resolveConfig, RunningHubClient, maskSecrets } from "../src/core/index.js";

test("client follows official auth, upload, submit, query, and output contract", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let queryCount = 0;
  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/uc/openapi/accountStatus")) {
      return Response.json({ code: 0, data: { remainMoney: "12.5", remainCoins: "3", currentTaskCounts: 0, apiType: "personal" } });
    }
    if (url.endsWith("/media/upload/binary")) return Response.json({ code: 0, data: { download_url: "https://cdn/file.png" } });
    if (url.endsWith("/openapi/v2/run/workflow/123456789012")) return Response.json({ code: 0, data: { taskId: "task-1" } });
    if (url.endsWith("/openapi/v2/query")) {
      queryCount += 1;
      return Response.json(queryCount === 1
        ? { status: "RUNNING" }
        : { status: "SUCCESS", results: [{ url: "https://cdn/out.png", outputType: "png" }, { text: "done" }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const client = new RunningHubClient("secret-key", resolveConfig({ pollIntervalMs: 1, pollJitterMs: 0 }), mockFetch);
  const account = await client.accountStatus();
  assert.equal(account.balance, "12.5");
  const taskId = await client.runWorkflow("123456789012", [{ nodeId: "1", fieldName: "text", fieldValue: "hello" }]);
  assert.equal(taskId, "task-1");
  const result = await client.pollTask(taskId, { intervalMs: 1, maxPollingMs: 100 });
  assert.equal(result.files[0]?.url, "https://cdn/out.png");
  assert.deepEqual(result.texts, ["done"]);
  const queryCall = calls.find(call => call.url.endsWith("/query"));
  assert.equal((queryCall?.init.headers as Record<string, string>).Authorization, "Bearer secret-key");
  const submitCall = calls.find(call => call.url.endsWith("/run/workflow/123456789012"));
  assert.equal((submitCall?.init.headers as Record<string, string>).Authorization, "Bearer secret-key");
  assert.deepEqual(JSON.parse(String(submitCall?.init.body)), {
    nodeInfoList: [{ nodeId: "1", fieldName: "text", fieldValue: "hello" }],
  });
});

test("secret masking removes query, bearer, and authorization forms", () => {
  const masked = maskSecrets("apiKey=abc123 Authorization: Bearer token.xyz Bearer another-token");
  assert.equal(masked.includes("abc123"), false);
  assert.equal(masked.includes("token.xyz"), false);
  assert.equal(masked.includes("another-token"), false);
});

test("a missing RunningHub webapp is a definite workflow failure, not submit ambiguity", () => {
  const detail = classifyRunningHubError({ message: "webapp not exists", phase: "submit" });
  assert.equal(detail.code, "WORKFLOW_VALIDATION");
  assert.equal(detail.retryable, false);
});

test("node info mismatch is a definite workflow mapping failure", () => {
  const detail = classifyRunningHubError({
    code: "NODE_INFO_MISMATCH",
    message: "NODE_INFO_MISMATCH(nodeId=6, fieldName=audio, reason=field_not_found_in_node_inputs)",
    phase: "submit",
  });
  assert.equal(detail.code, "WORKFLOW_VALIDATION");
  assert.equal(detail.retryable, false);
});

test("client cancels a submitted task through the RunningHub cancel endpoint", async () => {
  let body: unknown;
  const mockFetch: typeof fetch = async (input, init = {}) => {
    assert.equal(String(input), "https://www.runninghub.ai/task/openapi/cancel");
    body = JSON.parse(String(init.body));
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-key");
    return Response.json({ code: 0, msg: "success", data: null });
  };
  const client = new RunningHubClient("secret-key", resolveConfig({ apiHost: "https://www.runninghub.ai" }), mockFetch);
  await client.cancelTask("task-live");
  assert.deepEqual(body, { apiKey: "secret-key", taskId: "task-live" });
});

test("remote FAILED is terminal immediately and preserves the failing node reason", async () => {
  let queryCalls = 0;
  const mockFetch: typeof fetch = async () => {
    queryCalls += 1;
    return Response.json({
      status: "FAILED",
      errorCode: "805",
      errorMessage: "工作流运行失败",
      failedReason: {
        node_id: "392",
        node_name: "RTXVideoSuperResolution",
        exception_message: "torch.AcceleratorError: CUDA error: out of memory",
      },
    });
  };
  const client = new RunningHubClient("secret-key", resolveConfig({
    pollIntervalMs: 1, pollJitterMs: 0, maxQueryFailures: 5,
  }), mockFetch);
  await assert.rejects(
    client.pollTask("failed-task", { intervalMs: 1, maxPollingMs: 100 }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const detail = (error as { detail?: { code?: string; retryable?: boolean; message?: string } }).detail;
      assert.equal(detail?.code, "TASK_FAILED");
      assert.equal(detail?.retryable, false);
      assert.match(detail?.message ?? "", /392.*RTXVideoSuperResolution.*显存不足/);
      return true;
    },
  );
  assert.equal(queryCalls, 1);
});
