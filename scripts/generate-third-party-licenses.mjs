import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sources = [
  { label: "core", path: path.join(root, "package-lock.json") },
  { label: "frontend", path: path.join(root, "frontend", "package-lock.json") },
];
const rows = [];
for (const source of sources) {
  const lock = JSON.parse(await readFile(source.path, "utf8"));
  const directRuntime = new Set(Object.keys(lock.packages?.[""]?.dependencies ?? {}));
  const directDev = new Set(Object.keys(lock.packages?.[""]?.devDependencies ?? {}));
  for (const [key, metadata] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    const name = key.slice("node_modules/".length);
    const scope = directRuntime.has(name) ? "direct/runtime" : directDev.has(name) ? "direct/development" : metadata.dev ? "transitive/development" : "transitive/runtime";
    rows.push({ source: source.label, name, version: metadata.version ?? "unknown", license: metadata.license ?? "UNDECLARED", scope });
  }
}
rows.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.source.localeCompare(right.source));
const generated = [
  "# npm dependency license inventory",
  "",
  "> Generated from `package-lock.json` and `frontend/package-lock.json` by `npm run licenses:generate`.",
  "> Package metadata is an inventory aid; retain upstream license files when producing a distributable build.",
  "",
  "| Package | Version | License | Scope | Lockfile |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(row => `| ${escapeCell(row.name)} | ${escapeCell(row.version)} | ${escapeCell(row.license)} | ${row.scope} | ${row.source} |`),
  "",
].join("\n");
const output = path.join(root, "THIRD_PARTY_LICENSES", "NPM_DEPENDENCIES.md");
if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("THIRD_PARTY_LICENSES/NPM_DEPENDENCIES.md is stale. Run npm run licenses:generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(output, generated, "utf8");
  console.log(`Wrote ${path.relative(root, output)} with ${rows.length} package entries.`);
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
