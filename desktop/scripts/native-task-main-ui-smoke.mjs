import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after building desktop. Real main/preload/renderers and plan persistence;
// generated records and a separate HOME/userData only. No installed app, Agent,
// credentials, network service, or production project is used by this script.
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-native-main-'));
const previewRoot = path.join(temporaryRoot, 'preview');
const projectRoot = path.join(temporaryRoot, 'project');
const historyRoot = path.join(temporaryRoot, 'project-history');
const homeRoot = path.join(temporaryRoot, 'home');
const artifactRoot = path.join(temporaryRoot, 'artifacts');
const testDist = path.join(temporaryRoot, 'dist');
for (const directory of [previewRoot, projectRoot, historyRoot, homeRoot, artifactRoot, path.join(temporaryRoot, 'tmp'), path.join(temporaryRoot, 'bin')]) await mkdir(directory, { recursive: true });
await mkdir(testDist, { recursive: true });
for (const name of ['renderer', 'preload.cjs', 'brand']) await cp(path.join(desktopRoot, 'dist', name), path.join(testDist, name), { recursive: true });
// Exercise the original floating-window contract on every machine, including
// notched Macs. The alias only replaces the host's native provider dependency;
// production has no test environment switch and all routes/stores stay real.
const indexFile = path.join(desktopRoot, 'src/main/index.ts');
const hostShim = `
import { ElectronHost as RealHost } from ${JSON.stringify(path.join(desktopRoot, 'src/main/electron-host.ts'))};
export class ElectronHost extends RealHost {
  constructor(root) { super(root, { nativeProvider: () => undefined }); }
}
`;
const nativeShim = `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const caps={streaming:true,nativeContext:true,interrupt:true,resume:false,tools:true,approvals:true,modelSelection:false};
const runtimeID='67afc642-0824-47f8-858c-b2a25a4d54bb', connectionGeneration='69ee3518-9ec4-4e61-8643-a3d3b83dacaf';
globalThis.__nativeFixture={sends:0,permissions:0};
export class CodexAgentChatAdapter {
  descriptor; pending;
  constructor(options){this.descriptor={agentID:'codex',name:'Codex',protocol:'native',capabilities:{...caps,tools:!!options.nativeTools,approvals:!!options.nativeTools}};}
  getSource(){return {...this.descriptor,state:'ready',configDigest:'a'.repeat(64),runtimeID,connectionGeneration,model:{provider_id:'fixture',model_id:'synthetic-native-model'}};}
  async sendTurn(req,emit,signal){
    globalThis.__nativeFixture.sends++;
    await emit({type:'bound',binding:{runtimeID,connectionGeneration,externalSessionID:req.sessionID}});
    await emit({type:'submitted'});
    const choice=new Promise(resolve=>{this.pending=resolve;});
    await emit({type:'tool',tool:{id:'fixture-write',kind:'write',title:'Write result.txt',status:'pending',detail:'Synthetic workspace only'}});
    await emit({type:'permission',approval:{id:'c995ac25-c2b6-433a-852b-b84796fe476d',toolID:'fixture-write',title:'写入合成 result.txt',detail:'仅写入隔离测试目录的 result.txt',canAllow:true}});
    const allowed=await choice;
    if(!allowed||signal.aborted){await emit({type:'settled',outcome:'cancelled'});return;}
    await writeFile(join(req.execution.workspace.path,'result.txt'),'expected synthetic result');
    await emit({type:'tool',tool:{id:'fixture-write',kind:'write',title:'Write result.txt',status:'completed'}});
    await emit({type:'text-delta',text:'Synthetic protocol result; host verifies actual bytes.'});
    await emit({type:'settled',outcome:'finished'});
  }
  async replyPermission(_lookup,_id,decision){globalThis.__nativeFixture.permissions++;this.pending?.(decision==='allow');return {status:'queued'};}
  async cancelTurn(){this.pending?.(false);return {status:'confirmed'};}
}
`;

