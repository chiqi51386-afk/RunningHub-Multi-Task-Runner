import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { clearDraftInputs, createDraft, cloneDraft, exchangeImages, expandedImageSlotCount, prepareDraft, transferDraft, visibleMedia } from "../frontend/src/task-draft.js";
import { attachMediaControls } from "../frontend/src/workflow-view.js";
import type { WorkflowParameterView, WorkflowView } from "../frontend/src/types.js";

const image = (id: string): WorkflowParameterView => ({ id, key: `${id}.image`, nodeId: id, fieldName: "image", classType: "LoadImage", valueType: "image", semanticType: "image", defaultValue: "", confidence: 1, mediaControl: { parameterId: `switch_${id}`, activeValue: false, inactiveValue: true, autoEnableOnReplace: true, detected: false } });
const workflow = (id: string, parameters: WorkflowParameterView[]): WorkflowView => ({ id, name: id, runningHubWorkflowId: id, parameters, parameterCount: parameters.length, profileVersion: 1, needsReview: false, updatedAt: 0 });
const a = image("a"), b = image("b");

test("dynamic image slots preserve gaps, node identity, swaps and cleared hidden inputs", () => {
  const slots = Array.from({ length: 6 }, (_, i) => ({ ...image(`node${i}`), referenceIndex: i }));
  const wf = workflow("dynamic", slots);
  let draft = createDraft(wf);
  assert.equal(expandedImageSlotCount(slots, draft), 2);
  for (let i = 0; i < 6; i++) {
    draft.mediaOverrides[slots[i]!.id] = { enabled: true, mode: "replace", localPath: `picture${i + 1}.png` };
    assert.equal(expandedImageSlotCount(slots, draft), Math.min(6, Math.max(2, i + 2)));
  }
  draft.mediaOverrides.node1 = { enabled: false, mode: "clear" };
  assert.equal(draft.mediaOverrides.node2!.localPath, "picture3.png");
  draft = exchangeImages(draft, slots[0]!, slots[2]!);
  assert.equal(draft.mediaOverrides.node0!.localPath, "picture3.png");
  assert.equal(draft.mediaOverrides.node2!.localPath, "picture1.png");
  draft = exchangeImages(draft, slots[2]!, slots[1]!);
  assert.equal(draft.mediaOverrides.node1!.localPath, "picture1.png");
  assert.equal(draft.mediaOverrides.node2!.mode, "clear");
  const target = workflow("other", slots.map((slot, i) => ({ ...slot, id: `other${i}`, nodeId: `other${i}` })));
  const next = transferDraft(draft, wf, target, "h3-multi-reference");
  assert.equal(next.mediaOverrides.other1!.localPath, "picture1.png");
  assert.equal(next.mediaOverrides.other2!.mode, "clear");
  const cleared = prepareDraft(clearDraftInputs(next, target), target, "h3-multi-reference");
  assert.equal(expandedImageSlotCount(target.parameters, cleared), 2);
  assert.equal(Object.values(cleared.mediaOverrides).length, 6);
  assert.ok(Object.values(cleared.mediaOverrides).every(item => item.mode === "clear"));
  assert.equal(expandedImageSlotCount(slots.slice(0, 1), draft), 1);
});
test("bundled Inf to LTX keeps scheduler internals and produces no dpm++ scheduler override", () => {
  const load = (file: string, id: string) => {
    const data = JSON.parse(readFileSync(`${["ltx-2.3-digital-human","minimax-h3-multi-reference","minimax-h3-selflift"].includes(file)?"tests/fixtures/retired-workflows":"bundled-workflows"}/${file}.rhworkflow.json`, "utf8"));
    return workflow(id, data.profile.parameters);
  };
  const inf = load("infinitetalk-digital-human", "inf");
  const ltx = load("ltx-2.3-digital-human", "ltx");
  const input = createDraft(inf);
  const sourcePrompt = inf.parameters.find(p => p.semanticType === "prompt" && p.visible !== false)!;
  input.parameterValues[sourcePrompt.id] = "test input";
  const next = transferDraft(input, inf, ltx, "digital-human");
  for (const parameter of ltx.parameters.filter(p => p.semanticType === "scheduler")) {
    assert.equal(next.parameterValues[parameter.id], "simple");
  }
  for (const parameter of ltx.parameters.filter(p => p.visible === false && !["image", "audio", "video"].includes(p.valueType))) {
    assert.deepEqual(next.parameterValues[parameter.id], parameter.defaultValue, parameter.key);
  }
  assert.equal(next.parameterValues[ltx.parameters.find(p => p.key === "169.text")!.id], "test input");
});
test("digital human transfers audio and image to different nodes without changing source", () => {
  const audio = { ...image("audio"), valueType: "audio", semanticType: "audio", fieldName: "audio" } as WorkflowParameterView;
  const targetAudio = { ...audio, id: "newAudio", nodeId: "393", mediaControl: undefined };
  const first = workflow("first", [a, audio]);
  const next = workflow("next", [b, targetAudio]);
  const draft = createDraft(first);
  draft.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "face.png" };
  draft.mediaOverrides.audio = { enabled: true, mode: "replace", localPath: "voice.wav" };
  const result = transferDraft(draft, first, next, "digital-human");
  assert.equal(result.mediaOverrides.b!.localPath, "face.png");
  assert.equal(result.mediaOverrides.newAudio!.localPath, "voice.wav");
  assert.equal(result.mediaOverrides.audio, undefined);
  assert.equal(draft.mediaOverrides.audio!.localPath, "voice.wav");
});
const prompt = (id: string): WorkflowParameterView => ({ ...image(id), key: `${id}.text`, fieldName: "text", valueType: "string", semanticType: "prompt", mediaControl: undefined, defaultValue: "" });
test("Inf negative prompt does not block LTX switching or overwrite hidden LTX text", () => {
  const negative = { ...prompt("negative"), semanticType: "negative_prompt" as const, defaultValue: "internal negative" };
  const inf = workflow("inf", [a, prompt("positive"), negative]);
  const ltx = workflow("ltx", [b, prompt("169"), { ...prompt("165"), visible: false, defaultValue: "internal text" }]);
  const draft = createDraft(inf);
  draft.parameterValues.positive = "user prompt";
  draft.parameterValues.negative = "old custom negative";
  draft.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "face.png" };
  const next = transferDraft(draft, inf, ltx, "digital-human");
  assert.equal(next.parameterValues["169"], "user prompt");
  assert.equal(next.parameterValues["165"], "internal text");
  assert.equal(next.mediaOverrides.b!.localPath, "face.png");
  const back = transferDraft(next, ltx, inf, "digital-human");
  assert.equal(back.parameterValues.positive, "user prompt");
  assert.equal(back.parameterValues.negative, "internal negative");
  assert.equal(clearDraftInputs(back, inf).parameterValues.negative, "internal negative");
});
test("round-trip switching carries latest prompt and image, never stale target content", () => {
  const first = workflow("first", [a, prompt("pa")]);
  const second = workflow("second", [b, prompt("pb")]);
  const current = createDraft(first);
  current.parameterValues.pa = "新的生成词";
  current.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "first.png" };
  const next = transferDraft(current, first, second, "h3-multi-reference");
  assert.equal(next.parameterValues.pb, "新的生成词");
  next.parameterValues.pb = "再次修改";
  next.mediaOverrides.b!.localPath = "second.png";
  const back = transferDraft(next, second, first, "h3-multi-reference");
  assert.equal(back.parameterValues.pa, "再次修改");
  assert.equal(back.mediaOverrides.a!.localPath, "second.png");
  assert.equal(back.parameterValues.pb, undefined);
  const empty = clearDraftInputs(back, first);
  assert.equal(empty.parameterValues.pa, "");
  assert.equal(empty.mediaOverrides.a!.localPath, undefined);
  assert.equal(empty.parameterValues.switch_a, true);
  assert.equal(back.parameterValues.pa, "再次修改");
  const switchedEmpty = transferDraft(empty, first, second, "h3-multi-reference");
  assert.equal(switchedEmpty.parameterValues.pb, "");
  assert.equal(switchedEmpty.mediaOverrides.b!.mode, "clear");
});
test("ambiguous prompts, insufficient media slots and wrong snapshots are blocked", () => {
  const first = workflow("first", [a, prompt("p")]);
  const draft = createDraft(first);
  draft.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "ref.png" };
  assert.throws(() => transferDraft(draft, first, workflow("ambiguous", [b, prompt("x"), prompt("y")]), "h3-multi-reference"), /生成词映射/);
  assert.throws(() => transferDraft(draft, first, workflow("missing", [prompt("x")]), "h3-multi-reference"), /媒体槽不足/);
  assert.throws(() => prepareDraft(draft, workflow("wrong", [a]), "digital-human"), /映射已变化/);
});
test("occupied image slots exchange both files and preserve inverse switch values", () => {
  const draft = createDraft(workflow("h3", [a, b]));
  draft.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "a.png", previewUrl: "a" };
  draft.mediaOverrides.b = { enabled: true, mode: "replace", localPath: "b.png", previewUrl: "b" };
  const swapped = exchangeImages(draft, a, b);
  assert.equal(swapped.mediaOverrides.a!.localPath, "b.png");
  assert.equal(swapped.mediaOverrides.b!.localPath, "a.png");
  assert.equal(swapped.parameterValues.switch_a, false);
  assert.equal(swapped.parameterValues.switch_b, false);
  assert.equal(draft.mediaOverrides.a!.localPath, "a.png");
});
test("move into empty slot clears source and changes both switches", () => {
  const draft = createDraft(workflow("h3", [a, b]));
  draft.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "a.png" };
  const moved = exchangeImages(draft, a, b);
  assert.equal(moved.mediaOverrides.a!.mode, "clear");
  assert.equal(moved.mediaOverrides.b!.localPath, "a.png");
  assert.equal(moved.parameterValues.switch_a, true);
  assert.equal(moved.parameterValues.switch_b, false);
  assert.equal(exchangeImages(draft, a, a), draft);
});
test("H3 shows at most six image slots and suppresses audio/video overrides on submission", () => {
  const audio = { ...image("audio"), valueType: "audio", semanticType: "audio" } as WorkflowParameterView;
  const wf = workflow("h3", [...Array.from({ length: 7 }, (_, i) => image(String(i))), audio]);
  assert.equal(visibleMedia(wf, "h3-multi-reference").length, 6);
  const draft = createDraft(wf);
  draft.mediaOverrides.audio = { enabled: true, mode: "replace", localPath: "old.wav" };
  const prepared = prepareDraft(draft, wf, "h3-multi-reference");
  assert.equal(prepared.mediaOverrides.audio!.mode, "clear");
  assert.equal(prepared.mediaOverrides.audio!.localPath, undefined);
  assert.equal(draft.mediaOverrides.audio!.mode, "replace");
});
test("workflow switching maps reference slots to target node IDs and retains Plus", () => {
  const first = workflow("first", [a]);
  const next = workflow("next", [b]);
  const draft = createDraft(first);
  draft.instanceType = "plus";
  draft.mediaOverrides.a = { enabled: true, mode: "replace", localPath: "ref.png" };
  const result = transferDraft(draft, first, next, "h3-multi-reference");
  assert.equal(result.workflowId, "next");
  assert.equal(result.instanceType, "plus");
  assert.equal(result.mediaOverrides.b!.localPath, "ref.png");
  assert.equal(result.mediaOverrides.a, undefined);
  assert.equal(createDraft(next).instanceType, "default");
  const standard = { ...draft, instanceType: "default" as const };
  assert.equal(transferDraft(standard, first, next, "h3-multi-reference").instanceType, "default");
  assert.equal(prepareDraft(result, next, "h3-multi-reference").instanceType, "plus");
});
test("batch snapshot remains independent of subsequent input changes", () => {
  const draft = createDraft(workflow("h3", [a]));
  const copy = cloneDraft(draft);
  draft.parameterValues.foo = "changed";
  draft.mediaOverrides.a!.mode = "replace";
  assert.equal(copy.parameterValues.foo, undefined);
  assert.equal(copy.mediaOverrides.a!.mode, "clear");
});
test("manually configured media switch is never overwritten by heuristic detection", () => {
  const control = { ...a, id: "other", nodeId: "a", fieldName: "enabled", valueType: "boolean", semanticType: "unknown", defaultValue: true } as WorkflowParameterView;
  assert.deepEqual(attachMediaControls([a, control])[0]!.mediaControl, a.mediaControl);
});
