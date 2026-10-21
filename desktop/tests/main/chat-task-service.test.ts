import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatTaskService } from '../../src/main/chat-task-service';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator';
import type { SessionRecord, PreviewPlan } from '../../src/shared/types';
import type { CreateChatTaskInput } from '../../src/shared/chat-task';
async function fixture(t: test.TestContext) {
 const root=await mkdtemp(join(await realpath(tmpdir()),'sd-chat-task-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tasks=new TaskOrchestrator(root,{formalTasks:true}),sessionID=randomUUID(),messageID=randomUUID(),turnID=randomUUID(),date=new Date().toISOString();
 const record:SessionRecord={schema_version:1,conversation_id:sessionID,title:'合成已保存聊天',scope:{kind:'local_chat',local_chat_id:sessionID},created_at:date,updated_at:date,revision:2,turns:[{turn_id:turnID,client_request_id:randomUUID(),requested_model:{provider_id:'synthetic',model_id:'offline'},state:'finished',created_at:date,updated_at:date,draft_revision:0}],messages:[{message_id:messageID,turn_id:turnID,role:'assistant',text:'只保留这段摘录。\n不要带入其他完整聊天。',created_at:date,updated_at:date}]};
 let busy=false;const published:PreviewPlan[]=[];
 const service=new ChatTaskService({isSessionBusy:()=>busy,isAgentSessionBusy:()=>busy,loadSession:async()=>structuredClone(record),loadAgentSession:async()=>{const {binding:_,...agent}=structuredClone(record);return {...agent,kind:'electron_agent_chat',source:{agentID:'codex',configDigest:'fixture'}}}},tasks,p=>published.push(p));
 const ref={source:'model' as const,sessionID,messageID},source=await service.source(ref);
 const input:CreateChatTaskInput={requestID:randomUUID(),source:{...ref,digest:source.digest},title:'从已保存消息生成任务',goal:'明确要完成的结果',completionConditions:['人工可核对'],excerpt:'只保留这段摘录。'};
 return {root,tasks,record,service,input,published,setBusy:(v:boolean)=>busy=v};
}
test('one complete formal Task preserves IDs and only selected excerpt; source remains unchanged',async t=>{
 const f=await fixture(t),before=structuredClone(f.record),plan=await f.service.create(f.input);
 const disk=JSON.parse(await readFile(join(f.root,'tasks',plan.id,'task.json'),'utf8'));
 assert.equal(disk.kind,'screendeck_task');assert.equal(plan.id,f.input.requestID);assert.equal(plan.version,1);assert.equal(plan.work_items.length,0);
 assert.deepEqual(plan.task?.chat_refs,[{source:'model',sessionID:f.record.conversation_id}]);assert.equal(plan.task?.chat_origin?.messageID,f.input.source.messageID);assert.equal(plan.task?.chat_origin?.turnID,f.record.turns[0].turn_id);
 assert.equal(plan.task?.materials.length,1);assert.equal(plan.task?.materials[0].summary,f.input.excerpt);assert.equal(JSON.stringify(plan).includes('不要带入其他完整聊天'),false);assert.deepEqual(f.record,before);assert.equal(f.published.length,1);
});
test('omitting excerpt retains source IDs without copying any message body',async t=>{
 const f=await fixture(t),{excerpt:_,...input}=f.input,plan=await f.service.create(input);assert.deepEqual(plan.task?.materials,[]);assert.ok(plan.task?.chat_origin);assert.equal(JSON.stringify(plan).includes(f.record.messages[0].text),false);
});
test('simultaneous identical retries create one ID, edited task replays without overwrite, changed request rejected',async t=>{
 const f=await fixture(t),a=await Promise.all([f.service.create(f.input),f.service.create(f.input)]);assert.equal(a[0].id,a[1].id);assert.equal((await readdir(join(f.root,'tasks'))).length,1);
 const edited=await f.tasks.savePlan({...a[0],title:'用户后续修改'},1);const replay=await f.service.create(f.input);assert.equal(replay.version,edited.version);assert.equal(replay.title,edited.title);
 await assert.rejects(f.service.create({...f.input,title:'不能用原创建ID覆盖'}),/相同创建标识/);
});
test('source must be saved, finished, present, unchanged and correct kind',async t=>{
 const f=await fixture(t);f.setBusy(true);await assert.rejects(f.service.create(f.input),/未保存/);f.setBusy(false);
 f.record.turns[0].state='streaming';await assert.rejects(f.service.create(f.input),/已完成/);f.record.turns[0].state='finished';
 f.record.messages[0].text='消息已变';await assert.rejects(f.service.create(f.input),/已变化/);await assert.rejects(f.service.source({...f.input.source,messageID:randomUUID()}));assert.equal((await f.tasks.listPlans()).length,0);
});
test('injected text or unrelated excerpt cannot become a quoted source',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.create({...f.input,excerpt:'并非原文'}),/连续原文/);await assert.rejects(f.service.create({...f.input,goal:''}),/想完成什么/);await assert.rejects(f.service.create({...f.input,send:true}));assert.equal((await f.tasks.listPlans()).length,0);
});
test('Agent saved message keeps agent source, without any Agent API to start or send',async t=>{
 const f=await fixture(t),ref={source:'agent' as const,sessionID:f.record.conversation_id,messageID:f.record.messages[0].message_id};const saved=await f.service.source(ref);const plan=await f.service.create({...f.input,source:{...ref,digest:saved.digest}});assert.equal(plan.task?.chat_refs[0].source,'agent');assert.equal(plan.task?.chat_origin?.source,'agent');
});
test('ordinary task edits cannot forge, remove or replace creation provenance',async t=>{
 const f=await fixture(t),plan=await f.service.create(f.input);const {chat_origin:_,...content}=plan.task!;await assert.rejects(f.tasks.savePlan({...plan,task:content},1),/来源不可/);await assert.rejects(f.tasks.savePlan({...plan,task:{...plan.task!,chat_origin:{...plan.task!.chat_origin!,messageID:randomUUID()}}},1),/来源不可/);
 const independent=await f.tasks.createPlan('普通任务',[],undefined,{schemaVersion:3});await assert.rejects(f.tasks.savePlan({...independent,task:{...independent.task!,chat_origin:plan.task!.chat_origin}},1),/来源不可|回执/);
});
test('new route distinguishes pre-write validation from uncertain failure without widening IPC',async t=>{
 const f=await fixture(t);const {installChatTaskRoutes}=await import('../../src/main/chat-task-routes');
 const handlers=new Map<string,(input:unknown)=>unknown>();installChatTaskRoutes({handle:(channel:string,fn:(input:unknown)=>unknown)=>{handlers.set(channel,fn)}} as never,f.service);
 f.record.messages[0].text='来源已改变';const rejected=await handlers.get('create-task-from-chat')!(f.input) as {ok:false;error:{code:string;safeToEdit:boolean}};
 assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'chat-task-changed');assert.equal(rejected.error.safeToEdit,true);assert.equal((await f.tasks.listPlans()).length,0);
});