const jevShim = `
export { JevServiceError, validJevKey } from ${JSON.stringify(path.join(desktopRoot,'src/core/tasks/providers/jev-http-transport.ts'))};
globalThis.__jevFixture={sends:0};
export class JevHttpTransport {
  provenance='test-fixture';
  async systemOne(request){globalThis.__jevFixture.sends++;const ids=Object.keys(request.questions.assignee.criteria);return {model:'jev-1.13.0',answers:{assignee:{type:'choice',choice:'agent_codex',confidence:1,probabilities:Object.fromEntries(ids.map(id=>[id,id==='agent_codex'?1:0]))}},usage:{input_tokens:10,output_tokens:1}};}
}
`;
const planningShim = `
globalThis.__planningFixture={generations:0};
export class ConfiguredTaskPlanningModel {
  async capture(){const source={kind:'chat-completions',requestedModel:{provider_id:'fixture-planner',model_id:'synthetic-planner'},configDigest:'b'.repeat(64)};
    return {source,generate:async()=>{globalThis.__planningFixture.generations++;return {text:JSON.stringify({steps:[{key:'inspect',title:'核对合成材料',kind:'implementation',completion_conditions:['给出核对结果'],dependencies:[],candidateIDs:['native-codex','human'],preferredCandidateID:'native-codex'},{key:'check',title:'复核合成结果',kind:'validation',completion_conditions:['复核结果符合要求'],dependencies:['inspect'],candidateIDs:['native-codex','human'],preferredCandidateID:'native-codex'}]}),observedModel:source.requestedModel};}};}
}
`;
await build({ entryPoints: [indexFile], outfile: path.join(testDist, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], plugins: [{ name: 'floating-deck-host-dependency-only', setup(builder) {
  builder.onResolve({filter:/jev-http-transport\.js$/},()=>({path:'jev-fixture',namespace:'jev-fixture'}));
  builder.onLoad({filter:/.*/,namespace:'jev-fixture'},()=>({contents:jevShim,loader:'js',resolveDir:desktopRoot}));
  builder.onResolve({filter:/task-planning-model\.js$/},()=>({path:'planning-fixture',namespace:'planning-fixture'}));
  builder.onLoad({filter:/.*/,namespace:'planning-fixture'},()=>({contents:planningShim,loader:'js',resolveDir:desktopRoot}));
  builder.onResolve({filter:/codex-agent-chat-adapter\.js$/},args=>args.importer===indexFile?{path:'native-fixture',namespace:'native-fixture'}:undefined);
  builder.onLoad({filter:/.*/,namespace:'native-fixture'},()=>({contents:nativeShim,loader:'js',resolveDir:desktopRoot}));
  builder.onResolve({ filter: /^\.\/electron-host\.js$/ }, args => args.importer === indexFile ? { path: 'floating-test-host', namespace: 'floating-deck-test' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'floating-deck-test' }, () => ({ contents: hostShim, loader: 'ts', resolveDir: desktopRoot }));
} }] });
const timestamp = '2026-10-21T00:00:00.000Z';
const projectID = `project-${randomUUID()}`;
const taskID = 'task-001';
for (const directory of ['tasks', 'runs', 'artifacts']) await mkdir(path.join(historyRoot, 'projects', projectID, directory), { recursive: true });
const fixturePlanID = randomUUID();
const fixtureTitle = '隔离 Deck 长列表计划';
const identity = { schema_version: 2, kind: 'project', project_id: projectID, name: '隔离 Deck 验收项目', created_at: timestamp };
const task = { schema_version: 1, kind: 'task', project_id: projectID, task_id: taskID, title: '仅供只读核对的合成来源任务', goal: 'Deck 修改预览计划，不修改正式 task/run。', status: 'draft', plan_version: 1, assignee: 'human', created_at: timestamp, updated_at: timestamp, run_ids: [], acceptance: [{ id: 'source-preserved', description: '来源记录保持原样', verification: 'not_checked', requires_human: true }], references: [] };
const history = { schema_version: 1, kind: 'project_history', project_id: projectID, source_root: projectRoot, created_at: timestamp, project: { schema_version: 1, kind: 'project', project_id: projectID, name: identity.name, created_at: timestamp, timezone: 'Asia/Shanghai', mode: 'manual_pilot', references: [] }, migration: { backup_path: path.join(temporaryRoot, 'synthetic-backup'), migrated_at: timestamp } };
const item = (title, index) => ({ id: randomUUID(), title, kind: 'implementation', assignee: index === 1 ? 'agent' : index === 0 ? 'human' : 'unassigned', ...(index === 1 ? { agentID: 'opencode' } : {}), expected_result: '', dependencies: [], status: index === 0 ? 'completed' : 'planned' });
const fixturePlan = { schema_version: 2, kind: 'electron_preview_plan', id: fixturePlanID, title: fixtureTitle, version: 1, created_at: timestamp, updated_at: timestamp, work_items: Array.from({ length: 8 }, (_, index) => item(`合成子任务 ${index + 1}，验证小窗中的持续滚动与分工`, index)) };
const legacyPlan = { schema_version: 1, kind: 'electron_preview_plan', id: randomUUID(), title: '保留 v1 来源关联的合成计划', version: 1, created_at: timestamp, updated_at: timestamp, scope: { project_id: projectID, task_id: taskID }, work_items: [{ id: randomUUID(), title: '只读来源关联', kind: 'discussion', assignee: 'human', expected_result: '保持来源数据原样', dependencies: [], status: 'planned' }] };
const sourceFiles = [
  [path.join(projectRoot, '.screendeck', 'project.json'), identity],
  [path.join(historyRoot, 'projects', projectID, 'history.json'), history],
  [path.join(historyRoot, 'projects', projectID, 'tasks', `${taskID}.json`), task],
];
for (const [filename, value] of [...sourceFiles, [path.join(previewRoot, 'preview-plans', `${fixturePlan.id}.json`), fixturePlan], [path.join(previewRoot, 'preview-plans', `${legacyPlan.id}.json`), legacyPlan]]) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n');
}
const hashFile = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
const sourceHashes = await Promise.all(sourceFiles.map(async ([filename]) => [filename, await hashFile(filename)]));
const wrapper = path.join(temporaryRoot, 'electron-entry.cjs');
// Install guards before requiring the built app. The ordinary IPC listeners and
// stores remain in place. Two explicit test flags exercise failure and a real
// optimistic-version conflict through the original save-plan handler.
await writeFile(wrapper, `
const { app, session, net, ipcMain, shell } = require('electron');
const path = require('node:path');
const qa = globalThis.__deckWorkbenchSmoke = { network: [], processes: [], executionIPC: [], externalURLs: [], errors: [], planSaves: 0, injectedFailures: 0, injectedConflicts: 0, failNextPlanSave: false, conflictNextPlanSave: false };
app.setPath('userData', path.join(process.env.SCREENDECK_PREVIEW_ROOT, 'electron-host'));
app.setAppPath(${JSON.stringify(desktopRoot)});
const denyNetwork = value => { qa.network.push(String(value)); throw new Error('Offline Deck smoke blocks remote requests.'); };
const remote = value => /^(?:https?|wss?|ftp):/i.test(typeof value === 'string' ? value : value?.url ?? String(value));
for (const target of [globalThis, net]) if (typeof target.fetch === 'function') { const original = target.fetch.bind(target); target.fetch = (input, ...args) => remote(input) ? Promise.reject((() => { try { denyNetwork(typeof input === 'string' ? input : input?.url); } catch (e) { return e; } })()) : original(input, ...args); }
for (const name of ['node:http', 'node:https']) { const module = require(name); for (const method of ['request', 'get']) module[method] = () => denyNetwork(name + '.' + method); }
const childProcess = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = () => { qa.processes.push(method); throw new Error('Deck smoke never starts an external process.'); };
require('node:module').syncBuiltinESMExports();
const guardSession = value => { value.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (details, callback) => { qa.network.push(details.url); callback({ cancel: true }); }); };
app.on('session-created', guardSession);
app.whenReady().then(() => guardSession(session.defaultSession));
shell.openExternal = async url => { qa.externalURLs.push(String(url)); throw new Error('Deck smoke does not open external applications.'); };
process.on('uncaughtExceptionMonitor', error => qa.errors.push(String(error)));
app.on('render-process-gone', (_event, _contents, details) => qa.errors.push('render-process-gone: ' + details.reason));
const handle = ipcMain.handle.bind(ipcMain);
const forbidden = new Set(['send-message', 'send-agent-message', 'start-opencode', 'start-codex', 'login-codex', 'request-execution-authorization', 'start-task-execution', 'decide-execution-approval', 'reply-task-permission', 'review-work-item', 'cancel-task-execution', 'stop-generation', 'stop-agent-generation']);
ipcMain.handle = (channel, listener) => handle(channel, async (event, input) => {
  if (forbidden.has(channel.replace(/^screendeck:/, ''))) { qa.executionIPC.push(channel); throw new Error('Deck smoke forbids model calls and execution.'); }
  if (channel === 'screendeck:screen-displays') return []; // No real display enumeration in this fixture.
  if (channel === 'screendeck:opencode-installation') return { candidates: [] }; // Settings fixture never discovers or runs an external executable.
  if (channel === 'screendeck:save-plan') {
    qa.planSaves++;
    if (qa.failNextPlanSave) { qa.failNextPlanSave = false; qa.injectedFailures++; throw new Error('离线验收保存失败，草稿应保留。'); }
    if (qa.conflictNextPlanSave) { qa.conflictNextPlanSave = false; qa.injectedConflicts++; await listener(event, { ...input, plan: { ...input.plan, title: '另一窗口已保存的并发标题' } }); }
  }
  return listener(event, input);
});
require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(projectRoot)}]});
require(${JSON.stringify(path.join(testDist, 'main.cjs'))});
`);

