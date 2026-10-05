import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunningHubBackend } from "../src/core/index.js";
import { InMemorySecretStore } from "../src/core/secretStore.js";
import { syncBundledWorkflows } from "../src/core/workflows/bundled.js";

const bundles = readdirSync("bundled-workflows").filter(file => file.endsWith(".json"))
  .map(key => ({ key, value: JSON.parse(readFileSync(`bundled-workflows/${key}`, "utf8")) }));

test("reopen loads defaults only from application and preserves existing jobs", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "rh-bundle-reopen-"));
  const options = { databasePath: path.join(directory, "test.sqlite"), secretStore: new InMemorySecretStore() };
  let backend = new RunningHubBackend(options);
  try {
    const legacy = backend.workflows.importPortablePackage(bundles[0]!.value);
    const job = backend.jobs.create({ workflowId: legacy.id, parameters: {} });
    syncBundledWorkflows(backend.database, bundles);
    const version = backend.workflows.get(legacy.id)!.profileVersion;
    await backend.close();
    backend = new RunningHubBackend(options);
    assert.equal(backend.database.listWorkflows().length, 0);
    assert.deepEqual(backend.jobs.get(job.id)!.profileSnapshot, job.profileSnapshot);
    syncBundledWorkflows(backend.database, bundles);
    assert.equal(backend.workflows.get(legacy.id)!.profileVersion, version);
    assert.equal(backend.database.listWorkflows().length, bundles.length);
    assert.ok(backend.jobs.create({ workflowId: legacy.id, parameters: {} }));
    assert.deepEqual(backend.database.raw.pragma("foreign_key_check"), []);
    syncBundledWorkflows(backend.database, []);
    assert.equal(backend.database.listWorkflows().length, 0);
    assert.deepEqual(backend.jobs.get(job.id)!.profileSnapshot, job.profileSnapshot);
  } finally { await backend.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("bundles migrate old defaults, retain personal workflows and job snapshots, and are idempotent", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", secretStore: new InMemorySecretStore() });
  try {
    const old = bundles.map(bundle => backend.workflows.importPortablePackage(bundle.value));
    const personal = backend.workflows.importApiJson({ name: "个人", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "personal" } } } });
    const modified = { ...old[0]!, name: "旧默认", profileVersion: 100 };
    backend.database.saveWorkflow(modified);
    const job = backend.jobs.create({ workflowId: modified.id, parameters: {} });
    syncBundledWorkflows(backend.database, bundles);
    assert.equal(backend.database.listWorkflows().length, bundles.length + 1);
    assert.deepEqual(backend.database.getWorkflow(personal.id), personal);
    assert.notEqual(backend.database.getWorkflow(modified.id)!.profileVersion, 100);
    const installedVersion = backend.database.getWorkflow(modified.id)!.profileVersion;
    assert.equal((backend.database.raw.prepare("SELECT count(*) AS n FROM workflows").get() as { n: number }).n, 1);
    assert.deepEqual(backend.jobs.get(job.id)!.profileSnapshot, job.profileSnapshot);
    const records = backend.database.listWorkflows();
    syncBundledWorkflows(backend.database, bundles);
    assert.deepEqual(backend.database.listWorkflows(), records);
    assert.equal((backend.database.raw.prepare("SELECT count(*) AS n FROM bundled_workflow_backups").get() as { n: number }).n, 0);
    const updated = structuredClone(bundles);
    updated[0]!.value.workflow.name += "新版";
    syncBundledWorkflows(backend.database, updated);
    assert.notEqual(backend.database.getWorkflow(modified.id)!.profileVersion, installedVersion);
    const beforeFailure = backend.database.listWorkflows();
    backend.database.raw.exec("CREATE TRIGGER fail_bundle BEFORE UPDATE ON bundled_workflow_state BEGIN SELECT RAISE(ABORT, 'test'); END");
    assert.throws(() => syncBundledWorkflows(backend.database, bundles));
    assert.deepEqual(backend.database.listWorkflows(), beforeFailure);
  } finally { await backend.close(); }
});

test("fresh database gets all bundled defaults; invalid bundles make no partial changes", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:", secretStore: new InMemorySecretStore() });
  try {
    assert.throws(() => syncBundledWorkflows(backend.database, [...bundles, { key: "bad", value: {} }]));
    assert.equal(backend.database.listWorkflows().length, 0);
    syncBundledWorkflows(backend.database, bundles);
    assert.equal(backend.database.listWorkflows().length, bundles.length);
    const workflows = backend.workflows.list();
    const builtin = workflows[0]!;
    assert.equal(backend.workflows.isBundled(builtin.id), true);
    assert.throws(() => backend.workflows.remove(builtin.id), /默认工作流/);
    assert.throws(() => backend.workflows.updateProfile(builtin.id, builtin.profile), /默认工作流/);
    const imported = backend.workflows.importPortablePackage(bundles[0]!.value);
    assert.equal(backend.workflows.isBundled(imported.id), false);
    assert.notEqual(imported.id, builtin.id);
    backend.workflows.remove(imported.id);
    for (const workflow of workflows.filter(item => item.name.includes("H3"))) {
      const key = workflow.runningHubWorkflowId === "2107063778012905474" ? "61.aspect_ratio" : "115.aspect_ratio";
      const aspect = workflow.profile.parameters.find(item => item.key === key)!;
      assert.equal(aspect.semanticType, "aspect_ratio");
      assert.equal(workflow.profile.genericParameters.some(item => item.key === aspect.key), false);
    }
    const personal = backend.workflows.importApiJson({ name: "个人", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "personal" } } } });
    const retired = workflows.find(item => item.runningHubWorkflowId === bundles[0]!.value.workflow.runningHubWorkflowId)!;
    const job = backend.jobs.create({ workflowId: retired.id, parameters: {} });
    syncBundledWorkflows(backend.database, bundles.slice(1));
    assert.equal(backend.database.listWorkflows().some(item => item.id === retired.id), false);
    assert.deepEqual(backend.jobs.get(job.id)!.profileSnapshot, job.profileSnapshot);
    assert.ok(backend.database.getWorkflow(personal.id));
    syncBundledWorkflows(backend.database, bundles);
    assert.equal(backend.database.listWorkflows().length, bundles.length + 1);
  } finally { await backend.close(); }
});
