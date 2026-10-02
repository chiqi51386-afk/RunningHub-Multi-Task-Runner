import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

test("license inventory accepts Windows CRLF but rejects changed dependency content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rh-license-test-"));
  try {
    for (const folder of ["scripts", "frontend", "THIRD_PARTY_LICENSES"]) await mkdir(path.join(dir, folder));
    for (const file of ["scripts/generate-third-party-licenses.mjs", "package-lock.json", "frontend/package-lock.json", "THIRD_PARTY_LICENSES/NPM_DEPENDENCIES.md"]) {
      await copyFile(file, path.join(dir, file));
    }
    const inventory = path.join(dir, "THIRD_PARTY_LICENSES/NPM_DEPENDENCIES.md");
    const content = (await readFile(inventory, "utf8")).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    await writeFile(inventory, content);
    assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/generate-third-party-licenses.mjs", "--check"], { cwd: dir, stdio: "pipe" }));
    await writeFile(inventory, content.replace("better-sqlite3", "changed-package"));
    assert.throws(() => execFileSync(process.execPath, ["scripts/generate-third-party-licenses.mjs", "--check"], { cwd: dir, stdio: "pipe" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
