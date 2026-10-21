import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,realpath,rm,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dayAt,dayBounds,projectTimeline,type TimelineSources } from '../../src/core/timeline/projector.js';
import type { SessionRecord } from '../../src/shared/types.js';
import type { ProjectWorkspaceResult,RunDTO,TaskDTO } from '../../src/projects/types.js';
import { RecordingStore } from '../../src/main/recording/recording-store.js';
import { TimelineService } from '../../src/main/timeline/timeline-service.js';
import { installTimelineRoutes } from '../../src/main/timeline/timeline-routes.js';
import { timelineRefKey } from '../../src/shared/timeline.js';
const date='2026-10-21T02:00:00.000Z';
function session(times=[date],title='方案讨论'):SessionRecord {
  const id=randomUUID();return {schema_version:1,conversation_id:id,title,scope:{kind:'local_chat',local_chat_id:id},created_at:times[0],updated_at:times.at(-1)!,revision:1,
    turns:times.map(time=>({turn_id:randomUUID(),client_request_id:randomUUID(),requested_model:{provider_id:'fixture',model_id:'fixture'},state:'finished',created_at:time,updated_at:'2026-10-22T02:00:00.000Z',draft_revision:0})),messages:[]};
}
function withMessages(s:SessionRecord) { s.messages=s.turns.flatMap(turn=>['user','assistant'].map((role,i)=>({message_id:randomUUID(),turn_id:turn.turn_id,role:role as 'user'|'assistant',text:i?'已保存方案':'检索关键词 keyword',created_at:turn.created_at,updated_at:new Date(Date.parse(turn.created_at)+60000).toISOString()})));return s; }
const sources=():TimelineSources=>({sessions:[],agents:[],taskSessions:[],projects:[],acceptances:[]});
function workspace(projectID='project-'+randomUUID()):ProjectWorkspaceResult {
  const task:TaskDTO={schema_version:1,kind:'task',project_id:projectID,task_id:'task-001',title:'屏幕记录',goal:'本地检索',status:'ready',plan_version:1,assignee:'human',created_at:date,updated_at:date,run_ids:[],acceptance:[],references:[],historical:true,is_live:false};
  return {status:'ready',project:{schema_version:2,kind:'project',project_id:projectID,name:'演示项目',created_at:date,root_path:'/fixture',history_bound:true,readonly:true},tasks:[task],runs:[],artifact_refs:[],diagnostics:[],loaded_at:date,historical:true};
}
async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'screendeck-unified-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const frames=new RecordingStore(root);await frames.initialize();const input=sources();input.sessions=[withMessages(session([date,'2026-10-21T02:05:00.000Z']))];
  const service=new TimelineService(root,async()=>({sources:input,diagnostics:[]}),frames);return {root,frames,input,service};
}
const q={day:'2026-10-21',timeZone:'Asia/Shanghai',kind:'all' as const};
async function screen(frames:RecordingStore,time=date,text='画面 OCR keyword',displayID=1) {return frames.add({appName:'Editor',bundleID:'fixture.editor',text,displayID,width:640,height:360},Buffer.from([255,216,255,217]),new Date(time));}

test('session grouping uses local days and actual messages, not the full lifetime or mutable Turn update',()=>{
  const s=sources();s.sessions=[withMessages(session([date,'2026-10-21T02:05:00.000Z','2026-10-21T03:00:00.000Z','2026-10-21T16:01:00.000Z']))];
  const events=projectTimeline(s,'Asia/Shanghai');assert.equal(events.length,3);const early=events.find(e=>e.startedAt===date)!;
  assert.equal(early.itemCount,2);assert.equal(early.endedAt,'2026-10-21T02:06:00.000Z');assert.equal(dayAt(events[0].startedAt!,'Asia/Shanghai'),'2026-10-22');
  assert.equal(s.sessions[0].turns.length,4);assert.equal(early.status,'finished');
});

test('actual run time sorts ahead of later backfill and unknown time remains unknown; project IDs namespace task IDs',()=>{
  const input=sources();const a=workspace(),b=workspace();input.projects=[a,b];
  a.runs=[{schema_version:1,kind:'run',project_id:a.project!.project_id,task_id:'task-001',run_id:'run-20261021-001',plan_version:1,status:'completed',started_at:'2026-10-21T12:00:00+08:00',ended_at:'2026-10-21T13:00:00+08:00',recorded_at:'2026-10-22T00:00:00Z',executor:{agent:'fixture',model:null,effort:null,metadata_source:'fixture'},skills:[],summary:'原运行摘要',references:[],git:{commit_status:'none',commit_ids:[],push_status:'not_pushed'},historical:true,is_live:false}];
  a.runs.push({...a.runs[0],run_id:'run-20261021-002',started_at:null,ended_at:null});
  const events=projectTimeline(input,'Asia/Shanghai');assert.equal(events[0].ref.id,'run-20261021-001');assert.equal(events.at(-1)!.startedAt,null);assert.equal(events.at(-1)!.recordedAt,'2026-10-22T00:00:00Z');
  assert.equal(new Set(events.filter(e=>e.ref.source==='task').map(e=>timelineRefKey(e.ref))).size,2);
});

