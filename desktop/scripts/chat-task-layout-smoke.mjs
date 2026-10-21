import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Built Electron/main/preload/renderer, generated records only. No model calls,
// credentials, real project history, user app restarts, installs, or migrations.
const desktopRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-chat-task-layout-'));
const projectRoot = path.join(temporaryRoot, 'project');
const privateRoot = path.join(temporaryRoot, 'private');
const previewRoot = path.join(temporaryRoot, 'preview');
const launchHome = path.join(temporaryRoot, 'home');
const artifactRoot = path.join(desktopRoot, 'artifacts', 'chat-task-layout-smoke');
const projectID = `project-${randomUUID()}`;
const timestamp = '2026-10-13T00:00:00.000Z';
const identity = { schema_version: 2, kind: 'project', project_id: projectID, name: '隔离聊天与任务布局', created_at: timestamp };
const taskTitles = ['验证聊天中的任务上下文', '查看旧试运行未知结果', '查看旧模拟准备', '查看旧工具许可'];
const tasks = taskTitles.map((title, index) => ({
  schema_version: 1, kind: 'task', project_id: projectID, task_id: `task-${String(index + 1).padStart(3, '0')}`,
  title, goal: '合成布局验收数据；不访问真实任务，不调用模型，不执行真实工具。',
  status: 'draft', plan_version: 1, assignee: 'human', created_at: timestamp, updated_at: timestamp, run_ids: [],
  acceptance: [{ id: 'source-preserved', description: '来源记录保持原样', verification: 'not_checked', requires_human: true }],
  references: index === 0 ? [{ path: 'layout-notes.md', label: '布局验收材料.md' }] : [],
}));
const history = {
  schema_version: 1, kind: 'project_history', project_id: projectID, source_root: projectRoot, created_at: timestamp,
  project: { schema_version: 1, kind: 'project', project_id: projectID, name: identity.name, created_at: timestamp, timezone: 'Asia/Shanghai', mode: 'manual_pilot', references: [] },
  migration: { backup_path: path.join(temporaryRoot, 'synthetic-unopened-backup'), migrated_at: timestamp },
};
const namespace = path.join(privateRoot, 'projects', projectID);
const ordinarySession = {
  schema_version: 1, conversation_id: randomUUID(), title: '普通聊天 · 布局验收',
  scope: { kind: 'project', project_id: projectID, task_id: tasks[0].task_id },
  created_at: timestamp, updated_at: timestamp, revision: 1, turns: [], messages: [],
};
for (let index = 0; index < 8; index++) {
  const turnID = randomUUID();
  ordinarySession.turns.push({ turn_id: turnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'offline-layout-fixture' }, state: 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: index });
  for (const [role, text] of [
    ['user', `合成聊天问题 ${index + 1}：一起梳理目标、计划和验收。`],
    ['assistant', `合成聊天回复 ${index + 1}：这是写入临时 JSON 的离线测试正文。\n\n我们先保留普通聊天，再在右侧查看当前任务的目标和步骤。这里没有发生模型请求。`],
  ]) ordinarySession.messages.push({ message_id: randomUUID(), turn_id: turnID, role, text, created_at: timestamp, updated_at: timestamp });
}
const ordinaryFile = path.join(previewRoot, 'sessions', '2026', '10', '13', `${ordinarySession.conversation_id}.json`);
// Serialized legacy facts only. No driver, public authorization/start API or
// executable simulation mode is needed to read these records in production.
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const recordID = value => { const hash = digest(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
const plans = tasks.map((task, index) => ({
  schema_version: 1, kind: 'electron_preview_plan', id: randomUUID(), title: index === 0 ? '已保存的下一步计划' : `历史检查计划 ${index + 1}`,
  version: 1, created_at: timestamp, updated_at: timestamp, scope: { project_id: projectID, task_id: task.task_id },
  work_items: Array.from({ length: index === 0 ? 8 : 1 }, (_, item) => ({ id: randomUUID(), title: index === 0 ? ['梳理任务目标', '查看旧模拟成果'][item] ?? `后续工作 ${item + 1}` : task.title, kind: 'implementation', assignee: 'unassigned', expected_result: `一份可审核的合成结果 ${item + 1}`, dependencies: [], status: 'planned' })),
}));
const historical = (taskIndex, title, state) => {
  const sessionID = randomUUID(), turnID = randomUUID(), inputMessageID = randomUUID();
  const text = `只读旧历史：${title}`, model = { provider_id: 'simulation', model_id: 'simulation-v1' };
  const spec = { work: { planID: plans[taskIndex].id, planVersion: plans[taskIndex].version, workItemID: plans[taskIndex].work_items[0].id }, title, kind: 'implementation', expectedResult: '历史合成结果，未执行真实工具。', dependencies: [], inputMessageID, materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: digest('legacy-workspace') }, driver: { driverID: state === 'unknown' ? 'simulation-unknown' : 'simulation-success', configDigest: digest('legacy-driver'), mode: 'simulation' }, tools: state === 'awaiting_permission' ? { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] } : { kind: 'none' } };
  const execution = { spec, specDigest: digest({ spec, model, text }), ...(state === 'prepared' ? {} : { authorizationID: randomUUID(), external: { runtimeID: 'old-fixture-runtime', connectionGeneration: 'old-fixture-generation', externalSessionID: randomUUID() } }), eventReceipts: [], permissions: [], ...(state === 'finished' ? { result: { summary: '旧模拟结果：未调用模型、未修改文件、未执行命令。', artifacts: [], evidence: [] } } : {}) };
  if (state === 'awaiting_permission') {
    const action = { kind: 'file-write', path: 'simulation/result.txt', content: '这是保存的旧提案，本次不会写入。' };
    execution.permissions.push({ externalRequestID: randomUUID(), action, actionDigest: digest(action) });
  }
  const record = { schema_version: 2, kind: 'electron_task_session', conversation_id: sessionID, title, scope: { kind: 'project', project_id: projectID, task_id: tasks[taskIndex].task_id }, created_at: timestamp, updated_at: timestamp, revision: 1,
    turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: model, state, created_at: timestamp, updated_at: timestamp, draft_revision: 0, execution }],
    messages: [{ message_id: inputMessageID, turn_id: turnID, role: 'user', text, created_at: timestamp, updated_at: timestamp }, ...(state === 'prepared' ? [] : [{ message_id: randomUUID(), turn_id: turnID, role: 'assistant', text: '这是预置的旧模拟历史正文，不是本次执行结果。', created_at: timestamp, updated_at: timestamp }])],
  };
  return { taskIndex, record, turn: { session: { format: 'task-v2', sessionID }, turnID } };
};
const finished = historical(0, '已保存的旧模拟结果', 'finished');
const unknown = historical(1, '结果未知的旧试运行', 'unknown');
const prepared = historical(2, '尚未开始的旧模拟准备', 'prepared');
const permission = historical(3, '等待许可的旧模拟记录', 'awaiting_permission');
const legacy = [finished, unknown, prepared, permission];
const pendingApproval = target => ({ schema_version: 1, kind: 'electron_execution_approval', id: recordID(target.kind === 'execution' ? { kind: target.kind, turn: target.turn } : { kind: target.kind, turn: target.turn, externalRequestID: target.externalRequestID }), target, state: 'pending', created_at: timestamp, expires_at: '2026-10-14T00:00:00.000Z' });
const oldApprovals = [pendingApproval({ kind: 'execution', turn: prepared.turn, specDigest: prepared.record.turns[0].execution.specDigest }), pendingApproval({ kind: 'tool', turn: permission.turn, externalRequestID: permission.record.turns[0].execution.permissions[0].externalRequestID, actionDigest: permission.record.turns[0].execution.permissions[0].actionDigest })];
const resultDigest = digest({ specDigest: finished.record.turns[0].execution.specDigest, result: finished.record.turns[0].execution.result });
const accepted = { schema_version: 1, kind: 'electron_execution_acceptance', id: recordID({ turn: finished.turn, resultDigest }), turn: finished.turn, resultDigest, decision: 'accepted', decided_by: 'old-fixture-user', decided_at: timestamp };
const legacyFiles = [
  ...legacy.map(value => [path.join(previewRoot, 'task-sessions-v2', `${value.record.conversation_id}.json`), JSON.stringify(value.record)]),
  ...oldApprovals.map(value => [path.join(previewRoot, 'execution-approvals-v1', `${value.id}.json`), JSON.stringify(value)]),
  [path.join(previewRoot, 'execution-acceptances-v1', `${accepted.id}.json`), JSON.stringify(accepted)],
];

