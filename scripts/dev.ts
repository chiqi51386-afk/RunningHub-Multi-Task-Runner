import { readFile } from "node:fs/promises";
import { RunningHubBackend } from "../src/core/index.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const backend = new RunningHubBackend();
  try {
    if (command === "accounts") {
      console.log(JSON.stringify(backend.accounts.list(), null, 2));
    } else if (command === "jobs") {
      console.log(JSON.stringify(backend.jobs.list(), null, 2));
    } else if (command === "import-workflow") {
      const [file, runningHubWorkflowId, name = "Imported Workflow"] = args;
      if (!file || !runningHubWorkflowId) throw new Error("Usage: npm run dev -- import-workflow <api.json> <workflowId> [name]");
      const workflow = JSON.parse(await readFile(file, "utf8"));
      console.log(JSON.stringify(backend.workflows.importApiJson({ name, runningHubWorkflowId, workflow }), null, 2));
    } else if (command === "run") {
      backend.events.on("job.updated", job => console.log(`[${job.id}] ${job.status}`));
      await backend.start();
      console.log("Backend started. Press Ctrl+C to stop.");
      await new Promise<void>(resolve => process.once("SIGINT", resolve));
    } else {
      console.log("Commands: accounts | jobs | import-workflow <file> <workflowId> [name] | run");
    }
  } finally {
    await backend.close();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
