import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { maskSecrets } from "../src/core/runninghub/errors.js";

test("account diagnostic rejects redirects and redacts echoed keys without real account access", async () => {
  const fakeKey = "diagnostic-test-only-key";
  const writes: string[] = [];
  const logs: string[] = [];
  let request: RequestInit | undefined;
  let completion: Promise<unknown> | undefined;
  let closed = false;
  let quit = false;
  const imports: Record<string, unknown> = {
    "../dist/src/core/secureSecrets.js": { SystemSecretStore: class { decrypt() { return fakeKey; } } },
    "../dist/src/core/runninghub/errors.js": { maskSecrets },
  };
  // Run the actual maintenance script with every system/network capability mocked.
  const source = readFileSync("scripts/diagnose-account.cjs", "utf8")
    .replaceAll('import("', 'mockImport("');
  vm.runInNewContext(source, {
    mockImport: async (name: string) => {
      assert.ok(Object.hasOwn(imports, name));
      return imports[name];
    },
    require: (name: string) => {
      if (name === "node:path") return { join: (...parts: string[]) => parts.join("/"), dirname: () => "/mock/work" };
      if (name === "node:fs") return { mkdirSync() {}, writeFileSync: (_path: string, text: string) => writes.push(text) };
      if (name === "electron") return { safeStorage: {}, app: {
        whenReady: () => ({ then: (fn: () => Promise<unknown>) => { completion = fn(); return completion; } }),
        getPath: () => "/mock", quit: () => { quit = true; },
      } };
      if (name === "better-sqlite3") return class {
        prepare() { return { get: () => ({ id: "mock-account", label: "test", encrypted_key: "mock" }) }; }
        close() { closed = true; }
      };
      throw new Error(`Unexpected require: ${name}`);
    },
    fetch: async (_url: string, init: RequestInit) => {
      request = init;
      return { status: 200, text: async () => JSON.stringify({ unexpectedEcho: fakeKey, password: "test-password" }) };
    },
    process: { cwd: () => "/mock", exitCode: 0 },
    console: { log: (text: string) => logs.push(text) },
    AbortController, setTimeout, clearTimeout,
  });
  await completion;
  assert.equal(request?.redirect, "error");
  assert.equal(writes.length, 1);
  assert.deepEqual(logs, writes);
  assert.equal(writes[0]!.includes(fakeKey), false);
  assert.equal(writes[0]!.includes("test-password"), false);
  assert.equal(closed && quit, true);
});
