import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parsePortableWorkflowPackage, materializePortableProfile } from "../src/core/workflows/package.js";
import { resolveMediaInputs } from "../src/core/workflows/mediaInputs.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";
import { validateMvInput } from "../src/core/workflows/mvValidation.js";
import { applyMvShared, mvParameter, newMvDraft, prepareMvBatch } from "../frontend/src/mv-draft.js";
import { createModeForWorkflow } from "../frontend/src/workflow-view.js";
import type { WorkflowView } from "../frontend/src/types.js";
import { restoreDraft } from "../frontend/src/draft-storage.js";
const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync("bundled-workflows/h3-digital-human-mv.rhworkflow.json", "utf8")));
const profile = materializePortableProfile(pkg, "mv", 1, 1, 1);
const workflow = { id: "mv", profileVersion: 1, runningHubWorkflowId: pkg.workflow.runningHubWorkflowId, parameters: profile.parameters } as WorkflowView;
const p = (key: string) => mvParameter(workflow, key);
function valid(start = 0) {
  const d = newMvDraft(workflow, start);
  d.parameterValues[p("87.value").id] = "segment " + start;
  d.mediaOverrides[p("34.audio").id] = { enabled: true, mode: "replace", localPath: "song.wav" };
  return d;
}
test("audited MV successor preserves user inputs but adopts new hidden tiling default", () => {
  const old = valid(7);
  old.profileVersion = 0;
  old.workflowSnapshot = { ...workflow, runningHubWorkflowId: "2104101064866140162" };
  old.parameterValues[p("78.highres_tiling").id] = false;
  let archived = false;
  const restored = restoreDraft(old, [workflow], workflow, () => { archived = true; });
  assert.ok(archived);
  assert.equal(restored.parameterValues[p("87.value").id], "segment 7");
  assert.equal(restored.parameterValues[p("85.start_index").id], 7);
  assert.equal(restored.mediaOverrides[p("34.audio").id]?.localPath, "song.wav");
  assert.equal(restored.parameterValues[p("78.highres_tiling").id], true);
});
test("MV mode and exact exported prompt/audio/image graph", () => {
  assert.equal(workflow.runningHubWorkflowId, "2107063778012905474");
  assert.equal((pkg.workflow.apiJson as any)["78"].inputs.highres_tiling, true);
  assert.equal(p("78.highres_tiling").defaultValue, true);
  assert.equal(createModeForWorkflow(workflow), "h3-mv");
  const raw = pkg.workflow.apiJson as any;
  assert.equal(raw['58'], undefined);
  assert.equal(raw['59'], undefined);
  assert.deepEqual(raw['62'].inputs.model, ['57',0]);
  assert.equal(raw['78'].inputs.upscaler_model, 'h3_upscaler_lms_v0.1_fp32.safetensors');
  assert.equal(p('78.upscaler_model').defaultValue, raw['78'].inputs.upscaler_model);
  assert.deepEqual(raw["42"].inputs.prompt, ["87", 0]);
  assert.deepEqual(raw["78"].inputs.positive, ["42", 0]);
  assert.deepEqual(raw["84"].inputs.source, ["71", 1]);
  assert.deepEqual(raw["38"].inputs.audio, ["85", 0]);
  assert.deepEqual(raw["65"].inputs.audio, ["85", 0]);
  ["36", "88", "89", "90", "91", "92"].forEach((id, index) => {
    assert.deepEqual(raw["42"].inputs["ref_images.ref_image_" + index], [id, 0]);
    assert.equal(p(id + ".image").referenceIndex, index);
    assert.equal(raw[id].inputs.image, "");
  });
  assert.equal(raw["34"].inputs.audio, "");
});
test('MV task name is shared across all segments and survives preparation', () => {
  const shared = valid(); shared.taskName='越南广告';
  const drafts = [0,10,20].map(start=>applyMvShared(valid(start),shared,workflow));
  assert.deepEqual(prepareMvBatch(drafts,workflow).map(d=>d.taskName),['越南广告','越南广告','越南广告']);
  const previous=valid(7);previous.taskName='保留名称';previous.profileVersion=0;
  previous.workflowSnapshot={...workflow,runningHubWorkflowId:'2104166509705986049'};
  assert.equal(restoreDraft(previous,[workflow],workflow,()=>{}).taskName,'保留名称');
});
test("Three independent segments preserve final API targets and clear unused images", () => {
  const drafts = [0, 10.5, 20.75].map(valid);
  drafts[1]!.mediaOverrides[p("88.image").id] = { enabled: true, mode: "replace", localPath: "second.png" };
  const prepared = prepareMvBatch(drafts, workflow);
  prepared.forEach((d, index) => {
    const resolved = resolveMediaInputs(profile, d.parameterValues, d.mediaOverrides);
    validateMvInput(profile, resolved.parameters, resolved.media);
    const nodes = buildNodeInfoList(profile, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: m.localPath })));
    const value = (nodeId: string, fieldName: string) => nodes.find(n => n.nodeId === nodeId && n.fieldName === fieldName)?.fieldValue;
    assert.equal(value("87", "value"), "segment " + [0, 10.5, 20.75][index]);
    assert.equal(Number(value("85", "start_index")), [0, 10.5, 20.75][index]);
    assert.equal(Number(value("85", "duration")), 10);
    assert.equal(value("88", "image"), index === 1 ? "second.png" : "");
    assert.equal(value("36", "image"), "");
    assert.equal(value("34", "audio"), "song.wav");
    assert.equal(d.instanceType, "default");
  });
  prepared[0]!.parameterValues[p("87.value").id] = "changed";
  assert.equal(drafts[0]!.parameterValues[p("87.value").id], "segment 0");
});
test("MV batch validates every segment before submission; backend rejects bypass", () => {
  const drafts = [valid(), valid(10), valid(20)];
  drafts[2]!.parameterValues[p("87.value").id] = "";
  assert.throws(() => prepareMvBatch(drafts, workflow), /第 3 段/);
  for (const [key, value] of [["85.duration", 0], ["85.duration", -1], ["85.start_index", -1], ["87.value", ""]] as const) {
    const draft = valid(); draft.parameterValues[p(key).id] = value;
    const resolved = resolveMediaInputs(profile, draft.parameterValues, draft.mediaOverrides);
    assert.throws(() => validateMvInput(profile, resolved.parameters, resolved.media));
  }
  assert.throws(() => validateMvInput(profile, valid().parameterValues, []), /音频/);
});

