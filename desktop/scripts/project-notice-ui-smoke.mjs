import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Production Electron/preload/renderer with test-process-only IPC responses.
// Only synthetic metadata and temporary draft storage; no native chooser, key, model or Agent.
const desktopRoot = process.cwd();
const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-project-notices-'));
const preview = path.join(temporary, 'preview'), home = path.join(temporary, 'home');
const artifacts = path.join(desktopRoot, 'artifacts', 'project-notice-ui-smoke');
for (const directory of [home, preview, artifacts, path.join(temporary, 'tmp')]) await mkdir(directory, { recursive: true });
const launchEnv = {
  HOME: home,
  PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  TMPDIR: path.join(temporary, 'tmp'), TEMP: path.join(temporary, 'tmp'), TMP: path.join(temporary, 'tmp'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  SCREENDECK_PREVIEW_ROOT: preview, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects'),
};
for (const name of ['LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) {
  if (process.env[name] !== undefined) launchEnv[name] = process.env[name];
}
const timestamp = '2026-10-19T00:00:00.000Z';
const message = '项目记录暂时无法读取，请重新选择项目。';
const sourceA = 'a'.repeat(64), sourceB = 'b'.repeat(64), sourceC = 'c'.repeat(64);
const issue = (sourceID, label) => ({ sourceID, label, code: 'missing_source', message });
const warnings = [issue(sourceA, '合成来源甲'), issue(sourceB, '合成来源乙')];
const projectA = 'project-12345678-1234-1234-1234-123456789abc';
const projectB = 'project-22345678-1234-1234-1234-123456789abc';
const task = {
  schema_version: 1, kind: 'task', project_id: projectA, task_id: 'task-001', title: '合成只读任务', goal: '只测试项目提示。',
  status: 'draft', plan_version: 1, assignee: 'human', created_at: timestamp, updated_at: timestamp,
  run_ids: [], acceptance: [], references: [], historical: true, is_live: false,
};
const workspace = (id = projectA, empty = false) => ({
  status: empty ? 'empty' : 'ready',
  project: { schema_version: 2, kind: 'project', project_id: id, name: id === projectA ? '合成项目甲' : '合成项目乙',
    root_path: path.join(temporary, id), created_at: timestamp, history_bound: true, readonly: true },
  tasks: empty ? [] : [{ ...task, project_id: id }], runs: [], artifact_refs: [], diagnostics: [], loaded_at: timestamp, historical: true,
});
const failedWorkspace = { status: 'error', project: null, tasks: [], runs: [], artifact_refs: [],
  diagnostics: [{ code: 'missing_source', severity: 'error', path: '合成目录', message }], loaded_at: null, historical: true };
const modelID = randomUUID(), turnID = randomUUID();
const model = {
  schema_version: 1, conversation_id: modelID, title: '项目提示隔离聊天',
  scope: { kind: 'project', project_id: projectA }, created_at: timestamp, updated_at: timestamp, revision: 1,
  turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'offline-model' },
    state: 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }],
  messages: ['user', 'assistant'].map((role, index) => ({ message_id: randomUUID(), turn_id: turnID, role,
    text: index ? '合成回复，不是模型调用。' : '合成历史问题。', created_at: timestamp, updated_at: timestamp })),
};
const settingsDiagnostic = '合成配置诊断：模型连接暂不可用。';
const historyDiagnostic = '合成聊天诊断：一条本地记录暂不可读。';
const fixture = (options = {}) => ({
  settings: { baseURL: 'https://project-notice.invalid/v1', modelID: 'offline-model', hasKey: false, credentialStorage: 'none' },
  sessions: [model], agentSessions: [], taskSessions: [], chatPreferences: { revision: 0, entries: {} },
  projects: options.projects ?? [], plans: [], diagnostics: options.diagnostics ?? [],
  projectDiagnostics: options.projectDiagnostics ?? [], dataRootLabel: '临时项目提示隔离测试',
});
const checks = [], screenshots = [], pageErrors = [];
let application, page;
const composer = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const notices = () => page.getByTestId('project-notices');
const operations = () => page.getByTestId('project-operation-notice');
const warning = sourceID => notices().locator(`[data-source-id="${sourceID}"]`);
const chatRow = () => page.locator('.session-button').filter({ hasText: model.title });
const check = async (name, operation) => { console.log('CHECK ' + name); await operation(); checks.push(name); console.log('PASS ' + name); };
const snapshot = () => application.evaluate(() => {
  const state = globalThis.__projectNoticeFixture;
  return { counts: { ...state.counts }, pendingChoose: !!state.pendingChoose, pendingRefresh: !!state.pendingRefresh };
});
async function reset(data) {
  await application.evaluate((_electron, next) => {
    const state = globalThis.__projectNoticeFixture;
    if (state.pendingChoose || state.pendingRefresh) throw new Error('Previous synthetic operation is still pending.');
    state.fixture = next; state.nextChoose = undefined; state.nextRefresh = undefined;
  }, data);
  await page.reload();
  await expect(composer()).toBeVisible();
  await expect(chatRow()).toBeVisible();
}
async function tasks() {
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务', exact: true })).toBeVisible();
}
async function openChat(draft) {
  await chatRow().click();
  await expect(page.locator('.topbar-title')).toHaveText(model.title);
  await expect(page.locator('.messages > .message')).toHaveCount(2);
  if (draft !== undefined) await composer().fill(draft);
}
async function prepare(kind, action) {
  await application.evaluate((_electron, data) => { globalThis.__projectNoticeFixture[data.kind === 'choose' ? 'nextChoose' : 'nextRefresh'] = data.action; }, { kind, action });
}
async function release(kind, action) {
  await application.evaluate((_electron, data) => {
    const state = globalThis.__projectNoticeFixture, key = data.kind === 'choose' ? 'pendingChoose' : 'pendingRefresh';
    const pending = state[key]; if (!pending) throw new Error('No held synthetic operation.');
    state[key] = undefined;
    try { pending.resolve(state.finish(data.action)); } catch (error) { pending.reject(error); }
  }, { kind, action });
}
async function publish(diagnostics, ordinaryMessage) {
  await application.evaluate(({ BrowserWindow }, data) => {
    const state = globalThis.__projectNoticeFixture;
    if (data.diagnostics !== undefined) { state.fixture.projectDiagnostics = data.diagnostics; state.broadcast({ type: 'project-diagnostics-updated', diagnostics: data.diagnostics }); }
    if (data.ordinaryMessage) for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', { type: 'diagnostic', message: data.ordinaryMessage });
  }, { diagnostics, ordinaryMessage });
}
async function assertChat(draft, ordinaryMessage) {
  await expect(page.locator('.topbar-title')).toHaveText(model.title);
  await expect(composer()).toHaveValue(draft);
  await expect(notices()).toHaveCount(0); await expect(operations()).toHaveCount(0);
  await expect(page.locator('#center-column')).not.toContainText(message);
  if (ordinaryMessage) await expect(page.locator('.global-notice')).toContainText(ordinaryMessage);
}
async function screenshot(name) { await page.screenshot({ path: path.join(artifacts, name) }); screenshots.push(name); }
try {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30000 });
  const isolated = await application.evaluate(({ app }) => ({ home: process.env.HOME, userData: app.getPath('userData') }));
  assert.equal(isolated.home, home); assert.equal(isolated.userData, path.join(preview, 'electron-host'));
  page = await application.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await expect(composer()).toBeVisible();
  await application.evaluate(({ ipcMain, net, session, BrowserWindow, dialog, shell }, initial) => {
    const state = globalThis.__projectNoticeFixture = { fixture: initial, counts: { network: 0, submissions: 0, agentStarts: 0, sessionsCreated: 0, nativeChoosers: 0, externalLinks: 0, previews: 0, choose: 0, refresh: 0 } };
    state.broadcast = event => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', event); };
    state.finish = action => {
      if (action.projectDiagnostics !== undefined) { state.fixture.projectDiagnostics = action.projectDiagnostics; state.broadcast({ type: 'project-diagnostics-updated', diagnostics: action.projectDiagnostics }); }
      if (action.kind === 'throw') throw new Error(action.message ?? '合成项目操作失败。');
      const result = action.value ?? null;
      if (result?.project) state.fixture.projects = [...state.fixture.projects.filter(item => item.project?.project_id !== result.project.project_id), result];
      return result;
    };
    const replace = (channel, operation) => { ipcMain.removeHandler('screendeck:' + channel); ipcMain.handle('screendeck:' + channel, operation); };
    const hold = async (kind, input) => {
      state.counts[kind]++;
      const action = state[kind === 'choose' ? 'nextChoose' : 'nextRefresh'];
      state[kind === 'choose' ? 'nextChoose' : 'nextRefresh'] = undefined;
      if (!action) throw new Error('Synthetic project operation was not explicitly prepared.');
      if (kind === 'refresh' && !state.fixture.projects.some(item => item.project?.project_id === input)) throw new Error('Unknown synthetic refresh target.');
      if (action.kind === 'hold') return new Promise((resolve, reject) => { state[kind === 'choose' ? 'pendingChoose' : 'pendingRefresh'] = { resolve, reject }; });
      return state.finish(action);
    };
    replace('bootstrap', () => state.fixture);
    replace('get-settings', () => state.fixture.settings);
    replace('agent-chat-sources', () => []);
    replace('load-session', (_event, id) => state.fixture.sessions.find(record => record.conversation_id === id));
    replace('choose-project', () => hold('choose'));
    replace('refresh-project', (_event, id) => hold('refresh', id));
    for (const channel of ['send-message', 'send-agent-message', 'request-execution-authorization', 'start-task-execution']) replace(channel, () => { state.counts.submissions++; throw new Error('No model or execution in project notice smoke.'); });
    for (const channel of ['create-session', 'create-agent-session']) replace(channel, () => { state.counts.sessionsCreated++; throw new Error('No new sessions in project notice smoke.'); });
    replace('start-opencode', () => { state.counts.agentStarts++; throw new Error('No Agent runtime in project notice smoke.'); });
    replace('preview-artifact', () => { state.counts.previews++; throw new Error('No project content in project notice smoke.'); });
    dialog.showOpenDialog = async () => { state.counts.nativeChoosers++; throw new Error('Native chooser must be replaced by synthetic IPC.'); };
    shell.openExternal = async () => { state.counts.externalLinks++; throw new Error('No external links in project notice smoke.'); };
    const protect = original => (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (/^https?:/i.test(url)) { state.counts.network++; throw new Error('No network in project notice smoke.'); }
      return original(input, ...args);
    };
    globalThis.fetch = protect(globalThis.fetch.bind(globalThis)); net.fetch = protect(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => { state.counts.network++; done({ cancel: true }); });
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 940);
  }, fixture());

  await check('first-use-empty-is-not-a-project-error', async () => {
    await reset(fixture()); await tasks();
    await expect(page.getByRole('heading', { name: '还没有可读取的任务', exact: true })).toBeVisible();
    await expect(notices().locator('[data-source-id]')).toHaveCount(0); await expect(operations()).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新选择项目', exact: true })).toHaveCount(0);
    await expect(page.locator('.global-notice')).toHaveCount(0);
  });
  await check('startup-project-warnings-stay-in-tasks-and-other-diagnostics-stay-global', async () => {
    await reset(fixture({ projectDiagnostics: warnings, diagnostics: [settingsDiagnostic, historyDiagnostic] }));
    await expect(page.locator('.global-notice')).toContainText(settingsDiagnostic); await expect(page.locator('.global-notice')).toContainText(historyDiagnostic);
    await expect(notices()).toHaveCount(0); await expect(page.locator('#center-column')).not.toContainText(message);
    await tasks(); await expect(notices().locator('[data-source-id]')).toHaveCount(2);
    for (const item of warnings) { await expect(warning(item.sourceID)).toContainText(item.label + '：' + message); await expect(warning(item.sourceID).getByRole('button', { name: '重新选择项目', exact: true })).toBeEnabled(); }
    const choose = warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true }); await choose.focus(); await expect(choose).toBeFocused();
    await screenshot('project-startup-tasks-1440.png');
  });
  await check('chooser-cancel-preserves-warnings-navigation-and-chat-draft', async () => {
    await publish(undefined, settingsDiagnostic);
    const before = await notices().textContent();
    await prepare('choose', { value: null }); await warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true }).click();
    await expect(warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true })).toBeEnabled();
    assert.equal(await notices().textContent(), before); await expect(page.locator('.topbar-title')).toHaveText('任务');
    await expect(page.locator('.global-notice')).toContainText(settingsDiagnostic);
    const draft = '  取消选择仍保留聊天草稿\n末尾空格  '; await openChat(draft);
    await publish(undefined, historyDiagnostic);
    await prepare('choose', { value: null }); await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.getByRole('button', { name: '添加项目', exact: true })).toBeEnabled(); await assertChat(draft, historyDiagnostic);
    await tasks(); assert.equal(await notices().textContent(), before);
  });
  await check('failed-selection-and-cancelled-retry-keep-tasks-only-recovery', async () => {
    const failures = [...warnings, issue(sourceC, '合成来源丙')];
    await publish(undefined, settingsDiagnostic);
    await prepare('choose', { value: failedWorkspace, projectDiagnostics: failures });
    await warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true }).click();
    await expect(warning(sourceC)).toContainText(message); await expect(operations()).toHaveCount(0);
    await expect(page.locator('.global-notice')).toContainText(settingsDiagnostic);
    await prepare('choose', { kind: 'throw', message: '合成目录选择失败。' });
    await warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true }).click();
    await expect(operations()).toContainText('无法选择项目：');
    await expect(page.locator('.global-notice')).toContainText(settingsDiagnostic);
    const before = await notices().textContent(); await prepare('choose', { value: null });
    await operations().getByRole('button', { name: '重新选择项目', exact: true }).click();
    await expect(operations().getByRole('button', { name: '重新选择项目', exact: true })).toBeEnabled(); assert.equal(await notices().textContent(), before);
    await expect(page.locator('.global-notice')).toContainText(settingsDiagnostic);
    await openChat('失败提示不进入聊天'); await assertChat('失败提示不进入聊天');
    await expect(page.locator('#center-column')).not.toContainText('无法选择项目：');
  });
  await check('successful-recovery-clears-only-the-selected-source-warning', async () => {
    await reset(fixture({ projectDiagnostics: warnings })); await tasks();
    await publish(undefined, historyDiagnostic);
    await prepare('choose', { value: workspace(), projectDiagnostics: [warnings[1]] });
    await warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true }).click();
    await expect(page.locator('.topbar-title')).toHaveText('合成项目甲'); await expect(warning(sourceA)).toHaveCount(0);
    await expect(warning(sourceB)).toContainText('合成来源乙'); await expect(operations()).toHaveCount(0);
    await expect(page.locator('.global-notice')).toContainText(historyDiagnostic);
    await screenshot('project-recovered-one-source-1440.png');
  });
  await check('late-chooser-success-failure-and-rejection-do-not-replace-newer-chat', async () => {
    for (const outcome of ['success', 'failure', 'throw']) {
      await reset(fixture({ projects: [workspace()], projectDiagnostics: warnings })); await tasks();
      await prepare('choose', { kind: 'hold' }); await warning(sourceA).getByRole('button', { name: '重新选择项目', exact: true }).click();
      await expect.poll(async () => (await snapshot()).pendingChoose).toBe(true);
      const draft = `  迟到选择 ${outcome}\n保留此输入  `, ordinary = `当前聊天配置提示：${outcome}。`;
      await openChat(draft); await publish(undefined, ordinary);
      await release('choose', outcome === 'success' ? { value: workspace(projectB, true), projectDiagnostics: [warnings[1]] }
        : outcome === 'failure' ? { value: failedWorkspace, projectDiagnostics: warnings } : { kind: 'throw', message: '迟到的合成选择失败。' });
      await expect(page.getByRole('button', { name: '添加项目', exact: true })).toBeEnabled(); await assertChat(draft, ordinary);
      await tasks();
      if (outcome === 'success') { await expect(warning(sourceA)).toHaveCount(0); await expect(warning(sourceB)).toBeVisible(); }
      else if (outcome === 'failure') await expect(warning(sourceA)).toBeVisible();
      else await expect(operations()).toContainText('无法选择项目：');
      await openChat(); await assertChat(draft);
    }
  });
  await check('late-refresh-of-same-project-success-stale-and-rejection-stay-out-of-chat', async () => {
    for (const outcome of ['success', 'stale', 'throw']) {
      await reset(fixture({ projects: [workspace()], projectDiagnostics: [warnings[1]] }));
      await page.locator('.project-button').filter({ hasText: '合成项目甲' }).click();
      await prepare('refresh', { kind: 'hold' }); await page.getByRole('button', { name: '刷新', exact: true }).click();
      await expect.poll(async () => (await snapshot()).pendingRefresh).toBe(true);
      const draft = `同项目刷新 ${outcome}\n聊天草稿不变`, ordinary = `当前聊天记录提示：${outcome}。`;
      await openChat(draft); await publish(undefined, ordinary);
      const stale = { ...workspace(), status: 'stale', diagnostics: failedWorkspace.diagnostics };
      await release('refresh', outcome === 'throw' ? { kind: 'throw', message: '迟到的合成刷新失败。' }
        : { value: outcome === 'stale' ? stale : workspace(), projectDiagnostics: outcome === 'stale' ? warnings : [warnings[1]] });
      await expect(page.getByRole('button', { name: '添加项目', exact: true })).toBeEnabled(); await assertChat(draft, ordinary);
      await page.locator('.project-button').filter({ hasText: '合成项目甲' }).click();
      if (outcome === 'throw') await expect(operations()).toContainText('项目刷新失败：');
      if (outcome === 'stale') { await expect(page.locator('#center-column')).toContainText('项目快照已过期'); await expect(warning(sourceA)).toContainText(message); }
      await openChat(); await assertChat(draft);
    }
  });
  await check('diagnostic-events-never-show-project-errors-on-chat-search-or-timeline', async () => {
    await reset(fixture({ projects: [workspace()] })); const draft = '项目事件更新不覆盖当前聊天'; await openChat(draft);
    await publish(warnings, settingsDiagnostic); await assertChat(draft, settingsDiagnostic);
    for (const name of ['搜索', '时间线']) {
      await page.getByRole('button', { name, exact: true }).click(); await publish([...warnings, issue(sourceC, '合成来源丙')]);
      await expect(notices()).toHaveCount(0); await expect(page.locator('#center-column')).not.toContainText(message);
      if (name === '搜索') { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '搜索聊天', exact: true })).toHaveCount(0); }
    }
    await tasks(); await expect(notices().locator('[data-source-id]')).toHaveCount(3);
    await openChat(); await assertChat(draft);
  });
  await check('ordinary-draft-survives-reload-and-all-model-agent-content-operations-stay-zero', async () => {
    const draft = '  真实临时草稿存储\n刷新页面后逐字保留  '; await composer().fill(draft);
    await expect.poll(() => page.evaluate(id => window.screendeck.loadDraft('session:' + id), modelID)).toBe(draft);
    await page.reload(); await expect(chatRow()).toBeVisible(); await openChat(); await assertChat(draft);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await screenshot('project-notice-clean-chat-1440.png');
    const state = await snapshot();
    for (const key of ['network', 'submissions', 'agentStarts', 'sessionsCreated', 'nativeChoosers', 'externalLinks', 'previews']) assert.equal(state.counts[key], 0, key + ' must remain zero');
    assert.equal(state.pendingChoose, false); assert.equal(state.pendingRefresh, false); assert.deepEqual(pageErrors, []);
  });
  const report = { checks, counts: (await snapshot()).counts, screenshots, temporary, artifacts,
    limitations: ['Synthetic IPC tests production renderer and preload; project-reader and main diagnostic mapping are covered separately.', 'No stale artifact is opened; reader tests retain the stale-preview refusal check.'] };
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  if (application) { const timer = setTimeout(() => application?.process().kill('SIGKILL'), 8000); await application.close().catch(() => {}); clearTimeout(timer); }
}
