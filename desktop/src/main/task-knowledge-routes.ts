import { randomUUID } from 'node:crypto';
import { payload, textInput, uuidInput } from './ipc-validation.js';
import { StorageError } from '../core/storage/private-storage.js';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { TaskKnowledgeService } from './task-knowledge-service.js';
import type { KnowledgeSource } from '../shared/task-knowledge.js';
export function taskKnowledgeRouteHandlers(plans:TaskOrchestrator,knowledge:TaskKnowledgeService,sources:(id:string)=>Promise<KnowledgeSource[]>) {
  return {
    'knowledge:sources':async(input:unknown)=>sources(uuidInput(input)),
    'knowledge:search':async(input:unknown)=>{const v=payload(input,['query','includeArchived']);if(typeof v.includeArchived!=='boolean')throw new StorageError('ipc-input','归档筛选无效。');return knowledge.search(textInput(v.query,1024),v.includeArchived);},
    'knowledge:save':async(input:unknown)=>{
      const v=payload(input,['id','expectedRevision','archived','taskID','attemptID','confirmed','title','content','context']);
      const text={title:textInput(v.title,1024),content:textInput(v.content,24000),context:textInput(v.context,4096)};
      if(v.id!==undefined){if(v.taskID!==undefined||v.attemptID!==undefined||v.confirmed!==undefined||typeof v.archived!=='boolean')throw new StorageError('ipc-input','知识更新参数无效。');return knowledge.update(uuidInput(v.id),v.expectedRevision as number,text,v.archived);}
      if(v.expectedRevision!==undefined||v.archived!==undefined)throw new StorageError('ipc-input','知识创建参数无效。');
      return knowledge.create(text,uuidInput(v.taskID),uuidInput(v.attemptID),v.confirmed);
    },
    'knowledge:use':async(input:unknown)=>{
      const v=payload(input,['id','expectedRevision','taskID','expectedVersion']);const card=await knowledge.load(uuidInput(v.id)),view=await knowledge.view(card);
      if(card.revision!==v.expectedRevision||card.archived||view.sourceStatus!=='available')throw new StorageError('knowledge-unavailable','知识卡已变化、已归档或来源失效，请重新核对。');
      const plan=await plans.loadPlan(uuidInput(v.taskID));if(!plan||plan.scope||plan.schema_version!==3||!plan.task)throw new StorageError('knowledge-task','请保存本地任务后再选入知识。');
      if(plan.version!==v.expectedVersion)throw new StorageError('plan-conflict','任务已更新，请先核对新版本。');
      return plans.savePlan({...plan,task:{...plan.task,materials:[...plan.task.materials,{id:randomUUID(),title:card.title,summary:card.content+(card.context?'\n适用情境：'+card.context:''),source:{kind:'note',reference:`knowledge:${card.id}:r${card.revision}`,label:'人工确认知识 · 内容快照'}}]}},plan.version);
    },
  };
}
