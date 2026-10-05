import type {WorkflowRecord} from '../types.js';
import {H3_OPTIMIZATION_ROUTES} from './routes.js';

/** Freeze the global choice at submission; never fall back to another optimizer. */
export function selectOptimization(workflow:WorkflowRecord, parameters:Record<string,unknown>, requested:boolean|undefined, enabled:boolean, model:string) {
  const route=H3_OPTIMIZATION_ROUTES[workflow.runningHubWorkflowId];
  const toggle=workflow.profile.parameters.find(p=>p.key==='328.value'&&p.classType==='easy boolean');
  const use=requested ?? (toggle ? parameters[toggle.id]===true : false);
  if(!route){if(use)throw new Error('此工作流尚未配置生成词优化映射。');return undefined;}
  if(toggle)parameters[toggle.id]=false;
  if(!use)return undefined;
  return {model};
}
