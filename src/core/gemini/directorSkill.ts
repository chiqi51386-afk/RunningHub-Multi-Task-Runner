import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';

export const DIRECTOR_SKILL_ID='h3-storyboard-director-cn';
// Resolve relative to the module, never the launch directory. Source and compiled
// builds have different depth; both load the same packaged instruction file.
function readInstructions():string {
  const candidates=[
    new URL('../../../prompt-skills/h3-director.md',import.meta.url),
    new URL('../../../../prompt-skills/h3-director.md',import.meta.url),
  ];
  const file=candidates.find(url=>existsSync(url));
  if(!file)throw new Error('第一阶段导演指令文件缺失，请重新安装完整版本。');
  const content=readFileSync(file,'utf8').trim();
  if(!content)throw new Error('第一阶段导演指令文件为空。');
  return content;
}
export function directorSkill(id:unknown){
  if(id===undefined||id==='none')return undefined;
  if(id!==DIRECTOR_SKILL_ID)throw new Error('未知的第一阶段 Skill');
  const content=readInstructions();
  return {id:DIRECTOR_SKILL_ID,name:'H3 导演层（执行版 v2）',content,hash:createHash('sha256').update(content).digest('hex')};
}
