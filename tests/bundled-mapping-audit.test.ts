import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parsePortableWorkflowPackage, materializePortableProfile } from "../src/core/workflows/package.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";
import { resolveMediaInputs } from "../src/core/workflows/mediaInputs.js";
import { createDraft, prepareDraft, visibleMedia } from "../frontend/src/task-draft.js";
import type { WorkflowView } from "../frontend/src/types.js";

for (const file of readdirSync("bundled-workflows").filter(file => file.endsWith(".json"))) {
  test(`full input mapping: ${file}`, () => {
    const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync(`bundled-workflows/${file}`, "utf8")));
    const profile = materializePortableProfile(pkg, file, 1, 1, 1);
    const raw = pkg.workflow.apiJson as Record<string, { inputs: Record<string, unknown> }>;
    const targets = new Set<string>();
    for (const p of profile.parameters) {
      assert.ok(raw[p.nodeId] && Object.hasOwn(raw[p.nodeId]!.inputs, p.fieldName), p.key);
      assert.ok(!targets.has(`${p.nodeId}.${p.fieldName}`), `duplicate target ${p.key}`);
      targets.add(`${p.nodeId}.${p.fieldName}`);
    }
    const view = { id: file, profileVersion: 1, parameters: profile.parameters } as WorkflowView;
    const mode = file.includes("minimax") ? "h3-multi-reference" : "digital-human";
    const prompts = profile.parameters.filter(p => p.visible !== false && p.semanticType === "prompt");
    assert.equal(prompts.length, 1);
    const media = visibleMedia(view, mode);
    // Verify visible content loaders reach an output through the exported graph.
    const downstream = new Map<string, Set<string>>();
    const visit = (value: unknown, consumer: string): void => {
      if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[1]) && raw[String(value[0])]) {
        const source = String(value[0]);
        downstream.set(source, (downstream.get(source) ?? new Set()).add(consumer));
      } else if (value && typeof value === "object") Object.values(value).forEach(child => visit(child, consumer));
    };
    for (const [id, node] of Object.entries(raw)) visit(node.inputs, id);
    const outputs = new Set(profile.outputs.map(output => output.nodeId));
    for (const p of [...prompts, ...media]) {
      const pending = [p.nodeId], seen = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...(downstream.get(id) ?? []));
      }
      assert.ok([...seen].some(id => outputs.has(id)), `Disconnected content: ${p.key}`);
    }
    if (mode === "h3-multi-reference") assert.deepEqual(media.map(p => p.nodeId), file.includes("selflift")
      ? ["150", "164", "239", "241", "240", "238"] : ["51", "49", "50", "43", "19", "23"]);
    for (const count of [0, 1, media.length]) {
      const draft = createDraft(view);
      draft.parameterValues[prompts[0]!.id] = "MAPPING_AUDIT_UNIQUE_PROMPT";
      media.slice(0, count).forEach((p, index) => { draft.mediaOverrides[p.id] = { enabled: true, mode: "replace", localPath: `slot-${index + 1}` }; });
      const prepared = prepareDraft(draft, view, mode);
      const resolved = resolveMediaInputs(profile, prepared.parameterValues, prepared.mediaOverrides);
      const nodes = buildNodeInfoList(profile, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: `uploaded/${m.localPath}` })));
      const value = (nodeId: string, fieldName: string) => nodes.find(n => n.nodeId === nodeId && n.fieldName === fieldName)?.fieldValue;
      assert.equal(value(prompts[0]!.nodeId, prompts[0]!.fieldName), "MAPPING_AUDIT_UNIQUE_PROMPT");
      for (const p of profile.parameters.filter(p => ["image", "audio", "video"].includes(p.valueType))) {
        const index = media.findIndex(m => m.id === p.id);
        assert.equal(value(p.nodeId, p.fieldName), index >= 0 && index < count ? `uploaded/slot-${index + 1}` : "", p.key);
      }
      for (const n of nodes) assert.ok(Object.hasOwn(raw[n.nodeId]!.inputs, n.fieldName));
    }
    console.log(JSON.stringify({ workflow: file, fields: profile.parameters.length, prompt: prompts.map(p => p.key), imageOrder: media.map(p => p.key) }));
  });
}
