import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudRuntime } from "./runtime.js";
import { cloudServer } from "./server.js";
import { privateFile } from "./secrets.js";

const root = path.resolve(process.env.RH_DATA_DIR ?? "./data");
const bundles = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bundled-workflows");
const runtime = await cloudRuntime(root, bundles);
const token = (await privateFile(path.join(root, "api.token"), 32)).toString("hex");
const server = cloudServer(runtime, token);
const port = Number(process.env.RH_PORT ?? 17863);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
server.listen(port, process.env.RH_BIND ?? "127.0.0.1", () => {
  console.log(`Cloud service listening on port ${port}. Credentials: ${path.join(root, "api.token")} (binary; use hex encoding).`);
  void runtime.backend.start().catch(() => console.error("Scheduler startup failed; inspect task state before retrying."));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.close();
  void server.stopTts().then(() => runtime.backend.close()).finally(() => process.exit(0));
});
