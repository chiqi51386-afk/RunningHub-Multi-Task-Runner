import test from "node:test";
import assert from "node:assert/strict";
import { RunningHubBackend } from "../src/core/index.js";
import { NullLogger } from "../src/core/logger.js";
import { parseJobResult } from "../src/core/runninghub/client.js";

async function waitFor(check:()=>boolean){
  const end=Date.now()+4000;
  while(!check()){if(Date.now()>end)throw Error("timeout");await new Promise(r=>setTimeout(r,5));}
}
for(const kind of ["query-exception","invalid-url","missing-url"] as const) test(`fileUrl ${kind} never resubmits generation`,async()=>{
  let submissions=0,queries=0;
  const backend=new RunningHubBackend({databasePath:":memory:",logger:new NullLogger(),
    config:{pollIntervalMs:1,pollJitterMs:0,maxPollingMs:100,retryDelayMs:5,maxQueryFailures:1},
    fetch:async(input,init)=>{
      const url=String(input);
      if(url.endsWith("/accountStatus"))return Response.json({code:0,data:{remainMoney:"100",currentTaskCounts:0}});
      if(url.includes("/run/workflow/")){submissions++;return Response.json({code:0,data:{taskId:"paid-task"}});}
      if(url.endsWith("/query")){
        queries++;assert.equal(JSON.parse(String(init?.body)).taskId,"paid-task");
        if(kind==="query-exception")throw new TypeError("Cannot read properties of undefined (reading 'fileUrl')");
        return Response.json({status:"SUCCESS",results:[{fileUrl:kind==="invalid-url"?"not-a-url":null}]});
      }
      throw Error("unexpected network request");
    }});
  try{
    backend.accounts.add("test","test-key");
    const wf=backend.workflows.importApiJson({name:"test",runningHubWorkflowId:"123456789012",workflow:{"1":{class_type:"Text",inputs:{text:"default"},_meta:{title:"Prompt"}}}});
    const job=backend.jobs.create({workflowId:wf.id,parameters:{prompt:"test"}});
    await backend.start();
    await waitFor(()=>kind==="query-exception"?queries>=5:["FAILED","COMPLETED","RETRY_WAIT"].includes(backend.jobs.get(job.id)!.status));
    assert.equal(submissions,1);
    assert.equal(backend.jobs.get(job.id)!.remoteTaskId,"paid-task");
    if(kind==="query-exception")assert.ok(["RUNNING","REMOTE_QUEUED","RETRY_WAIT"].includes(backend.jobs.get(job.id)!.status));
    if(kind==="missing-url"){
      assert.notEqual(backend.jobs.get(job.id)!.status,"COMPLETED");
      assert.equal(backend.jobs.get(job.id)!.retryPhase,"query");
      await backend.stop();await backend.start();await waitFor(()=>queries>=5);
      assert.equal(submissions,1);
      assert.equal(backend.jobs.get(job.id)!.remoteTaskId,"paid-task");
    }
  }finally{await backend.close();}
});

test("partial file lists stay pending while genuine text-only outputs remain valid",()=>{
  for(const results of [[],[{fileUrl:""}],[{fileUrl:"   "}],[{fileUrl:{}}],[{fileUrl:null,text:"placeholder"}],[{fileUrl:"https://files/ok.mp4"},{fileUrl:null}]]){
    assert.throws(()=>parseJobResult("paid-task",{status:"SUCCESS",results}),/仅重查原任务/);
  }
  assert.deepEqual(parseJobResult("text-task",{status:"SUCCESS",results:[{text:"valid text"}]}).texts,["valid text"]);
});

test("old false completion rechecks saved task and downloads recovered URL without submitting",async()=>{
  let submits=0,queries=0,downloads=0;
  const backend=new RunningHubBackend({databasePath:":memory:",logger:new NullLogger(),
    config:{pollIntervalMs:1,pollJitterMs:0,maxPollingMs:100,retryDelayMs:5,maxQueryFailures:1},
    downloadTransfer:async(_f,_c,url,destination)=>{downloads++;assert.equal(url,"https://files/recovered.mp4");return destination;},
    fetch:async(input,init)=>{
      const url=String(input);
      if(url.endsWith("/accountStatus"))return Response.json({code:0,data:{remainMoney:"100",currentTaskCounts:0}});
      if(url.includes("/run/workflow/")){submits++;throw Error("MUST NOT RESUBMIT");}
      if(url.endsWith("/query")){
        queries++;assert.equal(JSON.parse(String(init?.body)).taskId,"already-paid");
        return Response.json({status:"SUCCESS",results:[{fileUrl:queries<3?null:"https://files/recovered.mp4"}]});
      }
      throw Error("unexpected network request");
    }});
  try{
    const account=backend.accounts.add("test","test-key");
    const wf=backend.workflows.importApiJson({name:"test",runningHubWorkflowId:"123456789012",workflow:{"1":{class_type:"Text",inputs:{text:"default"},_meta:{title:"Prompt"}}}});
    const job=backend.jobs.create({workflowId:wf.id,parameters:{prompt:"test"}});
    const raw={status:"SUCCESS",results:[{fileUrl:null}]};
    backend.database.updateJob(job.id,{status:"COMPLETED",accountId:account.id,remoteTaskId:"already-paid",completedAt:Date.now(),rawResult:raw,outputs:{taskId:"already-paid",files:[],texts:[],raw}});
    await backend.start();
    await waitFor(()=>backend.jobs.get(job.id)?.status==="COMPLETED"&&downloads===1);
    assert.equal(submits,0);assert.equal(queries,3);
    assert.equal(backend.jobs.get(job.id)!.outputs!.files.length,1);
    assert.equal(backend.jobs.get(job.id)!.remoteTaskId,"already-paid");
  }finally{await backend.close();}
});
