import test from "node:test";
import assert from "node:assert/strict";
import {assertTranscriptPreserved,optimizeTtsTranscript,TTS_OPTIMIZER_MODEL} from "../src/core/gemini/ttsOptimize.js";
import {TTS_LANGUAGES} from "../src/core/gemini/ttsTypes.js";

test("automatic optimization uses fixed Flash-Lite with separate instructions and verbatim source",async()=>{
 const original="Hôm nay Nguyễn gặp mẹ cảm ơn mẹ";
 const expected="Hôm nay, Nguyễn gặp mẹ. Cảm ơn mẹ!";
 // Uppercase changes are content changes too; keep exact case in accepted output.
 const accepted="Hôm nay, Nguyễn gặp mẹ. cảm ơn mẹ!";
 const result=await optimizeTtsTranscript({generate:async(input,signal,model)=>{
  assert.equal(model,TTS_OPTIMIZER_MODEL);assert.equal(JSON.parse(input.text).transcript,original);
  assert.match(input.systemInstruction!,/最高优先级/);
  return {text:accepted,keyId:"test",model:model!};
 }},{text:original,language:"vi"});
 assert.equal(result,accepted);assert.throws(()=>assertTranscriptPreserved(original,expected));
});
test("all 19 languages allow punctuation without changing their script",()=>{
 assert.equal(TTS_LANGUAGES.length,19);assert.equal(TTS_LANGUAGES[0].id,"vi");
 for(const language of TTS_LANGUAGES){assertTranscriptPreserved(language.sample,language.sample+"\n");}
 for(const [a,b] of [["ສະບາຍດີ ຂອບໃຈ","ສະບາຍດີ!\nຂອບໃຈ."],["សួស្តី អរគុណ","សួស្តី! អរគុណ."],["नमस्ते धन्यवाद","नमस्ते, धन्यवाद!"]])assertTranscriptPreserved(a!,b!);
});
test("content guard rejects deletion, repetition, translation, diacritics and protected token changes",()=>{
 const pairs=[
  ["Xin chào Nguyễn","Xin chào"],["Xin chào","Xin Xin chào"],["Xin chào","Hello"],
  ["mẹ","me"],["nowhere","now here"],["12.5","12,5"],["-15","15"],["10:30","10 30"],
  ["don't","dont"],["well-known","well known"],["U.S.A.","USA"],
  ["https://example.com/a-b","https://example.com/ab"],["a.b@example.com","ab@example.com"],
  ["Hello <sigh>","Hello"],["Hello","Hello <short pause>"],
 ];
 for(const [original,result]of pairs)assert.throws(()=>assertTranscriptPreserved(original!,result!));
 assertTranscriptPreserved("Nguyễn có 12.5 hôm nay","Nguyễn có 12.5, hôm nay.");
});
test("invalid and cancelled optimizations do not yield replacement text",async()=>{
 await assert.rejects(optimizeTtsTranscript({generate:async()=>({text:"rewritten",keyId:"a",model:"x"})},{text:"Original",language:"en"}),/未覆盖/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(optimizeTtsTranscript({generate:async()=>({text:"Original.",keyId:"a",model:"x"})},{text:"Original",language:"en"},controller.signal));
 await assert.rejects(optimizeTtsTranscript({generate:async()=>{throw Error("503");}},{text:"Original",language:"en"}),/503/);
});