test('calendar bounds cover DST 23/25-hour days with half-open boundaries',()=>{
  const spring=dayBounds('2026-03-08','America/New_York'),fall=dayBounds('2026-11-01','America/New_York');
  assert.equal(spring[1]-spring[0],23*3600000);assert.equal(fall[1]-fall[0],25*3600000);assert.equal(dayAt(spring[1]-1,'America/New_York'),'2026-03-08');assert.equal(dayAt(spring[1],'America/New_York'),'2026-03-09');
});

test('message search keeps exact message identity, bounded snippets and Session source',()=>{
  const input=sources();const s=withMessages(session());s.messages[1].text='x'.repeat(2000)+'unique needle'+'y'.repeat(2000);input.sessions=[s];
  const result=projectTimeline(input,'UTC','needle');assert.equal(result.length,1);assert.equal(result[0].messageID,s.messages[1].message_id);assert.ok(result[0].snippet.includes('needle'));assert.ok(result[0].snippet.length<300);assert.equal(result[0].ref.source,'model');
});

test('immutable snapshot pagination does not duplicate or omit after a new event; filters cannot reuse another cursor',async t=>{
  const {input,service}=await fixture(t);input.sessions=Array.from({length:61},(_,i)=>withMessages(session([new Date(Date.parse(date)+i*1000).toISOString()])));
  const first=await service.query(q);assert.equal(first.events.length,50);assert.equal(first.events[0].items.length,0);
  input.sessions.push(withMessages(session(['2026-10-21T05:00:00.000Z'])));
  const rest=await service.query({...q,snapshotID:first.snapshotID,cursor:first.nextCursor});assert.equal(rest.events.length,11);assert.equal(new Set([...first.events,...rest.events].map(e=>e.id)).size,61);
  assert.equal((await service.query(q)).total,62);await assert.rejects(service.query({...q,query:'changed',snapshotID:first.snapshotID,cursor:first.nextCursor}));
});

test('scene application/display filters do not hide work; all-date OCR hits retain timestamp and source',async t=>{
  const {service,frames}=await fixture(t);await screen(frames,date,'secretly find needle',1);await screen(frames,'2026-10-20T02:00:00.000Z','older needle',2);
  const work=await service.query(q);assert.equal(work.total,1);
  const scene=await service.scene({...q,kind:undefined,displayID:2}).catch(()=>null);assert.equal(scene,null); // strict API rejects work-only fields
  const old=await service.scene({day:q.day,timeZone:q.timeZone,query:'needle',allDates:true,displayID:2});assert.equal(old.total,1);assert.equal(old.frames[0].displayID,2);assert.equal(old.frames[0].timestamp,'2026-10-20T02:00:00.000Z');assert.ok(!('text' in old.frames[0]));
  assert.equal((await service.query(q)).total,1);
});

test('overlap is only contemporaneous; nearby points are not invented as a work relationship',async t=>{
  const {service,frames}=await fixture(t);const within=await screen(frames,'2026-10-21T02:03:00.000Z');await screen(frames,'2026-10-21T03:03:00.000Z');
  const page=await service.query(q);const context=await service.context(page.snapshotID,page.events[0].id);
  assert.equal(context.linked.length,0);assert.equal(context.contemporaneous.length,1);assert.equal(context.contemporaneous[0].id,within.id);assert.equal(context.links.length,0);
});

test('manual associations persist, allow many-to-many, use revision conflicts and unlink without deleting source pixels',async t=>{
  const {service,frames,root,input}=await fixture(t);const f=await screen(frames);const page=await service.query(q);const target=page.events[0].ref;
  const saved=await service.associate(target,[f.id],0);assert.equal(saved.revision,1);
  await assert.rejects(service.associate(target,[f.id],0),/修改/);
  const next=withMessages(session());input.sessions.push(next);await service.associate({source:'model',id:next.conversation_id},[f.id],1);
  const reloaded=new TimelineService(root,async()=>({sources:input,diagnostics:[]}),frames);const links=await reloaded.links.load();assert.equal(links.links.length,2);
  await service.links.remove(saved.links[0].id,2);assert.ok(await frames.image(f.id));assert.equal((await service.links.load()).links.filter(l=>!l.removedAt).length,1);
  assert.equal(input.sessions.length,2);
});

