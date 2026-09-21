import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildNodeInfoList, createWorkflowProfile, parseApiWorkflow } from "../src/core/index.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("parser exposes primitive literals, preserves metadata, and skips graph links", async () => {
  const parsed = parseApiWorkflow(await fixture("workflow-simple.json"));
  assert.equal(parsed.parameters.some(item => item.fieldName === "clip"), false);
  assert.equal(parsed.parameters.some(item => item.fieldName === "positive"), false);
  assert.equal(parsed.parameters.find(item => item.fieldName === "text")?.nodeTitle, "Positive Prompt");
  assert.equal(parsed.parameters.find(item => item.fieldName === "seed")?.valueType, "integer");
  assert.equal(parsed.parameters.find(item => item.fieldName === "cfg")?.valueType, "number");
  assert.match(parsed.workflowHash, /^[a-f0-9]{64}$/);
});

test("ResolutionSelector restores the official aspect-ratio combo and defaults to vertical video", async () => {
  const parsed = parseApiWorkflow({
    "252": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.5, multiple: 32 } },
  });
  const profile = createWorkflowProfile({ workflowId: "resolution", name: "Resolution", version: 1, parameters: parsed.parameters, now: 1 });
  const aspect = parsed.parameters.find(item => item.fieldName === "aspect_ratio");
  assert.equal(aspect?.valueType, "select");
  assert.equal(aspect?.defaultValue, "9:16 (Portrait Widescreen)");
  assert.equal(aspect?.submitDefault, true);
  assert.ok(aspect?.options?.includes("9:16 (Portrait Widescreen)"));
  assert.ok(aspect?.options?.includes("16:9 (Widescreen)"));
  assert.equal(profile.parameters.find(item => item.fieldName === "megapixels")?.semanticType, "resolution");
  assert.equal(profile.parameters.find(item => item.fieldName === "multiple")?.semanticType, "resolution_multiple");
  assert.equal(profile.parameters.find(item => item.fieldName === "multiple")?.visible, true);
});

test("parser removes harmless floating-point tails from widget defaults", () => {
  const parsed = parseApiWorkflow({
    "283": { class_type: "easy float", inputs: { value: 1.5000000000000002 }, _meta: { title: "Float" } },
  });
  assert.equal(parsed.parameters[0]?.defaultValue, 1.5);
});

test("recognizer creates stable semantic ids and unknown parameters are retained", async () => {
  const simple = parseApiWorkflow(await fixture("workflow-simple.json"));
  const profile = createWorkflowProfile({ workflowId: "wf", name: "Simple", version: 1, parameters: simple.parameters, now: 1 });
  assert.equal(profile.parameters.find(item => item.fieldName === "text")?.semanticType, "prompt");
  assert.equal(profile.parameters.find(item => item.fieldName === "noise_seed"), undefined);
  assert.equal(profile.parameters.find(item => item.fieldName === "seed")?.id, "seed");
  assert.equal(profile.parameters.find(item => item.fieldName === "width")?.semanticType, "width");

  const unknown = parseApiWorkflow(await fixture("workflow-unknown-nodes.json"));
  const unknownProfile = createWorkflowProfile({ workflowId: "future", name: "Future", version: 1, parameters: unknown.parameters, now: 1 });
  assert.deepEqual(unknownProfile.genericParameters.map(item => item.fieldName).sort(), ["bar", "foo", "mode"]);
  assert.equal(unknownProfile.needsReview, false);
  assert.ok(unknownProfile.genericParameters.every(item => item.visible === false));
});

test("nodeInfoList maps snapshot inputs and uploaded media without fixed node ids", async () => {
  const parsed = parseApiWorkflow(await fixture("workflow-simple.json"));
  const profile = createWorkflowProfile({ workflowId: "wf", name: "Simple", version: 1, parameters: parsed.parameters, now: 1 });
  const list = buildNodeInfoList(profile, { prompt: "changed", seed: 9 });
  assert.deepEqual(list.find(item => item.fieldName === "text"), { nodeId: "1", fieldName: "text", fieldValue: "changed" });
  assert.deepEqual(list.find(item => item.fieldName === "seed"), { nodeId: "3", fieldName: "seed", fieldValue: 9 });
});

test("nodeInfoList sends only changed widget values so graph connections remain intact", () => {
  const raw = {
    "6": { class_type: "LoadAudio", inputs: { audio: "default.mp3", audioUI: "" } },
    "7": { class_type: "AudioCrop", inputs: { start_time: "0:00", end_time: "5:00", audio: ["6", 0] } },
  };
  const parsed = parseApiWorkflow(raw);
  const profile = createWorkflowProfile({ workflowId: "audio", name: "Audio", version: 1, parameters: parsed.parameters, now: 1 });
  const defaults = Object.fromEntries(profile.parameters.map(parameter => [parameter.id, parameter.defaultValue]));
  const audio = profile.parameters.find(parameter => parameter.semanticType === "audio")!;
  const list = buildNodeInfoList(profile, defaults, [
    { parameterId: audio.id, localPath: "replacement.mp3", uploadedValue: "openapi/replacement.mp3" },
  ]);

  assert.deepEqual(list, [{ nodeId: "6", fieldName: "audio", fieldValue: "openapi/replacement.mp3" }]);
  assert.equal(list.some(item => item.nodeId === "7"), false);
});

