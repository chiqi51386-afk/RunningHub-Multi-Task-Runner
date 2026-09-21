const path = require("node:path");
const { createHash } = require("node:crypto");
const { app } = require("electron");
const Database = require("better-sqlite3");

app.whenReady().then(() => {
  const apiKey = String(process.env.RH_REPAIR_KEY ?? "").trim();
  if (!apiKey) throw new Error("RH_REPAIR_KEY is required.");
  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
  const database = new Database(path.join(app.getPath("userData"), "runninghub.sqlite"));
  try {
    const row = database.prepare("SELECT id, label FROM accounts WHERE key_fingerprint = ?").get(fingerprint);
    if (!row) throw new Error("没有找到与该 Key 指纹匹配的账号。");
    database.prepare(`
      UPDATE accounts
      SET encrypted_key = ?, state = 'UNCHECKED', auto_disabled = 0,
          auto_disabled_reason = NULL, last_error_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(apiKey, Date.now(), row.id);
    console.log(JSON.stringify({ repaired: true, accountId: row.id, label: row.label }));
  } finally {
    database.close();
    app.quit();
  }
}).catch(error => {
  console.error(JSON.stringify({ repaired: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
  app.quit();
});
