import { resolveConfig, RunningHubClient, type NodeInfo } from "../src/core/index.js";

async function main(): Promise<void> {
  if (process.env.RH_TEST_CONFIRM !== "YES") {
    throw new Error("Set RH_TEST_CONFIRM=YES to acknowledge that this test may create a billable RunningHub task.");
  }
  const apiKey = process.env.RH_TEST_API_KEY?.trim();
  const workflowId = process.env.RH_TEST_WORKFLOW_ID?.trim();
  if (!apiKey || !workflowId) throw new Error("RH_TEST_API_KEY and RH_TEST_WORKFLOW_ID are required.");
  const config = resolveConfig({ apiHost: process.env.RH_TEST_API_HOST || "https://www.runninghub.cn" });
  const client = new RunningHubClient(apiKey, config);
  const account = await client.accountStatus();
  console.log("Account:", { ...account, raw: undefined });
  if (process.env.RH_TEST_MEDIA_FILE) {
    const upload = await client.uploadMedia(process.env.RH_TEST_MEDIA_FILE);
    console.log("Upload value:", upload.value);
  }
  const nodes = JSON.parse(process.env.RH_TEST_NODE_INFO_JSON || "[]") as NodeInfo[];
  const taskId = await client.runWorkflow(workflowId, nodes);
  console.log("Task:", taskId);
  const result = await client.pollTask(taskId);
  console.log("Result:", JSON.stringify({ taskId, files: result.files, texts: result.texts, usage: result.usage }, null, 2));
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
