import type {CreateJobDraft,WorkflowView} from './types.js';

/** Compare only the inputs consumed by Google, never React object identity. */
export function optimizationInputSignature(draft:CreateJobDraft,workflow:WorkflowView):string {
  const keys=['247.text','132.value','115.aspect_ratio'];
  const values=keys.map(key=>{
    const parameter=workflow.parameters.find(p=>p.key===key);
    return [key,parameter?draft.parameterValues[parameter.id]:null];
  });
  const images=workflow.parameters.filter(p=>p.valueType==='image').sort((a,b)=>(a.referenceIndex??0)-(b.referenceIndex??0)).map(p=>{
    const media=draft.mediaOverrides[p.id];
    return [p.key,p.referenceIndex,media?.mode==='replace'?['replace',media.localPath??null,media.file?[media.file.name,media.file.size,media.file.lastModified]:null]:['clear']];
  });
  return JSON.stringify([draft.workflowId,draft.profileVersion,values,images]);
}
