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
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-task-module-'));
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
await build({ entryPoints: [indexFile], outfile: path.join(testDist, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], plugins: [{ name: 'floating-deck-host-dependency-only', setup(builder) {
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
const { app, session, net, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(path.join(temporaryRoot, 'AGENTLOG.md'))}});
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
  if (channel === 'screendeck:save-plan') {
    qa.planSaves++;
    if (qa.failNextPlanSave) { qa.failNextPlanSave = false; qa.injectedFailures++; throw new Error('离线验收保存失败，草稿应保留。'); }
    if (qa.conflictNextPlanSave) { qa.conflictNextPlanSave = false; qa.injectedConflicts++; await listener(event, { ...input, plan: { ...input.plan, title: '另一窗口已保存的并发标题' } }); }
  }
  return listener(event, input);
});
require(${JSON.stringify(path.join(testDist, 'main.cjs'))});
`);

const launchEnv = { HOME: homeRoot, TMPDIR: path.join(temporaryRoot, 'tmp'), TMP: path.join(temporaryRoot, 'tmp'), TEMP: path.join(temporaryRoot, 'tmp'), XDG_CONFIG_HOME: path.join(homeRoot, '.config'), XDG_CACHE_HOME: path.join(homeRoot, '.cache'), XDG_DATA_HOME: path.join(homeRoot, '.local', 'share'), PATH: [path.join(temporaryRoot, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: historyRoot, SCREENDECK_INITIAL_PROJECT: projectRoot };
if (process.env.SCREENDECK_FORMAL_SMOKE === '1') { launchEnv.SCREENDECK_DATA_ROOT = path.join(temporaryRoot, 'formal-data'); launchEnv.SCREENDECK_LEGACY_ROOT = previewRoot; }
for (const key of ['LANG', 'LC_ALL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[key] !== undefined) launchEnv[key] = process.env[key];

const checks = [], pageErrors = [];
let application, page, deck;
await writeFile(path.join(temporaryRoot,'AGENTLOG.md'),'# 人工日志\n\n保留现有人工内容。\n');
const check = async (name, run) => { await run(); checks.push(name); console.log('PASS ' + name); };
const plans = () => page.evaluate(async () => (await window.screendeck.bootstrap()).plans);
try {
  application = await electron.launch({ args: [wrapper], env: launchEnv, timeout: 30_000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(page.locator('.workbench')).toBeVisible();
  await check('real main timeline and recording IPC are registered', async () => {
    const result = await page.evaluate(async () => {
      const query = { day: '2026-10-21', timeZone: 'Asia/Shanghai' };
      const [scene, timeline, recording] = await Promise.all([window.screendeck.timelineScene(query), window.screendeck.timelineQuery(query), window.screendeck.screenStatus()]);
      return { frames: scene.total, tasks: timeline.total, recording };
    });
    assert.equal(result.frames, 0);
    assert.ok(result.tasks >= 1);
    assert.ok(result.recording);
  });
  let id;
  await check('project entry keeps source filtering and readonly task detail', async () => {
    await page.getByRole('button', {name:'隔离 Deck 验收项目',exact:true}).click();
    await expect(page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`)).toHaveCount(0);
    await expect(page.getByRole('button',{name:'刷新项目任务',exact:true})).toBeVisible();
    await page.locator('.task-overview').getByRole('button',{name:/仅供只读核对的合成来源任务/}).click();
    await expect(page.locator('.task-workspace-detail')).toContainText('Deck 修改预览计划，不修改正式 task/run。');
    await page.getByRole('button',{name:'任务列表',exact:true}).click();
    await page.getByRole('button',{name:'任务',exact:true}).click();
    await expect(page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`)).toBeVisible();
  });
  await check('board and list show one task source without an empty inspector', async () => {
    await expect(page.locator('.task-board-column')).toHaveCount(4);
    await expect(page.locator('.task-workspace-detail')).toHaveCount(0);
    await expect(page.locator('.task-overview-row').filter({hasText:'读取状态中'})).toHaveCount(0);
    await page.screenshot({path:path.join(artifactRoot,'task-board.png')});
    const before = await page.locator('.task-overview-row').count();
    await page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`).click();
    await expect(page.getByRole('heading',{name:'任务详情',exact:true})).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.task-workspace-detail')).toHaveCount(0);
    await expect(page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`)).toBeFocused();
    await page.getByRole('button',{name:'列表',exact:true}).click();
    await expect(page.locator('.task-list .task-overview-row')).toHaveCount(before);
    await page.getByRole('button',{name:'看板',exact:true}).click();
    await expect(page.locator('.task-board-column')).toHaveCount(4);
  });
  await check('create and persist real task details', async () => {
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    const detail = page.locator('.task-workspace-detail');
    await detail.getByRole('textbox', { name: '任务名称', exact: true }).fill('贯通任务页与 Deck');
    await detail.getByRole('textbox', { name: '任务目标', exact: true }).fill('任务内容在三个入口一致');
    await detail.getByRole('textbox', { name: '完成条件', exact: true }).fill('保存后可读取\n不会自动发送');
    await detail.getByRole('button', { name: '添加工作项', exact: true }).click();
    await detail.getByRole('textbox', { name: '工作项 1 名称', exact: true }).fill('核对任务数据');
    await detail.getByRole('button', { name: '添加材料摘要', exact: true }).click();
    await detail.getByRole('textbox', { name: '材料 1 摘要', exact: true }).fill('仅选定的合成摘要');
    await detail.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(detail.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    await expect.poll(async () => (await plans()).some(p => p.title === '贯通任务页与 Deck')).toBe(true);
    const saved = (await plans()).find(p => p.title === '贯通任务页与 Deck'); id = saved.id;
    assert.equal(saved.schema_version, 3); assert.equal(saved.task.goal, '任务内容在三个入口一致');
    assert.deepEqual(saved.task.completion_conditions, ['保存后可读取', '不会自动发送']);
    assert.equal(saved.task.materials[0].summary, '仅选定的合成摘要'); assert.equal(saved.version, 2);
    await page.screenshot({ path: path.join(artifactRoot, 'task-page.png') });
  });
  await check('project membership and manual handoff persist without sending or creating another task', async () => {
    const detail=page.locator('.task-workspace-detail');
    await detail.getByRole('combobox',{name:'任务所属项目',exact:true}).selectOption(projectID);
    await detail.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect.poll(async()=>(await plans()).find(p=>p.id===id)?.task.project_id).toBe(projectID);
    await page.getByRole('button',{name:'任务列表',exact:true}).click();
    await page.getByRole('button',{name:'隔离 Deck 验收项目',exact:true}).click();
    await expect(page.locator(`.task-overview [data-plan-id="${id}"]`)).toBeVisible();
    await page.locator(`.task-overview [data-plan-id="${id}"]`).click();
    await detail.getByRole('combobox',{name:'任务所属项目',exact:true}).selectOption('');
    await detail.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect.poll(async()=>(await plans()).find(p=>p.id===id)?.task.project_id??'').toBe('');
    await page.getByRole('button',{name:'任务列表',exact:true}).click();
    await page.getByRole('button',{name:'任务',exact:true}).click();
    await page.locator(`.task-overview [data-plan-id="${id}"]`).click();
    const version=(await plans()).find(p=>p.id===id).version;
    await detail.locator('.task-handoffs > summary').click();
    await detail.getByRole('textbox',{name:'交接摘要',exact:true}).fill('已确认任务入口，不代表执行通过');
    await detail.getByRole('textbox',{name:'交接下一步',exact:true}).fill('核对原始材料后继续');
    await detail.getByRole('button',{name:'保存交接',exact:true}).click();
    await expect(detail.locator('.task-handoff-entry')).toContainText('已确认任务入口，不代表执行通过');
    assert.equal((await plans()).find(p=>p.id===id).version,version);
    await detail.getByRole('button',{name:'导出 AGENTLOG.md',exact:true}).click();
    await expect(detail.locator('.task-handoffs [role=status]')).toContainText('交接日志已导出');
    const exported=await readFile(path.join(temporaryRoot,'AGENTLOG.md'),'utf8');assert.ok(exported.startsWith('# 人工日志\n\n保留现有人工内容。'));assert.ok(exported.includes('已确认任务入口，不代表执行通过'));
    if(launchEnv.SCREENDECK_DATA_ROOT){const stored=JSON.parse(await readFile(path.join(launchEnv.SCREENDECK_DATA_ROOT,'tasks',id,'task.json'),'utf8'));assert.equal(stored.kind,'screendeck_task');assert.equal(stored.id,id);}
  });
  await check('Deck opens and returns to the same task', async () => {
    const pending = application.waitForEvent('window');
    await page.getByRole('button', { name: '在 Deck 查看', exact: true }).click(); deck = await pending;
    deck.on('pageerror', error => pageErrors.push(error.message));
    await expect(deck.locator(`[data-plan-id="${id}"]`)).toBeVisible();
    await page.getByRole('button', { name: '新聊天', exact: true }).click();
    await deck.getByRole('button', { name: '打开工作台', exact: true }).click();
    await expect(page.locator(`.task-workspace-detail [data-plan-detail="${id}"]`)).toBeVisible();
  });
  await check('page drafts survive task switching', async () => {
    const detail = page.locator('.task-workspace-detail');
    await detail.getByRole('textbox', { name: '任务目标', exact: true }).fill('未保存的页内目标');
    await page.getByRole('button', {name:'任务列表',exact:true}).click();
    await page.locator(`.task-overview [data-plan-id="${fixturePlanID}"]`).click();
    await page.getByRole('button', {name:'任务列表',exact:true}).click();
    await page.locator(`.task-overview [data-plan-id="${id}"]`).click();
    await expect(detail.getByRole('textbox', { name: '任务目标', exact: true })).toHaveValue('未保存的页内目标');
    assert.equal((await plans()).find(p => p.id === id).task.goal, '任务内容在三个入口一致');
    await detail.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(detail.getByRole('button', { name: '讨论任务', exact: true })).toBeEnabled();
  });
  await check('selected summaries enter unsent chat draft only', async () => {
    await page.getByRole('button', { name: '讨论任务', exact: true }).click();
    const sidebar = page.locator('.local-task-sidebar'); await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('textbox', { name: '任务目标', exact: true })).toHaveValue('未保存的页内目标');
    await sidebar.getByRole('textbox', { name: '讨论内容', exact: true }).fill('请先讨论验收方法');
    await sidebar.locator('.task-chat-material input').first().check();
    await sidebar.getByRole('button', { name: '放入聊天草稿', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue(/请先讨论验收方法[\s\S]*仅选定的合成摘要/);
    const data = await page.evaluate(() => window.screendeck.bootstrap()); assert.equal(data.sessions.length, 0); assert.equal(data.agentSessions.length, 0);
    await page.screenshot({ path: path.join(artifactRoot, 'task-chat.png') });
  });
  await check('conflict retains draft without overwriting newer save', async () => {
    await page.getByRole('button', { name: '任务', exact: true }).click();
    const detail = page.locator('.task-workspace-detail');
    await detail.getByRole('textbox', { name: '任务目标', exact: true }).fill('保留冲突草稿');
    await page.evaluate(async id => { const current = (await window.screendeck.bootstrap()).plans.find(p => p.id === id); await window.screendeck.savePlan({ plan: { ...current, title: '其他窗口的新标题' }, expectedVersion: current.version }); }, id);
    await expect(detail.locator('.task-conflict')).toBeVisible();
    await expect(detail.getByRole('textbox', { name: '任务目标', exact: true })).toHaveValue('保留冲突草稿');
    await expect(detail.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  });
  await check('narrow layout and keyboard search remain readable', async () => {
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('deck=1')); win.setMinimumSize(560,500); win.setContentSize(720,780); });
    await page.getByRole('button', { name: '任务列表', exact: true }).click();
    await page.locator(`.task-overview [data-plan-id="${id}"]`).click();
    await expect(page.getByRole('button', { name: '任务列表', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '任务列表', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '搜索任务', exact: true }).focus(); await page.keyboard.type('不存在的任务');
    await expect(page.locator('.task-overview-row')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifactRoot, 'task-narrow.png') });
  });
  const qa = await application.evaluate(() => globalThis.__deckWorkbenchSmoke);
  assert.deepEqual(qa.network, []); assert.deepEqual(qa.processes, []); assert.deepEqual(qa.executionIPC, []); assert.deepEqual(pageErrors, []);
  for (const [filename, original] of sourceHashes) assert.equal(await hashFile(filename), original);
  await writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify({ checks, pageErrors, qa, temporaryRoot }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, artifactRoot }));
} catch (error) {
  await page?.screenshot({ path: path.join(artifactRoot, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ artifactRoot, checks, error: String(error), pageErrors })); throw error;
} finally { await application?.close(); }

// A clean installation has one empty state and one creation entry, with no blank inspector.
const emptyPreview = path.join(temporaryRoot, 'empty-preview');
const emptyHistory = path.join(temporaryRoot, 'empty-history');
await mkdir(emptyPreview, {recursive:true}); await mkdir(emptyHistory, {recursive:true});
const emptyEnv = {...launchEnv, SCREENDECK_PREVIEW_ROOT:emptyPreview, SCREENDECK_PROJECT_HISTORY_ROOT:emptyHistory};
delete emptyEnv.SCREENDECK_INITIAL_PROJECT;
if (process.env.SCREENDECK_FORMAL_SMOKE === '1') { emptyEnv.SCREENDECK_DATA_ROOT=path.join(temporaryRoot,'empty-formal-data'); emptyEnv.SCREENDECK_LEGACY_ROOT=emptyPreview; }
let emptyApp;
try {
  emptyApp = await electron.launch({args:[wrapper],env:emptyEnv,timeout:30_000});
  const emptyPage = await emptyApp.firstWindow();
  await emptyPage.getByRole('button',{name:'任务',exact:true}).click();
  await expect(emptyPage.locator('.task-workspace .task-empty')).toHaveCount(1);
  await expect(emptyPage.locator('.task-workspace-detail')).toHaveCount(0);
  await expect(emptyPage.getByRole('button',{name:'新建任务',exact:true})).toHaveCount(1);
  await emptyPage.screenshot({path:path.join(artifactRoot,'task-empty.png')});
  const emptyQA = await emptyApp.evaluate(() => globalThis.__deckWorkbenchSmoke);
  assert.deepEqual(emptyQA.network,[]); assert.deepEqual(emptyQA.processes,[]); assert.deepEqual(emptyQA.executionIPC,[]);
  checks.push('clean install has one empty state and no blank inspector');
  console.log('PASS '+checks.at(-1));
  const reportFile = path.join(artifactRoot,'report.json');
  const report = JSON.parse(await readFile(reportFile,'utf8'));
  await writeFile(reportFile,JSON.stringify({...report,checks},null,2));
  console.log(JSON.stringify({status:'passed',checks:checks.length,artifactRoot}));
} finally { await emptyApp?.close(); }
