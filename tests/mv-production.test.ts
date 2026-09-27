import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productionOutputPath } from "../src/core/downloads/naming.js";

test("MV filenames sort by segment, not completion order or random job ID", () => {
  const paths = [10, 2, 1].map(segmentIndex => productionOutputPath({groupId: "group-a", segmentIndex}, `job-${20-segmentIndex}`, 0, "mp4"));
  assert.deepEqual(paths.sort().map(p => p.split('/')[1]!.slice(0, 4)), ['0001', '0002', '0010']);
  const first = productionOutputPath({groupId: "group-a", segmentIndex: 2}, 'job', 0, 'mp4');
  assert.equal(first, productionOutputPath({groupId: "group-a", segmentIndex: 2}, 'job', 0, 'mp4'));
  assert.notEqual(first, productionOutputPath({groupId: "group-b", segmentIndex: 2}, 'job', 0, 'mp4'));
  assert.notEqual(first, productionOutputPath({groupId: "group-a", segmentIndex: 2}, 'job', 1, 'mp4'));
  assert.throws(() => productionOutputPath({groupId: '../escape', segmentIndex: 1}, 'job', 0, 'mp4'));
});
test("MV editor has no queued/submitted state; regeneration replaces instead of appending", () => {
  const source = readFileSync('frontend/src/MvWorkspace.tsx', 'utf8');
  assert.ok(!/\.queued|\.submitted|queuedBatchId|completedBatchIds/.test(source));
  assert.ok(source.includes('const pending = segments;'));
  assert.ok(source.includes('setSegments([makeSegment(editRequest.draft)])'));
  assert.ok(!source.includes('[...current, makeSegment(editRequest.draft)]'));
  assert.ok(!source.includes("previousDraft"));
  assert.ok(!source.includes("恢复重新生成前的草稿"));
  assert.ok(source.includes("function clearAllInputs()"));
  assert.ok(source.includes("setSegments([0, 10].map(start =>"));
});
