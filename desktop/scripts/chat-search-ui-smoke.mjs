import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Built Electron/preload/renderer; synthetic, fixed IPC and temporary drafts only.
// Never read user histories, choose real files, load credentials, or start an Agent/model.
const desktopRoot = process.cwd();
const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-chat-search-'));
const home = path.join(temporary, 'home'), preview = path.join(temporary, 'preview');
const artifacts = path.join(desktopRoot, 'artifacts', 'chat-search-ui-smoke');
for (const directory of [home, preview, artifacts, path.join(temporary, 'tmp')]) await mkdir(directory, { recursive: true });
const env = {
  HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  TMPDIR: path.join(temporary, 'tmp'), TEMP: path.join(temporary, 'tmp'), TMP: path.join(temporary, 'tmp'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  SCREENDECK_PREVIEW_ROOT: preview, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects'),
};
for (const name of ['LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
const timestamp = '2026-10-19T00:00:00.000Z', projectID = `project-${randomUUID()}`;
const task = { schema_version: 1, kind: 'task', project_id: projectID, task_id: 'task-001', title: '合成搜索上下文任务',
  goal: '只验证浮窗保留当前任务与草稿。', status: 'draft', plan_version: 1, assignee: 'human', created_at: timestamp, updated_at: timestamp,
  run_ids: [], references: [], acceptance: [], historical: true, is_live: false };
const file = { reference_id: 'synthetic-search-context', project_id: projectID, owner_kind: 'task', owner_id: task.task_id,
  label: '搜索上下文.md', path: 'synthetic-search-context.md', source: 'project', preview_type: 'text' };
const workspace = { status: 'ready', project: { schema_version: 2, kind: 'project', project_id: projectID, name: '隔离搜索项目',
  root_path: path.join(temporary, 'synthetic-project'), created_at: timestamp, history_bound: true, readonly: true },
  tasks: [task], runs: [], artifact_refs: [file], diagnostics: [], loaded_at: timestamp, historical: true };
const plan = { schema_version: 1, kind: 'electron_preview_plan', id: randomUUID(), title: '搜索期间保留的计划', version: 1,
  created_at: timestamp, updated_at: timestamp, scope: { project_id: projectID, task_id: task.task_id },
  work_items: Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), title: `合成工作项 ${index + 1}`, kind: 'implementation',
    assignee: 'unassigned', expected_result: '合成结果，不执行。', dependencies: [], status: 'planned' })) };
function record(title, body, index, agent = false) {
  const id = randomUUID(), turnID = randomUUID(), date = new Date(Date.parse(timestamp) + (300 - index) * 60_000).toISOString();
  return { schema_version: 1, conversation_id: id, title,
    scope: index === 0 ? { kind: 'project', project_id: projectID, task_id: task.task_id } : { kind: 'local_chat', local_chat_id: randomUUID() },
    created_at: timestamp, updated_at: date, revision: 1,
    turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'offline-search-model' },
      state: agent ? 'unknown' : 'finished', created_at: timestamp, updated_at: date, draft_revision: 0 }],
    messages: ['user', 'assistant'].map((role, part) => ({ message_id: randomUUID(), turn_id: turnID, role,
      text: part ? body : '这是合成历史问题，不发送到模型。', created_at: timestamp, updated_at: date })),
    ...(agent ? { kind: 'electron_agent_chat', source: { agentID: 'opencode', configDigest: 'a'.repeat(64) } } : {}) };
}
const background = record('保留背景与任务的聊天', '正文 body-needle 命中。\n\n' + Array.from({ length: 85 }, (_, index) => `背景段落 ${index + 1}：验证打开搜索不会丢失阅读位置。`).join('\n\n'), 0);
const titleMatch = record('Quartz 标题中的关键词', '这份正文使用不同词句。', 1);
const agent = record('OpenCode 只读旧聊天', 'OpenCode 正文 body-needle 命中。', 2, true);
const archived = record('已归档的线索', '归档正文 body-needle 命中。', 3);
const longTitle = record('很长的聊天标题与完整可访问名称'.repeat(18), '宽窗与窄窗正文 wide-needle 命中。', 4);
const scrollRecords = Array.from({ length: 12 }, (_, index) => record(`窄窗滚动记录 ${index + 1}`, 'scroll-needle 只验证结果列表内部滚动，不发送到模型。', index + 5));
const records = [background, titleMatch, agent, archived, longTitle, ...scrollRecords];
const fixture = { settings: { baseURL: 'https://search-fixture.invalid/v1', modelID: 'offline-search-model', hasKey: false, credentialStorage: 'none' },
  sessions: records.filter(item => !item.kind), agentSessions: [agent], taskSessions: [], projects: [workspace], plans: [plan],
  chatPreferences: { revision: 1, entries: { [`model:${archived.conversation_id}`]: { archived: true } } },
  diagnostics: [], projectDiagnostics: [], dataRootLabel: '临时搜索浮窗测试' };
