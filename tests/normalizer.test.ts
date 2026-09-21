import assert from "node:assert/strict";
import test from "node:test";
import { extractUploadValue, normalizeRunningHubResponse } from "../src/core/index.js";

test("response normalizer accepts task, status, error, result, and usage variants", () => {
  const normalized = normalizeRunningHubResponse({
    data: {
      task_id: "task-1", status: "success", usage: { consumeCoins: 3 },
      results: [
        { fileUrl: "https://cdn/video.mp4", fileType: "video" },
        { outputUrl: "https://cdn/image.png", outputType: "image" },
        { content: "done" },
      ],
    },
    error_code: 805,
    error_message: "node failed",
    failed_reason: { nodeId: "252" },
  });
  assert.equal(normalized.taskId, "task-1");
  assert.equal(normalized.status, "SUCCESS");
  assert.equal(normalized.errorCode, "805");
  assert.equal(normalized.errorMessage, "node failed");
  assert.deepEqual(normalized.files.map(file => file.url), ["https://cdn/video.mp4", "https://cdn/image.png"]);
  assert.deepEqual(normalized.texts, ["done"]);
  assert.deepEqual(normalized.usage, { consumeCoins: 3 });
});

test("upload normalizer prefers RunningHub workflow fileName and supports documented URL", () => {
  assert.equal(extractUploadValue({ code: 0, data: { fileName: "input/a.png", download_url: "https://cdn/a.png" } }), "input/a.png");
  assert.equal(extractUploadValue({ code: 0, data: { filename: "input/b.png" } }), "input/b.png");
  assert.equal(extractUploadValue({ code: 0, data: { download_url: "https://cdn/c.png" } }), "https://cdn/c.png");
});
