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
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-deck-workbench-'));
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
for (const key of ['LANG', 'LC_ALL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[key] !== undefined) launchEnv[key] = process.env[key];

const checks = [], screenshots = [], pageErrors = [];
let application, workbench, deck;
let currentCheck = 'launch';
const artifact = async filename => { await deck.screenshot({ path: path.join(artifactRoot, filename) }); screenshots.push(filename); };
const checkpoint = async extra => writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify({ temporaryRoot, artifactRoot, checks, screenshots, pageErrors, currentCheck, ...extra }, null, 2) + '\n');
const check = async (name, operation) => { currentCheck = name; await operation(); checks.push(name); await checkpoint(); console.log(`PASS ${name}`); };
const apiPlans = () => workbench.evaluate(async () => (await window.screendeck.bootstrap()).plans);
const loadPlan = async id => (await apiPlans()).find(plan => plan.id === id);
const planRow = id => deck.locator(`.deck-workbench [data-plan-id="${id}"]`);
const readTitle = id => planRow(id).locator('[data-inline-read="title"]');
const inlineInput = () => deck.getByRole('textbox', { name: '编辑任务名称', exact: true });
const openPlan = async id => {
  const plan = await loadPlan(id);
  const completed = deck.locator('.deck-completed-tasks');
  if (await completed.locator(`[data-plan-id="${id}"]`).count() && !await completed.evaluate(node => node.open)) await completed.locator('summary').click();
  const button = deck.getByRole('button', { name: `展开任务：${plan.title}`, exact: true });
  if (await button.count()) await button.click();
};
const resizeDeck = async (width, height) => {
  await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('deck=1'));
    if (!window) throw new Error('Deck window missing.');
    window.setContentSize(size.width, size.height);
  }, { width, height });
  await expect.poll(() => deck.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
};
const beginIME = async (page, text) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  return { commit: async () => { try { await session.send('Input.insertText', { text }); } finally { await session.detach(); } } };
};

