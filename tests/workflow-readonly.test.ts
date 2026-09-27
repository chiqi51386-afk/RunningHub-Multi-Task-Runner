import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bundled workflow view routes never expose mutation controls", () => {
  const app = readFileSync("frontend/src/App.tsx", "utf8");
  for (const section of ["parameters", "outputs", "visibility"]) assert.ok(app.includes(`section="${section}"`));
  assert.ok(!app.includes('disabled={workflow.builtIn} onClick={() => setEditing'));
  const view = readFileSync("frontend/src/WorkflowReadOnlyModal.tsx", "utf8");
  assert.ok(view.includes("默认工作流 · 只读"));
  assert.ok(!/onSave|updateProfile|<input|<textarea/.test(view));
  assert.ok(view.includes("parameter.defaultValue"));
  assert.ok(view.includes("output.nodeId"));
  assert.ok(view.includes("parameter.visible"));
});
