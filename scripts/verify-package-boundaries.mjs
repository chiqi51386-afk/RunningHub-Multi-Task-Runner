import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: process.platform === "win32" }));
const files = result[0]?.files?.map(item => String(item.path).replaceAll("\\", "/")) ?? [];
const prohibited = files.filter(file => file === "_reference" || file.startsWith("_reference/") || file === "work" || file.startsWith("work/") || file.startsWith("outputs/") || file.includes("node_modules/") || /(^|\/)\.env(?:\.|$)|\.sqlite(?:-|$)/i.test(file));
if (prohibited.length) {
  console.error(`Packaging boundary violation:\n${prohibited.join("\n")}`);
  process.exitCode = 1;
} else {
  const workflowFiles = readdirSync("bundled-workflows").filter(file => file.endsWith(".rhworkflow.json"));
  if (workflowFiles.length !== 4) throw new Error(`Expected 4 bundled workflows, found ${workflowFiles.length}.`);
  for (const file of workflowFiles) {
    const portable = JSON.parse(readFileSync(`bundled-workflows/${file}`, "utf8"));
    const inputParameters = portable.profile?.parameters?.filter(parameter => ["prompt", "image", "video", "audio"].includes(parameter.semanticType)) ?? [];
    if (!inputParameters.length || inputParameters.some(parameter => parameter.defaultValue !== "")) {
      throw new Error(`Bundled workflow contains prompt/media defaults: ${file}`);
    }
  }
  console.log(`Package boundary verified: ${files.length} files; 4 clean workflows included; local data and reference directories excluded.`);
}
