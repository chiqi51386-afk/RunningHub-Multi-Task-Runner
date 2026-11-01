import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { existingUserDataPath, hasUnfinishedWork } from "../src/desktop/installerPolicy.js";

test("NSIS uses the legacy data path, not the product or install directory", () => {
  for (const root of ["C:/Users/Frank/AppData/Roaming", "C:/Users/中文 用户/AppData/Roaming"]) {
    assert.equal(existingUserDataPath(root), path.join(root, "runninghub-multi-task-runner-core"));
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "runninghub-multi-task-runner-core");
  assert.equal(pkg.build.appId, "ai.runninghub.runner");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(pkg.build.win.target[0].target, "nsis");
  assert.match(pkg.scripts["release:win"], /--publish never/);
});

test("all unfinished phases block installer restart, including unknown phases", () => {
  for (const status of ["OPTIMIZE_PENDING", "OPTIMIZING", "PENDING", "ASSIGNED", "UPLOADING",
    "SUBMITTING", "SUBMIT_UNKNOWN", "REMOTE_QUEUED", "RUNNING", "REMOTE_SUCCESS",
    "DOWNLOAD_PENDING", "DOWNLOADING", "RETRY_WAIT", "FUTURE_STATUS"]) {
    assert.equal(hasUnfinishedWork([status], 0), true, status);
  }
  assert.equal(hasUnfinishedWork(["COMPLETED", "FAILED", "CANCELLED"], 0), false);
  assert.equal(hasUnfinishedWork([], 1), true);
  assert.equal(hasUnfinishedWork([], 0), false);
});
