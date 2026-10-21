import { dialog } from 'electron';
import { join } from 'node:path';
import { atomicReplace, readBytes, StorageError } from '../core/storage/private-storage.js';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { ElectronHost } from './electron-host.js';
import { payload,textInput,uuidInput } from './ipc-validation.js';
import { mergeTaskLog, type TaskHandoffService } from './task-handoff-service.js';
export function installTaskHandoffRoutes(host:ElectronHost,plans:TaskOrchestrator,handoffs:TaskHandoffService,projectDirectory?:(id:string)=>string|undefined) {
  host.handle('task-handoffs',async input=>{const id=uuidInput(input);if(!await plans.loadPlan(id))throw new StorageError('missing-plan','任务不存在。');return handoffs.list(id);});
  host.handle('save-task-handoff',async input=>{
    const v=payload(input,['planID','expectedVersion','summary','next']);const id=uuidInput(v.planID),summary=textInput(v.summary,16*1024),next=textInput(v.next,16*1024);
    return (await plans.transactPlan(id,async plan=>{if(plan.version!==v.expectedVersion)throw new StorageError('plan-conflict','任务已更新，请核对新版本后保存交接。');return {value:await handoffs.append(plan,{source:'manual',summary,next})};})).value;
  });
  host.handle('export-task-handoffs',async input=>{
    const id=uuidInput(input),plan=await plans.loadPlan(id);if(!plan)throw new StorageError('missing-plan','任务不存在。');
    const choice=await dialog.showSaveDialog({title:'导出任务交接日志',defaultPath:join(plan.task?.project_id?projectDirectory?.(plan.task.project_id)??'':'','AGENTLOG.md'),filters:[{name:'Markdown',extensions:['md']}]});
    if(choice.canceled||!choice.filePath)return {saved:false};
    const before=await readBytes(choice.filePath,1024*1024),existing=before?.toString('utf8')??'# Agent 交接日志\n';
    const bytes=Buffer.from(mergeTaskLog(existing,id,await handoffs.markdown(plan)));
    await atomicReplace(choice.filePath,bytes,before,1024*1024);return {saved:true};
  });
}