test("global Plus, ratio and audio are frozen in each queued snapshot", () => {
  const shared = valid();
  shared.instanceType = "plus";
  shared.parameterValues[p("61.megapixels").id] = 1.5;
  const draft = valid(2);
  draft.parameterValues[p("85.duration").id] = 10.5;
  const queued = prepareMvBatch([applyMvShared(draft, shared, workflow)], workflow)[0]!;
  shared.instanceType = "default";
  shared.parameterValues[p("61.megapixels").id] = 2;
  shared.mediaOverrides[p("34.audio").id]!.localPath = "different.wav";
  assert.equal(queued.instanceType, "plus");
  assert.equal(queued.parameterValues[p("61.megapixels").id], 1.5);
  assert.equal(queued.mediaOverrides[p("34.audio").id]!.localPath, "song.wav");
  const resolved = resolveMediaInputs(profile, queued.parameterValues, queued.mediaOverrides);
  const nodes = buildNodeInfoList(profile, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: m.localPath })));
  assert.equal(Number(nodes.find(n => n.nodeId === "85" && n.fieldName === "start_index")!.fieldValue), 2);
  assert.equal(Number(nodes.find(n => n.nodeId === "85" && n.fieldName === "duration")!.fieldValue), 10.5);
});

test("every empty reference is explicitly submitted, including stale workflow defaults", () => {
  const legacy = structuredClone(profile);
  for (const parameter of legacy.parameters.filter(p => p.valueType === "image")) parameter.defaultValue = "AUTHOR_IMAGE.png";
  for (const count of [0, 1, 2, 6]) {
    const draft = valid();
    const imageNodes = ["36", "88", "89", "90", "91", "92"];
    imageNodes.slice(0, count).forEach((id, index) => {
      draft.mediaOverrides[p(id + ".image").id] = { enabled: true, mode: "replace", localPath: "user-" + index + ".png" };
    });
    const resolved = resolveMediaInputs(legacy, draft.parameterValues, draft.mediaOverrides);
    const nodes = buildNodeInfoList(legacy, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: m.localPath })));
    imageNodes.forEach((id, index) => {
      assert.equal(nodes.find(n => n.nodeId === id && n.fieldName === "image")?.fieldValue, index < count ? "user-" + index + ".png" : "");
    });
    assert.ok(!JSON.stringify(nodes).includes("AUTHOR_IMAGE"));
  }
});

test("empty prompt/audio and invalid times cannot enter production batch", () => {
  assert.throws(() => prepareMvBatch([newMvDraft(workflow)], workflow), /生成词/);
  const noAudio = valid(); noAudio.mediaOverrides[p("34.audio").id] = { enabled: false, mode: "clear" };
  assert.throws(() => prepareMvBatch([noAudio], workflow), /音频/);
  for (const duration of [0, -1, "", NaN, Infinity]) {
    const d = valid(); d.parameterValues[p("85.duration").id] = duration;
    assert.throws(() => prepareMvBatch([d], workflow), /时长/);
  }
});

test("MV short and long durations pass frontend/backend and retain exact API duration", () => {
  assert.equal(p("85.duration").max, undefined);
  for (const duration of [0.5, 3, 16, 29, 75, 150]) {
    const draft = valid(75);
    draft.parameterValues[p("85.duration").id] = duration;
    const prepared = prepareMvBatch([draft], workflow)[0]!;
    const resolved = resolveMediaInputs(profile, prepared.parameterValues, prepared.mediaOverrides);
    validateMvInput(profile, resolved.parameters, resolved.media);
    const nodes = buildNodeInfoList(profile, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: m.localPath })));
    assert.equal(Number(nodes.find(n => n.nodeId === "85" && n.fieldName === "duration")!.fieldValue), duration);
    assert.equal(Number(nodes.find(n => n.nodeId === "85" && n.fieldName === "start_index")!.fieldValue), 75);
  }
});