console.log(`Deck smoke artifacts: ${artifactRoot}`);
try {
  application = await electron.launch({ args: [wrapper], env: launchEnv, timeout: 30_000 });
  application.on('window', page => page.on('pageerror', error => pageErrors.push(error.message)));
  workbench = await application.firstWindow({ timeout: 30_000 });
  workbench.on('pageerror', error => pageErrors.push(error.message));
  workbench.setDefaultTimeout(10_000);
  await expect(workbench.locator('.workbench')).toBeVisible({ timeout: 30_000 });
  const initial = await workbench.evaluate(() => window.screendeck.bootstrap());
  assert.equal(initial.settings.hasKey, false);
  assert.equal(initial.projects[0]?.status, 'ready', JSON.stringify({ diagnostics: initial.diagnostics, projects: initial.projectDiagnostics }));
  assert.ok(initial.plans.some(plan => plan.id === fixturePlanID));
  const pendingWindow = application.waitForEvent('window');
  await workbench.evaluate(ids => Promise.all(ids.map(id => window.screendeck.openDeck(undefined, id))), [legacyPlan.id, fixturePlanID]);
  deck = await pendingWindow;
  deck.setDefaultTimeout(10_000);
  await expect(deck.locator('.deck-workbench')).toBeVisible();
  await workbench.evaluate(() => { window.__deckSmokePlanEvents = []; window.screendeck.subscribe(event => { if (event.type === 'plan-updated') window.__deckSmokePlanEvents.push(event.plan); }); });

  await check('concurrent-first-open-creates-one-deck-and-selects-latest-plan-context', async () => {
    assert.equal((await application.windows()).length, 2);
    const context = await deck.evaluate(() => window.screendeck.getDeckContext());
    assert.equal(context.planID, fixturePlanID);
    assert.ok(context.revision >= 1);
    await expect(readTitle(fixturePlanID)).toBeVisible();
  });

  await check('real-deck-opens-at-380-and-collapses-to-96-with-restoration', async () => {
    assert.equal((await deck.evaluate(() => window.screendeck.getDeckPresentation())).mode, 'floating', 'The test-only host must preserve floating mode independently of physical displays.');
    await expect.poll(() => deck.evaluate(() => [innerWidth, innerHeight])).toEqual([380, 380]);
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), path.join(previewRoot, 'electron-host'));
    assert.equal((await application.windows()).length, 2);
    await deck.getByRole('button', { name: '收起浮窗', exact: true }).click();
    await expect.poll(() => deck.evaluate(() => innerHeight)).toBe(96);
    await deck.getByRole('button', { name: '展开浮窗', exact: true }).click();
    await expect.poll(() => deck.evaluate(() => [innerWidth, innerHeight])).toEqual([380, 380]);
    await deck.getByRole('button', { name: '收起浮窗', exact: true }).click();
    await expect.poll(() => deck.evaluate(() => innerHeight)).toBe(96);
    await workbench.getByRole('button', { name: '任务', exact: true }).click();
    await workbench.locator(`[data-plan-id="${fixturePlanID}"]`).click();
    await workbench.getByRole('button', { name: '在 Deck 查看', exact: true }).click();
    await expect.poll(() => deck.evaluate(() => [innerWidth, innerHeight])).toEqual([380, 380]);
    await expect(deck.getByRole('button', { name: '收起浮窗', exact: true })).toBeVisible();
    await artifact('deck-open-380x380.png');
  });

  let createdID, createdItemID;
  await check('same-page-create-and-repeated-open-retain-live-composer-dom', async () => {
    await deck.getByRole('button', { name: '新增任务', exact: true }).click();
    const title = deck.getByRole('textbox', { name: '主任务', exact: true });
    await title.fill('Deck 隔离新任务');
    await title.evaluate(node => { window.__deckSmokeComposer = node; window.__deckSmokeDocument = crypto.randomUUID(); node.setSelectionRange(2, 4); });
    const documentID = await deck.evaluate(() => window.__deckSmokeDocument);
    await workbench.evaluate(id => window.screendeck.openDeck(undefined, id), fixturePlanID);
    await expect(title).toHaveValue('Deck 隔离新任务');
    assert.equal(await title.evaluate(node => node === window.__deckSmokeComposer && node.selectionStart === 2 && node.selectionEnd === 4), true);
    assert.equal(await deck.evaluate(() => window.__deckSmokeDocument), documentID);
    assert.equal((await application.windows()).length, 2);
    await artifact('deck-create-380x380.png');
    await deck.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect.poll(async () => (await apiPlans()).filter(plan => plan.title === 'Deck 隔离新任务').length).toBe(1);
    const plan = (await apiPlans()).find(value => value.title === 'Deck 隔离新任务');
    createdID = plan.id;
    assert.equal(plan.schema_version, 3);
    assert.equal(plan.task.goal, 'Deck 隔离新任务');
    await expect(deck.getByRole('button', { name: '返回浮窗任务', exact: true })).toBeVisible();
    await deck.getByRole('button', { name: '返回浮窗任务', exact: true }).click();
    assert.equal(plan.scope, undefined);
    await expect.poll(() => workbench.evaluate(id => window.__deckSmokePlanEvents.some(value => value.id === id), createdID)).toBe(true);
    await workbench.getByRole('button', { name: '任务', exact: true }).click();
    await expect(workbench.locator(`[data-plan-id="${createdID}"]`)).toBeVisible();
  });

  await check('subtask-agent-assignment-progress-and-inline-title-persist-without-starting-agent', async () => {
    await openPlan(createdID);
    const input = deck.getByRole('textbox', { name: '新子任务名称', exact: true });
    if (!await input.count()) await deck.getByRole('button', { name: '添加子任务', exact: true }).click();
    await input.fill('核对本地计划保存');
    await input.evaluate(node => { window.__deckSmokeInline = node; });
    await planRow(createdID).getByRole('button', { name: /^新子任务分工：/ }).click();
    const menu = deck.getByRole('dialog', { name: '分工选择', exact: true });
    await menu.getByRole('combobox', { name: '筛选分工', exact: true }).fill('OpenCode');
    await menu.getByRole('option', { name: /OpenCode/ }).first().click();
    await expect(input).toHaveValue('核对本地计划保存');
    assert.equal(await input.evaluate(node => node === window.__deckSmokeInline), true);
    await input.press('Enter');
    await expect.poll(async () => (await loadPlan(createdID)).work_items.length).toBe(1);
    await expect(input).toHaveCount(0);
    await openPlan(createdID);
    let plan = await loadPlan(createdID);
    createdItemID = plan.work_items[0].id;
    assert.equal(plan.work_items[0].assignee, 'agent');
    assert.equal(plan.work_items[0].agentID, 'opencode');
    assert.equal(plan.work_items[0].status, 'planned');
    await planRow(createdID).locator('[data-inline-read="subtask"]').dblclick();
    const itemName = deck.getByRole('textbox', { name: '编辑子任务名称', exact: true });
    await itemName.fill('核对本地计划保存（已改名）');
    await itemName.press('Enter');
    await expect.poll(async () => (await loadPlan(createdID)).work_items[0].title).toBe('核对本地计划保存（已改名）');
    await deck.getByRole('checkbox', { name: '完成子任务：核对本地计划保存（已改名）', exact: true }).click();
    await expect.poll(async () => (await loadPlan(createdID)).work_items[0].status).toBe('completed');
    await expect(deck.getByRole('checkbox', { name: '完成子任务：核对本地计划保存（已改名）', exact: true })).toBeChecked();
    await expect(planRow(createdID).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    await expect(planRow(createdID).getByRole('progressbar')).toHaveAttribute('aria-valuemax', '1');
    await readTitle(createdID).dblclick();
    await inlineInput().fill('Deck 隔离任务改名');
    await inlineInput().press('Enter');
    await expect.poll(async () => (await loadPlan(createdID)).title).toBe('Deck 隔离任务改名');
    plan = await loadPlan(createdID);
    assert.equal(plan.work_items[0].id, createdItemID);
    const disk = JSON.parse(await readFile(path.join(previewRoot, 'preview-plans', `${createdID}.json`), 'utf8'));
    assert.deepEqual(disk, plan);
    await expect.poll(() => workbench.evaluate(id => window.__deckSmokePlanEvents.some(value => value.id === id && value.title === 'Deck 隔离任务改名'), createdID)).toBe(true);
    assert.equal((await deck.evaluate(() => window.screendeck.getOpenCodeStatus())).state, 'stopped');
    assert.equal((await deck.evaluate(() => window.screendeck.getCodexStatus())).state, 'stopped');
    await deck.reload();
    await expect(deck.locator('.deck-workbench')).toBeVisible();
    await openPlan(createdID);
    await expect(deck.getByRole('checkbox', { name: '完成子任务：核对本地计划保存（已改名）', exact: true })).toBeChecked();
    await expect(planRow(createdID).getByRole('button', { name: /^分工：/ })).toContainText('OpenCode');
  });

  await check('one-click-checkbox-or-owner-saves-edited-name-before-the-following-action', async () => {
    const before = await loadPlan(createdID);
    await planRow(createdID).locator('[data-inline-read="subtask"]').dblclick();
    const input = deck.getByRole('textbox', { name: '编辑子任务名称', exact: true });
    await input.fill('一次单击先保存名称再更新进度');
    await deck.getByRole('checkbox', { name: `完成子任务：${before.work_items[0].title}`, exact: true }).click();
    await expect.poll(async () => { const plan = await loadPlan(createdID); return [plan.work_items[0].title, plan.work_items[0].status]; }).toEqual(['一次单击先保存名称再更新进度', 'planned']);
    await expect(deck.getByRole('checkbox', { name: '完成子任务：一次单击先保存名称再更新进度', exact: true })).not.toBeChecked();
    assert.equal((await loadPlan(createdID)).version, before.version + 2);
    await planRow(createdID).locator('[data-inline-read="subtask"]').dblclick();
    await input.fill('先保存名称再选择人工分工');
    await planRow(createdID).getByRole('button', { name: /^分工：/ }).click();
    const menu = deck.getByRole('dialog', { name: '分工选择', exact: true });
    await menu.getByRole('combobox', { name: '筛选分工', exact: true }).fill('我');
    await menu.getByRole('option', { name: /^我/ }).click();
    await expect.poll(async () => { const plan = await loadPlan(createdID); return [plan.work_items[0].title, plan.work_items[0].assignee]; }).toEqual(['先保存名称再选择人工分工', 'human']);
    const saved = await loadPlan(createdID);
    assert.equal(saved.version, before.version + 4);
    assert.equal(saved.work_items[0].id, createdItemID);
    assert.equal(saved.work_items[0].agentID, undefined);
    await expect(planRow(createdID).getByRole('alert')).toHaveCount(0);
  });

  await check('main-window-plan-save-broadcasts-to-existing-deck', async () => {
    const updated = await workbench.evaluate(async id => { const data = await window.screendeck.bootstrap(); const plan = data.plans.find(value => value.id === id); return window.screendeck.savePlan({ plan: { ...plan, title: '主窗同步后的任务' }, expectedVersion: plan.version }); }, createdID);
    await expect(planRow(createdID)).toContainText(updated.title);
    await expect(workbench.locator(`[data-plan-id="${createdID}"]`)).toContainText(updated.title);
  });

  await check('save-failure-and-genuine-version-conflict-retain-inline-draft', async () => {
    await openPlan(createdID);
    await readTitle(createdID).dblclick();
    await inlineInput().fill('保存失败后保留的草稿');
    await application.evaluate(() => { globalThis.__deckWorkbenchSmoke.failNextPlanSave = true; });
    await inlineInput().press('Enter');
    await expect(inlineInput()).toHaveValue('保存失败后保留的草稿');
    await expect(planRow(createdID).getByRole('alert')).toBeVisible();
    assert.equal((await loadPlan(createdID)).title, '主窗同步后的任务');
    await inlineInput().press('Enter');
    await expect.poll(async () => (await loadPlan(createdID)).title).toBe('保存失败后保留的草稿');
    await readTitle(createdID).dblclick();
    await inlineInput().fill('发生冲突仍保留的草稿');
    await inlineInput().evaluate(node => { window.__deckSmokeConflict = node; });
    await application.evaluate(() => { globalThis.__deckWorkbenchSmoke.conflictNextPlanSave = true; });
    await inlineInput().press('Enter');
    await expect(inlineInput()).toHaveValue('发生冲突仍保留的草稿');
    assert.equal(await inlineInput().evaluate(node => node === window.__deckSmokeConflict), true);
    await expect(planRow(createdID).getByRole('alert')).toBeVisible();
    assert.equal((await loadPlan(createdID)).title, '另一窗口已保存的并发标题');
    await artifact('deck-conflict-draft.png');
    await inlineInput().press('Escape');
  });

  await check('keyboard-ime-preserves-inline-input-until-composition-finishes', async () => {
    await openPlan(createdID);
    await readTitle(createdID).focus();
    await readTitle(createdID).press('F2');
    await expect(inlineInput()).toBeFocused();
    const original = (await loadPlan(createdID)).title;
    await inlineInput().fill('');
    const ime = await beginIME(deck, '组合输入草稿');
    await deck.keyboard.press('Enter');
    await expect(inlineInput()).toBeVisible();
    assert.equal((await loadPlan(createdID)).title, original);
    await ime.commit();
    await inlineInput().press('Escape');
    await expect(inlineInput()).toHaveCount(0);
    assert.equal((await loadPlan(createdID)).title, original);
  });

  await check('360-by-300-hidden-scrollbar-remains-scrollable-and-rounded-picker-fits', async () => {
    await resizeDeck(360, 300);
    await openPlan(fixturePlanID);
    const list = deck.getByTestId('deck-task-list');
    const style = await list.evaluate(node => ({ scrollbarWidth: getComputedStyle(node).scrollbarWidth, webkitDisplay: getComputedStyle(node, '::-webkit-scrollbar').display, overflowY: getComputedStyle(node).overflowY, room: node.scrollHeight - node.clientHeight }));
    assert.equal(style.scrollbarWidth, 'none');
    assert.equal(style.overflowY, 'auto');
    assert.ok(style.room > 0);
    await list.evaluate(node => { node.scrollTop = 0; });
    const box = await list.boundingBox();
    await deck.mouse.move(box.x + 10, box.y + box.height / 2);
    await deck.mouse.wheel(0, 250);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await planRow(fixturePlanID).getByRole('button', { name: /^分工：/ }).last().click();
    const menu = deck.getByRole('dialog', { name: '分工选择', exact: true });
    const input = menu.getByRole('combobox', { name: '筛选分工', exact: true });
    await expect(input).toBeFocused();
    const frame = await input.evaluate(node => { const wrapper = node.parentElement, style = getComputedStyle(wrapper), own = getComputedStyle(node); return { radius: style.borderRadius, background: style.backgroundColor, outline: style.outlineColor, appearance: own.appearance }; });
    assert.equal(frame.radius, '5px');
    assert.equal(frame.appearance, 'none');
    assert.notEqual(frame.outline, 'rgba(0, 0, 0, 0)');
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 360 && menuBox.y + menuBox.height <= 300);
    await artifact('deck-owner-focus-360x300.png');
    await deck.keyboard.press('Escape');
    await artifact('deck-scroll-360x300.png');
  });

  // Delivery views are still generated through the real main API, not an IPC
  // replacement or renderer-only state. The registered Agent stays disconnected.
  await workbench.evaluate(async id => {
    const plan = (await window.screendeck.bootstrap()).plans.find(value => value.id === id);
    await window.screendeck.savePlan({ expectedVersion: plan.version, plan: { ...plan, title: '核对浮窗任务与分工', work_items: [
      { id: plan.work_items[0].id, title: '保存本地任务与进度', kind: 'validation', assignee: 'human', expected_result: '', dependencies: [], status: 'completed' },
      { id: crypto.randomUUID(), title: '检查 Agent 分工', kind: 'validation', assignee: 'agent', agentID: 'opencode', expected_result: '', dependencies: [], status: 'planned' },
    ] } });
  }, createdID);
  await resizeDeck(380, 380);
  await openPlan(createdID);
  await expect(planRow(createdID).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  await expect(planRow(createdID).getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2');
  await deck.getByTestId('deck-task-list').evaluate(node => { node.scrollTop = 0; });
  await deck.mouse.move(8, 64);
  await artifact('deck-delivery-380x380.png');
  await planRow(createdID).getByRole('button', { name: /^分工：/ }).last().click();
  await expect(deck.getByRole('dialog', { name: '分工选择', exact: true }).getByRole('combobox', { name: '筛选分工', exact: true })).toBeFocused();
  await artifact('deck-assignment-focused-380x380.png');
  await deck.keyboard.press('Escape');
  await resizeDeck(360, 300);
  await deck.locator('.deck-page-heading h1').click();
  await deck.mouse.move(8, 64);
  await artifact('deck-delivery-360x300.png');

  await check('no-source-writes-network-model-submissions-agent-processes-or-unhandled-errors', async () => {
    for (const [filename, hash] of sourceHashes) assert.equal(await hashFile(filename), hash, `Source fixture changed: ${path.basename(filename)}`);
    const legacy = JSON.parse(await readFile(path.join(previewRoot, 'preview-plans', `${legacyPlan.id}.json`), 'utf8'));
    assert.deepEqual(legacy, legacyPlan);
    const guard = await application.evaluate(() => globalThis.__deckWorkbenchSmoke);
    assert.deepEqual(guard.network, []);
    assert.deepEqual(guard.processes, []);
    assert.deepEqual(guard.executionIPC, []);
    assert.deepEqual(guard.externalURLs, []);
    assert.deepEqual(guard.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(guard.injectedFailures, 1);
    assert.equal(guard.injectedConflicts, 1);
    await checkpoint({ guard, passed: true });
  });
  await checkpoint({ passed: true, guard: await application.evaluate(() => globalThis.__deckWorkbenchSmoke) });
  console.log(JSON.stringify({ passed: checks.length, artifactRoot, report: path.join(artifactRoot, 'report.json') }));
} catch (error) {
  await deck?.screenshot({ path: path.join(artifactRoot, 'failure.png') }).catch(() => {});
  await checkpoint({ passed: false, error: String(error), deckState: await deck?.evaluate(async () => ({ context: await window.screendeck.getDeckContext(), selected: document.querySelector('.deck-task-entry.is-expanded')?.getAttribute('data-plan-id') })).catch(() => undefined), guard: await application?.evaluate(() => globalThis.__deckWorkbenchSmoke).catch(() => undefined) });
  throw error;
} finally {
  if (application) {
    const timeout = setTimeout(() => application.process().kill('SIGKILL'), 8_000);
    try { await application.close(); } finally { clearTimeout(timeout); }
  }
}
