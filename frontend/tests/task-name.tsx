import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CreateJob } from '../src/CreateTask';
import { createDraft } from '../src/task-draft';
import type { CreateJobDraft, WorkflowView } from '../src/types';
import sharp from '../../bundled-workflows/minimax-h3-sharp.rhworkflow.json';
import frames from '../../bundled-workflows/h3-first-last.rhworkflow.json';
import mv from '../../bundled-workflows/h3-digital-human-mv.rhworkflow.json';
import inf from '../../bundled-workflows/infinitetalk-digital-human.rhworkflow.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const root = createRoot(document.getElementById('root')!);
const results: string[] = [];
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); results.push(message); };
const workflows = [sharp, frames, mv, inf].map((pkg, i) => ({
  id: `fixture-${i}`, name: pkg.workflow.name, runningHubWorkflowId: pkg.workflow.runningHubWorkflowId,
  profileVersion: 1, parameters: pkg.profile.parameters, parameterCount: pkg.profile.parameters.length,
  needsReview: false, updatedAt: 0,
})) as WorkflowView[];
const setInput = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
};
const click = async (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label && !b.closest('[hidden]'));
  if (!button) throw Error(`Missing button: ${label}`);
  await act(async () => button.click());
};
try {
  for (const workflow of workflows) {
    localStorage.clear();
    let submitted: CreateJobDraft[] = [];
    const initialDraft = createDraft(workflow);
    if (workflow === workflows[2]) {
      const prompt = workflow.parameters.find(p => p.key === '87.value')!;
      const audio = workflow.parameters.find(p => p.key === '34.audio')!;
      initialDraft.parameterValues[prompt.id] = 'test';
      initialDraft.mediaOverrides[audio.id] = {enabled:true, mode:'replace',localPath:'C:/fixture.wav'};
    }
    await act(async () => root.render(<React.StrictMode><CreateJob key={workflow.id} workflows={workflows} initialWorkflowId={workflow.id} initialDraft={initialDraft} onCreate={async drafts => { submitted = drafts; return true; }}/></React.StrictMode>));
    const nameInput = document.querySelector<HTMLInputElement>('.create-mode-panel:not([hidden]) input[aria-label$="任务名称"]')!;
    for (const name of ['测', '测试', '测试名称', 'Ngày 8 任务']) {
      await setInput(nameInput, name);
      check(nameInput.value === name, `${workflow.name}: successive name input preserves ${name}`);
    }
    // IME/paste may have changed the visible input before React receives its
    // final input event. Clicking stage must snapshot the displayed name.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '尼罗河');
    await click('加入制作批次');
    check(document.querySelector('.batch-list strong')?.textContent === '尼罗河', `${workflow.name}: batch snapshot retains visible name during pending input`);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="编辑批次任务"]')!.click());
    await setInput(nameInput, '修改名称');
    await click('保存批次修改');
    await click('批量提交 1 个任务');
    check(submitted[0]?.taskName === '修改名称', `${workflow.name}: edited name reaches submission`);
    if (workflow !== workflows[2]) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '尼罗河直接提交');
      await click('提交当前任务');
      check(submitted[0]?.taskName === '尼罗河直接提交', `${workflow.name}: direct submission retains visible name`);
    }
  }
  document.title = 'PASS';
} catch (error) {
  document.title = 'FAIL'; results.push(String(error));
} finally {
  document.getElementById('result')!.textContent = results.join('\n');
  await act(async () => root.unmount());
}
