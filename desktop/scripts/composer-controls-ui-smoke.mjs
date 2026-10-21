import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Production renderer/preload and real temporary histories/drafts. Public settings,
// runtime metadata and streaming/stop events are fixture IPC; no model or Agent runs.
const root = process.cwd(), temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-composer-controls-'));
const home = path.join(temporary, 'home'), preview = path.join(temporary, 'preview'), artifacts = path.join(root, 'artifacts', 'composer-controls-ui-smoke');
const timestamp = '2026-10-19T00:00:00.000Z', shortModel = 'short-model';
const longModel = 'synthetic-long-model-' + 'read-only-metadata-'.repeat(12);
function record(title, agent = false) {
  const turnID = randomUUID();
  return { schema_version: 1, conversation_id: randomUUID(), title, scope: { kind: 'local_chat', local_chat_id: randomUUID() }, created_at: timestamp, updated_at: timestamp, revision: 1,
    turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: agent ? 'previous-agent-bound-model' : shortModel }, state: agent ? 'unknown' : 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }],
    messages: ['user', 'assistant'].map((role, index) => ({ message_id: randomUUID(), turn_id: turnID, role, text: index ? '这是合成旧回复，不是本次模型输出。' : '这是合成旧输入。', created_at: timestamp, updated_at: timestamp })),
    ...(agent ? { kind: 'electron_agent_chat', source: { agentID: 'opencode', configDigest: 'a'.repeat(64) } } : {}) };
}
const model = record('图标控件模型记录'), agent = record('图标控件旧 Agent', true);
const modelFile = path.join(preview, 'sessions', '2026', '10', '19', model.conversation_id + '.json'), agentFile = path.join(preview, 'agent-sessions-v1', agent.conversation_id + '.json');
for (const directory of [home, artifacts, path.join(temporary, 'tmp'), path.dirname(modelFile), path.dirname(agentFile)]) await mkdir(directory, { recursive: true });
await writeFile(modelFile, JSON.stringify(model)); await writeFile(agentFile, JSON.stringify(agent));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex'), initialHashes = [await hash(modelFile), await hash(agentFile)];
const env = { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  TMPDIR: path.join(temporary, 'tmp'), TEMP: path.join(temporary, 'tmp'), TMP: path.join(temporary, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  SCREENDECK_PREVIEW_ROOT: preview, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects') };
for (const name of ['LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
const checks = [], screenshots = [], pageErrors = [];
let application, page;
const composer = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const source = () => page.getByRole('combobox', { name: '聊天来源', exact: true });
const modelButton = () => page.getByRole('button', { name: '模型设置', exact: true });
const agentButton = () => page.getByRole('button', { name: 'Agent 设置', exact: true });
const settings = () => page.getByRole('dialog', { name: '设置', exact: true });
const row = item => page.locator('.session-button').filter({ hasText: item.title });
const counts = () => application.evaluate(() => ({ ...globalThis.__composerControls.counts, stops: [...globalThis.__composerControls.stops] }));
const check = async (name, operation) => { console.log('CHECK ' + name); await operation(); checks.push(name); console.log('PASS ' + name); };
async function screenshot(name) { await page.screenshot({ path: path.join(artifacts, name) }); screenshots.push(name); }
async function publicModel(modelID) {
  await application.evaluate(({ BrowserWindow }, modelID) => {
    const state = globalThis.__composerControls; state.bootstrap.settings = { ...state.bootstrap.settings, modelID };
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', { type: 'settings-updated', settings: state.bootstrap.settings });
  }, modelID);
}
async function publish(item, state) {
  await application.evaluate(({ BrowserWindow }, data) => {
    const test = globalThis.__composerControls, key = data.agent ? 'agent' : 'model', old = test[key];
    const next = { ...old, revision: old.revision + 1, turns: [{ ...old.turns[0], state: data.state }] }; test[key] = next;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', { type: data.agent ? 'agent-session-updated' : 'session-updated', session: next });
  }, { agent: !!item.kind, state });
}
async function assertTextToolbar() {
  await expect(page.locator('#composer-keyboard-hint, .composer-help')).toHaveCount(0);
  assert.ok(!(await composer().getAttribute('aria-describedby') ?? '').split(/\s+/).includes('composer-keyboard-hint'));
  const selected = await source().inputValue();
  await expect(source().locator('option:checked')).toHaveText(selected === 'agent' ? 'OpenCode' : '直接模型');
  const nativeStyle = await source().evaluate(node => { const style = getComputedStyle(node); return { opacity: Number(style.opacity), color: style.color }; });
  assert.equal(nativeStyle.opacity, 1); assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(nativeStyle.color), 'Selected source text is visible.');
  const button = selected === 'agent' ? agentButton() : modelButton(); await expect(button).toBeVisible();
  assert.ok((await button.innerText()).trim().length > 0, 'The settings button displays its model or connection text.');
  const controls = await page.locator('.composer').evaluate(node => [...node.querySelectorAll('.chat-source-select, .model-select, .send-button, .composer-expand')].map(control => {
    const box = control.getBoundingClientRect(); return { name: control.getAttribute('aria-label'), width: box.width, height: box.height };
  }));
  assert.equal(controls.length, 4);
  for (const control of controls) assert.ok(Math.abs(control.height - 32) <= 1, `${control.name} remains a 32px desktop control.`);
  for (const control of controls.filter(control => ['发送消息', '停止生成', '展开输入框', '收起输入框'].includes(control.name))) assert.ok(Math.abs(control.width - 32) <= 1, `${control.name} keeps its 32px square target.`);
  const sourceBox = controls.find(control => control.name === '聊天来源'); assert.ok(sourceBox.width >= 96 && sourceBox.width <= 128, 'Source stays a compact text dropdown.');
  const modelBox = controls.find(control => ['模型设置', 'Agent 设置'].includes(control.name)); assert.ok(modelBox.width <= 181, 'Model text never expands past its bounded width.');
}
try {
  application = await electron.launch({ args: [root], env, timeout: 30000 });
  const isolation = await application.evaluate(({ app }) => ({ home: process.env.HOME, userData: app.getPath('userData') }));
  assert.equal(isolation.home, home); assert.equal(isolation.userData, path.join(preview, 'electron-host'));
  page = await application.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message));
  await expect(row(model)).toBeVisible(); const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  bootstrap.settings = { baseURL: 'https://composer-fixture.invalid/v1', modelID: shortModel, hasKey: false, credentialStorage: 'none' };
  await application.evaluate(({ BrowserWindow, ipcMain, net, session, dialog, shell }, data) => {
    const test = globalThis.__composerControls = { ...data, counts: { network: 0, submits: 0, starts: 0, creates: 0, nativeChoosers: 0, externalLinks: 0 }, stops: [] };
    const replace = (channel, operation) => { ipcMain.removeHandler('screendeck:' + channel); ipcMain.handle('screendeck:' + channel, operation); };
    replace('bootstrap', () => test.bootstrap); replace('get-settings', () => test.bootstrap.settings);
    replace('agent-chat-sources', () => [{ agentID: 'opencode', name: 'OpenCode', state: 'unavailable', reason: 'stopped' }]);
    replace('opencode-status', () => ({ state: 'stopped' })); replace('opencode-installation', () => ({ candidates: [] }));
    for (const channel of ['send-message', 'send-agent-message', 'request-execution-authorization', 'start-task-execution']) replace(channel, () => { test.counts.submits++; throw new Error('Icon controls never submit.'); });
    for (const channel of ['create-session', 'create-agent-session']) replace(channel, () => { test.counts.creates++; throw new Error('Source selection never creates records.'); });
    replace('start-opencode', () => { test.counts.starts++; throw new Error('Settings opening never starts a runtime.'); });
    for (const agent of [false, true]) replace(agent ? 'stop-agent-generation' : 'stop-generation', (_event, id) => {
      const key = agent ? 'agent' : 'model', old = test[key]; if (id !== old.conversation_id) throw new Error('Wrong source stop.');
      test.stops.push({ source: key, id }); const next = { ...old, revision: old.revision + 1, turns: [{ ...old.turns[0], state: 'cancelling' }] }; test[key] = next;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', { type: agent ? 'agent-session-updated' : 'session-updated', session: next });
    });
    dialog.showOpenDialog = async () => { test.counts.nativeChoosers++; throw new Error('No native file chooser.'); };
    shell.openExternal = async () => { test.counts.externalLinks++; throw new Error('No external links.'); };
    const protect = original => (value, ...args) => {
      const url = typeof value === 'string' ? value : value?.url ?? String(value);
      if (/^https?:/i.test(url)) { test.counts.network++; throw new Error('No network in icon smoke.'); }
      return original(value, ...args);
    };
    globalThis.fetch = protect(globalThis.fetch.bind(globalThis)); net.fetch = protect(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => { test.counts.network++; done({ cancel: true }); });
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 940);
  }, { bootstrap, model, agent });
  await page.reload(); await expect(composer()).toBeVisible();

  await check('compact-text-toolbar-shows-source-and-model-with-bounded-long-label-and-full-title', async () => {
    await expect(source()).toHaveValue('model'); await assertTextToolbar(); await expect(modelButton()).toContainText(shortModel); await expect(modelButton()).toHaveAttribute('title', new RegExp(shortModel));
    assert.equal(await modelButton().locator('.model-select-label').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'A short model name remains fully visible.');
    await publicModel(longModel); await expect(modelButton()).toHaveAttribute('title', new RegExp(longModel)); await assertTextToolbar();
    const label = modelButton().locator('.model-select-label'); await expect(label).toHaveText(longModel);
    assert.equal(await label.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'), true, 'Long model text is clipped visually while retaining the complete tooltip.');
    await composer().fill('没有密钥时不能发送'); await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await composer().dispatchEvent('keydown', { key: 'Enter', code: 'Enter' }); assert.equal((await counts()).submits, 0);
    await screenshot('composer-dropdown-model-1440.png');
  });
  await check('native-source-hit-area-and-selection-preserve-both-drafts', async () => {
    await composer().fill('模型图标来源草稿');
    const hit = await source().evaluate(node => {
      const box = node.getBoundingClientRect();
      const points = [[4, 4], [box.width - 4, 4], [4, box.height - 4], [box.width - 4, box.height - 4], [box.width / 2, box.height / 2]];
      return { width: box.width, height: box.height, hit: points.every(([x, y]) => document.elementFromPoint(box.x + x, box.y + y) === node), opacity: Number(getComputedStyle(node).opacity) };
    });
    assert.ok(hit.width >= 96 && hit.width <= 128); assert.ok(Math.abs(hit.height - 32) <= 1); assert.equal(hit.hit, true); assert.equal(hit.opacity, 1);
    await source().click(); await page.keyboard.press('Escape'); await expect(source()).toBeFocused(); await source().selectOption('agent'); await expect(source()).toHaveValue('agent');
    await expect(composer()).toHaveValue(''); await expect(agentButton()).toContainText('未连接'); await assertTextToolbar(); await screenshot('composer-dropdown-agent-idle-1440.png'); await composer().fill('Agent 图标来源草稿');
    await source().focus(); await source().selectOption('model'); await expect(source()).toHaveValue('model'); await expect(composer()).toHaveValue('模型图标来源草稿');
    await source().click(); await page.keyboard.press('Escape'); await expect(source()).toBeFocused(); await source().selectOption('agent'); await expect(source()).toHaveValue('agent'); await expect(composer()).toHaveValue('Agent 图标来源草稿');
  });
  await check('model-text-opens-models-and-restores-focus-without-saving-or-starting', async () => {
    await source().focus(); await source().selectOption('model'); await expect(source()).toHaveValue('model');
    await modelButton().click(); await expect(settings().getByRole('tab', { name: '模型服务', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(settings().getByLabel('模型', { exact: true })).toHaveValue(longModel); await expect(settings().getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await page.keyboard.press('Escape'); await expect(settings()).toHaveCount(0); await expect(modelButton()).toBeFocused(); await expect(composer()).toHaveValue('模型图标来源草稿');
  });
  await check('old-agent-model-text-opens-settings-and-does-not-claim-ready-or-rebind', async () => {
    await row(agent).click(); await expect(source()).toHaveValue('agent'); await expect(agentButton()).toHaveAttribute('title', /previous-agent-bound-model/);
    await expect(agentButton()).toContainText('previous-agent-bound-model');
    await composer().fill('旧 Agent 仍不可发送'); await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await agentButton().click(); await expect(settings().getByRole('tab', { name: 'Agent 设置', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(settings().getByTestId('opencode-runtime-status')).toContainText('未启动');
    await page.keyboard.press('Escape'); await expect(settings()).toHaveCount(0); await expect(agentButton()).toBeFocused();
    await expect(composer()).toHaveValue('旧 Agent 仍不可发送'); await expect(agentButton()).toHaveAttribute('title', /previous-agent-bound-model/); await assertTextToolbar();
  });
  await check('streaming-source-lock-and-stop-remain-visible-and-route-to-the-original-source', async () => {
    for (const item of [model, agent]) {
      await row(item).click(); await publish(item, 'streaming'); await expect(source()).toBeDisabled();
      const stop = page.getByRole('button', { name: '停止生成', exact: true }); await expect(stop).toBeVisible(); await expect(stop).toBeEnabled(); await stop.click();
      await expect(stop).toBeDisabled(); await expect(source()).toBeDisabled(); await publish(item, 'cancelled'); await expect(source()).toBeEnabled();
    }
    assert.deepEqual((await counts()).stops, [{ source: 'model', id: model.conversation_id }, { source: 'agent', id: agent.conversation_id }]);
  });
  await check('normal-draft-status-is-silent-visually-and-failure-keeps-visible-retry', async () => {
    await row(model).click(); await composer().fill('正常草稿先成功保存');
    await expect.poll(() => page.evaluate(id => window.screendeck.loadDraft('session:' + id), model.conversation_id)).toBe('正常草稿先成功保存');
    const status = page.locator('.composer-draft-status'); await expect(status).toContainText('草稿已保存');
    assert.equal(await status.evaluate(node => { const box = node.getBoundingClientRect(); return box.width <= 2 && box.height <= 2; }), true);
    const directory = path.join(preview, 'local-state'); await chmod(directory, 0o500);
    try { await composer().fill('合成写入失败应显示重试'); await expect(page.getByRole('button', { name: '重试保存草稿', exact: true })).toBeVisible(); }
    finally { await chmod(directory, 0o700); }
    await page.getByRole('button', { name: '重试保存草稿', exact: true }).click();
    await expect.poll(() => page.evaluate(id => window.screendeck.loadDraft('session:' + id), model.conversation_id)).toBe('合成写入失败应显示重试');
    await expect(page.getByRole('button', { name: '重试保存草稿', exact: true })).toHaveCount(0); await assertTextToolbar();
  });
  await check('short-narrow-text-controls-keep-hit-targets-focus-order-and-fit-composer', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860, 600));
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([860, 600]); await page.emulateMedia({ reducedMotion: 'reduce' });
    await source().focus(); await expect(source()).toBeFocused(); await page.keyboard.press('Tab'); await expect(modelButton()).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: '展开输入框', exact: true })).toBeFocused();
    const fit = await page.locator('.composer').evaluate(node => {
      const outer = node.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, inside: [...node.querySelectorAll('button, select')].every(control => {
        const box = control.getBoundingClientRect(); return box.x >= outer.x && box.right <= outer.right + 1 && box.y >= outer.y && box.bottom <= outer.bottom + 1;
      }) };
    }); assert.equal(fit.overflow, false); assert.equal(fit.inside, true); await assertTextToolbar();
    await source().focus(); await screenshot('composer-dropdown-model-860x600.png');
    await source().selectOption('agent'); await expect(agentButton()).toContainText('未连接'); await assertTextToolbar();
    await screenshot('composer-dropdown-agent-idle-860x600.png'); await row(model).click();
  });
  await check('draft-reload-and-history-hashes-prove-controls-never-submit-or-rewrite-records', async () => {
    await expect(composer()).toHaveValue('合成写入失败应显示重试');
    const draft = await composer().inputValue(); await page.reload(); await expect(row(model)).toBeVisible(); await row(model).click(); await expect(composer()).toHaveValue(draft);
    assert.deepEqual([await hash(modelFile), await hash(agentFile)], initialHashes); assert.deepEqual(pageErrors, []);
    const current = await counts(); for (const key of ['network', 'submits', 'starts', 'creates', 'nativeChoosers', 'externalLinks']) assert.equal(current[key], 0, key + ' must remain zero');
    await screenshot('composer-dropdown-controls-clean.png');
  });
  const report = { checks, screenshots, counts: await counts(), temporary, artifacts, limitations: ['Runtime status and stop events are synthetic UI fixtures; this is not runtime cancellation evidence.', 'Native selection uses selectOption after mouse hit/focus checks; OS popup key handling is outside CDP automation.'] };
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 5000 }).catch(() => {}); throw error; }
finally { if (application) { const timer = setTimeout(() => application?.process().kill('SIGKILL'), 8000); await application.close().catch(() => {}); clearTimeout(timer); } }
