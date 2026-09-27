import assert from "node:assert/strict";
import test from "node:test";
import { parseApiWorkflow } from "../src/core/workflows/parser.js";
import { createWorkflowProfile } from "../src/core/workflows/profiles.js";
import { resolveMediaInputs } from "../src/core/workflows/mediaInputs.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";

const parsed = parseApiWorkflow({ "1": { class_type: "LoadImage", inputs: { image: "old.png" } }, "2": { class_type: "LoadAudio", inputs: { audio: "old.wav" } } });
const profile = createWorkflowProfile({ workflowId: "wf", name: "wf", version: 1, parameters: parsed.parameters, now: 1 });
test("omitted old draft slots clear image and audio in the final request", () => {
  const defaults = Object.fromEntries(profile.parameters.map(p => [p.id, p.defaultValue]));
  const resolved = resolveMediaInputs(profile, defaults, {});
  assert.equal(resolved.media.length, 0);
  const nodes = buildNodeInfoList(profile, resolved.parameters);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every(n => n.fieldValue === ""));
  assert.ok(Object.values(defaults).includes("old.png"));
});
test("partial upload overrides only its target and clears omitted slots", () => {
  const image = profile.parameters.find(p => p.valueType === "image")!;
  const resolved = resolveMediaInputs(profile, {}, { [image.id]: { mode: "replace", localPath: "new.png" } });
  const nodes = buildNodeInfoList(profile, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: "uploads/new.png" })));
  assert.equal(nodes.find(n => n.nodeId === "1")!.fieldValue, "uploads/new.png");
  assert.equal(nodes.find(n => n.nodeId === "2")!.fieldValue, "");
  assert.throws(() => resolveMediaInputs(profile, {}, { unknown: { mode: "clear" } }), /不属于/);
  assert.throws(() => resolveMediaInputs(profile, {}, { [image.id]: { mode: "replace" } }), /没有本地文件/);
});
