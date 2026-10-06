import {useEffect,useState} from 'react';
import {X,Upload} from 'lucide-react';
import { Feedback } from "../Feedback";
import {Select} from '../Select';
import type {WorkflowView} from '../types';
import type {WorkflowSkillSettings} from '../../../src/core/gemini/workflowSkills';

export default function WorkflowSkillModal({workflow,onClose}:{workflow:WorkflowView;onClose:()=>void}){
  const [settings,setSettings]=useState<WorkflowSkillSettings>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const bridge=window.runningHub?.skills;
  useEffect(()=>{let alive=true;if(bridge)bridge.settings(workflow.id).then(s=>{if(alive)setSettings(s);}).catch(e=>{if(alive)setError(String(e));});else setError('请在桌面端加载 Skill');return()=>{alive=false;};},[workflow.id]);
  async function change(action:()=>Promise<WorkflowSkillSettings|undefined>){
    if(busy)return;setBusy(true);setError('');
    try{const result=await action();if(result)setSettings(result);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  const selected=settings?.skills.find(s=>s.id===settings.selectedId);
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label="工作流 Skill">
    <div className="modal-head"><h2>{workflow.name} · Skill</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18}/></button></div>
    <p>单阶段生成词优化。设置仅用于这个工作流的新提交任务，不影响已提交任务。</p>
    <label>加载 Skill<Select aria-label="加载 Skill" disabled={busy||!settings} value={settings?.selectedId??'builtin'} onChange={e=>void change(()=>bridge!.select(workflow.id,e.target.value))}>{settings?.skills.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
    <div className="settings-actions"><button className="secondary" disabled={busy||!bridge} onClick={()=>void change(()=>bridge!.import(workflow.id))}><Upload size={16}/>{busy?'正在保存…':'上传自定义 Skill'}</button></div>
    <p>支持 UTF-8 的 .md / .txt 文件（最大 256 KB）。自定义内容替换内置 Skill；软件仍会附上生成词、素材、时长和画面比例，不执行文件里的代码。</p>
    {selected&&<details><summary>查看已加载内容 · {selected.name}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{selected.content}</pre></details>}
    <Feedback message={error} onClose={()=>setError("")}/>
    <div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button></div>
  </div></div>;
}
