import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunningHubError, terminalTaskError, sanitizeErrorRaw } from "../src/core/runninghub/errors.js";
import { RunningHubClient } from "../src/core/runninghub/client.js";
import { resolveConfig } from "../src/core/config.js";

test("terminal and classified error details redact nested credentials", () => {
  const raw = { password: "synthetic-password", nested: { "x-goog-api-key": "synthetic-google", access_token: "synthetic-token" } };
  for (const detail of [terminalTaskError(raw), classifyRunningHubError({ phase: "query", raw })]) {
    assert.doesNotMatch(JSON.stringify(detail), /synthetic-password|synthetic-google|synthetic-token/);
  }
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.equal(sanitizeErrorRaw(circular), "[unserializable error detail]");
});

test("RunningHub errors redact exact key in arbitrary provider echoes and invalid JSON", async () => {
  const key = "synthetic-runninghub-key";
  for (const body of [JSON.stringify({ code: 433, message: `rejected ${key}`, arbitraryEcho: key }), `invalid ${key}`]) {
    const client = new RunningHubClient(key, resolveConfig(), async () => new Response(body));
    await assert.rejects(client.runWorkflow("123", []), error => {
      assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-runninghub-key/);
      return true;
    });
  }
});