for (const folder of [path.join(projectRoot, '.screendeck'), ...['tasks', 'runs', 'artifacts'].map(name => path.join(namespace, name)), path.dirname(ordinaryFile), path.join(previewRoot, 'task-sessions-v2'), path.join(previewRoot, 'preview-plans'), path.join(previewRoot, 'execution-approvals-v1'), path.join(previewRoot, 'execution-acceptances-v1'), launchHome, artifactRoot]) await mkdir(folder, { recursive: true });
const sourceFiles = [
  [path.join(projectRoot, '.screendeck', 'project.json'), JSON.stringify(identity)],
  [path.join(namespace, 'history.json'), JSON.stringify(history)],
  ...tasks.map(task => [path.join(namespace, 'tasks', `${task.task_id}.json`), JSON.stringify(task)]),
  [path.join(projectRoot, 'layout-notes.md'), '# 布局验收材料\n\n' + Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 行：这是临时合成材料，仅检查文件页签和滚动位置。`).join('\n')],
  [ordinaryFile, JSON.stringify(ordinarySession)],
  ...plans.map(plan => [path.join(previewRoot, 'preview-plans', `${plan.id}.json`), JSON.stringify(plan)]),
  ...legacyFiles,
];
for (const [filename, text] of sourceFiles) await writeFile(filename, text);
const sourceHashes = await Promise.all(sourceFiles.map(async ([filename]) => [filename, createHash('sha256').update(await readFile(filename)).digest('hex')]));
const launchEnv = {};
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) launchEnv[name] = process.env[name];
Object.assign(launchEnv, { HOME: launchHome, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: privateRoot, SCREENDECK_INITIAL_PROJECT: projectRoot });

const checks = [];
const screenshots = [];
let application;
let page;
let currentCheck = 'launch';
const check = async (name, operation) => { currentCheck = name; await operation(); checks.push(name); console.log(`PASS ${name}`); };
const screenshot = async filename => { await page.screenshot({ path: path.join(artifactRoot, filename) }); screenshots.push(filename); };
const input = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const panel = () => page.locator('.detail-panel');
const thread = () => page.locator('.task-execution-history');
const resize = async (width, height) => {
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
};
const setPanelOpen = async open => {
  if (await page.getByRole('button', { name: open ? '展开右栏' : '收起右栏', exact: true }).isVisible()) await page.getByRole('button', { name: open ? '展开右栏' : '收起右栏', exact: true }).click();
  if (open) await expect(panel()).toBeVisible(); else await expect(panel()).toBeHidden();
};
const stateOf = async ref => page.evaluate(async ref => (await window.screendeck.loadTaskSession(ref.session)).turns.find(turn => turn.turn_id === ref.turnID), ref);
const assertChatFrame = async ({ ordinary = false } = {}) => {
  await expect(page.locator('.composer')).toBeVisible();
  await expect(input()).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  assert.equal(await input().evaluate(node => !!node.closest('#center-column')), true);
  if (ordinary) {
    await expect(page.locator('.messages > .message').filter({ hasText: '合成聊天问题 8' })).toHaveCount(1);
    await expect(page.locator('.messages > .message').filter({ hasText: '合成聊天回复 8' })).toHaveCount(1);
  }
};
const openTask = async index => {
  await page.locator('.task-shortcut').filter({ hasText: taskTitles[index] }).click();
  await expect(panel().locator('.detail-heading h1')).toHaveText(taskTitles[index]);
};
const openHistory = async record => {
  await setPanelOpen(true);
  await page.getByRole('tab', { name: '任务详情', exact: true }).click();
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: `查看试运行记录：${record.title}`, exact: true }).click();
  await expect(thread()).toBeVisible();
  assert.equal(await thread().evaluate(node => !!node.closest('#center-column .center-content .messages')), true);
  await assertChatFrame();
};
const installNetworkGuard = async instance => instance.evaluate(({ net, session }) => {
  globalThis.__chatTaskLayoutCounts = { remoteAttempts: 0, sends: 0, executionWrites: 0 };
  const guard = original => (input, ...args) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (/^https?:/i.test(url)) { globalThis.__chatTaskLayoutCounts.remoteAttempts++; throw new Error('Offline layout fixture blocks remote requests.'); }
    return original(input, ...args);
  };
  globalThis.fetch = guard(globalThis.fetch.bind(globalThis)); net.fetch = guard(net.fetch.bind(net));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { globalThis.__chatTaskLayoutCounts.remoteAttempts++; callback({ cancel: true }); });
});
const installSendGuard = async instance => instance.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('screendeck:send-message');
  ipcMain.handle('screendeck:send-message', () => { globalThis.__chatTaskLayoutCounts.sends++; throw new Error('Layout smoke never sends messages.'); });
  for (const channel of ['request-execution-authorization', 'start-task-execution', 'decide-execution-approval', 'cancel-task-execution', 'reply-task-permission', 'reconcile-task-execution', 'review-work-item', 'retry-task-pending-writes', 'start-opencode', 'send-agent-message']) {
    ipcMain.removeHandler(`screendeck:${channel}`);
    ipcMain.handle(`screendeck:${channel}`, () => { globalThis.__chatTaskLayoutCounts.executionWrites++; throw new Error('Read-only layout smoke forbids execution or history mutation.'); });
  }
});

try {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
  // Only this isolated app process is intercepted. Historical JSON was seeded before launch.
  await installNetworkGuard(application);
  page = await application.firstWindow({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  // Register only once the app has installed its ordinary handlers.
  await installSendGuard(application);
  const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(bootstrap.projects[0]?.status, 'ready', JSON.stringify(bootstrap.diagnostics));
  assert.equal(bootstrap.sessions.find(record => record.conversation_id === ordinarySession.conversation_id)?.messages.length, ordinarySession.messages.length);
  assert.equal(bootstrap.settings.hasKey, false);

  await check('preseeded-legacy-records-load-without-authorizing-or-starting-execution', async () => {
    assert.equal(bootstrap.plans.length, plans.length);
    assert.deepEqual(bootstrap.taskSessions.map(record => record.conversation_id).sort(), legacy.map(value => value.record.conversation_id).sort());
    for (const value of legacy) assert.deepEqual(await page.evaluate(ref => window.screendeck.loadTaskSession(ref), value.turn.session), value.record);
  });
  await resize(1440, 940);

  await check('empty-chat-has-normal-composer-and-no-empty-context-panel', async () => {
    await assertChatFrame();
    await expect(page.getByRole('button', { name: '展开右栏', exact: true })).toHaveCount(0);
    await expect(panel()).toBeHidden();
    assert.equal(await page.locator('.workbench').evaluate(node => node.classList.contains('has-detail')), false);
  });
  await check('separate-mode-simulation-group-and-request-form-removed', async () => {
    await expect(page.locator('.task-execution-chat, .execution-request, .task-execution-mode, .chat-mode-switch')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '申请模拟执行', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '申请本次授权', exact: true })).toHaveCount(0);
    assert.equal(await page.locator('.sidebar-heading').filter({ hasText: '模拟执行' }).count(), 0);
  });
  await page.locator('.project-button').filter({ hasText: identity.name }).click();
  await openTask(0);
  await page.locator('.session-button').filter({ hasText: ordinarySession.title }).click();
  await setPanelOpen(true);
  await check('ordinary-chat-body-stays-with-task-context', async () => {
    await assertChatFrame({ ordinary: true });
    await expect(panel().locator('.detail-heading h1')).toHaveText(tasks[0].title);
    await input().fill('继续讨论任务；此输入不发送。');
    const draftStatus = page.locator('.composer-draft-status[role="status"].visually-hidden');
    await expect(draftStatus).toHaveText('草稿已保存');
    assert.equal(await draftStatus.evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return rect.width <= 1 && rect.height <= 1 && style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)' && style.display !== 'none' && style.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true'; }), true, 'Draft status stays live without visible chrome.');
    await expect.poll(() => page.evaluate(key => window.screendeck.loadDraft(key), `session:${ordinarySession.conversation_id}`)).toBe('继续讨论任务；此输入不发送。');
  });
  await check('compact-plan-discussion-only-prefills-composer', async () => {
    await page.getByRole('tab', { name: '分工', exact: true }).click();
    await expect(page.getByTestId('task-work-items')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toBeHidden();
    const before = await page.evaluate(() => window.screendeck.bootstrap());
    await page.getByRole('button', { name: '讨论这一步', exact: true }).first().click();
    await expect(input()).toHaveValue(/梳理任务目标/);
    await expect(input()).toHaveValue(/一份可审核的合成结果 1/);
    await expect(input()).toBeFocused();
    const draftStatus = page.locator('.composer-draft-status[role="status"].visually-hidden');
    await expect(draftStatus).toHaveText('草稿已保存');
    assert.equal(await draftStatus.evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return rect.width <= 1 && rect.height <= 1 && style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)' && style.display !== 'none' && style.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true'; }), true, 'Discussion draft remains available as a live status without visible chrome.');
    const savedDraft = await input().inputValue();
    await expect.poll(() => page.evaluate(key => window.screendeck.loadDraft(key), `session:${ordinarySession.conversation_id}`)).toBe(savedDraft);
    const after = await page.evaluate(() => window.screendeck.bootstrap());
    assert.deepEqual(after.taskSessions, before.taskSessions, 'Discussion must not create or alter a task turn.');
    assert.deepEqual(after.sessions, before.sessions, 'Discussion must not submit an ordinary message.');
    assert.deepEqual(after.plans, before.plans, 'Discussion must not save or execute a plan.');
    await assertChatFrame({ ordinary: true });
  });
  await check('right-collapse-preserves-task-tab-plan-draft-and-scroll', async () => {
    await page.getByRole('button', { name: '编辑计划', exact: true }).click();
    const field = page.getByRole('textbox', { name: '工作项 1 内容', exact: true });
    await field.fill('尚未保存的任务目标修改');
    await expect(panel().getByText('尚未保存', { exact: true })).toBeVisible();
    const position = await panel().locator('.detail-scroll').evaluate(node => { node.scrollTop = 150; return node.scrollTop; });
    assert.ok(position > 0, 'Fixture must produce real scrollable task content.');
    const chatPosition = await page.locator('#center-column > .center-content').evaluate(node => { node.dataset.layoutSmokeFrame = 'preserved'; node.scrollTop = 210; node.dispatchEvent(new Event('scroll', { bubbles: true })); return node.scrollTop; });
    assert.ok(chatPosition > 0, 'Ordinary chat fixture must produce a real scroll position.');
    const draft = await input().inputValue();
    await setPanelOpen(false);
    await assertChatFrame({ ordinary: true });
    await expect(input()).toHaveValue(draft);
    await setPanelOpen(true);
    await expect(page.getByRole('tab', { name: '分工', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(field).toHaveValue('尚未保存的任务目标修改');
    await expect.poll(() => panel().locator('.detail-scroll').evaluate(node => node.scrollTop)).toBe(position);
    await expect(page.locator('#center-column > .center-content')).toHaveAttribute('data-layout-smoke-frame', 'preserved');
    await expect.poll(() => page.locator('#center-column > .center-content').evaluate(node => node.scrollTop)).toBe(chatPosition);
    assert.equal((await page.evaluate(() => window.screendeck.bootstrap())).plans.find(plan => plan.id === plans[0].id).work_items[0].title, '梳理任务目标');
  });
  await check('file-tab-content-and-scroll-survive-right-collapse', async () => {
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await panel().locator('.task-material').filter({ hasText: '布局验收材料.md' }).click();
    await expect(page.getByRole('tab', { name: '布局验收材料.md', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel().locator('.file-content pre')).toContainText('第 100 行');
    const position = await panel().locator('.file-content').evaluate(node => { node.scrollTop = 170; return node.scrollTop; });
    assert.ok(position > 0);
    await setPanelOpen(false); await setPanelOpen(true);
    await expect(page.getByRole('tab', { name: '布局验收材料.md', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel().locator('.file-content pre')).toContainText('第 100 行');
    await expect.poll(() => panel().locator('.file-content').evaluate(node => node.scrollTop)).toBe(position);
  });
  await check('closing-last-task-tab-collapses-panel-and-toggle-restores-draft', async () => {
    await page.getByRole('button', { name: '关闭文件预览：布局验收材料.md', exact: true }).click();
    await page.getByRole('tab', { name: '任务详情', exact: true }).click();
    await page.getByRole('tab', { name: '分工', exact: true }).click();
    const field = page.getByRole('textbox', { name: '工作项 1 内容', exact: true });
    await expect(field).toHaveValue('尚未保存的任务目标修改');
    const position = await panel().locator('.detail-scroll').evaluate(node => { node.scrollTop = 140; return node.scrollTop; });
    assert.ok(position > 0);
    await page.getByRole('button', { name: '关闭任务详情内容', exact: true }).click();
    await expect(panel()).toBeHidden();
    assert.equal(await page.locator('.workbench').evaluate(node => node.classList.contains('has-detail')), false);
    await assertChatFrame({ ordinary: true });
    await setPanelOpen(true);
    await expect(page.getByRole('tab', { name: '任务详情', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '分工', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(field).toHaveValue('尚未保存的任务目标修改');
    await expect.poll(() => panel().locator('.detail-scroll').evaluate(node => node.scrollTop)).toBe(position);
  });
  await check('tasks-and-timeline-navigation-retains-original-chat-context-and-unsaved-plan', async () => {
    const draft = await input().inputValue();
    const position = await panel().locator('.detail-scroll').evaluate(node => { node.scrollTop = 160; return node.scrollTop; });
    const before = await page.evaluate(() => window.screendeck.bootstrap());
    for (const name of ['任务', '时间线']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(panel()).toBeHidden();
      assert.equal(await page.locator('.workbench').evaluate(node => node.classList.contains('has-detail')), false);
      await page.locator('.session-button').filter({ hasText: ordinarySession.title }).click();
      await setPanelOpen(true);
      await assertChatFrame({ ordinary: true }); await expect(input()).toHaveValue(draft);
      await expect(page.getByRole('tab', { name: '分工', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue('尚未保存的任务目标修改');
      await expect.poll(() => panel().locator('.detail-scroll').evaluate(node => node.scrollTop)).toBe(position);
    }
    const after = await page.evaluate(() => window.screendeck.bootstrap());
    assert.deepEqual(after.plans, before.plans); assert.deepEqual(after.sessions, before.sessions); assert.deepEqual(after.taskSessions, before.taskSessions);
  });
  await page.getByRole('tab', { name: '任务详情', exact: true }).click();
  await page.getByRole('tab', { name: '分工', exact: true }).click();
  await page.getByRole('button', { name: '收起编辑', exact: true }).click();
  await panel().locator('.detail-scroll').evaluate(node => { node.scrollTop = 0; });
  await screenshot('chat-task-1440x940.png');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await panel().locator('.detail-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.locator('#center-column > .center-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await assertChatFrame({ ordinary: true });
  await screenshot('chat-task-overview-1440x940.png');
  await check('timeline-opens-existing-task-v2-inside-ordinary-chat', async () => {
    await openHistory(finished.record);
    await assertChatFrame({ ordinary: true });
    await expect(thread().getByRole('button', { name: '开始模拟执行', exact: true })).toHaveCount(0);
    await expect(thread().locator('.execution-request')).toHaveCount(0);
    await expect(thread().locator('.simulation-badge').first()).toHaveText(/模拟/);
    await expect(thread().getByText('旧模拟结果：未调用模型、未修改文件、未执行命令。', { exact: true })).toBeVisible();
  });
  await check('legacy-simulation-history-exposes-no-execution-or-review-writes', async () => {
    for (const value of legacy) {
      await openTask(value.taskIndex);
      await openHistory(value.record);
      for (const name of ['开始模拟执行', '开始本次执行', '批准本次范围', '允许这一次', '拒绝本次操作', '发送本次许可', '接受本次成果', '拒绝本次成果', '核对原尝试', '取消准备', '停止这次试运行']) await expect(thread().getByRole('button', { name, exact: true })).toHaveCount(0);
      assert.deepEqual(await page.evaluate(ref => window.screendeck.loadTaskSession(ref), value.turn.session), value.record);
      await assertChatFrame();
    }
    // Selecting a task opens its draft conversation; restore the saved chat
    // after the scope change before checking the drawer against ordinary text.
    await openTask(0);
    await page.locator('.session-button').filter({ hasText: ordinarySession.title }).click();
    await assertChatFrame({ ordinary: true });
  });
  await check('compact-drawer-inert-focus-trap-and-focus-restore', async () => {
    await setPanelOpen(false); await resize(860, 860);
    const toggle = page.getByRole('button', { name: '展开右栏', exact: true });
    await toggle.focus(); await toggle.click();
    await expect(panel()).toBeVisible();
    await expect.poll(() => page.locator('#center-column').evaluate(node => node.inert)).toBe(true);
    assert.deepEqual(await page.evaluate(() => ['.brand-header', '.sidebar', '.topbar', '#center-column'].map(selector => document.querySelector(selector).inert)), [true, true, true, true]);
    assert.equal(await input().evaluate(node => node.closest('#center-column').inert), true);
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.detail-panel')), true);
    for (let index = 0; index < 14; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.detail-panel')), true, 'Keyboard focus must remain inside an open compact drawer.'); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('chat-task-drawer-860x860.png');
    await page.keyboard.press('Escape');
    await expect(panel()).toBeHidden();
    await expect.poll(() => page.locator('#center-column').evaluate(node => node.inert)).toBe(false);
    assert.deepEqual(await page.evaluate(() => ['.brand-header', '.sidebar', '.topbar', '#center-column'].map(selector => document.querySelector(selector).inert)), [false, false, false, false]);
    await expect(page.getByRole('button', { name: '展开右栏', exact: true })).toBeFocused();
    await assertChatFrame({ ordinary: true });
    await screenshot('chat-task-chat-860x860.png');
  });
  await resize(1440, 940);
  await check('unknown-legacy-history-remains-readable-without-replay', async () => {
    await openTask(1); await openHistory(unknown.record);
    await expect(thread().locator('.execution-unknown')).toBeVisible();
    assert.deepEqual(await stateOf(unknown.turn), unknown.record.turns[0]);
    await expect(thread().getByRole('button', { name: '开始模拟执行', exact: true })).toHaveCount(0);
    await expect(thread().getByRole('button', { name: '核对原尝试', exact: true })).toHaveCount(0);
    await assertChatFrame();
  });
  await check('offline-layout-does-not-write-source-or-submit-model-chat', async () => {
    for (const [filename, expected] of sourceHashes) assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), expected, filename);
    const counts = await application.evaluate(() => globalThis.__chatTaskLayoutCounts);
    assert.deepEqual(counts, { remoteAttempts: 0, sends: 0, executionWrites: 0 });
    assert.equal((await page.evaluate(() => window.screendeck.getSettings())).hasKey, false);
  });
  await check('restart-with-missing-source-task-still-exposes-unresolved-history', async () => {
    const original = await stateOf(unknown.turn);
    const before = await page.evaluate(() => window.screendeck.bootstrap());
    await application.close(); application = undefined;
    // Remove only a generated fixture task. Never remove a user file or alter
    // preview history; the recovery entry must work with the original record.
    const removedFile = path.join(namespace, 'tasks', `${tasks[1].task_id}.json`);
    await rm(removedFile);
    application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
    await installNetworkGuard(application);
    page = await application.firstWindow({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
    await installSendGuard(application);
    await resize(1440, 940);
    const recovered = await page.evaluate(() => window.screendeck.bootstrap());
    assert.equal(recovered.taskSessions.length, before.taskSessions.length);
    assert.equal(recovered.projects.some(project => project.tasks.some(task => task.task_id === tasks[1].task_id)), false);
    await setPanelOpen(true);
    await expect(panel().getByText('原任务暂不可读，仍可查看已保存的执行事实。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `查看试运行记录：${unknown.record.title}`, exact: true }).click();
    await expect(thread()).toBeVisible();
    await assertChatFrame();
    await expect(thread().getByRole('button', { name: '核对原尝试', exact: true })).toHaveCount(0);
    await expect(thread().locator('.execution-unknown')).toBeVisible();
    const turn = await stateOf(unknown.turn);
    assert.equal(turn.state, 'unknown'); assert.equal(turn.client_request_id, original.client_request_id);
    assert.equal(turn.execution.authorizationID, original.execution.authorizationID);
    assert.deepEqual(turn.execution.external, original.execution.external);
    assert.deepEqual(turn.execution.spec, original.execution.spec);
    assert.equal((await page.evaluate(() => window.screendeck.bootstrap())).taskSessions.length, before.taskSessions.length);
    await expect(thread().getByRole('button', { name: '开始模拟执行', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '申请本次授权', exact: true })).toHaveCount(0);
    assert.deepEqual(await application.evaluate(() => globalThis.__chatTaskLayoutCounts), { remoteAttempts: 0, sends: 0, executionWrites: 0 });
    for (const [filename, expected] of sourceHashes) if (filename !== removedFile) assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), expected, filename);
    await assert.rejects(readFile(removedFile), { code: 'ENOENT' });
    await screenshot('chat-task-recovery-1440x940.png');
  });
  const report = { chatTaskLayoutSmoke: 'passed', temporaryRoot, checks, screenshots, ...(await application.evaluate(() => globalThis.__chatTaskLayoutCounts)), limitations: ['Only generated project/session/history and serialized read-only legacy simulation records were used.', 'No real model, external tools, user data, or packaged app were exercised.'] };
  await rm(path.join(artifactRoot, 'failure.json'), { force: true });
  await rm(path.join(artifactRoot, 'failure.png'), { force: true });
  await writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  if (page) { try { await screenshot('failure.png'); } catch { /* Preserve the original failure. */ } }
  await writeFile(path.join(artifactRoot, 'failure.json'), `${JSON.stringify({ currentCheck, checks, screenshots, temporaryRoot, error: String(error) }, null, 2)}\n`);
  throw error;
} finally { await application?.close(); }