const checks = [], screenshots = [], pageErrors = [], motionMeasurements = [];
let application, page, frameBeforeSearch;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const dialog = () => page.getByRole('dialog', { name: '搜索聊天', exact: true });
const input = () => dialog().getByRole('searchbox', { name: '搜索聊天', exact: true });
const results = () => dialog().getByRole('listbox', { name: '聊天结果', exact: true }).getByRole('option');
const result = item => dialog().getByRole('option', { name: `聊天：${item.title}`, exact: true });
// CSS locators intentionally allow inspection of the inert background while the modal is open.
const composer = () => page.locator('textarea[aria-label="输入消息"]');
const row = item => page.locator(`.session-button[data-chat-source="${item.kind ? 'agent' : 'model'}"]`).filter({ hasText: item.title });
const source = () => page.locator('select[aria-label="聊天来源"]');
const panel = () => page.locator('.detail-panel');
const chatScroll = () => page.locator('#center-column > .center-content');
const fileScroll = () => panel().locator('.task-panel-body:not([hidden]) .file-content');
const count = () => application.evaluate(() => ({ ...globalThis.__chatSearchFixture.counts, pendingLoad: !!globalThis.__chatSearchFixture.pendingLoad }));
const check = async (name, operation) => { console.log('CHECK ' + name); await operation(); checks.push(name); console.log('PASS ' + name); };
async function screenshot(name) { await page.screenshot({ path: path.join(artifacts, name) }); screenshots.push(name); }
async function closeSearch() { await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0); }
async function openSearch() { await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(input()).toBeFocused(); }
async function settleEntry() {
  await dialog().evaluate(async node => {
    await Promise.allSettled(node.getAnimations().filter(animation => animation.effect?.target === node).map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
}
const fieldFrame = () => dialog().locator('.chat-search-field').evaluate(node => {
  const box = node.getBoundingClientRect(), parent = node.closest('.chat-search-modal').getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, bottom: box.bottom, fieldHeight: box.height,
    height: parent.height, modalTop: parent.top, modalBottom: parent.bottom, modalLeft: parent.left, modalRight: parent.right,
    viewportWidth: innerWidth, viewportHeight: innerHeight };
});
async function inputOnly() {
  await expect(input()).toBeVisible(); await expect(dialog().locator('.modal-header')).toHaveCount(0);
  await expect(dialog().getByRole('heading', { name: '搜索聊天', exact: true })).toHaveClass('visually-hidden');
  await expect(dialog().getByRole('button')).toHaveCount(0); await expect(dialog().getByRole('combobox')).toHaveCount(0); await expect(dialog().getByRole('checkbox')).toHaveCount(0);
  await expect(dialog().getByRole('listbox')).toHaveCount(0); await expect(dialog().locator('.chat-search-footer:visible, .chat-search-caption:visible, .chat-search-empty:visible')).toHaveCount(0);
}
const frame = () => page.evaluate(() => {
  const center = document.querySelector('#center-column > .center-content');
  const fileBody = document.querySelector('.detail-panel .task-panel-body:not([hidden]) .file-content');
  const selected = document.querySelector('.session-button.active');
  return { selected: selected?.textContent, source: selected?.getAttribute('data-chat-source'), draft: document.querySelector('textarea[aria-label="输入消息"]').value,
    title: document.querySelector('.topbar-title').textContent, chatMarker: center?.dataset.searchSmokeFrame, chatScroll: center?.scrollTop,
    panelHidden: document.querySelector('.detail-panel')?.hidden, tab: document.querySelector('.panel-tabs [aria-selected="true"]')?.textContent,
    fileMarker: fileBody?.dataset.searchSmokeFrame, fileScroll: fileBody?.scrollTop,
    planDraft: document.querySelector('.detail-panel input[aria-label="工作项 1 内容"]')?.value };
});
const near = (actual, expected, label, tolerance = 1.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
function assertTopFrame(value, label) {
  const narrow = value.viewportWidth <= 600, top = narrow ? 64 : 80, inset = narrow ? 12 : 24;
  near(value.x, value.viewportWidth / 2, label + ' horizontal viewport center');
  near(value.modalTop, top, label + ' modal top'); near(value.y, top + 31, label + ' input center');
  near(value.fieldHeight, 60, label + ' input height');
  assert.ok(value.modalLeft >= inset - 1 && value.modalRight <= value.viewportWidth - inset + 1, label + ' horizontal inset');
  assert.ok(value.modalBottom <= value.viewportHeight - inset + 1, label + ' bottom inset');
}
const searchTrigger = () => page.locator('.sidebar .nav-group button[aria-label="搜索"]');
const triggerCenter = () => searchTrigger().evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
async function captureNextMotion() {
  await page.evaluate(() => { const state = window.__searchMotionTest; state.last = undefined; state.target = undefined; state.capture = true; });
}
async function motionStart(origin, label) {
  const start = await dialog().evaluate(async node => {
    const animations = node.getAnimations().filter(animation => animation.effect?.target === node);
    if (animations.length !== 1) throw new Error(`Expected one dialog entrance animation, found ${animations.length}.`);
    animations[0].pause(); animations[0].currentTime = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
    const field = node.querySelector('.chat-search-field'), box = field.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, scale: box.width / field.offsetWidth, opacity: Number(getComputedStyle(node).opacity) };
  });
  near(start.x, origin.x, label + ' origin x'); near(start.y, origin.y, label + ' origin y');
  near(start.scale, .18, label + ' initial scale', .015); near(start.opacity, 0, label + ' initial opacity', .01);
  return start;
}
async function topAnchored(label, finish = true) {
  const end = await dialog().evaluate(async (node, shouldFinish) => {
    const animations = node.getAnimations().filter(animation => animation.effect?.target === node);
    if (shouldFinish) { for (const animation of animations) animation.finish(); await Promise.allSettled(animations.map(animation => animation.finished)); }
    await new Promise(resolve => requestAnimationFrame(resolve));
    const field = node.querySelector('.chat-search-field'), box = field.getBoundingClientRect(), parent = node.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, bottom: box.bottom, fieldHeight: box.height,
      height: parent.height, modalTop: parent.top, modalBottom: parent.bottom, modalLeft: parent.left, modalRight: parent.right,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      scale: box.width / field.offsetWidth, opacity: Number(getComputedStyle(node).opacity), active: node.getAnimations().filter(animation => ['running', 'paused'].includes(animation.playState)).length };
  }, finish);
  assertTopFrame(end, label + ' final frame');
  near(end.scale, 1, label + ' final scale', .01); near(end.opacity, 1, label + ' final opacity', .01); assert.equal(end.active, 0);
  return end;
}
try {
  application = await electron.launch({ args: [desktopRoot], env, timeout: 30000 });
  const isolation = await application.evaluate(({ app }) => ({ home: process.env.HOME, userData: app.getPath('userData') }));
  assert.equal(isolation.home, home); assert.equal(isolation.userData, path.join(preview, 'electron-host'));
  page = await application.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message));
  await expect(composer()).toBeVisible();
  await application.evaluate(({ BrowserWindow, ipcMain, net, session, dialog, shell }, data) => {
    const state = globalThis.__chatSearchFixture = { fixture: data, counts: { network: 0, submissions: 0, agentStarts: 0, sessionsCreated: 0, planWrites: 0, previews: 0, nativeChoosers: 0, externalLinks: 0, loads: 0 } };
    const replace = (channel, operation) => { ipcMain.removeHandler('screendeck:' + channel); ipcMain.handle('screendeck:' + channel, operation); };
    replace('bootstrap', () => state.fixture); replace('get-settings', () => state.fixture.settings);
    replace('agent-chat-sources', () => [{ agentID: 'opencode', name: 'OpenCode', state: 'unavailable', reason: 'stopped' }]);
    const load = async (_event, id) => {
      state.counts.loads++;
      const found = [...state.fixture.sessions, ...state.fixture.agentSessions].find(item => item.conversation_id === id);
      if (!found) throw new Error('Unknown synthetic chat.');
      if (state.holdLoadID === id) { state.holdLoadID = undefined; return new Promise(resolve => { state.pendingLoad = { resolve, record: found }; }); }
      return found;
    };
    replace('load-session', load); replace('load-agent-session', load);
    replace('preview-artifact', (_event, value) => {
      if (value.projectID !== data.projects[0].project.project_id || value.referenceID !== data.projects[0].artifact_refs[0].reference_id) throw new Error('Unknown synthetic artifact.');
      state.counts.previews++; const text = Array.from({ length: 130 }, (_, index) => `合成文件第 ${index + 1} 行，不读取真实内容。`).join('\n');
      return { type: 'text', reference_id: value.referenceID, label: '搜索上下文.md', text, byte_length: Buffer.byteLength(text), mime_type: 'text/plain' };
    });
    for (const channel of ['send-message', 'send-agent-message', 'request-execution-authorization', 'start-task-execution']) replace(channel, () => { state.counts.submissions++; throw new Error('Search never submits.'); });
    for (const channel of ['create-session', 'create-agent-session']) replace(channel, () => { state.counts.sessionsCreated++; throw new Error('New-chat UI must not persist before Send.'); });
    for (const channel of ['create-plan', 'save-plan']) replace(channel, () => { state.counts.planWrites++; throw new Error('Search must not save the plan.'); });
    replace('start-opencode', () => { state.counts.agentStarts++; throw new Error('No Agent runtime in search smoke.'); });
    dialog.showOpenDialog = async () => { state.counts.nativeChoosers++; throw new Error('No native file chooser.'); };
    shell.openExternal = async () => { state.counts.externalLinks++; throw new Error('No external link.'); };
    const protect = original => (value, ...args) => {
      const url = typeof value === 'string' ? value : value?.url ?? String(value);
      if (/^https?:/i.test(url)) { state.counts.network++; throw new Error('No network in search smoke.'); }
      return original(value, ...args);
    };
    globalThis.fetch = protect(globalThis.fetch.bind(globalThis)); net.fetch = protect(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => { state.counts.network++; done({ cancel: true }); });
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 940);
  }, fixture);
  await page.reload(); await expect(row(background)).toBeVisible();

  await check('recent-plus-prepares-source-specific-new-chat-without-writing-history', async () => {
    await expect(page.getByRole('button', { name: '新聊天', exact: true })).toBeVisible();
    const plus = page.getByRole('button', { name: '新建聊天', exact: true }); await expect(plus).toBeVisible();
    await row(background).click(); await composer().fill('模型旧聊天草稿'); await plus.click();
    await expect(composer()).toHaveValue(''); await expect(source()).toHaveValue('model'); await composer().fill('新建模型草稿');
    await row(background).click(); await expect(composer()).toHaveValue('模型旧聊天草稿');
    await row(agent).click(); await composer().fill('Agent 旧聊天草稿'); await plus.click();
    await expect(composer()).toHaveValue(''); await expect(source()).toHaveValue('agent'); await composer().fill('新建 Agent 草稿');
    await row(agent).click(); await expect(composer()).toHaveValue('Agent 旧聊天草稿'); await expect(source()).toHaveValue('agent');
    assert.equal((await count()).sessionsCreated, 0); assert.equal((await count()).submissions, 0);
  });
  await check('opening-search-preserves-body-draft-scroll-plan-and-file-tab', async () => {
    await row(background).click(); await composer().fill('  打开搜索仍保留这份草稿\n尾部空格  ');
    await page.getByRole('button', { name: '展开右栏', exact: true }).click();
    await panel().getByRole('tab', { name: '分工', exact: true }).click(); await panel().getByRole('button', { name: '编辑计划', exact: true }).click();
    await panel().getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('搜索前尚未保存的计划修改');
    await panel().getByRole('tab', { name: '概览', exact: true }).click(); await panel().locator('.task-material').filter({ hasText: file.label }).click();
    await expect(fileScroll()).toContainText('第 130 行');
    await fileScroll().evaluate(node => { node.dataset.searchSmokeFrame = 'file-kept'; node.scrollTop = 170; });
    await chatScroll().evaluate(node => { node.dataset.searchSmokeFrame = 'chat-kept'; node.scrollTop = 210; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
    frameBeforeSearch = await frame(); assert.ok(frameBeforeSearch.chatScroll > 0); assert.ok(frameBeforeSearch.fileScroll > 0);
    await openSearch(); await expect(input()).toHaveValue(''); await expect(page.locator('#app-shell')).toHaveAttribute('inert', '');
    assert.deepEqual(await frame(), frameBeforeSearch); await screenshot('chat-search-context-1440.png');
    await closeSearch(); assert.deepEqual(await frame(), frameBeforeSearch);
  });
  await check('escape-and-scrim-restore-trigger-focus-and-background', async () => {
    const trigger = page.getByRole('button', { name: '搜索', exact: true });
    for (const close of ['escape', 'scrim']) {
      await openSearch(); await input().fill('quartz');
      if (close === 'escape') await page.keyboard.press('Escape');
      else await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
      await expect(dialog()).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(page.locator('#app-shell')).not.toHaveAttribute('inert', '');
      assert.deepEqual(await frame(), frameBeforeSearch);
    }
  });
  await check('command-search-is-modal-traps-tab-and-blocks-background-shortcuts', async () => {
    await composer().focus(); await page.keyboard.press(mod + '+k'); await expect(input()).toBeFocused();
    await page.keyboard.press(mod + '+n'); await expect(dialog()).toBeVisible(); assert.deepEqual(await frame(), frameBeforeSearch);
    await page.keyboard.press(mod + '+l'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.chat-search-modal')), true);
    for (let index = 0; index < 13; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.chat-search-modal')), true); }
    for (let index = 0; index < 8; index++) { await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.chat-search-modal')), true); }
    await closeSearch(); await expect(composer()).toBeFocused(); assert.deepEqual(await frame(), frameBeforeSearch);
  });
  await check('input-only-empty-query-expands-all-source-and-archived-results-with-stable-anchor', async () => {
    await openSearch(); await settleEntry(); await inputOnly();
    const empty = await fieldFrame(), loads = (await count()).loads; assertTopFrame(empty, 'empty input'); near(empty.height, 62, 'input-only frame height');
    await input().press('Enter'); await expect(dialog()).toBeVisible(); await inputOnly(); assert.equal((await count()).loads, loads);
    await input().fill('   '); await input().press('Enter'); await inputOnly(); assert.equal((await count()).loads, loads);
    await input().fill('  qUaRtZ  '); await expect(results()).toHaveCount(1); await expect(result(titleMatch).locator('strong mark')).toHaveText('Quartz');
    const expanded = await fieldFrame(); assertTopFrame(expanded, 'expanded results'); near(expanded.x, empty.x, 'typing keeps input x'); near(expanded.y, empty.y, 'typing keeps input y'); near(expanded.modalTop, empty.modalTop, 'typing keeps modal top'); assert.ok(expanded.height > empty.height);
    const listTop = await dialog().getByRole('listbox', { name: '聊天结果', exact: true }).evaluate(node => node.getBoundingClientRect().top); assert.ok(listTop >= expanded.bottom - 1, 'Results grow below the input.');
    await input().fill('body-needle'); await expect(results()).toHaveCount(3); await expect(dialog().locator('.chat-search-snippet mark')).toHaveCount(3);
    await expect(result(background)).toContainText('模型聊天'); await expect(result(agent)).toContainText('OpenCode'); await expect(result(archived)).toContainText('已归档');
    await expect(dialog().getByRole('combobox')).toHaveCount(0); await expect(dialog().getByRole('checkbox')).toHaveCount(0);
    await input().fill(''); await inputOnly(); const cleared = await fieldFrame(); assertTopFrame(cleared, 'cleared input'); near(cleared.x, empty.x, 'clearing keeps input x'); near(cleared.y, empty.y, 'clearing keeps input y'); near(cleared.modalTop, empty.modalTop, 'clearing keeps modal top'); near(cleared.height, empty.height, 'clearing removes results height');
    await input().fill('   '); await inputOnly(); near((await fieldFrame()).height, empty.height, 'whitespace does not expand results');
    await input().fill('never-a-synthetic-match'); await expect(results()).toHaveCount(0); await expect(dialog().locator('.chat-search-empty')).toContainText('没有找到相关聊天');
    const noResults = await fieldFrame(); assertTopFrame(noResults, 'no-results frame'); near(noResults.x, empty.x, 'no-results input x'); near(noResults.y, empty.y, 'no-results input y'); near(noResults.modalTop, empty.modalTop, 'no-results modal top');
    await closeSearch(); assert.deepEqual(await frame(), frameBeforeSearch);
  });
  await check('keyboard-navigation-opens-original-message-and-ime-enter-does-not-select', async () => {
    await openSearch(); await input().fill('body-needle'); await expect(results()).toHaveCount(3);
    await input().press('ArrowDown'); await expect(result(agent)).toHaveAttribute('aria-selected', 'true');
    await input().press('ArrowUp'); await expect(result(background)).toHaveAttribute('aria-selected', 'true');
    await input().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }); await expect(dialog()).toBeVisible();
    await input().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 229 }); await expect(dialog()).toBeVisible();
    await input().dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, keyCode: 229 }); await expect(dialog()).toBeVisible();
    await input().press('Enter'); await expect(dialog()).toHaveCount(0);
    const hit = page.locator('[data-search-hit="true"]'); await expect(hit).toHaveAttribute('data-message-id', background.messages[1].message_id);
    await expect(hit).toBeFocused(); await expect(composer()).toHaveValue(frameBeforeSearch.draft); await expect(row(background)).toHaveClass(/active/);
  });
  await check('late-search-load-cannot-replace-newer-new-chat-or-its-draft', async () => {
    await application.evaluate((_electron, id) => { globalThis.__chatSearchFixture.holdLoadID = id; }, longTitle.conversation_id);
    await openSearch(); await input().fill('wide-needle'); await expect(results()).toHaveCount(1); await result(longTitle).click();
    await expect.poll(async () => (await count()).pendingLoad).toBe(true); await expect(dialog()).toHaveCount(0);
    await page.getByRole('button', { name: '新建聊天', exact: true }).click(); const draft = '迟到读取不能覆盖新的聊天草稿'; await composer().fill(draft);
    await application.evaluate(() => { const state = globalThis.__chatSearchFixture, pending = state.pendingLoad; state.pendingLoad = undefined; pending.resolve(pending.record); });
    await expect.poll(() => page.evaluate(() => window.screendeck.loadDraft('new-chat'))).toBe(draft);
    await expect(page.locator('.topbar-title')).toHaveText('新聊天'); await expect(composer()).toHaveValue(draft); await expect(page.locator('[data-search-hit="true"]')).toHaveCount(0);
    await expect(page.locator('.session-button.active')).toHaveCount(0); assert.equal((await count()).sessionsCreated, 0);
  });
  await check('narrow-long-title-modal-fits-and-keeps-keyboard-focus', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860, 780));
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([860, 780]); await page.emulateMedia({ reducedMotion: 'reduce' });
    await composer().focus(); await page.keyboard.press(mod + '+k'); await expect(input()).toBeFocused(); await input().fill('wide-needle');
    await expect(results()).toHaveCount(1); await expect(result(longTitle)).toHaveAttribute('aria-label', '聊天：' + longTitle.title);
    const fit = await dialog().evaluate(node => {
      const box = node.getBoundingClientRect(), child = node.querySelector('input[type="search"]').getBoundingClientRect();
      return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, inputLeft: child.x, inputRight: child.right,
        contentOverflow: node.scrollWidth > node.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assertTopFrame(await fieldFrame(), 'long-title frame'); assert.ok(fit.x >= 24 && fit.right <= 837 && fit.bottom <= 757); assert.ok(fit.inputLeft >= fit.x && fit.inputRight <= fit.right);
    assert.equal(fit.contentOverflow, false); assert.equal(fit.pageOverflow, false);
    for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.chat-search-modal')), true); }
    await screenshot('chat-search-long-title-860.png');
    const minimumSize = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0], minimum = window.getMinimumSize(); window.setMinimumSize(480, 480); return minimum;
    });
    try {
      for (const [width, height] of [[860, 600], [560, 600]]) {
        await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
        await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
        await input().fill(''); await inputOnly(); const empty = await fieldFrame(); assertTopFrame(empty, 'short-window empty ' + width);
        await input().fill('scroll-needle'); await expect(results()).toHaveCount(scrollRecords.length);
        const anchor = await fieldFrame(); assertTopFrame(anchor, 'short-window results ' + width); near(anchor.modalTop, empty.modalTop, 'narrow results keep modal top'); near(anchor.y, empty.y, 'narrow results keep input anchor');
        const list = dialog().getByRole('listbox', { name: '聊天结果', exact: true });
        assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight), 'Narrow fixture must exercise bounded result scrolling.');
        await list.evaluate(node => { node.scrollTop = 100; }); assert.ok(await list.evaluate(node => node.scrollTop > 0));
        const scrolled = await fieldFrame(); assertTopFrame(scrolled, 'scrolled results ' + width); near(scrolled.y, anchor.y, 'scrolling results keep input anchor'); near(scrolled.modalTop, anchor.modalTop, 'scrolling results keep modal top');
        await screenshot(`chat-search-bounded-results-${width}x${height}.png`);
        await input().fill(''); await inputOnly(); const cleared = await fieldFrame(); assertTopFrame(cleared, 'short-window cleared ' + width); near(cleared.y, anchor.y, 'narrow clearing keeps input anchor'); near(cleared.modalTop, anchor.modalTop, 'narrow clearing keeps modal top');
      }
      await closeSearch(); await expect(composer()).toBeFocused();
    } finally {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setMinimumSize(...size), minimumSize);
    }
  });
  // Hold only these four motion checks at creation time, so a slow test runner
  // cannot miss the 260ms effect. Production keyframes and all earlier checks stay intact.
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    const state = window.__searchMotionTest = { original, capture: false };
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args);
      if (state.capture && this.matches('.chat-search-modal')) { animation.pause(); animation.currentTime = 0; state.last = animation; state.target = this; }
      return animation;
    };
  });
  await check('motion-click-origin-and-final-top-anchor-at-wide-and-narrow-sizes', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const [width, height] of [[1440, 940], [860, 780]]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
      const origin = await triggerCenter(); await captureNextMotion(); await openSearch();
      const label = 'sidebar-click-' + width, start = await motionStart(origin, label), end = await topAnchored(label);
      motionMeasurements.push({ label, origin, start, end }); await screenshot(`chat-search-top-${width}.png`); await closeSearch();
      await expect(searchTrigger()).toBeFocused();
    }
  });
  await check('motion-command-k-uses-real-expanded-and-collapsed-sidebar-trigger', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 940));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440);
    for (const collapsed of [false, true]) {
      if (collapsed) await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
      const origin = await triggerCenter(); await composer().focus(); await captureNextMotion(); await page.keyboard.press(mod + '+k'); await expect(input()).toBeFocused();
      const label = collapsed ? 'command-k-collapsed' : 'command-k-expanded', start = await motionStart(origin, label), end = await topAnchored(label);
      motionMeasurements.push({ label, origin, start, end }); await closeSearch(); await expect(composer()).toBeFocused();
    }
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  });
  await check('motion-reduce-skips-entrance-and-live-preference-change-cancels-it', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await captureNextMotion(); await openSearch();
    assert.equal(await dialog().evaluate(node => node.getAnimations().length), 0);
    assert.equal(await page.evaluate(() => window.__searchMotionTest.last !== undefined), false);
    motionMeasurements.push({ label: 'reduce-initial', end: await topAnchored('reduce-initial', false) }); await closeSearch();
    await page.emulateMedia({ reducedMotion: 'no-preference' }); const origin = await triggerCenter(); await captureNextMotion(); await openSearch();
    const start = await motionStart(origin, 'reduce-during-entrance'); await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => window.__searchMotionTest.last.playState)).toBe('idle');
    assert.equal(await dialog().evaluate(node => node.getAnimations().length), 0); await expect(input()).toBeFocused();
    motionMeasurements.push({ label: 'reduce-during-entrance', origin, start, end: await topAnchored('reduce-during-entrance', false) });
    await closeSearch(); await expect(searchTrigger()).toBeFocused();
  });
  await check('motion-immediate-escape-cancels-and-reopen-preserves-draft-and-focus', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await composer().fill('动画中关闭仍保留草稿'); const before = await frame(), origin = await triggerCenter();
    await captureNextMotion(); await openSearch(); await motionStart(origin, 'escape-at-start'); await closeSearch();
    await expect(searchTrigger()).toBeFocused(); await expect(page.locator('#app-shell')).not.toHaveAttribute('inert', ''); assert.deepEqual(await frame(), before);
    await expect.poll(() => page.evaluate(() => window.__searchMotionTest.last.playState)).toBe('idle');
    assert.equal(await page.evaluate(() => window.__searchMotionTest.target.isConnected), false);
    await captureNextMotion(); await openSearch(); const start = await motionStart(origin, 'reopen-after-cancel'), end = await topAnchored('reopen-after-cancel');
    motionMeasurements.push({ label: 'reopen-after-cancel', origin, start, end });
    await closeSearch(); await expect(searchTrigger()).toBeFocused(); assert.deepEqual(await frame(), before);
    await page.evaluate(() => { Element.prototype.animate = window.__searchMotionTest.original; delete window.__searchMotionTest; });
  });
  await check('search-plus-and-results-never-start-runtime-or-write-history-or-plan', async () => {
    const state = await count();
    for (const key of ['network', 'submissions', 'agentStarts', 'sessionsCreated', 'planWrites', 'nativeChoosers', 'externalLinks']) assert.equal(state[key], 0, key + ' must remain zero');
    assert.equal(state.previews, 1); assert.equal(state.pendingLoad, false); assert.deepEqual(pageErrors, []);
    const unchanged = await application.evaluate(() => ({ sessions: globalThis.__chatSearchFixture.fixture.sessions, agents: globalThis.__chatSearchFixture.fixture.agentSessions, plans: globalThis.__chatSearchFixture.fixture.plans }));
    assert.deepEqual(unchanged.sessions, fixture.sessions); assert.deepEqual(unchanged.agents, fixture.agentSessions); assert.deepEqual(unchanged.plans, [plan]);
    assert.equal(await page.evaluate(id => window.screendeck.loadDraft('agent-session:' + id), agent.conversation_id), 'Agent 旧聊天草稿');
  });
  const report = { checks, counts: await count(), screenshots, motionMeasurements, temporary, artifacts,
    limitations: ['Synthetic fixed IPC verifies production renderer/preload and real temporary drafts; backend history/permission behavior is covered separately.'] };
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 5000 }).catch(() => {}); throw error; }
finally { if (application) { const timer = setTimeout(() => application?.process().kill('SIGKILL'), 8000); await application.close().catch(() => {}); clearTimeout(timer); } }
