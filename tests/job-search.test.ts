import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesJobSearch, taskDisplayName, taskListName} from '../frontend/src/job-search.js';
import type {JobView} from '../frontend/src/types.js';
const job = {id:'local-123',remoteTaskId:'998877',workflowName:'hidden workflow',inputs:{media:[{mode:'replace',fileName:'人物A.png'}],parameters:[{semanticType:'prompt',value:'Walking in Hanoi'}]}} as JobView;
test('list hides only the final filename extension without changing canonical names',()=>{
  const named={...job,displayName:'001_版本1.5 (1).MP4'};
  assert.equal(taskListName(named),'001_版本1.5 (1)');
  assert.equal(taskDisplayName(named),'001_版本1.5 (1).MP4');
  assert.equal(matchesJobSearch(named,'.mp4'),true);
  assert.equal(taskListName({...job,taskName:'版本1.5'}),'版本1.5');
});
test('task search combines case-insensitive name, ID and prompt terms',()=>{
  assert.equal(taskDisplayName({...job,taskName:'我的任务'}),'我的任务');
  assert.equal(matchesJobSearch({...job,taskName:'我的任务'},'我的任务'),true);
  assert.equal(taskDisplayName(job),'任务 998877');
  assert.equal(taskDisplayName({...job,taskName:'原始名称',displayName:'001_原始名称 (1).mp4'}),'001_原始名称 (1).mp4');
  assert.equal(matchesJobSearch({...job,taskName:'原始名称',displayName:'001_原始名称 (1).mp4'},'原始名称 (1)'),true);
  for(const query of ['', '人物a', '998877', 'local-123', '人物A HANOI'])assert.equal(matchesJobSearch(job,query),true);
  assert.equal(matchesJobSearch(job,'absent'),false);
  assert.equal(matchesJobSearch(job,'hidden workflow'),false);
  assert.equal(taskDisplayName({...job,inputs:undefined}),'任务 998877');
});
