import assert from "node:assert/strict";
import test from "node:test";
import { isSavedDraft, serializeDraft, restoreDraft } from "../frontend/src/draft-storage.js";
import { createDraft } from "../frontend/src/task-draft.js";
import type { WorkflowView } from "../frontend/src/types.js";

test("delayed workflow loading preserves draft then recovers by exact node key, never ordinal", () => {
  const old = { id: "old", runningHubWorkflowId: "12345678", profileVersion: 1, parameters: [
    { id: "image_1", key: "51.image", valueType: "image", semanticType: "image", defaultValue: "" },
    { id: "prompt", key: "263.text", valueType: "string", semanticType: "prompt", defaultValue: "" }
  ] } as WorkflowView;
  const saved = createDraft(old);
  saved.parameterValues.prompt = "用户生成词";
  saved.mediaOverrides.image_1 = { enabled: true, mode: "replace", localPath: "C:/user/image.png" };
  const pending = restoreDraft(saved, [], undefined, () => assert.fail());
  assert.equal(pending, saved);
  const updated = { ...old, id: "bundled", profileVersion: 2, parameters: old.parameters.map((p, i) => ({ ...p, id: `new_${i}` })) };
  const result = restoreDraft(pending, [updated], updated, () => {});
  assert.equal(result.mediaOverrides.new_0?.localPath, "C:/user/image.png");
  assert.equal(result.parameterValues.new_1, "用户生成词");
  const changed = { ...updated, parameters: updated.parameters.map(p => ({ ...p, key: `different.${p.id}` })) };
  const rejected = restoreDraft(saved, [changed], changed, () => {});
  assert.equal(rejected.mediaOverrides.new_0?.mode, "clear");
  assert.equal(rejected.parameterValues.new_1, "");
});

test("upgrade archives stale input before initializing new schema; current input survives", () => {
  const workflow = { id: "new", profileVersion: 24, parameters: [{ id: "size", defaultValue: 0.5 }] } as WorkflowView;
  const saved = { ...createDraft(workflow), workflowId: "old", parameterValues: { size: "wrong old value" } };
  let backup: unknown;
  const restored = restoreDraft(saved, [workflow], workflow, value => { backup = structuredClone(value); });
  assert.deepEqual(backup, saved);
  assert.equal(restored.parameterValues.size, 0.5);
  assert.equal(restored.workflowId, "new");
  assert.throws(() => restoreDraft(saved, [workflow], workflow, () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(restoreDraft(saved, [], undefined, () => assert.fail()), saved);
  assert.equal(restoreDraft(restored, [workflow], workflow, () => assert.fail()), restored);
});

test("draft storage preserves exact IDs, versions and paths but excludes ephemeral media", () => {
  const draft = { workflowId: "original", profileVersion: 19, instanceType: "default", parameterValues: { prompt: "输入" },
    mediaOverrides: { image: { mode: "replace", localPath: "C:/素材/1.png", fileName: "1.png", previewUrl: "file:///C:/素材/1.png" },
      transient: { mode: "replace", file: { data: "huge" }, previewUrl: "blob:temporary" } } };
  const saved = JSON.parse(serializeDraft(draft));
  assert.ok(isSavedDraft(saved));
  assert.equal(saved.profileVersion, 19);
  assert.equal(saved.mediaOverrides.image!.localPath, "C:/素材/1.png");
  assert.equal(saved.mediaOverrides.transient!.file, undefined);
  assert.equal(saved.mediaOverrides.transient!.previewUrl, undefined);
  assert.equal(saved.mediaOverrides.transient!.mode, "replace");
  assert.equal(isSavedDraft({ workflowId: "x" }), false);
});
