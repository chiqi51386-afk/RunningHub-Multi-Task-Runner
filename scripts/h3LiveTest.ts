import { app } from "electron";
import path from "node:path";
import { RunningHubBackend } from "../src/core/index.js";
import { PlainTextSecretStore, type SecretStore } from "../src/core/secretStore.js";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "SUBMIT_UNKNOWN"]);
const testRoot = path.resolve("work", "h3-five-image-test");
const prompt = `subject_definitions:
<Subject 1> is the female explorer in the deep red coat from <Picture 1> and <Picture 2>.
<Subject 2> is the white tiger from <Picture 3>.
<Subject 3> is the golden fantasy airship from <Picture 4>.
<Subject 4> is the cyan-glowing jungle temple from <Picture 5>.

summary:
A four-second vertical cinematic reference-recognition test using all five supplied pictures.

retention_analysis:
<Subject 1>: fully_preserved - keep her East Asian facial identity, deep red coat, dark explorer clothing and boots.
<Subject 2>: fully_preserved - keep the white fur, dark stripes and pale blue eyes.
<Subject 3>: fully_preserved - keep the cream balloon, golden brass structure and propellers.
<Subject 4>: fully_preserved - keep the ancient stone entrance, jungle vegetation and vivid cyan inner light.

detailed_description:
A smooth four-second vertical cinematic shot. <Subject 1> stands at the entrance of <Subject 4> beside <Subject 2>. She looks upward as <Subject 3> glides slowly across the sky behind the temple. The camera makes a gentle forward push. Natural body motion, subtle coat movement, the tiger breathes and shifts its gaze, the airship propellers rotate, jungle leaves move lightly, and cyan light reflects realistically on wet stone. Preserve all reference identities and object designs. No cuts, no morphing, no extra people, no text.`;

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const userData = app.getPath("userData");
  const ephemeralKey = process.env.RUNNINGHUB_TEST_KEY?.trim();
  const secretStore: SecretStore = ephemeralKey
    ? { encrypt: () => { throw new Error("Live test does not persist API keys."); }, decrypt: () => ephemeralKey }
    : new PlainTextSecretStore();
  const backend = new RunningHubBackend({
    databasePath: path.join(userData, "runninghub.sqlite"),
    secretStore,
    config: { apiHost: "https://www.runninghub.ai", outputDir: path.join(userData, "downloads") },
  });
  try {
    // Repair only the known definitive missing-webapp record created before the
    // classifier fix. No ambiguous submit record is released automatically.
    for (const old of backend.jobs.list(["SUBMIT_UNKNOWN"])) {
      if (!/webapp\s+not\s+exists/i.test(old.lastError?.message ?? "")) continue;
      backend.jobs.recoverTransition(old.id, "FAILED", {
        lastError: { ...old.lastError!, code: "WORKFLOW_VALIDATION", phase: "submit", retryable: false, safeToReassign: false },
        completedAt: Date.now(),
      });
      if (old.accountId) backend.accounts.release(old.accountId, old.id, false, "IDLE");
    }

    await backend.start();
    const account = backend.accounts.list().find(item => item.enabled);
    if (!account) throw new Error("No enabled RunningHub account is configured.");
    let refreshed = await backend.accounts.refresh(account.id);
    for (let attempt = 2; refreshed.state === "TEMP_UNAVAILABLE" && attempt <= 3; attempt += 1) {
      await sleep(5_000);
      refreshed = await backend.accounts.refresh(account.id);
    }
    console.log(JSON.stringify({ event: "account", state: refreshed.state, coins: refreshed.coins ?? refreshed.balance ?? null }));
    if (refreshed.state !== "IDLE") {
      try { await backend.accounts.clientFor(account.id).client.accountStatus(); }
      catch (error) {
        const detail = error && typeof error === "object" && "detail" in error ? (error as { detail: unknown }).detail : undefined;
        console.log(JSON.stringify({ event: "account-error", message: error instanceof Error ? error.message : String(error), detail }));
      }
      throw new Error(`Configured account is not available: ${refreshed.state}`);
    }

    let workflow = backend.workflows.list().filter(item => /H3/i.test(item.name)).at(-1);
    if (!workflow) throw new Error("No imported H3 workflow was found.");
    const requestedWorkflowId = process.env.RUNNINGHUB_TEST_WORKFLOW_ID?.trim();
    if (requestedWorkflowId && workflow.runningHubWorkflowId !== requestedWorkflowId) {
      workflow = backend.workflows.updateProfile(workflow.id, workflow.profile, { runningHubWorkflowId: requestedWorkflowId });
    }
    const parameters = Object.fromEntries(workflow.profile.parameters.map(item => [item.id, item.defaultValue]));
    const bySemantic = (type: string) => workflow.profile.parameters.find(item => item.semanticType === type);
    const promptParameter = bySemantic("prompt");
    const durationParameter = bySemantic("duration");
    const aspectParameter = bySemantic("aspect_ratio");
    const megapixelsParameter = workflow.profile.parameters.find(item => item.key === "252.megapixels");
    if (!promptParameter || !durationParameter || !aspectParameter) throw new Error("H3 profile is missing prompt, duration, or aspect ratio mapping.");
    parameters[promptParameter.id] = prompt;
    parameters[durationParameter.id] = 4;
    parameters[aspectParameter.id] = "9:16 (Portrait Widescreen)";
    if (megapixelsParameter) parameters[megapixelsParameter.id] = 0.5;

    const images = workflow.profile.parameters.filter(item => item.semanticType === "image").slice(0, 5);
    if (images.length !== 5) throw new Error(`H3 profile exposes only ${images.length} image inputs; five are required.`);
    const media = images.map((parameter, index) => ({
      parameterId: parameter.id,
      localPath: path.join(testRoot, `image-${index + 1}.png`),
    }));
    console.log(JSON.stringify({
      event: "mapping", workflowId: workflow.runningHubWorkflowId,
      duration: parameters[durationParameter.id], aspectRatio: parameters[aspectParameter.id],
      images: images.map((item, index) => ({ picture: index + 1, node: item.key, file: `image-${index + 1}.png` })),
    }));

    const created = backend.jobs.create({ workflowId: workflow.id, parameters, media });
    console.log(JSON.stringify({ event: "created", jobId: created.id }));
    const deadline = Date.now() + 45 * 60_000;
    let previous = "";
    while (Date.now() < deadline) {
      const job = backend.jobs.get(created.id)!;
      const marker = `${job.status}:${job.remoteTaskId ?? ""}:${job.lastError?.message ?? ""}`;
      if (marker !== previous) {
        console.log(JSON.stringify({ event: "status", status: job.status, taskId: job.remoteTaskId ?? null, error: job.lastError?.message ?? null }));
        previous = marker;
      }
      if (terminal.has(job.status)) {
        console.log(JSON.stringify({
          event: "result", status: job.status, taskId: job.remoteTaskId ?? null,
          files: job.outputs?.files.map(file => ({ url: file.url, localPath: file.localPath, type: file.type, nodeId: file.nodeId })) ?? [],
          usage: job.outputs?.usage ?? null, raw: job.rawResult ?? null, error: job.lastError ?? null,
        }));
        process.exitCode = job.status === "COMPLETED" ? 0 : 2;
        return;
      }
      await sleep(5_000);
    }
    throw new Error("Live test exceeded 45 minutes.");
  } finally {
    await backend.close();
  }
}

app.whenReady().then(() => run().catch(error => {
  console.error(JSON.stringify({ event: "fatal", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}).finally(() => app.exit(typeof process.exitCode === "number" ? process.exitCode : Number(process.exitCode ?? 0))));
