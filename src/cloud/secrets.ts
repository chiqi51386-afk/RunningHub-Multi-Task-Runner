import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SecretStore } from "../core/secretStore.js";

export async function privateFile(file: string, bytes: number): Promise<Buffer> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, randomBytes(bytes), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const value = await readFile(file);
  if (value.length !== bytes) throw new Error("Invalid private configuration file");
  return value;
}

/** Cloud-local encryption, independent of Windows DPAPI. Keep key and DB together in backups. */
export class CloudSecrets implements SecretStore {
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error("Invalid encryption key"); }
  encrypt(value: string): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]);
  }
  decrypt(value: Buffer | string): string {
    if (!Buffer.isBuffer(value) || value.length < 28) throw new Error("Invalid encrypted credential");
    const cipher = createDecipheriv("aes-256-gcm", this.key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
  }
}
