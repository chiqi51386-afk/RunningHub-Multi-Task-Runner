import assert from "node:assert/strict";
import test from "node:test";
import { outputFilename, namingRule, shortOutputPath } from "../src/core/downloads/naming.js";

test("short names use persisted identity and fixed segment order", () => {
  const input = {identity:{task:9,group:2,date:'20260927'}, production:{segmentIndex:3},rule:'workflow-date' as const,workflow:'H3数字人MV',index:0,total:1,url:'https://example.test/a.mp4',extension:'mp4'};
  assert.equal(shortOutputPath(input),'MV_20260927_002/003.mp4');
  assert.equal(shortOutputPath({...input,total:2,index:1}),'MV_20260927_002/003_02.mp4');
  assert.equal(shortOutputPath({...input,production:undefined}),'20260927_H3数字人MV_009.mp4');
  assert.notEqual(shortOutputPath(input),shortOutputPath({...input,identity:{...input.identity,group:3}}));
});
const input = { rule: "workflow-date" as const, createdAt: new Date(2026, 8, 25, 13, 4, 5).getTime(), workflow: "H3 / 中文", jobId: "aabbccdd-1122-3344-5566-778899001122", index: 0, url: "https://example.test/video.mp4?token=secret", extension: "mp4" };
test("download filenames are deterministic, unicode-safe and contain task/output identity", () => {
  const name = outputFilename(input);
  assert.match(name, /^20260925-130405_H3 _ 中文_/);
  assert.ok(name.endsWith("_01.mp4"));
  assert.equal(outputFilename(input), name);
  assert.notEqual(outputFilename({ ...input, index: 1 }), name);
  assert.notEqual(outputFilename({ ...input, jobId: "other-task" }), name);
  assert.doesNotMatch(name, /[<>:"/\\|?*]/);
});
test("original names cannot escape output directory or leak query strings", () => {
  const name = outputFilename({ ...input, rule: "original", url: "https://example.test/%2e%2e%2fCON.mp4?token=secret" });
  assert.doesNotMatch(name, /[\\/]|secret|token/);
  assert.ok(name.endsWith(".mp4"));
  assert.equal(namingRule("invalid"), "workflow-date");
});
test("date preset excludes workflow name and extensions are constrained", () => {
  const name = outputFilename({ ...input, rule: "date", extension: "../../exe" });
  assert.doesNotMatch(name, /H3/);
  assert.ok(name.endsWith(".bin"));
});
