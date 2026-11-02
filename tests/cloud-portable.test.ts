import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";
import { GeminiStore } from "../src/core/gemini/store.js";
import { InMemorySecretStore } from "../src/core/secretStore.js";
import { exportAccounts, importAccounts } from "../src/core/accounts/portable.js";
import { CloudSecrets } from "../src/cloud/secrets.js";
import { cloudRuntime } from "../src/cloud/runtime.js";
import { cloudServer } from "../src/cloud/server.js";

test("account package migrates both pools/settings, deduplicates and rolls back invalid import", async () => {
  const source = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger() });
  const target = new RunningHubBackend({ databasePath: ":memory:", logger: new NullLogger(), secretStore: new CloudSecrets(randomBytes(32)) });
  const googleSource = new GeminiStore(source.database.raw, new InMemorySecretStore());
  // Use independent cloud storage encryption for the Gemini pool too.
  const googleTarget = new GeminiStore(target.database.raw, new CloudSecrets(randomBytes(32)));
  try {
    const account = source.accounts.add("paid account", "rh-test-key");
    source.accounts.setConcurrency(account.id, 3); source.accounts.setPriority(account.id, true); source.accounts.disable(account.id);
    googleSource.add(["AIza-test-credential-1234567890"]);
    googleSource.setEnabled(googleSource.list()[0]!.id, false);
    googleSource.setModel("gemini-3.8-flash");
    const portable = exportAccounts(source.database, googleSource);
    assert.deepEqual(importAccounts(target.database, googleTarget, portable), { runninghub: 1, gemini: 1, skipped: 0 });
    const copy = exportAccounts(target.database, googleTarget);
    assert.deepEqual(copy.runninghub, portable.runninghub); assert.deepEqual(copy.gemini, portable.gemini);
    assert.deepEqual(importAccounts(target.database, googleTarget, portable), { runninghub: 0, gemini: 0, skipped: 2 });
    const invalid = structuredClone(portable); invalid.runninghub.push({ ...invalid.runninghub[0]!, apiKey: "new-valid-key" }); invalid.gemini.keys[0]!.apiKey = "bad";
    assert.throws(() => importAccounts(target.database, googleTarget, invalid));
    assert.equal(target.accounts.list().length, 1);
    const encrypted = target.database.raw.prepare("SELECT encrypted_key FROM accounts").get() as { encrypted_key: Buffer };
    assert.ok(!encrypted.encrypted_key.includes(Buffer.from("rh-test-key")));
  } finally { await source.close(); await target.close(); }
});

test("cloud secret authentication detects tampering and uses unique nonces", () => {
  const store = new CloudSecrets(randomBytes(32)), a = store.encrypt("secret"), b = store.encrypt("secret");
  assert.notDeepEqual(a,b); assert.equal(store.decrypt(a), "secret"); a[a.length-1] = a[a.length-1]! ^ 1;
  assert.throws(() => store.decrypt(a));
});

test("headless API requires auth, imports desktop accounts and persists idempotent batches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"rh-cloud-test-"));
  const runtime = await cloudRuntime(root,path.resolve("bundled-workflows"));
  let server = cloudServer(runtime,"test-token");
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (endpoint: string, body: unknown) => fetch(base+endpoint,{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+"/accounts")).status,401);
    assert.equal((await fetch(base+"/accounts",{headers:{Authorization:"Bearer test-token",Origin:"https://bad.invalid"}})).status,401);
    const wf = runtime.backend.workflows.importApiJson({name:"test",runningHubWorkflowId:"123456789012",workflow:{"1":{class_type:"Text",inputs:{text:"default"},_meta:{title:"Prompt"}}}});
    const body = {requestId:"same-paid-request",jobs:[{workflowId:wf.id,parameters:{prompt:"hello"},optimize:false}]};
    const responses = await Promise.all([post("/jobs",body),post("/jobs",body)]);
    assert.ok(responses.every(r=>r.status===200));
    const [a,b] = await Promise.all(responses.map(r=>r.json())) as {jobIds:string[]}[];
    assert.deepEqual(a!.jobIds,b!.jobIds); assert.equal(runtime.backend.jobs.list().length,1);
    assert.equal((await post("/jobs",{...body,jobs:[{...body.jobs[0],taskName:"different"}]})).status,400);
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    server = cloudServer(runtime,"test-token"); await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.deepEqual((await (await post("/jobs",body)).json()).jobIds,a!.jobIds);
    assert.equal((await post(`/jobs/${a!.jobIds[0]}/query`,{})).status,400); // no remote ID: must never submit
    assert.equal(runtime.backend.jobs.list().length,1);
    assert.equal((await post("/accounts/import",{format:"rh-runner-accounts",version:1,exportedAt:"now",runninghub:[{label:"test",apiKey:"test-rh-key",enabled:true,preferred:true,maxConcurrency:3}],gemini:{model:"gemini-3.8-flash",keys:[]}})).status,200);
    const accounts = await (await fetch(base+"/accounts",{headers:{Authorization:"Bearer test-token"}})).text();
    assert.ok(!accounts.includes("test-rh-key"));
    const added = await post("/accounts/runninghub",{label:" Added ",apiKey:"  rh-fake-account-key  "});
    assert.equal(added.status,200);const account=await added.json();assert.equal(account.label,"Added");
    assert.equal(runtime.backend.database.getAccountWithSecret(account.id)?.apiKey,"rh-fake-account-key");
    assert.equal((await post("/accounts/runninghub",{label:"Duplicate",apiKey:"rh-fake-account-key"})).status,400);
    for(const apiKey of ["", "key one", "key\nsecond", 123]) assert.equal((await post("/accounts/runninghub",{label:"Bad",apiKey})).status,400);
    const google="AQ.fake-account-test-1234567890";
    assert.equal((await post("/accounts/gemini",{keys:[google,google]})).status,200);
    assert.equal(runtime.gemini.store.list().length,1);
    assert.equal((await post("/accounts/gemini",{keys:["AQ.another-fake-key-1234567890","bad key"]})).status,400);
    assert.equal(runtime.gemini.store.list().length,1);
    const bom=await fetch(base+"/accounts/gemini",{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:"\uFEFF"+JSON.stringify({keys:[google]})});
    assert.equal(bom.status,200);
    const listed=await (await fetch(base+"/accounts",{headers:{Authorization:"Bearer test-token"}})).text();
    assert.ok(!listed.includes(google)&&!listed.includes("rh-fake-account-key"));
    const upload = await fetch(base+"/uploads?filename=test.jpg",{method:"POST",headers:{Authorization:"Bearer test-token"},body:Buffer.from("test")});
    assert.equal(upload.status,200); const media = await upload.json(); assert.equal(await runtime.mediaPath(media.localPath),await realpath(media.localPath));
    await assert.rejects(()=>runtime.mediaPath(path.join(root,"secrets.key")));
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); await runtime.backend.close(); await rm(root,{recursive:true,force:true}); }
});
