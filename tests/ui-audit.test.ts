import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("job UI exposes structured errors, text outputs, stage progress, and download cancellation", async () => {
  const app = await readFile(path.join(root, "frontend/src/App.tsx"), "utf8");
  const desktop = await readFile(path.join(root, "src/desktop/main.ts"), "utf8");
  assert.match(app, /查看错误详情/);
  assert.match(app, /文本输出/);
  assert.match(app, /progress indeterminate/);
  assert.match(app, /取消下载/);
  assert.doesNotMatch(desktop, /progressByStatus/);
  assert.match(desktop, /stageLabel: stageByStatus/);
});

test("create page keeps its batch panel sticky only on desktop and prompt preview is 190px", async () => {
  const css = await readFile(path.join(root, "frontend/src/styles.css"), "utf8");
  assert.match(css, /\.topbar\s*\{[^}]*height:\s*68px/);
  assert.match(css, /\.create-sidebar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*84px;[^}]*max-height:[^}]*overflow-y:\s*auto/);
  assert.match(css, /@media \(max-width:\s*1080px\)[\s\S]*?\.create-sidebar\s*\{[^}]*position:\s*static;[^}]*max-height:\s*none;[^}]*overflow:\s*visible/);
  assert.match(css, /\.snapshot-parameter-list p\s*\{[^}]*max-height:\s*150px/);
  assert.match(css, /\.snapshot-parameter-list > div\.prompt p\s*\{[^}]*max-height:\s*190px/);
});

test("workflow editor keeps Workflow ID read-only and parameter renderer avoids empty select", async () => {
  const app = await readFile(path.join(root, "frontend/src/App.tsx"), "utf8");
  assert.match(app, /Workflow ID<input[^>]*readOnly/);
  assert.match(app, /parameter\.valueType === "select" && parameter\.options\?\.length/);
  assert.match(app, /parameter\.valueType === "json"/);
  assert.match(app, /JSON 尚未完成：请修正格式后再提交/);
});
