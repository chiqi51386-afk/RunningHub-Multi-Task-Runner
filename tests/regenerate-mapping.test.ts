import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { regenerateDraft } from "../frontend/src/regenerate-draft.js";
import type { JobInputSnapshotView, WorkflowView } from "../frontend/src/types.js";
import { parsePortableWorkflowPackage, materializePortableProfile } from "../src/core/workflows/package.js";
import { resolveMediaInputs } from "../src/core/workflows/mediaInputs.js";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";
for (const file of readdirSync("bundled-workflows").filter(name => name.endsWith(".json"))) {
  test(`regenerate reordered IDs: ${file}`, () => {
    const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync(`bundled-workflows/${file}`, "utf8")));
    const profile = materializePortableProfile(pkg, "workflow", 23);
    const workflow = { id: "workflow", profileVersion: 23, parameters: profile.parameters } as WorkflowView;
    const media = profile.parameters.filter(p => ["image", "audio", "video"].includes(p.valueType));
    const input: JobInputSnapshotView = { workflowId: "workflow", profileVersion: 19, instanceType: "default",
      parameters: profile.parameters.filter(p => p.visible !== false && !media.includes(p)).map(p => ({ id: `old-${p.id}`, key: p.key, semanticType: p.semanticType, label: p.key, value: p.semanticType === "prompt" ? "EXACT_PROMPT" : p.defaultValue })),
      media: [...media].reverse().map((p, i) => ({ parameterId: media[i]!.id, key: p.key, type: p.valueType as "image" | "audio" | "video", label: p.key, mode: "replace", localPath: `C:/test/${p.key}.input` })),
    };
    const draft = regenerateDraft(input, workflow);
    const resolved = resolveMediaInputs(profile, draft.parameterValues, draft.mediaOverrides);
    const nodes = buildNodeInfoList(profile, resolved.parameters, resolved.media.map(m => ({ ...m, uploadedValue: `uploaded:${m.localPath}` })));
    for (const p of media) assert.equal(nodes.find(n => n.nodeId === p.nodeId && n.fieldName === p.fieldName)?.fieldValue, `uploaded:C:/test/${p.key}.input`);
    for (const p of input.parameters) {
      const target = profile.parameters.find(item => item.key === p.key)!;
      if (p.semanticType !== "negative_prompt") assert.deepEqual(draft.parameterValues[target.id], p.value);
    }
    const bad = structuredClone(input);
    bad.media[0]!.key = "missing.image";
    assert.throws(() => regenerateDraft(bad, workflow), /缺失或重复/);
    bad.media[0] = { ...input.media[0]!, mode: "default" };
    assert.throws(() => regenerateDraft(bad, workflow), /云端默认素材/);
  });
}
