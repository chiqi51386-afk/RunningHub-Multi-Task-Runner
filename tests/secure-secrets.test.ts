import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";
import { SystemSecretStore, migratePlaintextKeys } from "../src/core/secureSecrets.js";

const system = {
  isEncryptionAvailable: () => true,
  encryptString: (v: string) => Buffer.from(v.split("").reverse().join("")),
  decryptString: (v: Buffer) => v.toString().split("").reverse().join(""),
};
function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY, encrypted_key TEXT, label TEXT)");
  db.prepare("INSERT INTO accounts VALUES (?, ?, ?)").run("a", "test-key-one", "keep-label");
  return db;
}
test("migration verifies keys, preserves metadata, and is idempotent", () => {
  const db = fixture();
  try {
    const store = new SystemSecretStore(system);
    assert.equal(migratePlaintextKeys(db, store), 1);
    const row = db.prepare("SELECT * FROM accounts").get() as {encrypted_key: string; label: string};
    assert.equal(store.decrypt(row.encrypted_key), "test-key-one");
    assert.notEqual(row.encrypted_key, "test-key-one");
    assert.equal(row.label, "keep-label");
    assert.equal(migratePlaintextKeys(db, store), 0);
  } finally { db.close(); }
});
test("failure on a later key rolls back earlier writes", () => {
  const db = fixture();
  db.prepare("INSERT INTO accounts VALUES (?, ?, ?)").run("b", "bad-key", "b");
  try {
    const store = new SystemSecretStore({...system, encryptString(v) { if (v === "bad-key") throw new Error("unavailable"); return system.encryptString(v); }});
    assert.throws(() => migratePlaintextKeys(db, store));
    assert.equal((db.prepare("SELECT encrypted_key FROM accounts WHERE id='a'").get() as {encrypted_key:string}).encrypted_key, "test-key-one");
  } finally { db.close(); }
});
test("unavailable encryption and insecure fallback fail closed", () => {
  for (const backend of [{...system, isEncryptionAvailable: () => false}, {...system, getSelectedStorageBackend: () => "basic_text"}]) {
    assert.throws(() => new SystemSecretStore(backend).encrypt("test-key"));
  }
  assert.throws(() => new SystemSecretStore(system).decrypt("plaintext"));
});
test("foreign encrypted keys are preserved and decryption errors do not disclose secrets", () => {
  const db = fixture();
  try {
    const store = new SystemSecretStore(system);
    migratePlaintextKeys(db, store);
    const foreign = new SystemSecretStore({...system, decryptString() { throw new Error("sensitive-system-detail"); }});
    assert.equal(migratePlaintextKeys(db, foreign), 0);
    assert.throws(() => foreign.decrypt(store.encrypt("test")), /无法解密/);
  } finally { db.close(); }
});

test("a foreign key is shown as requiring re-entry, without contacting the API", async () => {
  let locked = false;
  const store = new SystemSecretStore({...system, decryptString(v) { if (locked) throw new Error("locked"); return system.decryptString(v); }});
  const backend = new RunningHubBackend({databasePath: ":memory:", secretStore: store, logger: new NullLogger(),
    clientFactory: () => { throw new Error("must not call API"); }});
  try {
    const account = backend.accounts.add("test", "test-key");
    locked = true;
    assert.equal((await backend.accounts.refresh(account.id)).state, "SECRET_UNREADABLE");
  } finally { await backend.close(); }
});
