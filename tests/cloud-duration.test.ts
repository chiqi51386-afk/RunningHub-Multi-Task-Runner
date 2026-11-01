import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloudRuntime } from "../src/cloud/runtime.js";
import { cloudServer } from "../src/cloud/server.js";
import type { AddressInfo } from "node:net";
import { buildNodeInfoList } from "../src/core/workflows/nodeInfo.js";

test("cloud MV resolves full audio, preserves segments and uses current resolution for Plus", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cloud-duration-"));
  const runtime = await cloudRuntime(root, path.resolve("bundled-workflows"));
  try {
    const wav = Buffer.alloc(44 + 23400 * 2);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(1000, 24); wav.writeUInt32LE(2000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    const audio = path.join(root, "uploads", "speech.wav"); await writeFile(audio, wav);
    const wf = runtime.backend.workflows.list().find(w => w.runningHubWorkflowId === "2107063778012905474")!;
    const input = { workflowId: wf.id, taskName: "Name", parameters: { prompt: "Act naturally" }, media: [{parameterId: "audio", localPath: audio}], optimize: false };
    const full = await runtime.prepare(input);
    assert.equal(full.parameters.duration, 0); assert.equal(full.parameters.duration_2, 24);
    assert.equal(full.parameters.resolution, 1.5); assert.equal(full.instanceType, "plus");
    assert.equal(full.taskName, "Name"); assert.equal(full.promptOptimization, undefined);
    const nodes = buildNodeInfoList(wf.profile, full.parameters);
    assert.equal(nodes.find(n => n.nodeId === "85" && n.fieldName === "start_index")?.fieldValue, 0);
    assert.equal(nodes.find(n => n.nodeId === "85" && n.fieldName === "duration")?.fieldValue, 24);
    const server = cloudServer(runtime, "test-token");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const headers = {Authorization: "Bearer test-token"};
      const upload = await fetch(base + "/uploads?filename=voice.wav", {method:"POST",headers,body:wav});
      const meta = await upload.json(); assert.equal(meta.durationSeconds, 23.4); assert.equal(meta.suggestedEndSeconds, 24);
      const preview = await fetch(base + "/jobs/preview", {method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(input)});
      assert.equal(preview.status, 200); const planned = await preview.json();
      assert.equal(planned.parameters.duration_2, 24); assert.equal(runtime.backend.jobs.list().length, 0);
      const picture=path.join(root,"uploads","person.jpg");await writeFile(picture,"fixture");
      const call=async (method:string,endpoint:string,body?:unknown)=>fetch(base+endpoint,{method,headers:{...headers,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const form={module:"h3-mv",taskName:"Whole name",audio,images:[picture],prompt:"Speak",optimize:false,segments:[{endSeconds:10},{endSeconds:20},{}]};
      const add=await call("POST","/workspace/batches",{requestId:"batch-test",tasks:[form]});
      assert.equal(add.status,200,await add.clone().text());const batch=await add.json();
      assert.equal(batch.jobs.length,3);assert.deepEqual(batch.jobs.map((j:any)=>j.parameters.duration_2),[10,10,4]);
      assert.ok(batch.jobs.every((j:any)=>j.taskName==="Whole name"&&!j.promptOptimization));
      assert.deepEqual(batch.jobs.map((j:any)=>j.production.segmentIndex),[1,2,3]);
      assert.equal(new Set(batch.jobs.map((j:any)=>j.production.groupId)).size,1);
      assert.equal(runtime.backend.jobs.list().length,0);
      const submissions=await Promise.all([call("POST","/workspace/batches/batch-test/submit"),call("POST","/workspace/batches/batch-test/submit")]);
      const submitted=await Promise.all(submissions.map(r=>r.json()));assert.deepEqual(submitted[0].jobIds,submitted[1].jobIds);
      assert.equal(runtime.backend.jobs.list().length,3);
      assert.equal((await call("PATCH","/workspace/batches/batch-test",{tasks:[form]})).status,400);
      const tail=await call("POST","/workspace/preview",{module:"h3-first-last",lastFrame:picture,prompt:"Transition",optimize:false});
      assert.equal(tail.status,200,await tail.clone().text());const lastFrame=await tail.json();assert.equal(lastFrame.jobs[0].media[0].parameterId,"image_2");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    const first = await runtime.prepare({...input, audioRange: {startSeconds: 0, endSeconds: 10.5}});
    const last = await runtime.prepare({...input, audioRange: {startSeconds: 10.5}});
    assert.equal(first.parameters.duration_2, 10.5); assert.equal(last.parameters.duration, 10.5); assert.equal(last.parameters.duration_2, 13.5);
    const old = await runtime.prepare({...input, parameters: {...input.parameters, duration: 5, duration_2: 10}});
    assert.equal(old.parameters.duration_2, 10);
    await assert.rejects(runtime.prepare({...input, audioRange: {startSeconds: 24}}));
    await assert.rejects(runtime.prepare({...input, audioRange: {endSeconds: 25}}));
    await assert.rejects(runtime.prepare({...input, parameters: {...input.parameters, duration_2: 10}, audioRange: {endSeconds: 10}}));
    for (const mp of [0.9, 1.5, 2]) {
      const threshold = mp === 0.9 ? 15 : mp === 1.5 ? 13 : 12;
      for (const duration of [threshold, threshold + 0.1]) {
        const job = await runtime.prepare({...input, parameters: {...input.parameters, resolution: mp}, audioRange: {endSeconds: duration}});
        assert.equal(job.instanceType, duration > threshold ? "plus" : "default");
      }
    }
    const explicit = await runtime.prepare({...input, instanceType: "default"}); assert.equal(explicit.instanceType, "default");
    assert.equal(runtime.backend.jobs.list().length, 3);
    for (const w of runtime.backend.workflows.list().filter(w => ["2106577322987307010", "2106994828660080641"].includes(w.runningHubWorkflowId))) {
      const draft = await runtime.prepare({workflowId: w.id, parameters: {prompt: "Test"}, optimize:false});
      assert.equal(draft.parameters.resolution, 1.5);
    }
  } finally { await runtime.backend.close(); await rm(root, {recursive:true,force:true}); }
});
