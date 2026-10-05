import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { GeminiStore } from "../src/core/gemini/store.js";
import { GeminiPool } from "../src/core/gemini/pool.js";
import { generateGemini } from "../src/core/gemini/client.js";
import { SystemSecretStore } from "../src/core/secureSecrets.js";

const keys = ["AIza-test-key-alpha-123456789", "AIza-test-key-beta-123456789", "AIza-test-key-gamma-123456789"];
const ok = (text="OK") => Response.json({status:"completed",steps:[{type:"thought",content:[{type:"text",text:"PRIVATE THOUGHT"}]},{type:"model_output",content:[{type:"text",text}]}]});
test("503 retries the identical request, succeeds without changing model",async()=>{
  const bodies:string[]=[];
  const text=await generateGemini(keys[0]!,"gemini-3.8-flash",{text:"hello"},{retryDelayMs:1,fetch:async(_u,o)=>{
    bodies.push(String(o?.body));return bodies.length<3?Response.json({error:{}},{status:503}):ok();
  }});
  assert.equal(text,"OK");assert.equal(bodies.length,3);assert.equal(new Set(bodies).size,1);
});
test("503 retries are bounded and cancellation interrupts backoff",async()=>{
  let calls=0;
  await assert.rejects(generateGemini(keys[0]!,"gemini-3.8-flash",{text:"hello"},{retryDelayMs:1,fetch:async()=>{calls++;return Response.json({error:{}},{status:503});}}),/503/);
  assert.equal(calls,3);
  const controller=new AbortController();calls=0;
  const pending=generateGemini(keys[0]!,"gemini-3.8-flash",{text:"hello"},{signal:controller.signal,retryDelayMs:10000,fetch:async()=>{calls++;setTimeout(()=>controller.abort(),10);return Response.json({error:{}},{status:503});}});
  await assert.rejects(pending,/取消/);assert.equal(calls,1);
});
test("model health and cooldown stay isolated across switching and restart",async()=>{
  const f=fixture(async()=>ok());try{
    const id=f.store.list()[0]!.id;
    f.store.record(id,"ready",1000,undefined,undefined,"gemini-3.5-flash-lite");
    f.store.record(id,"cooldown",1000,"503",31000,"gemini-3.8-flash");
    f.store.setModel("gemini-3.8-flash");assert.equal(f.store.list()[0]!.state,"cooldown");
    f.store.setModel("gemini-3.5-flash-lite");assert.equal(f.store.list()[0]!.state,"ready");
    assert.equal(f.store.list()[0]!.retryAt,undefined);
    assert.equal(f.store.list("gemini-3.7-flash")[0]!.state,"unchecked");
    const reloaded=new GeminiStore(f.db,{encrypt:v=>v,decrypt:v=>String(v)});
    assert.equal(reloaded.list("gemini-3.8-flash")[0]!.state,"cooldown");
  }finally{f.db.close();}
});
function fixture(fetcher: typeof fetch, timeoutMs=1000) {
  const db=new Database(":memory:");
  const secrets=new SystemSecretStore({isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v.split("").reverse().join("")),decryptString:v=>v.toString().split("").reverse().join("")});
  const store=new GeminiStore(db,secrets);store.add(keys);
  let now=1000;
  return {db,store,pool:new GeminiPool(store,{fetch:fetcher,now:()=>now,timeoutMs}),advance:(ms:number)=>{now+=ms;}};
}
test("Gemini keys deduplicate, encrypt, persist and never expose secrets in settings",()=>{
  const f=fixture(async()=>ok());try{
    f.store.add([keys[0],keys[0]]);assert.equal(f.store.list().length,3);
    const settings=JSON.stringify(f.store.settings());assert.ok(!settings.includes(keys[0]!));
    const row=f.db.prepare("SELECT encrypted_key FROM gemini_keys ORDER BY sequence LIMIT 1").get() as {encrypted_key:string};assert.notEqual(row.encrypted_key,keys[0]);
    f.store.setModel("gemini-custom-test");assert.equal(f.store.settings().model,"gemini-custom-test");
    assert.equal(f.store.settings().optimizationEnabled,false);
    f.store.setOptimizationEnabled(true);assert.equal(f.store.settings().optimizationEnabled,true);
    f.store.setModel("gemini-another");assert.equal(f.store.settings().optimizationEnabled,true);
    assert.throws(()=>f.store.setOptimizationEnabled("true"));
    f.store.setOptimizationEnabled(false);assert.equal(f.store.settings().optimizationEnabled,false);
    assert.throws(()=>f.store.setModel("https://evil.test"));
    assert.throws(()=>f.store.add(["short"]));assert.equal(f.store.list().length,3);
  }finally{f.db.close();}
});
test("Google authorization keys with dots survive storage and request headers unchanged",async()=>{
  const authKey="AQ.synthetic-not-a-real-credential-123456789";
  const f=fixture(async(_url,options)=>{
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"),authKey);
    return ok();
  });
  try {
    f.store.add([`  ${authKey}\r\n`,authKey]);
    assert.equal(f.store.list().length,4);
    const key=f.store.list().at(-1)!;
    assert.equal(f.store.secret(key.id),authKey);
    assert.ok(!JSON.stringify(f.store.settings()).includes(authKey));
    assert.equal((await f.pool.test(key.id)).success,true);
    for(const invalid of ["AQ.invalid key 123456789", "AQ.invalid\r\nHeader: injected", "AQ."+"a".repeat(2048)])assert.throws(()=>f.store.add([invalid]));
    assert.equal(f.store.list().length,4);
  } finally {f.db.close();}
});

