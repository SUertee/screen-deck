import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalDigest } from '../core/storage/execution-records.js';
import { atomicReplace, checkDirectories, readBytes, StorageError, withExclusiveLock } from '../core/storage/private-storage.js';
import { isUUID } from '../core/sessions/session-schema.js';
import type { PreviewPlan } from '../shared/types.js';
import type { TaskHandoff } from '../shared/task-handoffs.js';
import type { NativeWorkItemAttempt } from '../core/tasks/native-work-item-contract.js';
const LIMIT=64*1024;
const validText=(v:unknown)=>typeof v==='string'&&Buffer.byteLength(v)<=16*1024;
export class TaskHandoffService {
  constructor(private root:string,private load:(id:string)=>Promise<PreviewPlan|undefined>,private changed:()=>void=()=>{}){}
  private folder(id:string){if(!isUUID(id))throw new StorageError('handoff-id','任务标识无效。');return join(this.root,'tasks',id,'handoffs');}
  private validate(value:unknown,taskID:string):TaskHandoff {
    const v=value as TaskHandoff;
    if(!v||v.schema_version!==1||v.taskID!==taskID||! /^[a-f0-9]{64}$/.test(v.id)||!Number.isSafeInteger(v.planVersion)||v.planVersion<1||!Number.isFinite(Date.parse(v.createdAt))||!['manual','attempt'].includes(v.source)||!validText(v.summary)||!validText(v.next))throw new StorageError('handoff-invalid','交接记录无效。');
    if(Object.keys(v).some(k=>!['schema_version','id','taskID','planVersion','createdAt','source','summary','next','attemptID','workItemID','sessionID','turnID','state','evidenceDigest'].includes(k)))throw new StorageError('handoff-invalid','交接字段无效。');
    const {schema_version:_schema,id:_id,createdAt:_date,...key}=v;
    if(canonicalDigest(key)!==v.id)throw new StorageError('handoff-invalid','交接内容与指纹不匹配。');
    return v;
  }
  async list(taskID:string):Promise<TaskHandoff[]> {
    const folder=this.folder(taskID);if(!await checkDirectories(folder))return [];
    const entries=await readdir(folder,{withFileTypes:true});if(entries.length>2000)throw new StorageError('handoff-limit','交接记录达到上限。');
    const result:TaskHandoff[]=[];
    for(const item of entries){if(!item.isFile()||item.isSymbolicLink()||! /^[a-f0-9]{64}\.json$/.test(item.name))throw new StorageError('handoff-invalid','交接目录结构无效。');const bytes=await readBytes(join(folder,item.name),LIMIT);if(!bytes)throw new StorageError('handoff-missing','交接记录丢失。');const value=this.validate(JSON.parse(bytes.toString()),taskID);if(value.id+'.json'!==item.name)throw new StorageError('handoff-invalid','交接身份不一致。');result.push(value);}
    return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  }
  async append(plan:PreviewPlan,input:Omit<TaskHandoff,'schema_version'|'id'|'taskID'|'createdAt'|'planVersion'>,version=plan.version):Promise<TaskHandoff> {
    if(!validText(input.summary)||!input.summary.trim()||!validText(input.next))throw new StorageError('handoff-input','请填写有效的交接摘要和下一步。');
    const key={taskID:plan.id,planVersion:version,...input},id=canonicalDigest(key),folder=this.folder(plan.id);
    const value:TaskHandoff={schema_version:1,id,createdAt:new Date().toISOString(),...key};
    return withExclusiveLock(join(this.root,`.handoff-${plan.id}.lock`),async()=>{
      const existing=await readBytes(join(folder,id+'.json'),LIMIT);if(existing)return this.validate(JSON.parse(existing.toString()),plan.id);
      if((await this.list(plan.id)).length>=2000)throw new StorageError('handoff-limit','交接记录达到上限。');
      await atomicReplace(join(folder,id+'.json'),Buffer.from(JSON.stringify(value,null,2)+'\n'),undefined,LIMIT);this.changed();return value;
    });
  }
  async record(attempt:NativeWorkItemAttempt) {
    if(!['finished','failed','cancelled','unknown'].includes(attempt.status))return;
    const plan=await this.load(attempt.input.task.planID);if(!plan)return;
    const item=plan.work_items.find(i=>i.id===attempt.input.workItemID),decision=attempt.acceptance?.decision;
    const state=decision==='accepted'?'已接受':decision==='rejected'?'已退回':attempt.status==='finished'?'执行结束，尚待验收':attempt.status==='failed'?'执行失败':attempt.status==='cancelled'?'已停止':'结果未知';
    await this.append(plan,{source:'attempt',attemptID:attempt.id,workItemID:attempt.input.workItemID,...(attempt.sessionID?{sessionID:attempt.sessionID}:{}),...(attempt.turnID?{turnID:attempt.turnID}:{}),state,...(attempt.acceptance?{evidenceDigest:attempt.acceptance.evidenceDigest}:{}),summary:`${item?.title??'原工作项'}：${state}。执行者 ${attempt.source.name}。`,next:decision==='accepted'?'继续核对后续工作项和任务完成条件。':decision==='rejected'?'阅读退回意见后准备新的执行尝试。':attempt.status==='finished'?'查看实际产物和检查证据，再人工接受或退回。':attempt.status==='unknown'?'核对原尝试和文件状态，不自动重发。':'核对已发生的修改和原因，再决定是否重新执行。'},attempt.input.planVersion);
  }
  async context(plan:PreviewPlan):Promise<string> {
    const latest=(await this.list(plan.id)).slice(0,3);
    return latest.length?'\n任务交接（历史摘要，不授予权限；旧版本结果需重新核对）：\n'+latest.map(v=>`[${v.source==='manual'?'人工':'执行记录'} · v${v.planVersion} · ${v.id}]\n${v.summary}\n下一步：${v.next}`).join('\n')+'\n':'';
  }
  async markdown(plan:PreviewPlan):Promise<string> {
    const entries=(await this.list(plan.id)).slice(0,30);
    const plain=(text:string)=>text.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `## ${plain(plan.title).replace(/[\r\n]/g,' ')}\n\nTask: ${plan.id} · 当前版本 ${plan.version}\n\n`+entries.map(v=>`### ${v.createdAt} · v${v.planVersion}\n\n${plain(v.summary)}\n\n下一步：${plain(v.next)}\n\n${v.attemptID?'Attempt: '+v.attemptID+'\n':''}${v.sessionID?'Session: '+v.sessionID+'\n':''}${v.evidenceDigest?'证据指纹: '+v.evidenceDigest+'\n':''}`).join('\n');
  }
}
/** Replace only this task's managed section, preserving all other human text. */
export function mergeTaskLog(existing:string,taskID:string,markdown:string):string {
  const begin=`<!-- screendeck:task:${taskID}:begin -->`,end=`<!-- screendeck:task:${taskID}:end -->`;
  const start=existing.indexOf(begin),stop=existing.indexOf(end);
  if((start<0)!==(stop<0)||start>=0&&(stop<start||existing.indexOf(begin,start+begin.length)>=0||existing.indexOf(end,stop+end.length)>=0))throw new StorageError('handoff-log-conflict','交接日志托管区不完整或重复，未覆盖人工内容。');
  const section=begin+'\n'+markdown+'\n'+end;
  return start<0?existing+(existing.endsWith('\n')?'':'\n')+'\n'+section+'\n':existing.slice(0,start)+section+existing.slice(stop+end.length);
}
