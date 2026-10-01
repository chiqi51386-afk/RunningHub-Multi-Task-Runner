export const updateRepositoryUrl = "https://github.com/chiqi51386-afk/RunningHub-Multi-Task-Runner";
export const latestReleaseUrl = `${updateRepositoryUrl}/releases/latest`;
export const latestReleaseApiUrl = "https://api.github.com/repos/chiqi51386-afk/RunningHub-Multi-Task-Runner/releases/latest";
export const latestReleaseApiUrls = [
  latestReleaseApiUrl,
] as const;
export const trustedUpdateAssetPrefixes = [
  "/chiqi51386-afk/RunningHub-Multi-Task-Runner/releases/download/",
] as const;

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
  size?: unknown;
}

interface GithubReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  repositoryUrl: string;
  releaseUrl: string;
  publishedAt?: string;
  assetName?: string;
  assetUrl?: string;
  assetDigest?: string;
  assetSize?: number;
}

export interface UpdateProgress {
  stage: "downloading" | "verifying" | "extracting" | "restarting";
  percent: number;
  message: string;
}

function versionParts(value: string): number[] {
  const version = value.trim().replace(/^v/i, "");
  // The release version also becomes a local update-directory component.
  // Validate the whole value, not merely the part preceding a hyphen.
  if (!/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) return [];
  const clean = version.split("-")[0]!;
  return clean.split(".").map(part => Number(part));
}

export function isNewerVersion(latest: string, current: string): boolean {
  const left = versionParts(latest);
  const right = versionParts(current);
  if (!left.length || !right.length) return false;
  for (let index = 0; index < Math.max(left.length, right.length, 3); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function parseLatestRelease(payload: unknown, currentVersion: string): UpdateInfo {
  if (!payload || typeof payload !== "object") throw new Error("GitHub 返回的更新信息格式无效。");
  const release = payload as GithubReleasePayload;
  const latestVersion = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/i, "") : "";
  if (latestVersion !== latestVersion.trim() || !versionParts(latestVersion).length) throw new Error("最新 Release 缺少有效版本号。");
  const assets = Array.isArray(release.assets) ? release.assets as GithubReleaseAsset[] : [];
  const asset = assets.find(item => item?.name === `RunningHub-Runner-v${latestVersion}-windows-x64.zip`);
  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    repositoryUrl: updateRepositoryUrl,
    releaseUrl: typeof release.html_url === "string" ? release.html_url : latestReleaseUrl,
    publishedAt: typeof release.published_at === "string" ? release.published_at : undefined,
    assetName: typeof asset?.name === "string" ? asset.name : undefined,
    assetUrl: typeof asset?.browser_download_url === "string" ? asset.browser_download_url : undefined,
    assetDigest: typeof asset?.digest === "string" ? asset.digest : undefined,
    assetSize: typeof asset?.size === "number" && Number.isFinite(asset.size) && asset.size > 0 ? asset.size : undefined,
  };
}
