import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real main/preload/renderer and synthetic persisted histories/drafts. Streaming
// events and stop acknowledgements are fixture IPC, never an Agent/model process.
const desktopRoot = process.cwd();
const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-chat-surfaces-'));
const home = path.join(temporary, 'home'), preview = path.join(temporary, 'preview');
const artifacts = path.join(desktopRoot, 'artifacts', 'chat-surfaces-ui-smoke');
const timestamp = '2026-10-19T00:00:00.000Z';
const userText = '  用户第一行\n\n第二行保留末尾空格  \n';
const code = '  const value = "代码缩进";\n    return value;\nconst longValue = "' + 'x'.repeat(260) + '";';
const assistantText = '# 合成回复\n\n```typescript\n' + code + '\n```\n\n' + Array.from({ length: 32 }, (_, index) => `阅读段落 ${index + 1}：使用临时合成内容验证消息和输入区。`).join('\n\n')
  + '\n\n![仅显示替代文本](https://surfaces.invalid/never-load.png)\n<script>window.surfaceUnsafe=true</script>\n[仅显示链接文本](https://surfaces.invalid/no-navigation)\n';
function record(title, agent = false) {
  const turnID = randomUUID();
  return { schema_version: 1, conversation_id: randomUUID(), title, scope: { kind: 'local_chat', local_chat_id: randomUUID() },
    created_at: timestamp, updated_at: timestamp, revision: 1,
    turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'offline-surfaces-model' },
      state: agent ? 'unknown' : 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }],
    messages: ['user', 'assistant'].map((role, part) => ({ message_id: randomUUID(), turn_id: turnID, role, text: part ? assistantText : userText, created_at: timestamp, updated_at: timestamp })),
    ...(agent ? { kind: 'electron_agent_chat', source: { agentID: 'opencode', configDigest: 'a'.repeat(64) } } : {}) };
}
const model = record('消息输入区 · 模型聊天'), agent = record('消息输入区 · 旧 OpenCode', true);
const modelFile = path.join(preview, 'sessions', '2026', '10', '19', model.conversation_id + '.json');
const agentFile = path.join(preview, 'agent-sessions-v1', agent.conversation_id + '.json');
for (const directory of [home, artifacts, path.join(temporary, 'tmp'), path.dirname(modelFile), path.dirname(agentFile)]) await mkdir(directory, { recursive: true });
await writeFile(modelFile, JSON.stringify(model)); await writeFile(agentFile, JSON.stringify(agent));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const initialHashes = [await hash(modelFile), await hash(agentFile)];
const env = { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  TMPDIR: path.join(temporary, 'tmp'), TEMP: path.join(temporary, 'tmp'), TMP: path.join(temporary, 'tmp'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  SCREENDECK_PREVIEW_ROOT: preview, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects') };
for (const name of ['LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
const checks = [], screenshots = [], geometry = [], pageErrors = [];
let application, page, savedAgentDraft;
const composer = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const row = item => page.locator('.session-button').filter({ hasText: item.title });
const article = (item, role) => page.locator(`[data-message-id="${item.messages[role === 'user' ? 0 : 1].message_id}"]`);
const quote = (item, role) => article(item, role).getByRole('button', { name: role === 'user' ? '引用这条消息' : '引用这条回复', exact: true });
const expand = () => page.getByRole('button', { name: '展开输入框', exact: true });
const collapse = () => page.getByRole('button', { name: '收起输入框', exact: true });
const source = () => page.getByRole('combobox', { name: '聊天来源', exact: true });
const state = () => application.evaluate(() => {
  const test = globalThis.__chatSurfaces;
  return { counts: { ...test.counts }, clipboard: test.clipboard, modelStops: [...test.modelStops], agentStops: [...test.agentStops] };
});
const check = async (name, operation) => { console.log('CHECK ' + name); await operation(); checks.push(name); console.log('PASS ' + name); };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual} != ${expected}`);
async function screenshot(name) { await page.screenshot({ path: path.join(artifacts, name) }); screenshots.push(name); }
async function resize(width, height = 940) {
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}
async function publish(item, nextState) {
  await application.evaluate(({ BrowserWindow }, data) => {
    const test = globalThis.__chatSurfaces, key = data.agent ? 'agent' : 'model', previous = test[key];
    const next = { ...previous, revision: previous.revision + 1, turns: [{ ...previous.turns[0], state: data.state }] };
    test[key] = next;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', { type: data.agent ? 'agent-session-updated' : 'session-updated', session: next });
  }, { agent: !!item.kind, state: nextState });
}
async function fit(label) {
  const value = await page.evaluate(() => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
    const box = document.querySelector('.composer');
    return { messages: rect(document.querySelector('.messages')), composer: rect(box), viewport: { width: innerWidth, height: innerHeight },
      controls: [...box.querySelectorAll('button, select')].map(node => ({ label: node.getAttribute('aria-label') ?? node.title ?? node.textContent, ...rect(node) })),
      overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  near(value.messages.x, value.composer.x, label + ' content left'); near(value.messages.right, value.composer.right, label + ' content right');
  assert.equal(value.overflow, false);
  for (const control of value.controls) {
    assert.ok(control.x >= value.composer.x && control.right <= value.composer.right + 1, `${label}: ${control.label} fits width`);
    assert.ok(control.y >= value.composer.y && control.bottom <= value.composer.bottom + 1, `${label}: ${control.label} fits height`);
  }
  geometry.push({ label, ...value });
}
try {
  application = await electron.launch({ args: [desktopRoot], env, timeout: 30000 });
  const isolated = await application.evaluate(({ app }) => ({ home: process.env.HOME, userData: app.getPath('userData') }));
  assert.equal(isolated.home, home); assert.equal(isolated.userData, path.join(preview, 'electron-host'));
  page = await application.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message));
  await expect(row(model)).toBeVisible();
  const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  bootstrap.settings = { baseURL: 'https://surfaces.invalid/v1', modelID: 'synthetic-model-with-a-deliberately-long-visible-name-to-test-ellipsis', hasKey: false, credentialStorage: 'none' };
  await application.evaluate(({ BrowserWindow, ipcMain, clipboard, net, session, dialog, shell }, data) => {
    const test = globalThis.__chatSurfaces = { ...data, counts: { network: 0, submissions: 0, starts: 0, created: 0, clipboardWrites: 0, nativeChoosers: 0, externalLinks: 0 }, clipboard: '', modelStops: [], agentStops: [] };
    const replace = (channel, operation) => { ipcMain.removeHandler('screendeck:' + channel); ipcMain.handle('screendeck:' + channel, operation); };
    replace('bootstrap', () => test.bootstrap); replace('get-settings', () => test.bootstrap.settings);
    replace('agent-chat-sources', () => [{ agentID: 'opencode', name: 'OpenCode', protocol: 'acp', capabilities: { streaming: true, nativeContext: true, interrupt: true, resume: false, tools: false, approvals: false, modelSelection: false }, state: 'unavailable', reason: 'stopped' }]);
    for (const channel of ['send-message', 'send-agent-message', 'request-execution-authorization', 'start-task-execution']) replace(channel, () => { test.counts.submissions++; throw new Error('No submission in surfaces smoke.'); });
    for (const channel of ['create-session', 'create-agent-session']) replace(channel, () => { test.counts.created++; throw new Error('No new record in surfaces smoke.'); });
    replace('start-opencode', () => { test.counts.starts++; throw new Error('No Agent runtime in surfaces smoke.'); });
    for (const agent of [false, true]) replace(agent ? 'stop-agent-generation' : 'stop-generation', (_event, id) => {
      const key = agent ? 'agent' : 'model', previous = test[key];
      if (id !== previous.conversation_id) throw new Error('Stop sent to the wrong synthetic chat.');
      test[agent ? 'agentStops' : 'modelStops'].push(id);
      const next = { ...previous, revision: previous.revision + 1, turns: [{ ...previous.turns[0], state: 'cancelling' }] }; test[key] = next;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('screendeck:event', { type: agent ? 'agent-session-updated' : 'session-updated', session: next });
    });
    clipboard.writeText = text => { if (test.failCopy) { test.failCopy = false; throw new Error('Synthetic clipboard failure.'); } test.clipboard = text; test.counts.clipboardWrites++; };
    dialog.showOpenDialog = async () => { test.counts.nativeChoosers++; throw new Error('No native chooser in surfaces smoke.'); };
    shell.openExternal = async () => { test.counts.externalLinks++; throw new Error('No link navigation in surfaces smoke.'); };
    const protect = original => (value, ...args) => {
      const url = typeof value === 'string' ? value : value?.url ?? String(value);
      if (/^https?:/i.test(url)) { test.counts.network++; throw new Error('No network in surfaces smoke.'); }
      return original(value, ...args);
    };
    globalThis.fetch = protect(globalThis.fetch.bind(globalThis)); net.fetch = protect(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => { test.counts.network++; done({ cancel: true }); });
  }, { bootstrap, model, agent });
  await page.reload(); await expect(row(model)).toBeVisible(); await row(model).click();

  await check('message-and-composer-columns-align-with-long-content-at-wide-and-narrow-widths', async () => {
    for (const [width, height] of [[1440, 940], [860, 780]]) { await resize(width, height); await fit('model-' + width); }
    await resize(1440); await page.locator('#center-column > .center-content').evaluate(node => { node.scrollTop = 0; }); await screenshot('chat-surfaces-1440.png');
  });
  await check('message-actions-use-compact-icons-and-keep-code-copy-labels', async () => {
    for (const role of ['user', 'assistant']) {
      const actions = article(model, role).locator('.chat-message-actions');
      const buttons = actions.getByRole('button'); await expect(buttons).toHaveCount(2);
      const sizes = await buttons.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }));
      for (const [width, height] of sizes) { near(width, 28, 'action width'); near(height, 28, 'action height'); }
      const copy = actions.getByRole('button', {name: role === 'user' ? '复制用户消息' : '复制回复', exact: true});
      await expect(copy).toHaveAttribute('title', role === 'user' ? '复制用户消息' : '复制回复');
      await expect(copy.locator('.copy-button-label')).toBeHidden(); await expect(quote(model, role).locator('span')).toBeHidden();
      await quote(model, role).focus(); await expect(quote(model, role)).toBeFocused();
    }
    await expect(article(model, 'assistant').getByRole('button', {name: '复制代码', exact: true}).locator('.copy-button-label')).toBeVisible();
    await quote(model, 'assistant').scrollIntoViewIfNeeded(); await screenshot('message-actions-compact.png');
  });
  await check('quotes-append-original-whitespace-and-markdown-to-existing-draft-without-send', async () => {
    const before = '  已有草稿\n继续补充  '; await composer().fill(before);
    await quote(model, 'user').click(); await expect(composer()).toBeFocused();
    const withUser = await composer().inputValue(); assert.ok(withUser.startsWith(before));
    assert.ok(withUser.includes('>   用户第一行\n> \n> 第二行保留末尾空格  \n> '));
    await quote(model, 'assistant').click(); await expect(composer()).toBeFocused();
    const withReply = await composer().inputValue(); assert.ok(withReply.startsWith(withUser));
    const appended = withReply.slice(withUser.length).split('\n').filter(line => line.startsWith('> ')).map(line => line.slice(2)).join('\n');
    assert.equal(appended, assistantText); assert.equal((await state()).counts.submissions, 0);
    assert.equal(await hash(modelFile), initialHashes[0]);
  });
  await check('expanded-input-preserves-content-ime-newlines-and-real-draft-storage', async () => {
    const text = '  输入开始\n' + Array.from({ length: 70 }, (_, index) => `长输入第 ${index + 1} 行`).join('\n') + '\n尾部  ';
    await composer().fill(text); await expect.poll(() => composer().evaluate(node => node.clientHeight)).toBe(180);
    await expand().click(); await expect(collapse()).toBeVisible();
    await expect.poll(() => composer().evaluate(node => node.clientHeight)).toBe(360); await expect(composer()).toHaveValue(text);
    await composer().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }); await expect(composer()).toHaveValue(text);
    await collapse().click(); await expect.poll(() => composer().evaluate(node => node.clientHeight)).toBe(180); await expect(composer()).toHaveValue(text);
    await composer().fill('第一行'); await composer().press('End'); await composer().press('Shift+Enter'); await composer().press('x'); await expect(composer()).toHaveValue('第一行\nx');
    await expect.poll(() => page.evaluate(id => window.screendeck.loadDraft('session:' + id), model.conversation_id)).toBe('第一行\nx');
    assert.equal((await state()).counts.submissions, 0);
  });
  await check('message-code-copy-and-safe-markdown-remain-functional-in-new-actions', async () => {
    await expect(page.locator('.turn-receipt')).toHaveCount(0);
    await article(model, 'user').getByRole('button', { name: '复制用户消息', exact: true }).click(); assert.equal((await state()).clipboard, userText);
    await article(model, 'assistant').getByRole('button', { name: '复制回复', exact: true }).click(); assert.equal((await state()).clipboard, assistantText);
    await article(model, 'assistant').getByRole('button', { name: '复制代码', exact: true }).click(); assert.equal((await state()).clipboard, code);
    await expect(page.locator('.markdown img, .markdown script, .markdown a')).toHaveCount(0); assert.equal(await page.evaluate(() => window.surfaceUnsafe), undefined);
    await application.evaluate(() => { globalThis.__chatSurfaces.failCopy = true; });
    const copy = article(model, 'user').getByRole('button', { name: '复制用户消息', exact: true }); await copy.click(); await expect(copy).toHaveAttribute('data-copy-state', 'error');
    await copy.click(); await expect(copy).toHaveAttribute('data-copy-state', 'success'); assert.equal((await state()).clipboard, userText);
  });
  await check('agent-source-and-draft-remain-separate-and-quote-does-not-restart-it', async () => {
    await row(agent).click(); await expect(source()).toHaveValue('agent:opencode'); await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await composer().fill('Agent 原有草稿'); await quote(agent, 'user').click(); savedAgentDraft = await composer().inputValue();
    assert.ok(savedAgentDraft.startsWith('Agent 原有草稿')); assert.ok(savedAgentDraft.includes('>   用户第一行\n> \n> 第二行保留末尾空格  \n> '));
    await row(model).click(); await expect(composer()).toHaveValue('第一行\nx'); await expect(source()).toHaveValue('model');
    await row(agent).click(); await expect(composer()).toHaveValue(savedAgentDraft); await expect(source()).toHaveValue('agent:opencode');
    assert.equal((await state()).counts.starts, 0); assert.equal(await hash(agentFile), initialHashes[1]);
  });
  await check('streaming-and-cancelling-lock-source-and-route-stop-to-the-original-source', async () => {
    for (const item of [model, agent]) {
      await row(item).click(); await publish(item, 'streaming'); await expect(source()).toBeDisabled();
      for (const role of ['user', 'assistant']) await expect(article(item, role).locator('.chat-message-actions')).toHaveCount(0);
      await expect(page.locator('.turn-receipt')).toHaveCount(0);
      const stop = page.getByRole('button', { name: '停止生成', exact: true }); await expect(stop).toBeEnabled(); await stop.click();
      await expect(stop).toBeDisabled(); await expect(source()).toBeDisabled();
      for (const role of ['user', 'assistant']) await expect(article(item, role).locator('.chat-message-actions')).toHaveCount(0);
      await composer().dispatchEvent('keydown', { key: 'Enter', code: 'Enter' }); assert.equal((await state()).counts.submissions, 0);
      await publish(item, 'cancelled'); await expect(source()).toBeEnabled(); await expect(stop).toHaveCount(0);
      for (const role of ['user', 'assistant']) await expect(quote(item, role)).toBeEnabled();
      await expect(article(item, 'assistant').getByRole('button', { name: '复制回复', exact: true })).toBeEnabled();
      await expect(page.locator('.turn-receipt')).toHaveCount(0);
    }
    const stopped = await state(); assert.deepEqual(stopped.modelStops, [model.conversation_id]); assert.deepEqual(stopped.agentStops, [agent.conversation_id]);
  });
  await check('narrow-toolbar-actions-and-code-keep-keyboard-focus-and-fit-surface', async () => {
    await row(model).click(); await resize(860, 780); await page.emulateMedia({ reducedMotion: 'reduce' }); await fit('narrow-actions');
    await source().focus(); await expect(source()).toBeFocused(); await page.keyboard.press('Tab'); await expect(page.locator('.model-select')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(expand()).toBeFocused(); await expand().press('Enter'); await expect(collapse()).toBeVisible(); await collapse().click();
    await quote(model, 'assistant').focus(); await expect(quote(model, 'assistant')).toBeFocused();
    const codeBox = article(model, 'assistant').locator('[data-testid="markdown-code-block"] pre'); await codeBox.scrollIntoViewIfNeeded();
    assert.ok(await codeBox.evaluate(node => node.scrollWidth > node.clientWidth), 'Fixture must produce meaningful horizontal code scrolling.');
    await codeBox.evaluate(node => { node.scrollLeft = 120; window.surfaceCodeNode = node; });
    assert.ok(await codeBox.evaluate(node => node.scrollLeft > 0));
    await composer().fill('保存草稿也不重置代码块');
    await expect.poll(() => page.evaluate(id => window.screendeck.loadDraft('session:' + id), model.conversation_id)).toBe('保存草稿也不重置代码块');
    assert.equal(await codeBox.evaluate(node => node === window.surfaceCodeNode), true, 'Unchanged code block keeps its DOM during draft updates.');
    assert.ok(await codeBox.evaluate(node => node.scrollLeft > 0));
    await screenshot('chat-surfaces-860.png');
  });
  await check('short-window-expanded-input-and-quote-limit-keep-draft-and-controls-reachable', async () => {
    await resize(860, 600);
    const oversized = 'x'.repeat(64500); await composer().fill(oversized); await quote(model, 'assistant').click();
    await expect(composer()).toHaveValue(oversized); await expect(page.locator('.global-notice')).toContainText('原草稿已保留');
    await composer().fill(Array.from({ length: 70 }, (_, index) => `短窗长输入第 ${index + 1} 行`).join('\n'));
    await expand().click(); await expect(collapse()).toBeVisible(); await fit('short-expanded-notice');
    const visible = await page.locator('.composer-wrap').evaluate(node => {
      const box = node.getBoundingClientRect(); return box.y >= 0 && box.bottom <= innerHeight;
    }); assert.equal(visible, true, 'Expanded input and footer remain in the short viewport.');
    await screenshot('chat-surfaces-860-short-expanded.png'); await collapse().click();
    assert.equal((await state()).counts.submissions, 0);
  });
  await check('draft-reload-and-history-hashes-prove-no-implicit-send-or-rewrite', async () => {
    const draft = '  展开与引用之外仍保留的最终草稿\n末尾  '; await composer().fill(draft);
    await expect.poll(() => page.evaluate(id => window.screendeck.loadDraft('session:' + id), model.conversation_id)).toBe(draft);
    await page.reload(); await expect(row(model)).toBeVisible(); await row(model).click(); await expect(composer()).toHaveValue(draft);
    assert.equal(await page.evaluate(id => window.screendeck.loadDraft('agent-session:' + id), agent.conversation_id), savedAgentDraft);
    assert.deepEqual([await hash(modelFile), await hash(agentFile)], initialHashes); assert.deepEqual(pageErrors, []);
    const current = await state(); for (const key of ['network', 'submissions', 'starts', 'created', 'nativeChoosers', 'externalLinks']) assert.equal(current.counts[key], 0, key + ' must remain zero');
  });
  const report = { checks, screenshots, geometry, counts: (await state()).counts, temporary, artifacts,
    limitations: ['Stop acknowledgements are synthetic renderer fixtures, not runtime or cancellation integration evidence.', 'Clipboard writes are captured in this test process; the system clipboard is never read.'] };
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 5000 }).catch(() => {}); throw error; }
finally { if (application) { const timer = setTimeout(() => application?.process().kill('SIGKILL'), 8000); await application.close().catch(() => {}); clearTimeout(timer); } }
