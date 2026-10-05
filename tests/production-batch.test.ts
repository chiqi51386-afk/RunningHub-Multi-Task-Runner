import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parsePortableWorkflowPackage, materializePortableProfile } from "../src/core/workflows/package.js";
import { createDraft } from "../frontend/src/task-draft.js";
import { mergeSavedBatches, prepareProductionBatch } from "../frontend/src/production-batch.js";
import type { WorkflowView } from "../frontend/src/types.js";

const workflows = ["ltx-2.3-digital-human", "minimax-h3-selflift", "h3-digital-human-mv"].map((name, index) => {
  const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync(`${["ltx-2.3-digital-human","minimax-h3-multi-reference","minimax-h3-selflift"].includes(name)?"tests/fixtures/retired-workflows":"bundled-workflows"}/${name}.rhworkflow.json`, "utf8")));
  const id = `workflow-${index}`;
  return { id, profileVersion: 1, runningHubWorkflowId: pkg.workflow.runningHubWorkflowId, parameters: materializePortableProfile(pkg, id, 1, 1, 1).parameters } as WorkflowView;
});
function items() {
  return workflows.map((workflow, index) => {
    const draft = createDraft(workflow);
    for (const p of workflow.parameters) {
      if (p.semanticType === "prompt") draft.parameterValues[p.id] = `prompt-${index}`;
      if (p.valueType === "audio" || p.valueType === "image") draft.mediaOverrides[p.id] = { enabled: true, mode: "replace", localPath: `${index}-${p.key}.png` };
    }
    return { id: `item-${index}`, draft };
  });
}
test("mixed production batch keeps each workflow, input and Plus snapshot independent", () => {
  const batch = items(); batch[2]!.draft.instanceType = "plus";
  const result = prepareProductionBatch(batch, workflows);
  assert.equal(result.length, 3);
  result.forEach((draft, index) => {
    assert.equal(draft.workflowId, workflows[index]!.id);
    assert.deepEqual(draft.parameterValues, batch[index]!.draft.parameterValues);
    assert.equal(draft.instanceType, index === 2 ? "plus" : "default");
    for (const media of Object.values(draft.mediaOverrides)) if (media.mode === "replace") assert.ok(media.localPath?.startsWith(`${index}-`));
  });
  result[2]!.parameterValues.extra = "changed";
  assert.equal(batch[2]!.draft.parameterValues.extra, undefined);
});
test("MV validation applies in a mixed batch regardless of the active editor", () => {
  const batch = items(), p = workflows[2]!.parameters.find(p => p.key === "85.duration")!;
  batch[2]!.draft.parameterValues[p.id] = 0;
  assert.throws(() => prepareProductionBatch(batch, workflows), /第 3 项.*时长/);
  batch[2]!.draft.profileVersion++;
  assert.throws(() => prepareProductionBatch(batch, workflows), /映射已变化/);
  assert.throws(() => prepareProductionBatch(items(), workflows.slice(0, 2)), /工作流已删除/);
});
test("pending MV successor upgrades exact inputs and preserves segment identity", () => {
  const batch = items();
  const old = batch[2]!.draft;
  old.profileVersion = 0;
  old.workflowSnapshot = { ...workflows[2]!, runningHubWorkflowId: '2104101064866140162' };
  old.production = {groupId: 'previous-group', segmentIndex: 7};
  const tile = workflows[2]!.parameters.find(p => p.key === '78.highres_tiling')!;
  old.parameterValues[tile.id] = false;
  const migrated = prepareProductionBatch(batch, workflows)[2]!;
  assert.equal(migrated.profileVersion, 1);
  assert.equal(migrated.parameterValues[tile.id], true);
  assert.equal(migrated.production?.segmentIndex, 7);
  assert.deepEqual(migrated.mediaOverrides, old.mediaOverrides);
  assert.equal(old.profileVersion, 0);
});
test("legacy MV migration preserves snapshots and is idempotent after a interrupted migration", () => {
  const batch = items();
  const merged = mergeSavedBatches(batch.slice(0, 2), [batch[2]!]);
  assert.deepEqual(merged, batch);
  assert.deepEqual(mergeSavedBatches(merged, [batch[2]!]), batch);
  assert.equal(mergeSavedBatches(null, [batch[2]!]).length, 1);
});
