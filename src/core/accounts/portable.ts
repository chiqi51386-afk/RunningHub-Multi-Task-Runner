import type { CoreDatabase } from "../database.js";
import type { GeminiStore } from "../gemini/store.js";

export interface AccountPackage {
  format: "rh-runner-accounts";
  version: 1;
  exportedAt: string;
  runninghub: { label: string; apiKey: string; enabled: boolean; preferred: boolean; maxConcurrency: number }[];
  gemini: { model: string; keys: { label: string; apiKey: string; enabled: boolean }[] };
}

/** Explicit user export only. Never return this payload from account-list endpoints. */
export function exportAccounts(db: CoreDatabase, gemini: GeminiStore): AccountPackage {
  return {
    format: "rh-runner-accounts", version: 1, exportedAt: new Date().toISOString(),
    runninghub: db.listAccounts().map(a => ({ label: a.label, apiKey: db.getAccountWithSecret(a.id)!.apiKey,
      enabled: a.enabled && !a.manualDisabled, preferred: !!a.preferred, maxConcurrency: a.maxConcurrency ?? 1 })),
    gemini: { model: gemini.settings().model, keys: gemini.list().map(a => ({ label: a.label, apiKey: gemini.secret(a.id), enabled: a.enabled })) },
  };
}

export function importAccounts(db: CoreDatabase, gemini: GeminiStore, value: unknown) {
  const input = value as AccountPackage;
  const key = (v: unknown) => typeof v === "string" && /^[\x21-\x7e]{1,2048}$/.test(v);
  const label = (v: unknown) => typeof v === "string" && v.length <= 200;
  if (!input || input.format !== "rh-runner-accounts" || input.version !== 1 || !Array.isArray(input.runninghub)
    || !input.gemini || !Array.isArray(input.gemini.keys) || input.runninghub.length > 10000 || input.gemini.keys.length > 10000
    || typeof input.gemini.model !== "string" || !/^gemini-[A-Za-z0-9._-]{1,100}$/.test(input.gemini.model)
    || input.runninghub.some(a => !a || !key(a.apiKey) || !label(a.label) || typeof a.enabled !== "boolean" || typeof a.preferred !== "boolean"
      || !Number.isInteger(a.maxConcurrency) || a.maxConcurrency < 1 || a.maxConcurrency > 100)
    || input.gemini.keys.some(a => !a || !label(a.label) || typeof a.enabled !== "boolean" || typeof a.apiKey !== "string" || !/^[A-Za-z0-9._-]{20,2048}$/.test(a.apiKey))) {
    throw new Error("账号文件格式无效；未导入任何账号。");
  }
  return db.transaction(() => {
    let runninghub = 0, google = 0, skipped = 0;
    const rhKeys = new Set(db.listAccounts().map(a => db.getAccountWithSecret(a.id)!.apiKey));
    const googleKeys = new Set(gemini.list().map(a => gemini.secret(a.id)));
    const hadGoogleKeys = googleKeys.size > 0;
    for (const a of input.runninghub) {
      if (rhKeys.has(a.apiKey)) { skipped++; continue; }
      const saved = db.addAccount(a.label, a.apiKey);
      db.setAccountConcurrency(saved.id, a.maxConcurrency);
      db.setAccountPriority(saved.id, a.preferred);
      if (!a.enabled) db.setAccountEnabled(saved.id, false);
      rhKeys.add(a.apiKey); runninghub++;
    }
    for (const a of input.gemini.keys) {
      if (googleKeys.has(a.apiKey)) { skipped++; continue; }
      const before = new Set(gemini.list().map(k => k.id));
      gemini.add([a.apiKey]);
      const saved = gemini.list().find(k => !before.has(k.id))!;
      db.raw.prepare("UPDATE gemini_keys SET label=?, enabled=? WHERE id=?").run(a.label, a.enabled ? 1 : 0, saved.id);
      googleKeys.add(a.apiKey); google++;
    }
    if (!hadGoogleKeys) gemini.setModel(input.gemini.model);
    return { runninghub, gemini: google, skipped };
  });
}
