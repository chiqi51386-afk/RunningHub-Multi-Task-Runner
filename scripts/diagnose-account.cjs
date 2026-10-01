const path = require("node:path");
const fs = require("node:fs");
const { app, safeStorage } = require("electron");
const Database = require("better-sqlite3");

const diagnosticPath = path.join(process.cwd(), "work", "account-diagnostic.json");
function emit(value) {
  fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  fs.writeFileSync(diagnosticPath, JSON.stringify(value, null, 2), "utf8");
  console.log(JSON.stringify(value, null, 2));
}

app.whenReady().then(async () => {
  const { SystemSecretStore } = await import("../dist/src/core/secureSecrets.js");
  const databasePath = path.join(app.getPath("appData"), "runninghub-multi-task-runner-core", "runninghub.sqlite");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(`
      SELECT id, label, encrypted_key
      FROM accounts
      WHERE enabled = 1
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    if (!row) throw new Error("没有可检测的启用账号。");
    const apiKey = new SystemSecretStore(safeStorage).decrypt(row.encrypted_key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("请求超过 20 秒")), 20_000);
    const startedAt = Date.now();
    try {
      const response = await fetch("https://www.runninghub.ai/uc/openapi/accountStatus", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ apikey: apiKey }),
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); }
      catch { body = { nonJson: text.slice(0, 300) }; }
      emit({
        accountId: row.id,
        label: row.label,
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAt,
        response: body,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    emit({
      diagnosticError: error instanceof Error ? error.message : String(error),
      cause: error && typeof error === "object" && "cause" in error ? String(error.cause) : undefined,
    });
    process.exitCode = 1;
  } finally {
    database.close();
    app.quit();
  }
});