const launchEnv = { HOME: homeRoot, TMPDIR: path.join(temporaryRoot, 'tmp'), TMP: path.join(temporaryRoot, 'tmp'), TEMP: path.join(temporaryRoot, 'tmp'), XDG_CONFIG_HOME: path.join(homeRoot, '.config'), XDG_CACHE_HOME: path.join(homeRoot, '.cache'), XDG_DATA_HOME: path.join(homeRoot, '.local', 'share'), PATH: [path.join(temporaryRoot, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: historyRoot, SCREENDECK_INITIAL_PROJECT: projectRoot };
if (process.env.SCREENDECK_FORMAL_SMOKE === '1') { launchEnv.SCREENDECK_DATA_ROOT = path.join(temporaryRoot, 'formal-data'); launchEnv.SCREENDECK_LEGACY_ROOT = previewRoot; }
for (const key of ['LANG', 'LC_ALL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[key] !== undefined) launchEnv[key] = process.env[key];

const errors=[], checks=[];let application,page;
try {
  application=await electron.launch({args:[wrapper],env:launchEnv,timeout:30000});page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await expect(page.locator('.workbench')).toBeVisible();await page.getByRole('button',{name:'任务',exact:true}).click();
  await page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`).click();
  const detail=page.locator('.task-workspace-detail');
  await detail.getByRole('button',{name:'编辑任务与步骤',exact:true}).click();
  await detail.getByRole('combobox',{name:'工作项 1 执行者',exact:true}).selectOption('agent:codex');
  await detail.getByRole('checkbox',{name:'人工完成工作项 1',exact:true}).uncheck();
  await detail.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(detail.getByRole('button',{name:'讨论任务',exact:true})).toBeEnabled();
  if(launchEnv.SCREENDECK_DATA_ROOT){await detail.getByRole('button',{name:'编辑任务与步骤',exact:true}).click();await detail.getByRole('combobox',{name:'任务所属项目',exact:true}).selectOption(projectID);await detail.getByRole('button',{name:'保存修改',exact:true}).click();await expect(detail.getByRole('button',{name:'讨论任务',exact:true})).toBeEnabled();}
  if(launchEnv.SCREENDECK_DATA_ROOT)await page.evaluate(async id=>{const p=(await window.screendeck.bootstrap()).plans.find(p=>p.id===id);await window.screendeck.saveTaskHandoff({planID:id,expectedVersion:p.version,summary:'已核对合成材料，尚未执行',next:'只修改 result.txt 并按规则验收'});},fixturePlanID);
  await page.locator('.task-native-section > summary').click();const panel=page.getByRole('region',{name:'原生工作项执行',exact:true});
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox',{name:'执行工作项',exact:true}).selectOption(fixturePlan.work_items[0].id);
  await panel.getByRole('combobox',{name:'执行 Agent',exact:true}).selectOption('codex');
  await panel.getByRole('button',{name:launchEnv.SCREENDECK_DATA_ROOT?'使用项目目录':'选择工作目录',exact:true}).click();
  await panel.getByRole('textbox',{name:'本次执行说明',exact:true}).fill('Write result.txt with the expected synthetic result.');
  await panel.getByRole('textbox',{name:'产物路径 1',exact:true}).fill('result.txt');
  await panel.getByRole('textbox',{name:'预期包含内容 1',exact:true}).fill('expected synthetic result');
  await panel.getByRole('button',{name:'冻结输入，不执行',exact:true}).click();
  await expect(panel.getByRole('button',{name:'批准并开始这一次',exact:true})).toBeEnabled();
  if(launchEnv.SCREENDECK_DATA_ROOT){const frozen=await page.evaluate(async id=>(await window.screendeck.nativeList({kind:'local',planID:id}))[0],fixturePlanID);assert.ok(frozen.prompt.includes('已核对合成材料，尚未执行'));checks.push('versioned task handoff is frozen into native dispatch context');}
  assert.equal((await application.evaluate(()=>globalThis.__nativeFixture)).sends,0);checks.push('real prepare persists without submission');
  await panel.getByRole('button',{name:'批准并开始这一次',exact:true}).click();
  await expect(panel.getByRole('button',{name:'批准这一次',exact:true})).toBeVisible();
  const boardCard=page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`);
  await expect(boardCard).toHaveAttribute('data-state','attention');
  await expect(boardCard.locator('.task-card-status')).toHaveText('待审批');
  checks.push('board reflects the original native pending permission without granting it');
  await panel.getByRole('button',{name:'批准这一次',exact:true}).click();
  await expect.poll(async()=>page.evaluate(async id=>{const a=(await window.screendeck.nativeList({kind:'local',planID:id}))[0];return (await window.screendeck.loadAgentSession(a.sessionID))?.turns[0]?.state;},fixturePlanID)).toBe('finished');
  if(!await panel.getByRole('button',{name:'读取宿主产物与检查',exact:true}).isVisible()) await panel.getByRole('button',{name:'核对原尝试',exact:true}).click();
  await expect(panel.getByRole('button',{name:'读取宿主产物与检查',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'读取宿主产物与检查',exact:true}).click();
  await expect(panel.getByRole('button',{name:'人工接受成果',exact:true})).toBeEnabled();
  await panel.getByRole('textbox',{name:'人工验收意见',exact:true}).fill('Reviewed actual synthetic file and native approval.');
  await panel.getByRole('button',{name:'人工接受成果',exact:true}).click();
  await expect.poll(async()=>page.evaluate(async id=>(await window.screendeck.nativeList({kind:'local',planID:id}))[0]?.acceptance?.decision,fixturePlanID)).toBe('accepted');
  if(launchEnv.SCREENDECK_DATA_ROOT){await expect.poll(async()=>page.evaluate(async id=>(await window.screendeck.taskHandoffs(id)).some(h=>h.state==='已接受'),fixturePlanID)).toBe(true);checks.push('original accepted attempt generates a durable handoff without changing manual progress');}
  const facts=await application.evaluate(()=>globalThis.__nativeFixture);assert.equal(facts.sends,1);assert.equal(facts.permissions,1);
  const saved=await page.evaluate(async id=>(await window.screendeck.bootstrap()).plans.find(p=>p.id===id),fixturePlanID);assert.equal(saved.work_items[0].status,'planned');
  assert.equal(await readFile(path.join(projectRoot,'result.txt'),'utf8'),'expected synthetic result');
  checks.push('real IPC, durable start approval, original tool approval, host bytes and independent acceptance');
  await page.screenshot({path:path.join(artifactRoot,'native-main-accepted.png')});
  const knowledgeResult=await page.evaluate(async id=>{
    const api=window.screendeck,sources=await api.knowledgeSources(id);
    if(sources.length!==1)throw new Error('Expected one accepted knowledge source');
    const source=sources[0];
    const saved=await api.saveKnowledge({taskID:id,attemptID:source.attemptID,confirmed:true,title:'合成复用经验',content:'校验具体文件与原尝试后再保存人工验收。',context:'合成任务验收流程'});
    const found=await api.searchKnowledge({query:'合成复用',includeArchived:false});
    if(found.length!==1||found[0].card.id!==saved.card.id)throw new Error('Knowledge search mismatch');
    const task=(await api.bootstrap()).plans.find(p=>p.id===id);
    const updated=await api.useKnowledge({id:saved.card.id,expectedRevision:saved.card.revision,taskID:id,expectedVersion:task.version});
    if(!updated.task.materials.some(m=>m.summary.includes('校验具体文件')))throw new Error('Knowledge material was not saved');
    const archived=await api.saveKnowledge({id:saved.card.id,expectedRevision:saved.card.revision,archived:true,title:saved.card.title,content:saved.card.content,context:saved.card.context});
    if((await api.searchKnowledge({query:'合成复用',includeArchived:false})).length)throw new Error('Archived knowledge remained in active search');
    return{source:saved.sourceStatus,taskVersion:updated.version,archived:archived.card.archived};
  },fixturePlanID);
  assert.equal(knowledgeResult.source,'available');assert.equal(knowledgeResult.archived,true);
  checks.push('real IPC accepted result to knowledge, search, explicit task material reuse and archive');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('tab',{name:'Agent 设置',exact:true}).click();
  await expect(page.getByRole('region',{name:'任务分工判断 / Jev',exact:true})).toBeVisible();
  await expect(page.getByLabel('Jev 模型版本',{exact:true})).toHaveValue('jev-latest');
  await page.getByRole('button',{name:'选择 Agent',exact:true}).click();
  const agentMenu=page.getByRole('menu',{name:'Agent 列表',exact:true});
  await expect(agentMenu.getByRole('menuitemradio',{name:/Jev/i})).toHaveCount(0);
  await expect(agentMenu.getByRole('menuitemradio',{name:/^Codex/})).toHaveCount(1);
  await page.screenshot({path:path.join(artifactRoot,'jev-independent-settings.png')});
  await page.keyboard.press('Escape');
  checks.push('real Settings keeps Jev configuration separate from execution Agent menu');
  await page.getByRole('dialog',{name:'设置',exact:true}).getByRole('button',{name:'完成',exact:true}).last().click();
  const planningTask=await page.evaluate(async()=>{const api=window.screendeck;await api.saveSettings({baseURL:'https://synthetic.invalid/v1',modelID:'synthetic-planner',apiKey:'synthetic-key-never-sent'});return api.createTaskDraft({requestID:crypto.randomUUID(),goal:'从主目标形成可审阅的合成执行计划'});});
  await page.locator('.task-overview [data-plan-id="'+planningTask.id+'"]').click();
  const planningPanel=page.locator('.task-workspace-detail .task-planning');
  await expect(planningPanel.getByRole('button',{name:'生成步骤草稿',exact:true})).toBeEnabled();
  await planningPanel.getByRole('button',{name:'生成步骤草稿',exact:true}).click();
  await expect(planningPanel.getByRole('region',{name:'步骤草稿'})).toBeVisible();
  await planningPanel.getByRole('textbox',{name:'步骤 1 标题',exact:true}).fill('用户确认的材料核对');
  await planningPanel.getByRole('checkbox',{name:'我已核对步骤、依赖、完成条件和分工',exact:true}).check();
  await planningPanel.getByRole('button',{name:'确认并保存执行计划',exact:true}).click();
  await expect.poll(async()=>page.evaluate(async id=>(await window.screendeck.bootstrap()).plans.find(p=>p.id===id)?.work_items.length,planningTask.id)).toBe(2);
  await expect(planningPanel.getByRole('textbox',{name:'步骤 1 标题',exact:true})).toHaveValue('用户确认的材料核对');
  await planningPanel.getByRole('button',{name:'建立逐项队列',exact:true}).click();
  await expect(planningPanel.getByRole('region',{name:'逐项队列'})).toContainText('下一项可准备');
  const planningFacts=await application.evaluate(()=>({model:globalThis.__planningFixture.generations,native:globalThis.__nativeFixture.sends}));assert.deepEqual(planningFacts,{model:1,native:1});
  checks.push('real main/preload generates one plan draft, saves edited steps and creates a queue without executing');
  await page.screenshot({path:path.join(artifactRoot,'main-goal-plan-queue.png')});
  // Real second window + IPC/stores; only model/Agent/HTTP dependencies are synthetic.
  const deckWindow=application.waitForEvent('window');
  await page.evaluate(()=>window.screendeck.openDeck());
  const deck=await deckWindow;deck.setDefaultTimeout(10_000);
  await expect(deck.locator('.deck-workbench')).toBeVisible();
  await deck.getByRole('button',{name:'新增任务',exact:true}).click();
  await deck.getByRole('textbox',{name:'主任务',exact:true}).fill('浮窗主目标拆解与分工联调');
  await deck.getByRole('button',{name:'创建任务',exact:true}).click();
  const deckPlanning=deck.locator('.deck-planning-view .task-planning');
  await expect(deckPlanning.getByRole('button',{name:'生成步骤草稿',exact:true})).toBeEnabled();
  await deck.screenshot({path:path.join(artifactRoot,'deck-goal-created.png')});
  await deckPlanning.getByRole('button',{name:'生成步骤草稿',exact:true}).click();
  await expect(deckPlanning.getByRole('region',{name:'步骤草稿'})).toBeVisible();
  await deckPlanning.getByRole('textbox',{name:'步骤 1 标题',exact:true}).fill('浮窗确认的第一步');
  await deckPlanning.getByRole('combobox',{name:'步骤 2 分工',exact:true}).selectOption('human');
  await deckPlanning.getByRole('checkbox',{name:'我已核对步骤、依赖、完成条件和分工',exact:true}).check();
  await deckPlanning.getByRole('button',{name:'确认并保存执行计划',exact:true}).click();
  await expect.poll(async()=>deck.evaluate(async()=>{const data=await window.screendeck.bootstrap();return data.plans.find(p=>p.task?.goal==='浮窗主目标拆解与分工联调')?.work_items.length;})).toBe(2);
  const shared=await deck.evaluate(async()=>{const data=await window.screendeck.bootstrap();return data.plans.find(p=>p.task?.goal==='浮窗主目标拆解与分工联调');});
  assert.equal(shared.schema_version,3);assert.equal(shared.work_items[0].agentID,'codex');assert.equal(shared.work_items[1].assignee,'human');assert.deepEqual(shared.work_items[1].dependencies,[shared.work_items[0].id]);
  assert.equal((await page.evaluate(async id=>(await window.screendeck.bootstrap()).plans.find(p=>p.id===id),shared.id)).version,shared.version);
  await deck.evaluate(()=>window.screendeck.saveJevSettings({model:'jev-latest',apiKey:'synthetic-jev-only'}));
  // Reopen the same view to refresh public settings without generating again.
  await deck.getByRole('button',{name:'返回浮窗任务',exact:true}).click();
  await deck.locator('[data-plan-id="'+shared.id+'"]').getByRole('button',{name:'规划与分工',exact:true}).click();
  // Opening Jev reads public settings; it does not send a request.
  const jev=deck.locator('.deck-planning-view .task-jev');
  await jev.locator('summary').click();
  await expect(jev.getByRole('combobox',{name:'Jev 工作项',exact:true})).toBeVisible();
  await jev.getByRole('combobox',{name:'Jev 工作项',exact:true}).selectOption(shared.work_items[0].id);
  await jev.getByRole('button',{name:'预览发送内容',exact:true}).click();
  await expect(jev.locator('.task-jev-preview')).toContainText('浮窗主目标拆解与分工联调');
  await expect(jev.locator('.task-jev-preview pre')).not.toContainText('creation_receipt');
  await jev.getByRole('checkbox',{name:'确认发送以上内容并产生本次调用费用',exact:true}).check();
  await jev.getByRole('button',{name:'发送给 Jev',exact:true}).click();
  await expect(jev.locator('.task-jev-result')).toContainText('Codex');
  await jev.getByRole('button',{name:'确认并保存分工',exact:true}).click();
  await expect.poll(async()=>deck.evaluate(async id=>(await window.screendeck.bootstrap()).plans.find(p=>p.id===id)?.version,shared.id)).toBe(shared.version+1);
  const applied=await page.evaluate(async id=>(await window.screendeck.bootstrap()).plans.find(p=>p.id===id),shared.id);
  assert.equal(applied.work_items[0].model.model_id,'synthetic-native-model');
  await deck.screenshot({path:path.join(artifactRoot,'deck-plan-and-assignment.png')});
  assert.equal(await deck.locator('.deck-planning-scroll').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  const finalCounters=await application.evaluate(()=>({planner:globalThis.__planningFixture.generations,jev:globalThis.__jevFixture.sends,native:globalThis.__nativeFixture.sends}));
  assert.deepEqual(finalCounters,{planner:2,jev:1,native:1});
  checks.push('Deck creates a formal goal, generates and confirms shared dependent steps with actual candidate models; no execution or duplicate planning on reopen');
  await deck.getByRole('button',{name:'返回浮窗任务',exact:true}).click();
  await expect(deck.locator('[data-plan-id="'+shared.id+'"]')).toContainText('浮窗确认的第一步');
  await deck.screenshot({path:path.join(artifactRoot,'deck-shared-task-list.png')});
  await deck.locator('[data-plan-id="'+shared.id+'"]').getByRole('button',{name:'规划与分工',exact:true}).click();
  await application.evaluate(({BrowserWindow},url)=>{const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);window.setMinimumSize(320,300);window.setSize(320,380);},deck.url());
  await expect.poll(()=>deck.evaluate(()=>innerWidth)).toBe(320);
  assert.equal(await deck.locator('.deck-planning-scroll').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  await deck.getByRole('button',{name:'返回浮窗任务',exact:true}).focus();await expect(deck.getByRole('button',{name:'返回浮窗任务',exact:true})).toBeFocused();
  await deck.screenshot({path:path.join(artifactRoot,'deck-planning-320.png')});
  checks.push('Deck planning fits 320px, scrolls within its fixed window and retains a keyboard-accessible back control');

  await page.getByRole('button',{name:'知识',exact:true}).click();
  const knowledge=page.getByRole('region',{name:'知识库',exact:true});
  await knowledge.getByLabel('筛选知识',{exact:true}).click();
  await knowledge.getByRole('button',{name:'已归档',exact:true}).click();
  await knowledge.locator('.knowledge-row').filter({hasText:'合成复用经验'}).click();
  await knowledge.getByLabel('更多操作',{exact:true}).click();
  await knowledge.getByRole('button',{name:'恢复',exact:true}).click();
  await expect(knowledge.getByRole('status')).toContainText('已恢复');
  await knowledge.getByLabel('筛选知识',{exact:true}).click();
  await knowledge.getByRole('button',{name:'知识库',exact:true}).click();
  await knowledge.locator('.knowledge-row').filter({hasText:'合成复用经验'}).click();
  await expect(knowledge.getByRole('button',{name:'用于任务',exact:true})).toBeEnabled();
  await knowledge.getByRole('button',{name:'用于任务',exact:true}).click();
  await knowledge.getByRole('combobox',{name:'目标任务',exact:true}).selectOption(planningTask.id);
  await expect(knowledge.locator('.knowledge-snapshot')).toContainText('校验具体文件与原尝试');
  await knowledge.getByRole('button',{name:'确认选入',exact:true}).click();
  await expect(knowledge.getByRole('status')).toContainText('已选入');
  const knowledgeTask=await page.evaluate(async id=>(await window.screendeck.bootstrap()).plans.find(p=>p.id===id),planningTask.id);
  assert.ok(knowledgeTask.task.materials.some(m=>m.summary.includes('校验具体文件与原尝试')));
  assert.equal((await application.evaluate(()=>globalThis.__nativeFixture)).sends,1);
  await page.screenshot({path:path.join(artifactRoot,'knowledge-real-accepted-source.png')});
  checks.push('Knowledge page reuses a real host-accepted native source, restores archive and explicitly saves a target material without execution');
  const qa=await application.evaluate(()=>globalThis.__deckWorkbenchSmoke);assert.deepEqual(qa.network,[]);assert.deepEqual(qa.processes,[]);assert.deepEqual(errors,[]);
  await writeFile(path.join(artifactRoot,'report.json'),JSON.stringify({checks,facts,qa,errors,temporaryRoot},null,2));console.log(JSON.stringify({status:'passed',checks,artifactRoot}));
}catch(error){await page?.screenshot({path:path.join(artifactRoot,'failure.png')}).catch(()=>{});console.error(JSON.stringify({artifactRoot,error:String(error),errors}));throw error;}finally{await application?.close();}