test("representative H3 and multiple-media fixtures expose required semantics", async () => {
  const h3 = parseApiWorkflow(await fixture("workflow-h3.json"));
  const h3Profile = createWorkflowProfile({ workflowId: "h3", name: "H3", version: 1, parameters: h3.parameters, now: 1 });
  const semantics = new Set(h3Profile.parameters.map(item => item.semanticType));
  assert.ok(semantics.has("prompt"));
  assert.ok(semantics.has("duration"));
  assert.ok(semantics.has("aspect_ratio"));
  assert.ok(semantics.has("resolution"));
  assert.ok(semantics.has("image"));
  const images = h3Profile.parameters.filter(item => item.semanticType === "image");
  assert.equal(images.length, 6);
  assert.deepEqual(images.map(item => item.id), ["image", "image_2", "image_3", "image_4", "image_5", "image_6"]);
  assert.ok(images.every(item => item.showEnableToggle === true));

  const media = parseApiWorkflow(await fixture("workflow-multiple-media.json"));
  const mediaProfile = createWorkflowProfile({ workflowId: "media", name: "Media", version: 1, parameters: media.parameters, now: 1 });
  assert.deepEqual(mediaProfile.parameters.map(item => item.semanticType), ["image", "video", "audio"]);
});

test("media controls are detected and an uploaded file activates its switch", async () => {
  const parsed = parseApiWorkflow(await fixture("workflow-media-switches.json"));
  const profile = createWorkflowProfile({ workflowId: "switches", name: "Switches", version: 1, parameters: parsed.parameters, now: 1 });
  const image = profile.parameters.find(item => item.semanticType === "image");
  const audio = profile.parameters.find(item => item.semanticType === "audio");
  assert.equal(image?.mediaControl?.parameterId, "10_enabled");
  assert.equal(audio?.mediaControl?.parameterId, "21_value");

  const list = buildNodeInfoList(profile, {}, [{ parameterId: image!.id, localPath: "replacement.png", uploadedValue: "remote.png" }]);
  assert.deepEqual(list.find(item => item.nodeId === "10" && item.fieldName === "enabled"), { nodeId: "10", fieldName: "enabled", fieldValue: true });
  assert.deepEqual(list.find(item => item.nodeId === "10" && item.fieldName === "image"), { nodeId: "10", fieldName: "image", fieldValue: "remote.png" });
});

test("media without a switch remains a direct upload and does not invent control fields", async () => {
  const parsed = parseApiWorkflow(await fixture("workflow-multiple-media.json"));
  const profile = createWorkflowProfile({ workflowId: "direct", name: "Direct", version: 1, parameters: parsed.parameters, now: 1 });
  assert.ok(profile.parameters.every(item => item.mediaControl === undefined));
  const image = profile.parameters.find(item => item.semanticType === "image")!;
  const list = buildNodeInfoList(profile, {}, [{ parameterId: image.id, localPath: "replacement.png", uploadedValue: "remote.png" }]);
  assert.equal(list.length, 1);
  assert.deepEqual(list.find(item => item.nodeId === "10"), { nodeId: "10", fieldName: "image", fieldValue: "remote.png" });
});

test("generic multiline Text prompts and staged video outputs are discovered", () => {
  const raw = {
    "263": { class_type: "Text", inputs: { text: "subject_definitions:\n<Subject 1> is a performer.\nscene_description: A cinematic performance with natural movement and realistic lighting across the whole shot." }, _meta: { title: "Text" } },
    "264": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: "YZ_H3_一采", save_output: false, images: ["1", 0] }, _meta: { title: "Video Combine" } },
    "214": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: "YZ_H3_二采", save_output: true, images: ["2", 0] }, _meta: { title: "Video Combine" } },
  };
  const parsed = parseApiWorkflow(raw);
  const profile = createWorkflowProfile({ workflowId: "h3-real", name: "H3 Real", version: 1, parameters: parsed.parameters, outputs: parsed.outputs, now: 1 });
  assert.equal(profile.parameters.find(item => item.key === "263.text")?.semanticType, "prompt");
  assert.deepEqual(profile.outputs.map(item => [item.nodeId, item.stage, item.saveOutput]), [["264", 1, false], ["214", 2, true]]);
});

test("loader helper fields are not misclassified as upload slots", () => {
  const parsed = parseApiWorkflow({
    "1": { class_type: "LoadAudio", inputs: { audio: "input.wav", audioUI: "" } },
    "2": { class_type: "VHS_LoadVideo", inputs: { video: "input.mp4", force_size: "Disabled", format: "AnimateDiff" } },
  });
  const profile = createWorkflowProfile({ workflowId: "helpers", name: "Helpers", version: 1, parameters: parsed.parameters, now: 1 });
  assert.deepEqual(profile.parameters.filter(item => ["image", "video", "audio"].includes(item.semanticType)).map(item => item.key), ["1.audio", "2.video"]);
});
