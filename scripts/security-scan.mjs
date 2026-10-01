// Local read-only screening. Never prints matching secret values.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["provider-token", /\bsk-[A-Za-z0-9_-]{24,}\b/g],
  ["credential-url", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s/@]+@/g],
];
const matches = [];
function scan(label, content) {
  for (const [kind, regex] of patterns) {
    regex.lastIndex = 0;
    for (const match of content.matchAll(regex)) matches.push({ file: label, line: content.slice(0, match.index).split("\n").length, kind });
  }
}
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of files) {
  try { scan(file, readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
let generated = 0;
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else if (/\.(?:js|cjs|json|html|css|map)$/.test(file)) { generated++; scan(file, readFileSync(file, "utf8")); }
  }
}
for (const dir of ["dist", "frontend/dist"]) walk(dir);
let historyBlobs = 0;
if (process.argv.includes("--history")) {
  const ids = execFileSync("git", ["rev-list", "--objects", "--all"], { encoding: "utf8" }).split("\n").filter(Boolean).map(line => line.split(" ")[0]);
  const metadata = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: ids.join("\n") + "\n", encoding: "utf8" });
  for (const line of metadata.trim().split("\n")) {
    const [id, type] = line.split(" ");
    if (type !== "blob") continue;
    historyBlobs++;
    scan(`git-blob:${id}`, execFileSync("git", ["cat-file", "blob", id], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }));
  }
}
console.log(JSON.stringify({ workingTreeFiles: files.length, generatedFiles: generated, historyBlobs, matches, limitation: "Pattern-based only; no proof that opaque keys, unreachable commits or external backups are absent." }, null, 2));
if (matches.length) process.exitCode = 1;