test('association validation rejects fabricated sources and missing pictures without writing empty defaults',async t=>{
  const {service,frames}=await fixture(t);const f=await screen(frames);await assert.rejects(service.associate({source:'model',id:randomUUID()},[f.id],0),/不可读/);
  const p=await service.query(q);await assert.rejects(service.associate(p.events[0].ref,[`${Date.now()}-${randomUUID()}`],0),/过期/);assert.equal((await service.links.load()).revision,0);
});

test('deleting a picture scrubs cached OCR summaries, leaves unavailable associations and never removes the work',async t=>{
  const {service,frames}=await fixture(t);const f=await screen(frames,date,'private OCR needle');const work=await service.query(q);await service.associate(work.events[0].ref,[f.id],0);
  const scene=await service.scene({day:q.day,timeZone:q.timeZone,query:'needle'});assert.equal(scene.total,1);await frames.delete(f.id);
  const cached=await service.scene({day:q.day,timeZone:q.timeZone,query:'needle',snapshotID:scene.snapshotID});assert.equal(cached.total,0);assert.deepEqual(cached.points,[]);
  assert.throws(()=>service.frameText(f.id));const context=await service.context(work.snapshotID,work.events[0].id);assert.equal(context.unavailableCount,1);assert.equal(context.linked.length,0);assert.equal((await service.query(q)).total,1);
});

test('corrupt association file is preserved; no-frame service still lists sessions with source diagnostics',async t=>{
  const {root,service,input}=await fixture(t);
  const page=await service.query(q);const file=path.join(root,'timeline-associations-v1','links.json');
  await service.links.remove(randomUUID(),0).catch(()=>{});await writeFile(file,'{corrupt');
  await assert.rejects(service.links.load(),/未覆盖/);assert.equal(await readFile(file,'utf8'),'{corrupt');
  const noScreen=new TimelineService(root,async()=>({sources:input,diagnostics:['部分来源损坏']}));const result=await noScreen.query(q);assert.equal(result.total,page.total);assert.ok(result.diagnostics.length>=2);
});

test('trusted timeline routes reject arbitrary roots, malformed IDs, unknown fields and broad payloads',async t=>{
  const {service}=await fixture(t);const handlers=new Map<string,(v:unknown)=>unknown>();installTimelineRoutes({handle:(name,fn)=>{handlers.set(name,fn);}},service);
  await assert.rejects(Promise.resolve().then(()=>handlers.get('timeline-query')!({...q,root:'/etc'})));
  await assert.rejects(Promise.resolve().then(()=>handlers.get('timeline-query')!({...q,day:'2026-02-30'})));
  assert.throws(()=>handlers.get('timeline-frame-text')!('../../private'));
  assert.throws(()=>handlers.get('timeline-associate')!({target:{source:'model',id:randomUUID()},frameIDs:Array(101).fill('bad'),expectedRevision:0}));
  await assert.rejects(service.query({...q,timeZone:'invalid'}));
});

test('task execution and acceptance remain distinct; only the matching result version is shown as accepted',async()=>{
  const { taskResultDigest }=await import('../../src/core/sessions/task-session-schema.js');
  const input=sources();const w=workspace();input.projects=[w];const basic=withMessages(session());
  const record={...basic,schema_version:2 as const,kind:'electron_task_session' as const,scope:{kind:'project' as const,project_id:w.project!.project_id,task_id:'task-001'},turns:basic.turns.map(t=>({...t,state:'finished' as const,execution:{spec:{work:{planID:randomUUID(),planVersion:1,workItemID:randomUUID()},title:'执行讨论',kind:'discussion' as const,expectedResult:'文本方案',dependencies:[],inputMessageID:basic.messages[0].message_id,materials:[],workspace:{workspaceID:randomUUID(),bindingDigest:'a'.repeat(64)},driver:{driverID:'fixture',configDigest:'b'.repeat(64),mode:'external' as const},tools:{kind:'none' as const}},specDigest:'c'.repeat(64),eventReceipts:[],permissions:[],result:{summary:'文本结果',artifacts:[],evidence:[]}}}))};
  input.taskSessions=[record];const turn=record.turns[0];
  assert.equal(projectTimeline(input,'UTC').find(e=>e.ref.source==='task-session')!.status,'awaiting_review');
  input.acceptances=[{schema_version:1,kind:'electron_execution_acceptance',id:randomUUID(),turn:{session:{format:'task-v2',sessionID:record.conversation_id},turnID:turn.turn_id},resultDigest:taskResultDigest(turn,record),decision:'accepted',decided_by:'fixture-user',decided_at:'2026-10-22T08:00:00.000Z',comment:'人工确认'}];
  const events=projectTimeline(input,'UTC');assert.equal(events.find(e=>e.sourceLabel==='人工成果验收')!.startedAt,'2026-10-22T08:00:00.000Z');assert.equal(events.find(e=>e.sourceLabel==='任务执行会话')!.status,'accepted');
  record.messages.find(m=>m.role==='assistant')!.text='changed version';assert.equal(projectTimeline(input,'UTC').find(e=>e.sourceLabel==='任务执行会话')!.status,'awaiting_review');assert.equal(projectTimeline(input,'UTC').filter(e=>e.sourceLabel==='人工成果验收').length,0);
  assert.equal(w.tasks[0].status,'ready');
});

