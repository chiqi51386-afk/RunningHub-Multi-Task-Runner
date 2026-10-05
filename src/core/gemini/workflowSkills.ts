import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {H3_SKILL,H3_REFERENCE_GUIDE,H3_BASE_GUIDE} from './h3OfficialSkill.js';

export interface SkillSnapshot {id:string;name:string;content:string;hash:string;builtIn?:boolean}
export interface WorkflowSkillSettings {selectedId:string;skills:SkillSnapshot[]}
const names:Record<string,string>={
  '2106577322987307010':'H3多参考 · 官方 Skill',
  '2106994828660080641':'H3首尾帧 · 官方 Skill',
  '2107063778012905474':'H3数字人 · 官方 Skill',
};
export const supportsWorkflowSkill=(id:string)=>Object.hasOwn(names,id);
export function builtinWorkflowSkill(id:string,referenceMode=id!=='2106994828660080641'):SkillSnapshot {
  if(!supportsWorkflowSkill(id))throw Error('此工作流不支持生成词 Skill');
  const content=`${H3_SKILL}\n\n${referenceMode?H3_REFERENCE_GUIDE:H3_BASE_GUIDE}`;
  return {id:'builtin',name:names[id]!,content,hash:createHash('sha256').update(content).digest('hex'),builtIn:true};
}
export class WorkflowSkillStore {
  constructor(private db:Database){db.exec(`CREATE TABLE IF NOT EXISTS workflow_skills(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_skill_selection(workflow_id TEXT PRIMARY KEY,skill_id TEXT NOT NULL);`);
    db.transaction(() => {
      db.prepare("UPDATE workflow_skills SET workflow_id=? WHERE workflow_id=?").run('2107063778012905474','2104166509705986049');
      db.prepare("INSERT OR IGNORE INTO workflow_skill_selection(workflow_id,skill_id) SELECT ?,skill_id FROM workflow_skill_selection WHERE workflow_id=?").run('2107063778012905474','2104166509705986049');
    })();
  }
  settings(workflowId:string):WorkflowSkillSettings {
    const builtin=builtinWorkflowSkill(workflowId);
    const custom=this.db.prepare('SELECT id,name,content,hash FROM workflow_skills WHERE workflow_id=? ORDER BY rowid').all(workflowId) as SkillSnapshot[];
    const row=this.db.prepare('SELECT skill_id FROM workflow_skill_selection WHERE workflow_id=?').get(workflowId) as {skill_id:string}|undefined;
    return {selectedId:row?.skill_id??'builtin',skills:[builtin,...custom]};
  }
  select(workflowId:string,id:unknown){
    const settings=this.settings(workflowId);
    if(typeof id!=='string'||!settings.skills.some(s=>s.id===id))throw Error('Skill 不存在或不属于此工作流');
    this.db.prepare('INSERT INTO workflow_skill_selection(workflow_id,skill_id) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET skill_id=excluded.skill_id').run(workflowId,id);
    return this.settings(workflowId);
  }
  import(workflowId:string,name:unknown,content:unknown){
    builtinWorkflowSkill(workflowId);
    if(typeof name!=='string'||!name.trim()||name.length>200||typeof content!=='string'||!content.trim()||content.includes('\0')||Buffer.byteLength(content,'utf8')>256*1024)throw Error('Skill 必须是非空 UTF-8 文本，最大 256 KB');
    const clean=content.replace(/^\uFEFF/,'').trim(),hash=createHash('sha256').update(clean).digest('hex');
    const existing=this.db.prepare('SELECT id FROM workflow_skills WHERE workflow_id=? AND hash=?').get(workflowId,hash) as {id:string}|undefined;
    const id=existing?.id??randomUUID();
    if(!existing)this.db.prepare('INSERT INTO workflow_skills(id,workflow_id,name,content,hash) VALUES(?,?,?,?,?)').run(id,workflowId,name.trim(),clean,hash);
    return this.select(workflowId,id);
  }
  snapshot(workflowId:string,referenceMode:boolean):SkillSnapshot {
    const settings=this.settings(workflowId);
    if(settings.selectedId==='builtin')return builtinWorkflowSkill(workflowId,referenceMode);
    const skill=settings.skills.find(s=>s.id===settings.selectedId);
    if(!skill)throw Error('所选 Skill 已丢失，请重新选择');
    return structuredClone(skill);
  }
}
