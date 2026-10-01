import assert from "node:assert/strict";
import test from "node:test";
import { isNewerVersion, parseLatestRelease, updateRepositoryUrl, latestReleaseApiUrls, trustedUpdateAssetPrefixes } from "../src/desktop/updates.js";

test("updates use only the personal repository, never the organization fallback", () => {
  assert.deepEqual(latestReleaseApiUrls, ["https://api.github.com/repos/chiqi51386-afk/RunningHub-Multi-Task-Runner/releases/latest"]);
  assert.deepEqual(trustedUpdateAssetPrefixes, ["/chiqi51386-afk/RunningHub-Multi-Task-Runner/releases/download/"]);
});

test("update version comparison handles normal semantic versions", () => {
  assert.equal(isNewerVersion("0.1.3", "0.1.2"), true);
  assert.equal(isNewerVersion("v0.1.2", "0.1.2"), false);
  assert.equal(isNewerVersion("0.1.1", "0.1.2"), false);
});

test("release versions cannot escape the update directory", () => {
  for (const tag of ["v9-../../../../data", "v9-..\\..\\data", "v9-foo/bar", "v9-foo:bar", "v9-foo\n"]) {
    assert.throws(() => parseLatestRelease({ tag_name: tag }, "0.1.0"), /有效版本号/);
  }
});

test("update package must match the release tag exactly", () => {
  const result = parseLatestRelease({ tag_name: "v0.1.49", assets: [null,
    { name: "RunningHub-Runner-v0.1.48-windows-x64.zip" }] }, "0.1.47");
  assert.equal(result.assetName, undefined);
});

test("GitHub release parsing selects the official Windows package", () => {
  const result = parseLatestRelease({
    tag_name: "v0.1.3",
    html_url: `${updateRepositoryUrl}/releases/tag/v0.1.3`,
    published_at: "2026-09-21T00:00:00Z",
    assets: [
      { name: "source.zip", browser_download_url: "https://example.invalid/source.zip" },
      {
        name: "RunningHub-Runner-v0.1.3-windows-x64.zip",
        browser_download_url: "https://example.invalid/app.zip",
        digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        size: 123456,
      },
    ],
  }, "0.1.2");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, "0.1.3");
  assert.equal(result.assetName, "RunningHub-Runner-v0.1.3-windows-x64.zip");
  assert.equal(result.assetUrl, "https://example.invalid/app.zip");
  assert.equal(result.assetDigest, "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.equal(result.assetSize, 123456);
});
