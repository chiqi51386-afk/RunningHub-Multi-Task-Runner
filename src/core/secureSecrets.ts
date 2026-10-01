import type { Database } from "better-sqlite3";
import type { SecretStore } from "./secretStore.js";

export interface SystemEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

const prefix = "rh-safe:v1:";
export class SecretStorageError extends Error {}

/** Never silently fall back to plaintext, including Linux's basic_text backend. */
export class SystemSecretStore implements SecretStore {
  constructor(private readonly system: SystemEncryption) {}

  private requireEncryption(): void {
    if (!this.system.isEncryptionAvailable() || this.system.getSelectedStorageBackend?.() === "basic_text") {
      throw new SecretStorageError("系统密钥加密不可用；未写入明文，请解锁系统钥匙串后重试。");
    }
  }

  encrypt(value: string): string {
    this.requireEncryption();
    try {
      const encrypted = this.system.encryptString(value);
      if (this.system.decryptString(encrypted) !== value) throw new Error();
      return prefix + encrypted.toString("base64");
    } catch {
      throw new SecretStorageError("密钥加密验证失败，原数据未更改。");
    }
  }

  decrypt(value: Buffer | string): string {
    this.requireEncryption();
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (!text.startsWith(prefix)) throw new SecretStorageError("密钥尚未安全迁移，请重新填写 API Key。");
    try {
      const encoded = text.slice(prefix.length);
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.toString("base64") !== encoded) throw new Error();
      return this.system.decryptString(bytes);
    } catch {
      throw new SecretStorageError("无法解密此账号的 API Key；若更换了电脑或系统用户，请重新填写。");
    }
  }
}

/** Atomic, idempotent migration. Existing encrypted keys stay intact on another machine. */
export function migratePlaintextKeys(db: Database, store: SystemSecretStore): number {
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, encrypted_key FROM accounts").all() as { id: string; encrypted_key: Buffer | string }[];
    let count = 0;
    const update = db.prepare("UPDATE accounts SET encrypted_key = ? WHERE id = ?");
    for (const row of rows) {
      const value = Buffer.isBuffer(row.encrypted_key) ? row.encrypted_key.toString("utf8") : row.encrypted_key;
      if (value.startsWith(prefix)) continue;
      if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("存在无法识别的旧密钥，迁移已回滚，原数据保留。");
      const encrypted = store.encrypt(value);
      if (store.decrypt(encrypted) !== value) throw new Error("密钥迁移验证失败，原数据保留。");
      update.run(encrypted, row.id);
      count++;
    }
    return count;
  }).immediate();
}