test('goal alone saves a draft with derived title and no conditions, work or implicit materials',async t=>{
 const f=await fixture(t),requestID=randomUUID(),goal='把方案整理成可演示的版本\n保留第二行完整目标';
 const plan=await f.service.draft({requestID,goal});assert.equal(plan.id,requestID);assert.equal(plan.title,'把方案整理成可演示的版本');assert.equal(plan.task?.goal,goal);assert.deepEqual(plan.task?.completion_conditions,[]);assert.deepEqual(plan.work_items,[]);assert.deepEqual(plan.task?.materials,[]);assert.deepEqual(plan.task?.chat_refs,[]);
 assert.equal((await f.service.draft({requestID,goal})).id,plan.id);assert.equal((await f.tasks.listPlans()).length,1);
 await assert.rejects(f.tasks.savePlan({...plan,task:{...plan.task!,creation_receipt:undefined}},1),/回执不可/);
});
test('chat goal alone remains explicit and uses first line title while preserving the original source',async t=>{
 const f=await fixture(t),goal='只写一个主任务就能保存';const plan=await f.service.create({requestID:f.input.requestID,source:f.input.source,goal});assert.equal(plan.title,goal);assert.deepEqual(plan.task?.completion_conditions,[]);assert.deepEqual(plan.task?.materials,[]);assert.ok(plan.task?.chat_origin);assert.equal(plan.task?.chat_refs[0].sessionID,f.record.conversation_id);
});
