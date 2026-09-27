import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePortableWorkflowPackage, materializePortableProfile } from "../src/core/workflows/package.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";
import { createDraft, transferDraft, visibleMedia } from "../frontend/src/task-draft.js";
import { createModeForWorkflow, generationParameterOrder, migrateParameterView } from "../frontend/src/workflow-view.js";
import type { WorkflowView } from "../frontend/src/types.js";

function load(file: string): WorkflowView {
  const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync(`bundled-workflows/${file}.rhworkflow.json`, "utf8")));
  const profile = materializePortableProfile(pkg, file, 1, 0, 0);
  return { id: file, name: pkg.workflow.name, runningHubWorkflowId: pkg.workflow.runningHubWorkflowId,
    profileVersion: 1, parameters: profile.parameters } as WorkflowView;
}

test("SelfLift exposes the reviewed controls and submits their exact targets", () => {
  const workflow = load("minimax-h3-selflift");
  assert.equal(workflow.name, "SelfLift双采");
  assert.equal(createModeForWorkflow(workflow), "h3-multi-reference");
  const controls = workflow.parameters.filter(p => p.visible && !["image", "prompt", "unknown"].includes(p.semanticType))
    .sort((a, b) => generationParameterOrder(a) - generationParameterOrder(b));
  assert.deepEqual(controls.map(p => p.key), ["115.aspect_ratio", "132.value", "115.megapixels", "235.lowres_scale"]);
  assert.equal(migrateParameterView(controls[2]!).semanticType, "target_resolution");
  const draft = createDraft(workflow);
  assert.equal(draft.instanceType, "default");
  const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync("bundled-workflows/minimax-h3-selflift.rhworkflow.json", "utf8")));
  const profile = materializePortableProfile(pkg, workflow.id, 1);
  const values = buildNodeInfoList(profile, draft.parameterValues);
  for (const p of controls) assert.equal(values.find(v => v.nodeId === p.nodeId && v.fieldName === p.fieldName)?.fieldValue, p.defaultValue);
  assert.equal(values.find(v => v.nodeId === "232" && v.fieldName === "value")?.fieldValue, "");
  assert.equal(values.find(v => v.nodeId === "235" && v.fieldName === "seed")?.fieldValue, 666);
  assert.equal((pkg.workflow.apiJson["235"] as { inputs: { highres_tiling: boolean } }).inputs.highres_tiling, true);
  assert.equal(values.find(v => v.nodeId === "235" && v.fieldName === "highres_tiling")?.fieldValue, true);
});

test("switching to SelfLift retains ordered media and prompt, not old pass resolution or multiplier", () => {
  const old = load("minimax-h3-multi-reference"), next = load("minimax-h3-selflift");
  const draft = createDraft(old);
  const prompt = old.parameters.find(p => p.semanticType === "prompt" && p.visible)!;
  draft.parameterValues[prompt.id] = "USER_INPUT_SENTINEL";
  for (const p of old.parameters.filter(p => ["resolution", "upscale_factor"].includes(p.semanticType))) draft.parameterValues[p.id] = 0.7;
  visibleMedia(old, "h3-multi-reference").forEach((p, i) => { draft.mediaOverrides[p.id] = { mode: "replace", enabled: true, localPath: `image-${i + 1}.png` }; });
  const transferred = transferDraft(draft, old, next, "h3-multi-reference");
  assert.equal(transferred.parameterValues.prompt, "USER_INPUT_SENTINEL");
  assert.equal(transferred.parameterValues[next.parameters.find(p => p.key === "115.megapixels")!.id], 2);
  assert.equal(transferred.parameterValues[next.parameters.find(p => p.key === "235.lowres_scale")!.id], 0.4);
  const images = visibleMedia(next, "h3-multi-reference");
  assert.deepEqual(images.map(p => p.nodeId), ["150", "164", "239", "241", "240", "238"]);
  images.forEach((p, i) => assert.equal(transferred.mediaOverrides[p.id]!.localPath, `image-${i + 1}.png`));
  const back = transferDraft(transferred, next, old, "h3-multi-reference");
  assert.equal(back.parameterValues[prompt.id], "USER_INPUT_SENTINEL");
});
