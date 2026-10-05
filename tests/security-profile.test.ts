import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { materializePortableProfile, parsePortableWorkflowPackage } from "../src/core/workflows/package.js";
import { validateProfile, validateProfileAgainstWorkflow } from "../src/core/workflows/profiles.js";
import { RunningHubBackend } from "../src/core/index.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";

function fixture() {
  const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync("tests/fixtures/retired-workflows/minimax-h3-selflift.rhworkflow.json", "utf8")));
  return { profile: materializePortableProfile(pkg, "test", 1), raw: pkg.workflow.apiJson };
}
test("profile rejects different IDs targeting the same API input", () => {
  const { profile } = fixture();
  profile.parameters.push({ ...profile.parameters[0]!, id: "duplicate-target" });
  assert.throws(() => validateProfile(profile), /Duplicate workflow parameter target/);
});
test("profile does not accept inherited object fields as API inputs", () => {
  const { profile, raw } = fixture();
  profile.parameters[0]!.fieldName = "toString";
  assert.throws(() => validateProfileAgainstWorkflow(profile, raw), /失效参数映射/);
});

test("profile rejects a UI key that disagrees with its API target", () => {
  const { profile } = fixture();
  profile.parameters[0]!.key = "999999.unrelated";
  assert.throws(() => validateProfile(profile), /参数标识与提交节点不一致/);
  assert.throws(() => buildNodeInfoList(profile, {}), /参数标识与提交节点不一致/);
});

test("portable import rejects inconsistent display and submission identities", () => {
  const pkg = JSON.parse(readFileSync("tests/fixtures/retired-workflows/minimax-h3-selflift.rhworkflow.json", "utf8"));
  pkg.profile.parameters[0].key = "999999.unrelated";
  assert.throws(() => parsePortableWorkflowPackage(pkg), /参数标识与提交节点不一致/);
});

test("legacy inconsistent profiles cannot enter a single job or partially commit a batch", async () => {
  const backend = new RunningHubBackend({ databasePath: ":memory:" });
  try {
    const good = backend.workflows.importApiJson({ name: "valid", runningHubWorkflowId: "123456789012",
      workflow: { "1": { class_type: "Text", inputs: { text: "" } } } });
    const bad = backend.workflows.importApiJson({ name: "legacy", runningHubWorkflowId: "123456789013",
      workflow: { "2": { class_type: "Text", inputs: { text: "" } } } });
    bad.profile.parameters[0]!.key = "1.text";
    backend.database.saveWorkflow(bad);
    assert.throws(() => backend.jobs.create({ workflowId: bad.id, parameters: {} }), /参数标识与提交节点不一致/);
    assert.throws(() => backend.jobs.createBatch([
      { workflowId: good.id, parameters: {} }, { workflowId: bad.id, parameters: {} },
    ]), /批次第 2 项创建失败/);
    assert.equal(backend.jobs.list().length, 0);
  } finally { await backend.close(); }
});
