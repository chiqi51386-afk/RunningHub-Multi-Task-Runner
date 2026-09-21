import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CoreDatabase } from "../src/core/database.js";
import { BackendEvents } from "../src/core/events.js";
import { InMemorySecretStore } from "../src/core/secretStore.js";
import { Workflows } from "../src/core/workflows/workflows.js";
import { createCleanPortableWorkflowPackage } from "../src/core/workflows/package.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("portable workflow package preserves reviewed profile settings across databases", async () => {
  const sourceDb = new CoreDatabase(":memory:", new InMemorySecretStore());
  const source = new Workflows(sourceDb, new BackendEvents());
  const imported = source.importApiJson({
    name: "Portable H3",
    runningHubWorkflowId: "2093983063180054529",
    sourceUrl: "https://www.runninghub.ai/zh-cn/post/2093983063180054529",
    workflow: await fixture("workflow-h3.json"),
  });
  const reviewedParameters = imported.profile.parameters.map((parameter, index) => index === 0
    ? { ...parameter, nodeTitle: "已人工修正", visible: false, showEnableToggle: false }
    : parameter);
  const reviewed = source.updateProfile(imported.id, {
    ...imported.profile,
    functionDescription: "多参考图视频生成",
    usageInstructions: "上传参考图并填写生成词。",
    parameters: reviewedParameters,
  });
  const portable = source.exportPortablePackage(reviewed.id, "test");

  assert.equal("workflowId" in portable.profile, false);
  assert.equal(portable.workflow.sourceUrl, "https://www.runninghub.ai/zh-cn/post/2093983063180054529");

  const targetDb = new CoreDatabase(":memory:", new InMemorySecretStore());
  const target = new Workflows(targetDb, new BackendEvents());
  const restored = target.importPortablePackage(portable);
  assert.equal(restored.sourceUrl, portable.workflow.sourceUrl);
  assert.equal(restored.profile.parameters[0]?.nodeTitle, "已人工修正");
  assert.equal(restored.profile.parameters[0]?.visible, false);
  assert.equal(restored.profile.parameters[0]?.showEnableToggle, false);
  assert.equal(restored.profile.functionDescription, "多参考图视频生成");
  assert.equal(restored.profile.usageInstructions, "上传参考图并填写生成词。");
  assert.deepEqual(restored.profile.outputs, reviewed.profile.outputs);
  sourceDb.close();
  targetDb.close();
});

test("portable workflow package rejects modified API JSON", async () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const workflows = new Workflows(db, new BackendEvents());
  const imported = workflows.importApiJson({
    name: "Tamper test",
    runningHubWorkflowId: "2093983063180054529",
    workflow: await fixture("workflow-simple.json"),
  });
  const portable = workflows.exportPortablePackage(imported.id);
  portable.workflow.apiJson["tampered"] = { class_type: "Text", inputs: { text: "changed" } };
  assert.throws(() => workflows.importPortablePackage(portable), /workflowHash/);
  db.close();
});

test("clean bundled package removes prompt and media defaults", async () => {
  const db = new CoreDatabase(":memory:", new InMemorySecretStore());
  const workflows = new Workflows(db, new BackendEvents());
  const imported = workflows.importApiJson({
    name: "Clean defaults",
    runningHubWorkflowId: "2093983063180054529",
    workflow: await fixture("workflow-h3.json"),
  });
  const portable = createCleanPortableWorkflowPackage(imported);
  const inputParameters = portable.profile.parameters.filter(parameter => ["prompt", "image", "video", "audio"].includes(parameter.semanticType));
  assert.ok(inputParameters.length > 1);
  assert.ok(inputParameters.every(parameter => parameter.defaultValue === ""));
  for (const parameter of inputParameters) {
    const node = portable.workflow.apiJson[parameter.nodeId] as { inputs: Record<string, unknown> };
    assert.equal(node.inputs[parameter.fieldName], "");
  }
  const restored = workflows.importPortablePackage(portable);
  assert.ok(restored.profile.parameters.filter(parameter => ["prompt", "image", "video", "audio"].includes(parameter.semanticType)).every(parameter => parameter.defaultValue === ""));
  db.close();
});

test("Chinese 生成词 in an older portable profile is repaired to prompt on import", () => {
  const sourceDb = new CoreDatabase(":memory:", new InMemorySecretStore());
  const source = new Workflows(sourceDb, new BackendEvents());
  const imported = source.importApiJson({
    name: "中文生成词",
    runningHubWorkflowId: "2101869007837089794",
    workflow: {
      "325": {
        class_type: "Text",
        inputs: { text: "时长8秒。镜头从人物中景开始，随后切换到面部近景并保持自然表演。" },
        _meta: { title: "原始生成词输入（直连Qwen）" },
      },
    },
  });
  assert.equal(imported.profile.parameters[0]?.semanticType, "prompt");

  const portable = source.exportPortablePackage(imported.id);
  portable.profile.parameters[0] = {
    ...portable.profile.parameters[0]!, id: "325_text", semanticType: "unknown", confidence: 0.2, visible: false,
  };
  portable.profile.genericParameters = structuredClone(portable.profile.parameters);

  const targetDb = new CoreDatabase(":memory:", new InMemorySecretStore());
  const target = new Workflows(targetDb, new BackendEvents());
  const restored = target.importPortablePackage(portable);
  assert.equal(restored.profile.parameters[0]?.id, "325_text");
  assert.equal(restored.profile.parameters[0]?.semanticType, "prompt");
  assert.equal(restored.profile.parameters[0]?.visible, true);
  assert.equal(restored.profile.genericParameters.length, 0);
  sourceDb.close();
  targetDb.close();
});
