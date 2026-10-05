import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import Database from "better-sqlite3";
import {generateTts,ttsRequest} from "../src/core/gemini/tts.js";
import {TTS_MODEL} from "../src/core/gemini/ttsTypes.js";
import {GeminiPool} from "../src/core/gemini/pool.js";
import {GeminiStore} from "../src/core/gemini/store.js";
import {parsePortableWorkflowPackage,materializePortableProfile} from "../src/core/workflows/package.js";
import {applyTtsAudio,createDraft} from "../frontend/src/task-draft.js";
import type {WorkflowView} from "../frontend/src/types.js";
const input={text:"Hôm nay, Nguyễn gặp mẹ.\nCảm ơn mẹ!",voice:"Erinome",language:"vi",style:"温柔、稍慢"};
const wav=Buffer.alloc(48);wav.write("RIFF");wav.writeUInt32LE(40,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(4,40);
const ok=()=>Response.json({status:"completed",output_audio:{data:wav.toString("base64"),mime_type:"audio/wav"}});
test("TTS preserves Vietnamese transcript and separates emotion, language and voice",async()=>{
 const body=ttsRequest(input);assert.equal(body.model,TTS_MODEL);
 assert.equal(body.input[0]!.content[0]!.text,input.text);
 assert.match(body.input[0]!.content[0]!.annotations[0]!.style,/Vietnamese/);
 assert.match(body.input[0]!.content[0]!.annotations[0]!.style,/温柔、稍慢/);
 assert.deepEqual(body.generation_config.speech_config,[{voice:"Erinome"}]);
 let sent:any;assert.equal(await generateTts("test",input,{fetch:async(_u,o)=>{sent=JSON.parse(String(o?.body));return ok();}}),wav.toString("base64"));
 assert.deepEqual(sent,body);
 assert.equal(await generateTts("test",input,{fetch:async()=>Response.json({status:"completed",steps:[{type:"model_output",content:[{type:"audio",mime_type:"audio/wav",data:wav.toString("base64")}]}]})}),wav.toString("base64"));
});
test("TTS rejects missing audio, partial output and invalid controls",async()=>{
 for(const result of [{status:"completed"},{status:"failed",output_audio:{data:wav.toString("base64")}},{status:"completed",output_audio:{data:Buffer.from("garbage").toString("base64")}}]){
  await assert.rejects(generateTts("test",input,{fetch:async()=>Response.json(result)}));
 }
 assert.throws(()=>ttsRequest({...input,voice:"invented"}));assert.throws(()=>ttsRequest({...input,text:" "}));
});
test("TTS rotates quota-limited key and keeps text model health independent",async()=>{
 const db=new Database(":memory:");
 try{
  const store=new GeminiStore(db,{encrypt:v=>v,decrypt:v=>String(v)});
  store.add(["AIza-test-alpha-123456789","AIza-test-beta-123456789"]);
  const keys=store.list();store.record(keys[0]!.id,"ready",Date.now(),undefined,undefined,"gemini-3.5-flash-lite");
  let calls=0;const pool=new GeminiPool(store,{fetch:async()=>++calls===1?Response.json({error:{}},{status:429}):ok()});
  const result=await pool.speech(input);assert.equal(calls,2);assert.equal(result.keyId,keys[1]!.id);assert.equal(result.model,TTS_MODEL);
  assert.equal(store.list("gemini-3.5-flash-lite")[0]!.state,"ready");assert.equal(store.list(TTS_MODEL)[0]!.state,"cooldown");
 }finally{db.close();}
});
test("TTS cancellation propagates without recording successful audio",async()=>{
 const controller=new AbortController();
 const request=generateTts("test",input,{signal:controller.signal,fetch:async(_u,o)=>new Promise((_resolve,reject)=>o?.signal?.addEventListener("abort",()=>reject(Error("abort")),{once:true}))});
 controller.abort();await assert.rejects(request,/取消/);
});
for(const name of ["ltx-2.3-digital-human","infinitetalk-digital-human"])test(`TTS audio maps to ${name} without changing images or parameters`,()=>{
 const pkg=parsePortableWorkflowPackage(JSON.parse(readFileSync(`${["ltx-2.3-digital-human","minimax-h3-multi-reference","minimax-h3-selflift"].includes(name)?"tests/fixtures/retired-workflows":"bundled-workflows"}/${name}.rhworkflow.json`,"utf8")));
 const profile=materializePortableProfile(pkg,name,1);
 const view={id:name,profileVersion:1,parameters:profile.parameters} as WorkflowView;
 const draft=createDraft(view);const image=profile.parameters.find(p=>p.valueType==="image")!;
 draft.mediaOverrides[image.id]={mode:"replace",enabled:true,localPath:"C:/portrait.png"};
 const before=structuredClone(draft);const audio={localPath:"C:/tts.wav",fileName:"tts.wav",previewUrl:"file:///C:/tts.wav"};
 const result=applyTtsAudio(draft,view,audio);const parameter=profile.parameters.find(p=>p.valueType==="audio")!;
 assert.equal(result.mediaOverrides[parameter.id]!.localPath,audio.localPath);
 assert.equal(result.mediaOverrides[parameter.id]!.mode,"replace");assert.deepEqual(result.mediaOverrides[image.id],before.mediaOverrides[image.id]);
 assert.deepEqual(result.parameterValues,before.parameterValues);assert.deepEqual(draft,before);
 assert.throws(()=>applyTtsAudio(draft,{...view,profileVersion:2},audio),/更新/);
});
