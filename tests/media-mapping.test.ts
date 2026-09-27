import assert from "node:assert/strict";
import test from "node:test";
import { parseApiWorkflow } from "../src/core/workflows/parser.js";
import { createWorkflowProfile } from "../src/core/workflows/profiles.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";
import { createDraft, visibleMedia, setDraftMedia, exchangeImages } from "../frontend/src/task-draft.js";
import type { WorkflowView } from "../frontend/src/types.js";

function fixture(first: string, second: string, intermediate = false) {
  const raw = {
    [first]: { class_type: "LoadImage", inputs: { image: "" } },
    [second]: { class_type: "LoadImage", inputs: { image: "" } },
    resize: { class_type: "ImageScale", inputs: { image: [first, 0], width: 512 } },
    generator: { class_type: "Generator", inputs: { "ref_images.ref_image_0": [intermediate ? "resize" : first, 0], "ref_images.ref_image_1": [second, 0] } },
  };
  const parsed = parseApiWorkflow(raw);
  const profile = createWorkflowProfile({ workflowId: "test", name: "test", version: 1, parameters: parsed.parameters });
  const view = { id: "test", profileVersion: 1, parameters: profile.parameters } as WorkflowView;
  return { raw, profile, view };
}
test("reference slots follow graph sockets across unrelated node IDs", () => {
  for (const [a, b] of [["51", "19"], ["903", "2"], ["x", "y"]]) {
    const { view, profile } = fixture(a!, b!);
    const media = visibleMedia(view, "h3-multi-reference");
    assert.deepEqual(media.map(p => p.nodeId), [a, b]);
    let draft = createDraft(view);
    media.forEach((p, index) => { draft = setDraftMedia(draft, p, { enabled: true, mode: "replace", localPath: `image${index+1}` }); });
    draft = exchangeImages(draft, media[0]!, media[1]!);
    const nodes = buildNodeInfoList(profile, draft.parameterValues, media.map(p => ({ parameterId: p.id, localPath: "mock", uploadedValue: draft.mediaOverrides[p.id]!.localPath! })));
    assert.equal(nodes.find(n => n.nodeId === a)?.fieldValue, "image2");
    assert.equal(nodes.find(n => n.nodeId === b)?.fieldValue, "image1");
  }
});
test("single upstream loader through processing node is traced", () => {
  assert.deepEqual(visibleMedia(fixture("90", "3", true).view, "h3-multi-reference").map(p => p.nodeId), ["90", "3"]);
});
test("contradictory reference order is marked instead of guessed", () => {
  const { raw } = fixture("51", "19");
  const parsed = parseApiWorkflow({ ...raw, secondGenerator: { inputs: { "reference_images.reference_image_1": ["51", 0] }, class_type: "AnotherGenerator" } });
  assert.match(parsed.parameters.find(p => p.nodeId === "51")!.mappingIssue!, /冲突/);
});
test("explicit media clearing is sent even when the imported default is empty", () => {
  const { view, profile } = fixture("90", "3");
  const draft = createDraft(view);
  const nodes = buildNodeInfoList(profile, draft.parameterValues);
  assert.equal(nodes.filter(n => n.fieldName === "image" && n.fieldValue === "").length, 2);
});
test("partial reference upload keeps other un-switched slots explicitly empty", () => {
  const raw = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), { class_type: "LoadImage", inputs: { image: "old.png" } }]));
  const parsed = parseApiWorkflow(raw);
  const profile = createWorkflowProfile({ workflowId: "partial", name: "Partial", version: 1, parameters: parsed.parameters, now: 1 });
  const images = profile.parameters.filter(item => item.valueType === "image");
  assert.equal(images.length, 9);
  const inputs = Object.fromEntries(images.map(item => [item.id, ""]));
  const nodes = buildNodeInfoList(profile, inputs, images.slice(0, 2).map((item, i) => ({ parameterId: item.id, localPath: `ref${i}.png`, uploadedValue: `uploaded/ref${i}.png` })));
  assert.equal(nodes.filter(item => item.fieldValue === "").length, 7);
  assert.equal(nodes.filter(item => String(item.fieldValue).startsWith("uploaded/")).length, 2);
  assert.equal(nodes.some(item => item.fieldValue === "old.png"), false);
});