test('frame-to-work context searches the whole day even beyond page one or a text filter',async t=>{
  const {service,input,frames}=await fixture(t);const original=input.sessions[0];original.title='较早的实际工作';
  input.sessions.push(...Array.from({length:55},(_,i)=>withMessages(session([new Date(Date.parse(date)+3600000+i*60000).toISOString()],'较晚工作'))));
  const first=await service.query(q);assert.ok(!first.events.some(e=>e.ref.id===original.conversation_id));assert.ok(first.markers.some(e=>e.title==='较早的实际工作'));
  const picture=await screen(frames,'2026-10-21T02:03:00.000Z');await service.query({...q,query:'不存在的关键词'});
  const at=await service.at(picture.id,q.timeZone);assert.equal(at.total,1);assert.equal(at.events[0].ref.id,original.conversation_id);
  assert.equal(service.detail(at.snapshotID,at.events[0].id).title,'较早的实际工作');
});

test('unavailable work references keep the association and expiry offers a clean reread',async t=>{
  const {service,input,frames}=await fixture(t);const picture=await screen(frames);const p=await service.query(q);
  await service.associate(p.events[0].ref,[picture.id],0);input.sessions=[];
  const related=await service.frameRelations(picture.id);assert.equal(related.links.length,1);assert.equal(related.links[0].event,null);
  const clock=Date.now;t.mock.method(Date,'now',()=>clock()+11*60000);assert.throws(()=>service.detail(p.snapshotID,p.events[0].id),/过期/);assert.equal((await service.query(q)).total,0);
});

test('archived chats remain readable and clearly labelled without modifying their source',()=>{
  const input=sources();const s=withMessages(session());input.sessions=[s];input.archived=[`model:${s.conversation_id}`];
  const event=projectTimeline(input,'UTC')[0];assert.match(event.sourceLabel,/已归档/);assert.equal(event.status,'finished');assert.equal(s.title,'方案讨论');
});


test('shared navigation locates beyond the first page, respects work and scene filters, and leaves recording gaps empty',async t=>{
  const {service,input,frames}=await fixture(t);const original=input.sessions[0];
  input.sessions.push(...Array.from({length:55},(_,i)=>withMessages(session([new Date(Date.parse(date)+3600000+i*60000).toISOString()],'较晚工作'))));
  const picture=await screen(frames,'2026-10-21T02:03:00.000Z');
  const p=await service.query(q),scene=await service.scene({day:q.day,timeZone:q.timeZone}),time=Date.parse(picture.timestamp);
  const match=service.locate(p.snapshotID,scene.snapshotID,time);assert.equal(service.detail(p.snapshotID,match.eventID!).ref.id,original.conversation_id);assert.equal(match.frameID,picture.id);
  assert.deepEqual(service.locate(p.snapshotID,scene.snapshotID,Date.parse('2026-10-21T09:00:00Z')),{});
  const tasks=await service.query({...q,kind:'task'});assert.equal(service.locate(tasks.snapshotID,scene.snapshotID,time).eventID,undefined);
  const noDisplay=await service.scene({day:q.day,timeZone:q.timeZone,displayID:2});assert.equal(service.locate(p.snapshotID,noDisplay.snapshotID,time).frameID,undefined);
  for(const value of [NaN,Infinity,time+0.5,Date.parse('2026-10-20T02:00:00Z')])assert.throws(()=>service.locate(p.snapshotID,scene.snapshotID,value));
  const tomorrow=await service.scene({day:'2026-10-22',timeZone:q.timeZone});assert.throws(()=>service.locate(p.snapshotID,tomorrow.snapshotID,time),/过期/);
  const clock=Date.now;t.mock.method(Date,'now',()=>clock()+11*60000);assert.throws(()=>service.locate(p.snapshotID,scene.snapshotID,time),/过期/);
});
