import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePortableWorkflowPackage, materializePortableProfile } from "../src/core/workflows/package.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";
import { createDraft, cloneDraft, prepareDraft } from "../frontend/src/task-draft.js";
import { serializeDraft, restoreDraft } from "../frontend/src/draft-storage.js";
import { createModeForWorkflow, isPromptOptimizationControl, migrateParameterView } from "../frontend/src/workflow-view.js";
import type { WorkflowView } from "../frontend/src/types.js";

for (const [file, id, promptNode, field, consumer] of [
  ["minimax-h3-multi-reference", "2104088262948556801", "325", "text", "265"],
  ["minimax-h3-selflift", "2104087390590894081", "232", "value", "136"],
]) {
  test(file + ": optimizer switch maps independently and defaults off", () => {
    const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync(`bundled-workflows/${file}.rhworkflow.json`, "utf8")));
    const profile = materializePortableProfile(pkg, file!, 1);
    const view = { id: file, name: pkg.workflow.name, runningHubWorkflowId: id, profileVersion: 1, parameters: profile.parameters } as WorkflowView;
    assert.equal(pkg.workflow.runningHubWorkflowId, id);
    assert.equal(createModeForWorkflow(view), "h3-multi-reference");
    const raw = pkg.workflow.apiJson as Record<string, { inputs: Record<string, unknown> }>;
    assert.equal(raw["328"]!.inputs.value, false);
    assert.deepEqual(raw["327"]!.inputs.boolean, ["328", 0]);
    assert.deepEqual(raw["327"]!.inputs.on_false, [promptNode, 0]);
    assert.deepEqual(raw["327"]!.inputs.on_true, ["323", 0]);
    assert.deepEqual(raw["323"]!.inputs.prompt, [promptNode, 0]);
    assert.deepEqual(raw[consumer!]!.inputs.prompt, ["327", 0]);
    const control = view.parameters.find(isPromptOptimizationControl)!;
    assert.ok(control);
    assert.equal(migrateParameterView(control).semanticType, "unknown");
    const prompts = profile.parameters.filter(p => p.visible && p.semanticType === "prompt");
    assert.equal(prompts.length, 1);
    const off = createDraft(view);
    off.parameterValues[prompts[0]!.id] = "USER PROMPT";
    const on = cloneDraft(off);
    on.parameterValues[control.id] = true;
    for (const [draft, expected] of [[off, false], [on, true]] as const) {
      const restored = restoreDraft(JSON.parse(serializeDraft(draft)), [view], view, () => {});
      const prepared = prepareDraft(restored, view, "h3-multi-reference");
      const nodes = buildNodeInfoList(profile, prepared.parameterValues);
      assert.equal(nodes.find(n => n.nodeId === "328" && n.fieldName === "value")?.fieldValue, expected);
      assert.equal(nodes.find(n => n.nodeId === promptNode && n.fieldName === field)?.fieldValue, "USER PROMPT");
    }
    assert.equal(off.parameterValues[control.id], false);
  });
}
