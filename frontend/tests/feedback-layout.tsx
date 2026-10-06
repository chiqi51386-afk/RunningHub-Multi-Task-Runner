import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Feedback, Notice } from '../src/Feedback';
import { CreateJob } from '../src/CreateTask';
import Accounts from '../src/views/Accounts';
import Jobs from '../src/views/Jobs';
import SettingsModal from '../src/modals/SettingsModal';
import { GeminiTts } from '../src/GeminiTts';
import type { JobView } from '../src/types';
import { defaultUiPreferences } from '../src/app-shared';
import type { WorkflowView } from '../src/types';
import sharp from '../../bundled-workflows/minimax-h3-sharp.rhworkflow.json';
import frames from '../../bundled-workflows/h3-first-last.rhworkflow.json';
import mv from '../../bundled-workflows/h3-digital-human-mv.rhworkflow.json';
import inf from '../../bundled-workflows/infinitetalk-digital-human.rhworkflow.json';
import '../src/styles.css';
import '../src/themes.css';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
const root = createRoot(document.getElementById('root')!);
const results:string[]=[];
const check=(ok:unknown,message:string)=>{if(!ok)throw Error(message);results.push(message);};
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const workflows=[sharp,frames,mv,inf].map((pkg,i)=>({id:`fixture-${i}`,name:pkg.workflow.name,runningHubWorkflowId:pkg.workflow.runningHubWorkflowId,profileVersion:1,parameters:pkg.profile.parameters,parameterCount:pkg.profile.parameters.length,needsReview:false,updatedAt:0})) as WorkflowView[];
const render=async(content:React.ReactNode)=>{await act(async()=>root.render(<div className="app-shell"><aside className="sidebar"/><main className="main"><div className="page">{content}</div></main></div>));await act(async()=>{await wait(40);});};
function checkBounds(label:string){
  check(document.documentElement.scrollWidth<=innerWidth+1,`${label}: no document horizontal overflow at ${innerWidth}px`);
  for(const selector of ['.create-layout','.form-panel','.submit-bar','.modal','.tts-workspace']){
    for(const node of document.querySelectorAll<HTMLElement>(selector)){
      if(!node.getClientRects().length)continue;
      const r=node.getBoundingClientRect();
      check(r.left>=-1&&r.right<=innerWidth+1,`${label}: ${selector} stays inside viewport`);
    }
  }
  for(const parent of document.querySelectorAll('.submit-bar,.content-input-label,.tts-options,.jobs-toolbar')){
    if(!parent.getClientRects().length)continue;
    const children=[...parent.children].map(e=>e.getBoundingClientRect()).filter(r=>r.width&&r.height);
    children.forEach((a,i)=>children.slice(i+1).forEach(b=>check(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`${label}: controls do not overlap`)));
  }
}
try{
  localStorage.clear();
  await render(<><div id="anchor">内容</div><Feedback message={'失败：'+ '很长的文件名'.repeat(50)} duration={0}/><Feedback message="已加入 1 个任务" tone="success" duration={0}/><Notice><div className="operation-toast">正在取消任务…</div></Notice><Notice><div className="task-toast">任务生成完成</div></Notice></>);
  const boxes=[...document.querySelectorAll('.notification-stack > *')].map(e=>e.getBoundingClientRect());
  check(boxes.length===4,'four concurrent notices share a single region');
  boxes.forEach((r,i)=>{check(r.left>=0&&r.right<=innerWidth,'long notice stays within viewport');if(i)check(r.top>=boxes[i-1].bottom,'notifications never overlap each other');});
  const before=document.getElementById('anchor')!.getBoundingClientRect().top;
  await act(async()=>document.querySelector<HTMLButtonElement>('.feedback-toast button')!.click());
  check(document.getElementById('anchor')!.getBoundingClientRect().top===before,'dismissing feedback does not move the form');
  await render(<Feedback message="自动消失" tone="success" duration={50}/>);
  await act(async()=>{await wait(90);});
  check(!document.querySelector('.feedback-toast'),'success notice dismisses automatically');
  for(const workflow of workflows){
    await render(<CreateJob key={workflow.id} workflows={workflows} initialWorkflowId={workflow.id} onCreate={async()=>true}/>);
    checkBounds(workflow.name);
  }
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('.create-mode-tabs button')].find(b=>b.textContent==='Gemini TTS')!.click());
  checkBounds('Gemini TTS');
  localStorage.setItem('rh-runner.tts.v1',JSON.stringify({text:'配音测试文本',style:'缓慢温柔',language:'vi',voice:'Erinome'}));
  await render(<GeminiTts active onSend={()=>{}}/>);
  const transcript=document.querySelector<HTMLTextAreaElement>('#tts-transcript')!;
  const style=document.querySelector<HTMLTextAreaElement>('[aria-label="风格指令"]')!;
  const clear=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='清空文本')!;
  check(transcript.value==='配音测试文本'&&style.value==='缓慢温柔','TTS loads both saved texts');
  check(clear.getBoundingClientRect().bottom+8<=transcript.getBoundingClientRect().top,'TTS clear button has spacing above textarea');
  check(!document.body.textContent?.includes('自动优化'),'TTS automatic optimization removed');
  await act(async()=>clear.click());
  check(transcript.value===''&&style.value==='','clear text empties transcript and style together');
  await act(async()=>{await wait(350);});
  const savedTts=JSON.parse(localStorage.getItem('rh-runner.tts.v1')!);
  check(savedTts.text===''&&savedTts.style===''&&savedTts.voice==='Erinome'&&savedTts.language==='vi','clear persists empty texts without changing language or voice');
  for(const status of ['RUNNING','FAILED','COMPLETED'] as const){
    const job={id:status,status,taskName:'预览测试',createdAt:1,inputs:{workflowId:'fixture',profileVersion:1,media:[],parameters:[]},outputs:[]} as unknown as JobView;
    await render(<Jobs key={status} jobs={[job]} cancelling={new Set()} onCancel={()=>{}} onRegenerate={()=>{}} onDelete={()=>{}} onReveal={()=>{}}/>);
    const preview=document.querySelector<HTMLButtonElement>('.job-actions .primary')!;
    check(preview.textContent==='预览',`${status}: preview button has unified label`);
    await act(async()=>{preview.click();await wait(100);});
    check(document.querySelector('.preview-section-tabs .active')?.textContent?.startsWith(status==='COMPLETED'?'生成输出':'提交参数'),`${status}: preview opens correct initial section`);
  }
  await render(<Accounts accounts={[{id:'test-account',label:'很长的账号名称'.repeat(12),enabled:true,state:'IDLE',maxConcurrency:3}]} refreshing={null} onRefresh={()=>{}} onRefreshAll={()=>{}} onAdd={()=>{}} onRekey={()=>{}} onToggle={()=>{}} onRemove={()=>{}} onCopyApiKeysUrl={()=>{}}/>);
  checkBounds('账号池');
  await render(<Jobs jobs={[]} cancelling={new Set()} onCancel={()=>{}} onRegenerate={()=>{}} onDelete={()=>{}} onReveal={()=>{}}/>);
  checkBounds('任务列表');
  await render(<SettingsModal preferences={defaultUiPreferences} onPreferencesChange={()=>{}} onClose={()=>{}}/>);
  checkBounds('设置');
  document.title='PASS';
}catch(error){results.push(String(error));document.title='FAIL';}
finally{await act(async()=>root.unmount());document.getElementById('result')!.textContent=results.join('\n');}
