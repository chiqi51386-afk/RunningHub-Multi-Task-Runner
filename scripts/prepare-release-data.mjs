import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CoreDatabase } from "../dist/src/core/database.js";
import { BackendEvents } from "../dist/src/core/events.js";
import { PlainTextSecretStore } from "../dist/src/core/secretStore.js";
import { createCleanPortableWorkflowPackage } from "../dist/src/core/workflows/package.js";
import { Workflows } from "../dist/src/core/workflows/workflows.js";

const databasePath = process.argv[2];
const outputDirectory = path.resolve(process.argv[3] ?? "bundled-workflows");
if (!databasePath) throw new Error("Usage: node scripts/prepare-release-data.mjs <database-path> [output-directory]");

const expected = new Map([
  ["2093983063180054529", "minimax-h3-multi-reference.rhworkflow.json"],
  ["2101869007837089794", "minimax-h3-chinese-prompt.rhworkflow.json"],
  ["2100933451562491906", "infinitetalk-digital-human.rhworkflow.json"],
  ["2101727071255941122", "ltx-2.3-digital-human.rhworkflow.json"],
]);

const database = new CoreDatabase(path.resolve(databasePath), new PlainTextSecretStore());
const workflows = new Workflows(database, new BackendEvents());
const records = workflows.list().filter(workflow => expected.has(workflow.runningHubWorkflowId));
if (records.length !== expected.size) {
  const present = records.map(workflow => workflow.runningHubWorkflowId).join(", ");
  database.close();
  throw new Error(`Expected ${expected.size} release workflows, found ${records.length}: ${present}`);
}

await mkdir(outputDirectory, { recursive: true });
for (const record of records) {
  const portable = createCleanPortableWorkflowPackage(record, "0.1.0");
  workflows.importPortablePackage(portable);
  const file = expected.get(record.runningHubWorkflowId);
  await writeFile(path.join(outputDirectory, file), `${JSON.stringify(portable, null, 2)}\n`, "utf8");
}

database.transaction(() => {
  const now = Date.now();
  database.raw.prepare(`
    UPDATE accounts SET current_job_id = NULL,
      state = CASE WHEN enabled = 1 AND manual_disabled = 0 THEN 'IDLE' ELSE 'DISABLED' END,
      updated_at = ?
  `).run(now);
  database.raw.prepare("DELETE FROM jobs").run();
});

console.log(`Prepared ${records.length} clean bundled workflows and cleared local job records.`);
database.close();