test("Gemini concurrent callers use four different keys and queue excess requests",async()=>{
  const used:string[]=[];let active=0,maxActive=0;
  const f=fixture(async(_url,options)=>{active++;maxActive=Math.max(maxActive,active);used.push(new Headers(options?.headers).get("x-goog-api-key")!);await new Promise(r=>setTimeout(r,5));active--;return ok();});
  try{const fourth="AIza-test-key-delta-123456789";f.store.add([fourth]);await Promise.all(Array.from({length:8},()=>f.pool.generate({text:"hello"})));assert.deepEqual(used.slice(0,4),[...keys,fourth]);assert.equal(used.length,8);assert.equal(maxActive,4);}finally{f.db.close();}
});
test("one usable key remains serial even with four workers",async()=>{
  let active=0,maxActive=0;
  const f=fixture(async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));active--;return ok();});
  try{for(const key of f.store.list().slice(1))f.store.setEnabled(key.id,false);await Promise.all([f.pool.generate({text:'one'}),f.pool.generate({text:'two'})]);assert.equal(maxActive,1);}finally{f.db.close();}
});
test("thinking level is sent only when explicitly requested",async()=>{
  const bodies:any[]=[];
  const f=fixture(async(_u,o)=>{bodies.push(JSON.parse(String(o?.body)));return ok();});
  try{await f.pool.generate({text:'director',thinkingLevel:'low',maxOutputTokens:4096});await f.pool.generate({text:'format'});assert.equal(bodies[0].generation_config.thinking_level,'low');assert.equal(bodies[0].generation_config.max_output_tokens,4096);assert.equal(bodies[1].generation_config.thinking_level,undefined);}finally{f.db.close();}
});
test("queued and key-waiting requests cancel without occupying a key",async()=>{
  let release!:()=>void;let calls=0;
  const gate=new Promise<void>(r=>{release=r;});
  const f=fixture(async()=>{calls++;await gate;return ok();});
  try{
    for(const key of f.store.list().slice(1))f.store.setEnabled(key.id,false);
    const first=f.pool.generate({text:'first'});
    const waiting=new AbortController(),queued=new AbortController();
    const second=f.pool.generate({text:'waiting'},waiting.signal);
    const third=f.pool.generate({text:'queued'},queued.signal);
    const secondCheck=assert.rejects(second,/取消/),thirdCheck=assert.rejects(third,/取消/);
    await new Promise(r=>setImmediate(r));waiting.abort();queued.abort();
    await Promise.all([secondCheck,thirdCheck]);assert.equal(calls,1);
    release();await first;
    await f.pool.generate({text:'after cancellation'});assert.equal(calls,2);
  }finally{release();f.db.close();}
});
test("429 switches key, persists cooldown and automatically recovers after expiry",async()=>{
  let first=true;const used:string[]=[];
  const f=fixture(async(_url,options)=>{const key=new Headers(options?.headers).get("x-goog-api-key")!;used.push(key);if(key===keys[0]&&first){first=false;return Response.json({error:{status:"RESOURCE_EXHAUSTED"}},{status:429,headers:{"retry-after":"60"}});}return ok();});
  try{
    await f.pool.generate({text:"hello"});const a=f.store.list()[0]!;assert.equal(a.state,"cooldown");assert.equal(a.enabled,true);assert.equal(a.retryAt,61000);
    f.advance(61000);await f.pool.generate({text:"hello"});await f.pool.generate({text:"hello"});
    assert.deepEqual(used,[keys[0],keys[1],keys[2],keys[0]]);assert.equal(f.store.list()[0]!.state,"ready");
  }finally{f.db.close();}
});
test("model errors do not rotate through keys or classify them as invalid",async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return Response.json({error:{message:keys[0]}},{status:404});});
  try{await assert.rejects(f.pool.generate({text:"hello"}),/模型/);assert.equal(calls,1);assert.equal(f.store.list()[0]!.state,"unchecked");assert.ok(!JSON.stringify(f.store.settings()).includes(keys[0]!));}finally{f.db.close();}
});
test("invalid API key in HTTP 400 rotates; request INVALID_ARGUMENT does not",async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return calls===1?Response.json({error:{details:[{reason:"API_KEY_INVALID"}]}},{status:400}):ok();});
  try{await f.pool.generate({text:"hello"});assert.equal(calls,2);assert.equal(f.store.list()[0]!.state,"auth_error");assert.equal(f.store.list()[0]!.enabled,true);}finally{f.db.close();}
  const g=fixture(async()=>Response.json({error:{status:"INVALID_ARGUMENT"}},{status:400}));
  try{const result=await g.pool.test();assert.equal(result.success,false);assert.equal(g.store.list().filter(k=>k.lastCheckedAt).length,1);assert.equal(g.store.list()[0]!.state,"unchecked");}finally{g.db.close();}
});
test("disabled keys are skipped but can be explicitly retested without enabling",async()=>{
  const used:string[]=[];const f=fixture(async(_u,o)=>{used.push(new Headers(o?.headers).get("x-goog-api-key")!);return ok();});
  try{const a=f.store.list()[0]!;f.store.setEnabled(a.id,false);await f.pool.generate({text:"hello"});await f.pool.test(a.id);assert.deepEqual(used,[keys[1],keys[0]]);assert.equal(f.store.list()[0]!.enabled,false);}finally{f.db.close();}
});
test("all keys cooling causes no request; after restart cooldown is retained",async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return Response.json({error:{}},{status:429});});
  try{await assert.rejects(f.pool.generate({text:"hello"}));assert.equal(calls,3);const pool=new GeminiPool(f.store,{fetch:async()=>{throw new Error("must not call");},now:()=>1000});await assert.rejects(pool.generate({text:"hello"}),/冷却/);assert.equal(calls,3);}finally{f.db.close();}
});
test("request snapshots survive editing while queued and preserve sparse image numbers",async()=>{
  const requests:any[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const f=fixture(async(url,o)=>{assert.equal(url,"https://generativelanguage.googleapis.com/v1beta/interactions");requests.push(JSON.parse(String(o?.body)));if(requests.length===1)await gate;return ok("final text");});
  try{
    const p=f.pool.generate({text:"first"});await new Promise(r=>setImmediate(r));
    const draft={text:"original",systemInstruction:"official skill",images:[{referenceIndex:3,mimeType:"image/png" as const,data:"YWJj"}]};
    const q=f.pool.generate(draft);draft.text="edited";draft.images[0]!.referenceIndex=1;f.store.setModel("gemini-changed");release();
    assert.equal((await p).text,"final text");await q;
    assert.equal(requests[1].model,"gemini-3.5-flash-lite");assert.equal(requests[1].store,false);assert.equal(requests[1].system_instruction,"official skill");
    assert.equal(requests[1].input[0].text,"original");assert.equal(requests[1].input[1].text,"<Picture 3>");assert.equal(requests[1].input[2].mime_type,"image/png");
  }finally{f.db.close();}
});
test("empty, incomplete and filtered responses are not accepted or retried on another key",async()=>{
  for(const body of [{status:"incomplete",steps:[{type:"model_output",content:[{type:"text",text:"partial"}]}]},{status:"completed",steps:[]}]){
    let calls=0;const f=fixture(async()=>{calls++;return Response.json(body);});try{await assert.rejects(f.pool.generate({text:"hello"}));assert.equal(calls,1);}finally{f.db.close();}
  }
});
test("cancel does not degrade a key and timeout is classified as temporary",async()=>{
  const controller=new AbortController();
  const f=fixture(async(_u,o)=>new Promise((_resolve,reject)=>{o?.signal?.addEventListener("abort",()=>reject(new Error("secret detail")),{once:true});controller.abort();}));
  try{await assert.rejects(f.pool.generate({text:"hello"},controller.signal),/取消/);assert.equal(f.store.list()[0]!.state,"unchecked");}finally{f.db.close();}
  const keepAlive=setTimeout(()=>{},100);
  try{await assert.rejects(generateGemini(keys[0]!,"gemini-3.5-flash-lite",{text:"hello"},{timeoutMs:5,fetch:async(_u,o)=>new Promise((_res,rej)=>o?.signal?.addEventListener("abort",()=>rej(new Error("private")),{once:true}))}),/超时/);}finally{clearTimeout(keepAlive);}
});

test("timeout during response body reading remains a temporary failure",async()=>{
  const keepAlive=setTimeout(()=>{},100);
  try {
    await assert.rejects(generateGemini(keys[0]!,"gemini-3.5-flash-lite",{text:"hello"},{timeoutMs:5,fetch:async(_url,options)=>({
      ok:true,status:200,headers:new Headers(),
      json:()=>new Promise((_resolve,reject)=>options?.signal?.addEventListener("abort",()=>reject(new Error("body interrupted")),{once:true})),
    } as Response)}),error=>error instanceof Error && error.message.includes("超时") && (error as {kind?:string}).kind==="transient");
  } finally { clearTimeout(keepAlive); }
});
