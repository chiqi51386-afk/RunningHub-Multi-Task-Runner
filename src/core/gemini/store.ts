import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { SecretStore } from "../secretStore.js";
import { DEFAULT_GEMINI_MODEL, type GeminiKeyState, type GeminiKeyView, type GeminiSettings } from "./types.js";

interface Row {
  id: string; label: string; encrypted_key: Buffer | string; key_hint: string; enabled: number;
  state: GeminiKeyState; retry_at: number | null; last_checked_at: number | null;
  last_error: string | null; last_used_at: number | null;
}

export class GeminiStore {
  constructor(private db: Database, private secrets: SecretStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS gemini_model_health (
      key_id TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL,
      last_checked_at INTEGER, last_error TEXT, retry_at INTEGER,
      PRIMARY KEY(key_id,model)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS gemini_keys (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
      encrypted_key BLOB NOT NULL, key_hash TEXT UNIQUE NOT NULL, key_hint TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'unchecked',
      retry_at INTEGER, last_checked_at INTEGER, last_error TEXT, last_used_at INTEGER
    ); CREATE TABLE IF NOT EXISTS gemini_director_settings (id INTEGER PRIMARY KEY CHECK(id=1), skill_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gemini_preferences (id INTEGER PRIMARY KEY CHECK(id=1), optimization_enabled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS gemini_settings (id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL);`);
  }
  setOptimizationEnabled(enabled: unknown): GeminiSettings {
    if(typeof enabled!=="boolean")throw new Error("无效的优化开关。");
    this.db.prepare("INSERT INTO gemini_preferences(id,optimization_enabled) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET optimization_enabled=excluded.optimization_enabled").run(enabled?1:0);
    return this.settings();
  }
  settings(): GeminiSettings {
    const row = this.db.prepare("SELECT model FROM gemini_settings WHERE id=1").get() as { model: string } | undefined;
    const preference=this.db.prepare("SELECT optimization_enabled FROM gemini_preferences WHERE id=1").get() as {optimization_enabled:number}|undefined;
    return { optimizationEnabled: preference?.optimization_enabled===1, model: row?.model ?? DEFAULT_GEMINI_MODEL, keys: this.list() };
  }
  setModel(value: unknown): GeminiSettings {
    if (typeof value !== "string" || !/^gemini-[A-Za-z0-9._-]{1,100}$/.test(value.trim())) throw new Error("请输入有效的 Gemini 模型名称。");
    this.db.prepare("INSERT INTO gemini_settings(id,model) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model").run(value.trim());
    return this.settings();
  }
  list(model?: string): GeminiKeyView[] {
    model ??= (this.db.prepare("SELECT model FROM gemini_settings WHERE id=1").get() as {model:string}|undefined)?.model ?? DEFAULT_GEMINI_MODEL;
    return (this.db.prepare(`SELECT k.*, COALESCE(h.state,'unchecked') AS state,
      h.last_checked_at, h.last_error, h.retry_at FROM gemini_keys k
      LEFT JOIN gemini_model_health h ON h.key_id=k.id AND h.model=? ORDER BY k.sequence`).all(model) as Row[]).map(row => ({
      id: row.id, label: row.label, maskedKey: row.key_hint, enabled: !!row.enabled, state: row.state,
      retryAt: row.retry_at ?? undefined, lastCheckedAt: row.last_checked_at ?? undefined,
      lastError: row.last_error ?? undefined, lastUsedAt: row.last_used_at ?? undefined,
    }));
  }
  add(input: unknown): GeminiSettings {
    if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error("每次可添加 1–100 个 API Key。");
    const values = input.map(value => {
      // Google authorization keys use AQ. as well as older AIza keys.
      // Check transport-safe characters only; Google validates the credential.
      if (typeof value !== "string" || !/^[A-Za-z0-9._-]{20,2048}$/.test(value.trim())) throw new Error("API Key 格式不正确，请每行填写一个完整 Key（不能包含空格）。");
      return value.trim();
    });
    this.db.transaction(() => {
      for (const value of values) {
        const hash = createHash("sha256").update(value).digest("hex");
        if (this.db.prepare("SELECT id FROM gemini_keys WHERE key_hash=?").get(hash)) continue;
        const number = (this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM gemini_keys").get() as {n:number}).n;
        this.db.prepare("INSERT INTO gemini_keys(id,label,encrypted_key,key_hash,key_hint) VALUES(?,?,?,?,?)")
          .run(randomUUID(), `Google ${number}`, this.secrets.encrypt(value), hash, `${value.slice(0,4)}••••${value.slice(-4)}`);
      }
    })();
    return this.settings();
  }
  setEnabled(id: string, enabled: boolean): GeminiSettings {
    if (typeof id !== "string" || typeof enabled !== "boolean") throw new Error("无效的 Key 操作。");
    this.db.prepare("UPDATE gemini_keys SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
    return this.settings();
  }
  remove(id: string): GeminiSettings {
    if (typeof id !== "string") throw new Error("无效的 Key 编号。");
    this.db.prepare("DELETE FROM gemini_keys WHERE id=?").run(id);
    this.db.prepare("DELETE FROM gemini_model_health WHERE key_id=?").run(id);
    return this.settings();
  }
  secret(id: string): string {
    const row = this.db.prepare("SELECT encrypted_key FROM gemini_keys WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("API Key 已删除。");
    return this.secrets.decrypt(row.encrypted_key);
  }
  used(id: string, now: number): void {
    this.db.prepare("UPDATE gemini_keys SET last_used_at=? WHERE id=?").run(now,id);
  }
  record(id: string, state: GeminiKeyState, now: number, message?: string, retryAt?: number, model?: string): void {
    model ??= (this.db.prepare("SELECT model FROM gemini_settings WHERE id=1").get() as {model:string}|undefined)?.model ?? DEFAULT_GEMINI_MODEL;
    this.db.prepare(`INSERT INTO gemini_model_health(key_id,model,state,last_checked_at,last_error,retry_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM gemini_keys WHERE id=?)
      ON CONFLICT(key_id,model) DO UPDATE SET state=excluded.state,last_checked_at=excluded.last_checked_at,
      last_error=excluded.last_error,retry_at=excluded.retry_at`)
      .run(id,model,state,now,message ?? null,retryAt ?? null,id);
  }
}
