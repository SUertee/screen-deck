import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,readdir,symlink,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateApplicationData } from '../../src/main/data-migration';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator';
import { TaskRecordStore,encodeTask,decodeTask } from '../../src/core/storage/task-record-store';
import { DirectoryProjects } from '../../src/projects/directory-projects';
import { ProjectWorkspaceReader } from '../../src/projects/reader';
import { TaskHandoffService,mergeTaskLog } from '../../src/main/task-handoff-service';
import type { PreviewPlan } from '../../src/shared/types';
import type { NativeWorkItemAttempt } from '../../src/core/tasks/native-work-item-contract';
const plan=():PreviewPlan=>({schema_version:3,kind:'electron_preview_plan',id:randomUUID(),title:'迁移测试',version:7,created_at:'2026-10-21T00:00:00Z',updated_at:'2026-10-21T00:00:00Z',task:{goal:'保持全部身份与版本',completion_conditions:['不覆盖'],materials:[],chat_refs:[{source:'agent',sessionID:randomUUID()}]},work_items:[]});
async function fixture(t:test.TestContext){const base=await mkdtemp(join(await realpath(tmpdir()),'sd-domain-'));t.after(()=>rm(base,{recursive:true,force:true}));const old=join(base,'old'),root=join(base,'new');await mkdir(join(old,'preview-plans'),{recursive:true});return {base,old,root};}
test('migration preserves DTO identity, sessions and frozen bytes; old source remains',async t=>{
 const {old,root}=await fixture(t),p=plan(),sessionID=p.task!.chat_refs[0].sessionID;
 const original=JSON.stringify(p);await writeFile(join(old,'preview-plans',p.id+'.json'),original);
 await mkdir(join(old,'agent-sessions-v1'),{recursive:true});const session=JSON.stringify({conversation_id:sessionID,scope:{kind:'local_task',local_task_id:p.id}});await writeFile(join(old,'agent-sessions-v1',sessionID+'.json'),session);
 await migrateApplicationData(old,root);assert.deepEqual(await new TaskRecordStore(root).load(p.id),p);
 assert.equal(await readFile(join(root,'agent-sessions-v1',sessionID+'.json'),'utf8'),session);
 assert.equal(await readFile(join(old,'preview-plans',p.id+'.json'),'utf8'),original);
 const disk=JSON.parse(await readFile(join(root,'tasks',p.id,'task.json'),'utf8'));assert.equal(disk.kind,'screendeck_task');assert.equal(disk.plan_format_version,3);
 const store=new TaskOrchestrator(root,{formalTasks:true});const loaded=(await store.loadPlan(p.id))!;await store.savePlan({...loaded,title:'正式目录继续保存'},7);
 await migrateApplicationData(old,root);assert.equal((await new TaskRecordStore(root).load(p.id))!.version,8);assert.equal((await new TaskRecordStore(root).load(p.id))!.title,'正式目录继续保存');
});
test('conflicting destinations abort before copying other records',async t=>{
 const {old,root}=await fixture(t),p=plan();await writeFile(join(old,'preview-plans',p.id+'.json'),JSON.stringify(p));await mkdir(join(root,'tasks',p.id),{recursive:true});await writeFile(join(root,'tasks',p.id,'task.json'),encodeTask({...p,title:'不覆盖我'}));await writeFile(join(old,'provider.toml'),'sentinel');
 await assert.rejects(migrateApplicationData(old,root),/已有不同记录/);await assert.rejects(readFile(join(root,'provider.toml')),/ENOENT/);
 assert.equal(decodeTask(await readFile(join(root,'tasks',p.id,'task.json'))).title,'不覆盖我');
});
test('interrupted identical migration resumes without duplicate tasks',async t=>{
 const {old,root}=await fixture(t),p=plan();await writeFile(join(old,'preview-plans',p.id+'.json'),JSON.stringify(p));await mkdir(join(root,'tasks',p.id),{recursive:true});await writeFile(join(root,'tasks',p.id,'task.json'),encodeTask(p));await migrateApplicationData(old,root);assert.equal((await new TaskRecordStore(root).list()).length,1);
});
test('symlinks and incomplete writer locks block migration without following them',async t=>{
 const {base,old,root}=await fixture(t);await mkdir(join(old,'sessions'));await writeFile(join(base,'outside'),'not copied');await symlink(join(base,'outside'),join(old,'sessions','escape.json'));await assert.rejects(migrateApplicationData(old,root),/不安全/);await rm(join(old,'sessions','escape.json'));await writeFile(join(old,'sessions','writer.lock'),'active');await assert.rejects(migrateApplicationData(old,root),/写入锁/);
});
test('formal store rejects stale writes and restarts without schema drift',async t=>{
 const {root}=await fixture(t),a=new TaskOrchestrator(root,{formalTasks:true}),b=new TaskOrchestrator(root,{formalTasks:true});const p=await a.createPlan('正式任务',[],undefined,{schemaVersion:3});const old=(await b.loadPlan(p.id))!;await a.savePlan({...p,title:'新标题'},1);await assert.rejects(b.savePlan({...old,title:'迟到覆盖'},1));assert.equal((await new TaskRecordStore(root).load(p.id))?.title,'新标题');
});
test('ordinary folders register stable projects without modifying the folder',async t=>{
 const {base,root}=await fixture(t),folder=join(base,'documents');await mkdir(folder);await writeFile(join(folder,'notes.md'),'keep');const reader=new ProjectWorkspaceReader({privateRoot:root,directoryProjects:new DirectoryProjects(root)});const first=await reader.read(folder);assert.equal(first.status,'empty');assert.ok(first.project);assert.deepEqual(await readdir(folder),['notes.md']);const again=await new ProjectWorkspaceReader({privateRoot:root,directoryProjects:new DirectoryProjects(root)}).read(folder);assert.equal(again.project?.project_id,first.project?.project_id);assert.equal((await reader.refresh(first.project!.project_id)).project?.root_path,folder);
});
test('optional membership does not convert a task to legacy read-only scope',async t=>{
 const {root}=await fixture(t),store=new TaskOrchestrator(root,{formalTasks:true}),p=await store.createPlan('独立任务',[],undefined,{schemaVersion:3});const project_id='project-'+randomUUID();const saved=await store.savePlan({...p,task:{...p.task!,project_id}},1);assert.equal(saved.scope,undefined);assert.equal(saved.task?.project_id,project_id);const {project_id:_,...content}=saved.task!;const moved=await store.savePlan({...saved,task:content},2);assert.equal(moved.id,p.id);assert.equal(moved.task?.project_id,undefined);
});
test('handoffs are idempotent and versioned, with no task or acceptance mutation',async t=>{
 const {root}=await fixture(t),store=new TaskOrchestrator(root,{formalTasks:true}),p=await store.createPlan('交接任务',[],undefined,{schemaVersion:3});const service=new TaskHandoffService(root,id=>store.loadPlan(id));const h=await service.append(p,{source:'manual',summary:'排查完成，尚未测试',next:'运行测试'});assert.deepEqual(await service.append(p,{source:'manual',summary:'排查完成，尚未测试',next:'运行测试'}),h);assert.equal((await service.list(p.id)).length,1);assert.match(await service.context(p),/排查完成，尚未测试/);assert.equal((await store.loadPlan(p.id))!.version,1);
});
test('finished and unknown native attempts produce truthful handoffs, acceptance separate',async t=>{
 const {root}=await fixture(t),p=plan(),service=new TaskHandoffService(root,async()=>p);const attempt={id:randomUUID(),input:{task:{kind:'local',planID:p.id},workItemID:randomUUID(),planVersion:p.version},source:{name:'Codex'},status:'finished',sessionID:randomUUID()} as NativeWorkItemAttempt;
 await service.record(attempt);assert.match((await service.list(p.id))[0].summary,/尚待验收/);attempt.status='unknown';await service.record(attempt);assert.ok((await service.list(p.id)).some(h=>h.next.includes('不自动重发')));attempt.status='finished';attempt.acceptance={decision:'accepted',evidenceDigest:'a'.repeat(64),actor:'user',comment:'checked'};await service.record(attempt);assert.ok((await service.list(p.id)).some(h=>h.state==='已接受'));
});
test('AGENTLOG managed export preserves human text, other tasks and detects malformed sections',()=>{
 const id=randomUUID(),other=randomUUID(),human='# 项目日志\n\n人工记录：保留这段。\n';const first=mergeTaskLog(human,id,'任务一');const both=mergeTaskLog(first,other,'任务二');const updated=mergeTaskLog(both,id,'任务一新摘要');assert.ok(updated.startsWith(human));assert.match(updated,/任务二/);assert.match(updated,/任务一新摘要/);assert.equal(updated.split(`screendeck:task:${id}:begin`).length,2);assert.throws(()=>mergeTaskLog(`<!-- screendeck:task:${id}:begin -->`,id,'x'),/未覆盖人工内容/);
});
test('invalid migration receipt cannot hide legacy data behind a fake completion',async t=>{
 const {old,root}=await fixture(t);await mkdir(join(root,'migrations'),{recursive:true});await writeFile(join(root,'migrations','electron-v1.json'),JSON.stringify({schema_version:1,kind:'screendeck_migration',state:'complete',source:old,completedAt:new Date().toISOString(),files:[{path:'../escape',sha256:'a'.repeat(64)}]}));await assert.rejects(migrateApplicationData(old,root),/迁移标记无效/);
});
test('corrupt project index is rejected without rewriting it',async t=>{
 const {base,root}=await fixture(t);await mkdir(join(root,'projects'),{recursive:true});const file=join(root,'projects','directory-index.json'),bad=JSON.stringify({schema_version:1,kind:'screendeck_directory_projects',projects:[{schema_version:9,kind:'wrong',project_id:'project-'+randomUUID(),root_path:base,name:'bad',created_at:new Date().toISOString()}]});await writeFile(file,bad);await assert.rejects(new DirectoryProjects(root).register(base),/索引无效/);assert.equal(await readFile(file,'utf8'),bad);
});
test('handoff content tampering is detected and log export treats embedded markers as text',async t=>{
 const {root}=await fixture(t),p=plan(),service=new TaskHandoffService(root,async()=>p),summary='备注 <!-- screendeck:task:'+p.id+':end -->';const h=await service.append(p,{source:'manual',summary,next:'继续'});assert.match(await service.markdown(p),/&lt;!-- screendeck/);const file=join(root,'tasks',p.id,'handoffs',h.id+'.json');await writeFile(file,JSON.stringify({...h,summary:'篡改'}));await assert.rejects(service.list(p.id),/指纹不匹配/);
});
