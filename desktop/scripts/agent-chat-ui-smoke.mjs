import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Production main/preload/renderer with a generated Node SDK ACP agent. Nothing
// in this test starts a real OpenCode binary or calls a provider/model service.
const desktopRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-agent-chat-ui-'));
const previewRoot = path.join(temporaryRoot, 'preview'), privateRoot = path.join(temporaryRoot, 'private'), fixtureRoot = path.join(temporaryRoot, 'fixture');
const launchHome = path.join(temporaryRoot, 'home');
const artifactRoot = path.join(desktopRoot, 'artifacts', 'agent-chat-ui-smoke');
const binaryPath = path.join(fixtureRoot, 'node-acp-fixture.mjs');
const fixtureKey = 'agent-gui-only-synthetic-key', modelID = 'agent-gui-fixture-model';
const timestamp = '2026-10-14T00:00:00.000Z', ordinaryID = randomUUID(), ordinaryTurnID = randomUUID();
const ordinary = { schema_version: 1, conversation_id: ordinaryID, title: '普通聊天离线记录', scope: { kind: 'local_chat', local_chat_id: randomUUID() }, created_at: timestamp, updated_at: timestamp, revision: 1, turns: [{ turn_id: ordinaryTurnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'saved-offline-model' }, state: 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }], messages: ['user', 'assistant'].map((role, index) => ({ message_id: randomUUID(), turn_id: ordinaryTurnID, role, text: '离线普通聊天原文 ' + (index + 1), created_at: timestamp, updated_at: timestamp })) };
const ordinaryFile = path.join(previewRoot, 'sessions', '2026', '10', '14', ordinaryID + '.json');
for (const directory of [path.dirname(ordinaryFile), privateRoot, fixtureRoot, artifactRoot, launchHome]) await mkdir(directory, { recursive: true });
await writeFile(ordinaryFile, JSON.stringify(ordinary));
const ordinaryHash = createHash('sha256').update(await readFile(ordinaryFile)).digest('hex');
const sdkURL = pathToFileURL(path.join(desktopRoot, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')).href;
await writeFile(binaryPath, '#!' + process.execPath + '\n' + 'globalThis.__SCREENDECK_ACP_FIXTURE_SDK_URL = ' + JSON.stringify(sdkURL) + ';\n' + await readFile(path.join(desktopRoot, 'tests', 'fixtures', 'opencode-acp-ui-runtime.mjs'), 'utf8'), { mode: 0o700 });
const launchEnv = {};
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) launchEnv[name] = process.env[name];
Object.assign(launchEnv, { HOME: launchHome, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: privateRoot });
const checks = [], screenshots = [], appCounts = []; let application, page, currentCheck = 'launch', agentID, continuityID;
const check = async (name, operation) => { currentCheck = name; await operation(); checks.push(name); console.log('PASS ' + name); };
const counts = async () => { try { return JSON.parse(await readFile(path.join(fixtureRoot, 'runtime-counts.json'), 'utf8')); } catch { return { promptSubmissions: 0, sessionCreates: 0, acpStarts: 0, loadCalls: 0 }; } };
const screenshot = async filename => { await page.screenshot({ path: path.join(artifactRoot, filename) }); screenshots.push(filename); };
const composer = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const picker = () => page.getByRole('combobox', { name: '聊天来源', exact: true });
const load = () => page.evaluate(id => window.screendeck.loadAgentSession(id), agentID);
const waitState = state => expect.poll(async () => (await load())?.turns.at(-1)?.state, { timeout: 30_000 }).toBe(state);
const resize = async (width, height) => {
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
};
const noPrompt = async () => { const value = await counts(); assert.equal(value.promptSubmissions, 0); assert.equal(value.sessionCreates, 0); };
const start = async (manualChoose = false) => {
  await application.evaluate(({ dialog }, binaryPath) => { dialog.showOpenDialog = async () => { globalThis.__agentChatUICounts.chooserCalls++; return { canceled: false, filePaths: [binaryPath] }; }; }, binaryPath);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '设置', exact: true });
  await modal.getByRole('tab', { name: '编码工具', exact: true }).click();
  const chooserBefore = (await application.evaluate(() => globalThis.__agentChatUICounts)).chooserCalls;
  if (manualChoose) {
    await modal.getByTestId('opencode-binary-choose').click();
    await expect(modal.getByTestId('opencode-runtime-start')).toBeEnabled();
    const metadata = await counts();
    for (const key of ['versionChecks', 'configChecks', 'acpStarts', 'sessionCreates', 'promptSubmissions']) assert.equal(metadata[key] ?? 0, 0, `manual choice must not invoke ${key}`);
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
  }
  await modal.getByTestId('opencode-runtime-start').click();
  await expect(modal.getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0', { timeout: 30_000 });
  assert.equal((await application.evaluate(() => globalThis.__agentChatUICounts)).chooserCalls, chooserBefore + (manualChoose ? 1 : 0));
  await modal.getByRole('button', { name: '完成', exact: true }).click();
};
const launch = async () => {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
  application.process().stderr?.on('data', bytes => console.error('[electron] ' + String(bytes).replaceAll(fixtureKey, '[synthetic-key]').slice(0, 4096)));
  await application.evaluate(({ net, session, ipcMain }) => {
    globalThis.__agentChatUICounts = { chooserCalls: 0, httpAttempts: 0, ordinarySends: 0 };
    const wrap = original => (input, ...args) => { const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input)); if (['http:', 'https:'].includes(url.protocol)) { globalThis.__agentChatUICounts.httpAttempts++; throw new Error('Agent chat GUI fixture forbids HTTP.'); } return original(input, ...args); };
    globalThis.fetch = wrap(globalThis.fetch.bind(globalThis)); net.fetch = wrap(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { globalThis.__agentChatUICounts.httpAttempts++; callback({ cancel: true }); });
    globalThis.__installAgentChatGuard = () => { ipcMain.removeHandler('screendeck:send-message'); ipcMain.handle('screendeck:send-message', () => { globalThis.__agentChatUICounts.ordinarySends++; throw new Error('GUI smoke never sends ordinary model chat.'); }); };
  });
  page = await application.firstWindow({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  await application.evaluate(() => globalThis.__installAgentChatGuard());
  await resize(1440, 940);
  assert.deepEqual((await page.evaluate(() => window.screendeck.bootstrap())).sessions.find(value => value.conversation_id === ordinaryID), ordinary, 'the generated ordinary record must pass the real reader');
  page.setDefaultTimeout(15_000);
};
const sendText = async text => { await composer().fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
const openAgent = async () => { await page.locator('.session-button[data-chat-source="agent"]').first().click(); await expect(picker()).toHaveValue('agent'); };
const assertFit = async () => {
  const metrics = await page.evaluate(() => {
    const selectors = ['.composer', '.chat-source-select', '.agent-model-label', '.send-button'];
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1, rects: selectors.flatMap(selector => { const node = document.querySelector(selector); if (!node) return []; const rect = node.getBoundingClientRect(); return [{ selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }]; }) };
  });
  assert.equal(metrics.overflow, false); for (const rect of metrics.rects) { assert.ok(rect.left >= 0 && rect.right <= await page.evaluate(() => innerWidth) + 1, JSON.stringify(rect)); assert.ok(rect.top >= 0 && rect.bottom <= await page.evaluate(() => innerHeight) + 1, JSON.stringify(rect)); }
};

try {
  await launch();
  await check('default-model-source-and-two-column-empty-chat', async () => {
    await expect(picker()).toHaveValue('model'); await expect(composer()).toBeVisible();
    await expect(page.getByRole('button', { name: '展开右栏', exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
    assert.equal((await application.evaluate(() => globalThis.__agentChatUICounts)).chooserCalls, 0); await noPrompt();
  });
  await check('source-selection-is-readonly-and-not-ready-has-tools-settings-action', async () => {
    await composer().fill('模型新聊天草稿'); await picker().selectOption('agent');
    await expect(composer()).toHaveValue(''); await expect(page.getByText('OpenCode 尚未连接。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '打开编码工具设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(modal.getByRole('tab', { name: '编码工具', exact: true })).toHaveAttribute('aria-selected', 'true');
    await modal.getByRole('button', { name: '完成', exact: true }).click(); await noPrompt();
  });
  await check('new-drafts-are-separated-by-source-without-creating-session', async () => {
    await composer().fill('Agent 新聊天草稿'); await picker().selectOption('model'); await expect(composer()).toHaveValue('模型新聊天草稿');
    await picker().selectOption('agent'); await expect(composer()).toHaveValue('Agent 新聊天草稿');
    assert.equal((await page.evaluate(() => window.screendeck.bootstrap())).agentSessions.length, 0); await noPrompt();
  });
  await check('model-button-opens-model-settings-and-saving-does-not-start', async () => {
    await picker().selectOption('model'); await page.locator('.model-select').click();
    const modal = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(modal.getByRole('tab', { name: '模型服务', exact: true })).toHaveAttribute('aria-selected', 'true');
    await modal.getByLabel('API 地址', { exact: true }).fill('https://fixture.example/v1');
    await modal.getByLabel('模型名称', { exact: true }).fill(modelID); await modal.getByLabel('API 密钥', { exact: true }).fill(fixtureKey);
    await modal.getByLabel('记住 API 密钥', { exact: true }).uncheck(); await modal.getByRole('button', { name: '保存连接', exact: true }).click();
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' }); await noPrompt();
  });
  await check('explicit-start-verifies-connection-but-creates-no-native-chat', async () => {
    await start(true); await picker().selectOption('agent'); await expect(page.getByLabel('OpenCode 已绑定模型', { exact: true })).toHaveText(modelID);
    await expect(page.locator('.model-select')).toHaveCount(0); await expect(page.getByRole('button', { name: 'OpenCode 聊天暂不支持 Deck', exact: true })).toBeDisabled();
    const value = await counts(); assert.equal(value.controls.titleDisabled, true); assert.equal(value.controls.toolPolicyDenied, true); await noPrompt();
  });
  const firstText = '第一轮：只讨论合成目标。', secondText = '第二轮：继续上一轮的合成上下文。';
  await check('agent-send-does-not-use-direct-model-key-gate', async () => {
    // Narrow synthetic public event only: the main process still has the test key
    // and frozen runtime config. This exercises UI gating, not credential changes.
    const publicSettings = await page.evaluate(() => window.screendeck.getSettings());
    await application.evaluate(({ BrowserWindow }, settings) => BrowserWindow.getAllWindows()[0].webContents.send('screendeck:event', { type: 'settings-updated', settings: { ...settings, hasKey: false } }), publicSettings);
    await expect(page.locator('.composer-source-feedback')).toContainText('无工具文本');
    await sendText(firstText);
    await expect.poll(async () => (await page.evaluate(() => window.screendeck.bootstrap())).agentSessions.length).toBe(1);
    agentID = (await page.evaluate(() => window.screendeck.bootstrap())).agentSessions[0].conversation_id; continuityID = agentID;
    await waitState('finished'); await expect(composer()).toHaveValue('');
    await expect(page.locator('.message.assistant .message-header')).toContainText('OpenCode 回复');
  });
  await check('second-turn-reuses-one-native-session-and-sends-only-new-input', async () => {
    await sendText(secondText); await expect.poll(async () => (await load()).turns.length).toBe(2); await waitState('finished');
    const value = await counts(), record = await load(); assert.equal(value.sessionCreates, 1); assert.equal(value.promptSubmissions, 2);
    assert.deepEqual(value.prompts.map(value => value.text), [firstText, secondText]); assert.equal(new Set(value.prompts.map(value => value.sessionID)).size, 1);
    assert.equal(record.binding.externalSessionID, value.prompts[0].sessionID); assert.equal(record.messages.filter(value => value.role === 'assistant').length, 2);
    assert.equal(new Set(record.messages.map(value => value.message_id)).size, 4); await screenshot('agent-chat-two-turns-1440x940.png');
  });
  await check('failed-agent-record-write-can-be-retried-locally-without-resubmitting', async () => {
    const directory = path.join(previewRoot, 'agent-sessions-v1'), before = await counts();
    await chmod(directory, 0o500);
    try {
      await sendText('只验证本地落盘失败，不应投递。');
      await expect(page.getByRole('button', { name: '重试记录保存', exact: true })).toBeVisible();
      assert.equal((await counts()).promptSubmissions, before.promptSubmissions);
    } finally { await chmod(directory, 0o700); }
    await page.getByRole('button', { name: '重试记录保存', exact: true }).click();
    await expect(page.locator('.global-notice')).toContainText('本地记录已保存，请求没有重发。');
    const saved = JSON.parse(await readFile(path.join(directory, agentID + '.json'), 'utf8'));
    assert.equal(saved.turns.at(-1).state, 'failed'); assert.equal((await counts()).promptSubmissions, before.promptSubmissions);
  });
  await check('existing-source-switch-opens-new-chat-and-preserves-both-drafts-history', async () => {
    await composer().fill('现有 Agent 聊天未发送草稿'); await picker().selectOption('model'); await expect(composer()).toHaveValue('模型新聊天草稿');
    await expect(page.locator('.message')).toHaveCount(0); await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
    await page.getByRole('button', { name: ordinary.title, exact: true }).click(); await expect(picker()).toHaveValue('model'); await expect(page.locator('.messages')).toContainText('离线普通聊天原文 2');
    await composer().fill('普通记录未发送草稿'); await openAgent(); await expect(composer()).toHaveValue('现有 Agent 聊天未发送草稿');
    await expect(page.locator('.message')).toHaveCount(6); assert.equal((await counts()).promptSubmissions, 2); assert.equal((await load()).source.agentID, 'opencode');
  });
  await check('visible-stop-button-uses-agent-cancel-and-waits-for-explicit-receipt', async () => {
    await sendText('[fixture:hold] 验证界面停止'); await waitState('streaming');
    await page.getByRole('button', { name: '停止生成', exact: true }).click(); await waitState('cancelled');
    const value = await counts(); assert.equal(value.cancelNotifications, 1); assert.equal(value.cancelledResponses, 1);
    assert.equal((await application.evaluate(() => globalThis.__agentChatUICounts)).ordinarySends, 0);
  });
  await check('busy-source-lock-and-late-cancel-do-not-replace-other-chat-draft', async () => {
    await sendText('[fixture:hold] 合成取消测试'); await waitState('streaming'); await expect(picker()).toBeDisabled();
    await page.getByRole('button', { name: ordinary.title, exact: true }).click(); await composer().fill('晚到事件不能覆盖的普通草稿');
    await page.evaluate(id => window.screendeck.stopAgentGeneration(id), agentID); await waitState('cancelled');
    await expect(picker()).toHaveValue('model'); await expect(composer()).toHaveValue('晚到事件不能覆盖的普通草稿'); await expect(page.locator('.messages')).toContainText('离线普通聊天原文 2');
    const value = await counts(); assert.equal(value.cancelNotifications, 2); assert.equal(value.cancelledResponses, 2);
  });
  await check('narrow-source-picker-focus-and-composer-remain-visible', async () => {
    await openAgent(); await composer().fill('窄窗键盘操作草稿'); await resize(860, 780); await assertFit(); await picker().focus();
    await expect(picker()).toBeFocused(); const outline = await picker().evaluate(node => getComputedStyle(node).outlineWidth); assert.notEqual(outline, '0px');
    await picker().press('Tab'); await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeFocused();
    await screenshot('agent-chat-narrow-focus-860x780.png'); await resize(1440, 940);
  });
  await check('disconnect-stays-unknown-with-explicit-new-chat-and-no-auto-retry', async () => {
    await page.getByRole('button', { name: '新聊天', exact: true }).click(); await sendText('[fixture:disconnect] 合成断线测试');
    await expect.poll(async () => (await page.evaluate(() => window.screendeck.bootstrap())).agentSessions.length).toBe(2);
    agentID = (await page.evaluate(() => window.screendeck.bootstrap())).agentSessions.find(value => value.conversation_id !== continuityID).conversation_id; await waitState('unknown'); await expect(page.getByRole('button', { name: '新建 OpenCode 聊天', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled(); const before = await counts();
    await page.getByRole('button', { name: '新建 OpenCode 聊天', exact: true }).click(); await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
    assert.equal((await counts()).promptSubmissions, before.promptSubmissions); await openAgent(); await screenshot('agent-chat-unknown-1440x940.png');
  });
  await check('app-restart-loads-local-agent-history-without-native-load-or-replay', async () => {
    const before = await counts(); appCounts.push(await application.evaluate(() => globalThis.__agentChatUICounts)); await application.close(); application = undefined;
    await launch(); await openAgent(); await expect(page.locator('.messages')).toContainText('[fixture:disconnect] 合成断线测试'); await expect(page.getByRole('button', { name: '新建 OpenCode 聊天', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled(); const after = await counts();
    for (const key of ['sessionCreates', 'promptSubmissions', 'loadCalls', 'acpStarts']) assert.equal(after[key], before[key]);
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' }); await screenshot('agent-chat-restart-readonly-1440x940.png');
  });
  await check('reconnected-new-generation-does-not-rebind-old-agent-history', async () => {
    const modalOpen = page.getByRole('button', { name: '打开编码工具设置', exact: true }); await modalOpen.click();
    const modal = page.getByRole('dialog', { name: '设置', exact: true }); await modal.getByRole('tab', { name: '模型服务', exact: true }).click();
    await modal.getByLabel('API 密钥', { exact: true }).fill(fixtureKey); await modal.getByRole('button', { name: '保存连接', exact: true }).click(); await modal.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: firstText + '，OpenCode 聊天', exact: true }).click(); agentID = continuityID;
    const oldBinding = (await load()).binding, before = await counts(); await start();
    await expect(page.locator('.composer-source-feedback')).toContainText('之前的连接'); assert.deepEqual((await load()).binding, oldBinding);
    const after = await counts(); for (const key of ['sessionCreates', 'promptSubmissions', 'loadCalls']) assert.equal(after[key], before[key]);
    await page.getByRole('button', { name: '新建 OpenCode 聊天', exact: true }).click(); await composer().fill('新连接的新聊天草稿'); await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  });
  await check('eight-state-component-preview-has-token-styles-and-keyboard-focus', async () => {
    const previewPath = path.resolve(desktopRoot, '..', 'docs', 'design', 'assets', 'frontend', 'previews', 'ChatSourcePicker.preview.html');
    const waiting = application.waitForEvent('window');
    await application.evaluate(async ({ BrowserWindow }, filename) => { const preview = new BrowserWindow({ show: false, width: 980, height: 860, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } }); await preview.loadFile(filename); }, previewPath);
    const preview = await waiting; await expect(preview.locator('[data-preview-state]')).toHaveCount(8);
    await preview.locator('[data-preview-state="default"] select').focus(); await expect(preview.locator('[data-preview-state="default"] select')).toBeFocused();
    assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await preview.screenshot({ path: path.join(artifactRoot, 'chat-source-picker-eight-states.png') }); screenshots.push('chat-source-picker-eight-states.png'); await preview.close();
  });
  await check('public-data-is-secret-free-and-ordinary-history-is-unchanged', async () => {
    const data = await page.evaluate(async () => ({ bootstrap: await window.screendeck.bootstrap(), sources: await window.screendeck.getAgentSources(), status: await window.screendeck.getOpenCodeStatus(), settings: await window.screendeck.getSettings() }));
    assert.equal(JSON.stringify(data).includes(fixtureKey), false); assert.equal((await page.locator('body').innerText()).includes(fixtureKey), false);
    assert.deepEqual(data.bootstrap.sessions.find(value => value.conversation_id === ordinaryID), ordinary); assert.equal(createHash('sha256').update(await readFile(ordinaryFile)).digest('hex'), ordinaryHash);
    const value = await counts(); assert.equal(value.externalModelRequests, 0); assert.equal(value.loadCalls, 0); assert.deepEqual(value.protocolProblems, []); assert.equal(value.promptSubmissions, 5);
    appCounts.push(await application.evaluate(() => globalThis.__agentChatUICounts)); for (const value of appCounts) { assert.equal(value.httpAttempts, 0); assert.equal(value.ordinarySends, 0); }
  });
  const report = { agentChatUISmoke: 'passed', checks, screenshots, temporaryRoot, runtimeCounts: await counts(), appCounts, fixture: 'production main/preload/renderer with generated Node SDK 1.8 ACP v1 agent', limitations: ['No official OpenCode binary, model, tools or user data are used.', 'A narrow synthetic settings-updated event exercises the UI Agent credential gate without changing the actual frozen main runtime config.', 'HTTP and ordinary-send guards begin after Electron launch and initialization, respectively; counters cover smoke interactions.'] };
  await rm(path.join(artifactRoot, 'failure.json'), { force: true }); await rm(path.join(artifactRoot, 'failure.png'), { force: true });
  await writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) {
  if (page) try { await screenshot('failure.png'); } catch { /* retain first error */ }
  await writeFile(path.join(artifactRoot, 'failure.json'), JSON.stringify({ currentCheck, checks, screenshots, temporaryRoot, error: String(error).replaceAll(fixtureKey, '[fixture-key]') }, null, 2) + '\n'); throw error;
} finally { await application?.close(); }
