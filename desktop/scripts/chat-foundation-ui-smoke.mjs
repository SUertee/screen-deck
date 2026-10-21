import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real main/preload/renderer, isolated synthetic histories; no model or Agent runtime.
const root = process.cwd();
const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-chat-foundation-'));
const preview = path.join(temporary, 'preview'), home = path.join(temporary, 'home');
const timestamp = '2026-10-18T00:00:00.000Z';
const code = '  const value = "原样复制";\n    return value;';
const reply = '搜索命中：needle。\n\n```typescript\n' + code + '\n```\n\n' + Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}：用于验证阅读旧消息时保持滚动位置。\n`).join('\n') + '\n![remote](https://example.invalid/never-fetch.png)\n<script>window.untrusted=true</script>';
function record(title, agent = false) {
  const id = randomUUID(), turn = randomUUID();
  return { schema_version: 1, conversation_id: id, title, scope: { kind: 'local_chat', local_chat_id: randomUUID() }, created_at: timestamp, updated_at: timestamp, revision: 1, turns: [{ turn_id: turn, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'fixture-model' }, state: agent ? 'unknown' : 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }], messages: ['user', 'assistant'].map((role, i) => ({ message_id: randomUUID(), turn_id: turn, role, text: i ? reply : '  用户消息原文\n  保留缩进  ', created_at: timestamp, updated_at: timestamp })), ...(agent ? { kind: 'electron_agent_chat', source: { agentID: 'opencode', configDigest: 'a'.repeat(64) } } : {}) };
}
const model = record('日常模型聊天'), agent = record('旧连接 OpenCode', true);
const modelFile = path.join(preview, 'sessions', '2026', '10', '18', model.conversation_id + '.json');
const agentFile = path.join(preview, 'agent-sessions-v1', agent.conversation_id + '.json');
for (const dir of [path.dirname(modelFile), path.dirname(agentFile), home]) await mkdir(dir, { recursive: true });
await writeFile(modelFile, JSON.stringify(model)); await writeFile(agentFile, JSON.stringify(agent));
const env = { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: preview, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects') };
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
let application, page;
const checks = [];
const check = async (name, operation) => { console.log('CHECK ' + name); await operation(); checks.push(name); console.log('PASS ' + name); };
const composer = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const more = title => page.getByRole('button', { name: `聊天选项：${title}`, exact: true });
const row = title => page.locator('.session-button').filter({ hasText: title });
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function launch() {
  application = await electron.launch({ args: [root], env, timeout: 30000 });
  application.process().stderr?.on('data', chunk => { if (/Error|failed|Exception/.test(String(chunk))) console.error(String(chunk).slice(0, 2000)); });
  page = await application.firstWindow(); page.setDefaultTimeout(12000);
  await expect(page.locator('.session-button').first()).toBeVisible();
  await application.evaluate(({ clipboard, net, session, ipcMain }) => {
    globalThis.__chatFoundation = { clipboard: '', writes: 0, requests: 0, failedCopy: false };
    clipboard.writeText = text => { if (globalThis.__chatFoundation.failedCopy) throw new Error('synthetic clipboard failure'); globalThis.__chatFoundation.clipboard = text; globalThis.__chatFoundation.writes++; };
    const block = () => { globalThis.__chatFoundation.requests++; throw new Error('No network in chat foundation smoke'); };
    const protect = original => (input, ...args) => { const url = new URL(typeof input === 'string' ? input : input.url); if (['http:', 'https:'].includes(url.protocol)) return block(); return original(input, ...args); };
    globalThis.fetch = protect(globalThis.fetch.bind(globalThis)); net.fetch = protect(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, done) => { globalThis.__chatFoundation.requests++; done({ cancel: true }); });

  });
  await application.evaluate(({ ipcMain }) => { for (const channel of ['send-message', 'send-agent-message']) { ipcMain.removeHandler('screendeck:' + channel); ipcMain.handle('screendeck:' + channel, () => { globalThis.__chatFoundation.requests++; throw new Error('No model in UI smoke'); }); } });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 940));
}
const mainState = () => application.evaluate(() => globalThis.__chatFoundation);
try {
  await launch();
  await check('single-line-history-and-menu-keyboard-focus', async () => {
    await expect(page.locator('.session-button small')).toHaveCount(0);
    const options = more('日常模型聊天'); await row('日常模型聊天').hover(); await options.click();
    await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(options).toBeFocused();
  });
  await check('canonical-rename-with-frozen-turns-and-unchanged-other-source', async () => {
    await more('日常模型聊天').click(); await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名聊天' });
    await expect(dialog.getByRole('textbox', { name: '聊天名称' })).toBeFocused();
    await dialog.getByRole('textbox', { name: '聊天名称' }).fill('重命名后的聊天');
    await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(row('重命名后的聊天')).toBeVisible();
    const saved = JSON.parse(await readFile(modelFile)); assert.equal(saved.title, '重命名后的聊天'); assert.deepEqual(saved.turns, model.turns); assert.deepEqual(saved.messages, model.messages); assert.equal(saved.revision, 2);
    assert.deepEqual(JSON.parse(await readFile(agentFile)), agent);
  });
  await check('message-and-code-copy-preserve-source-and-report-failure', async () => {
    await row('重命名后的聊天').click();
    await page.getByRole('button', { name: '复制用户消息', exact: true }).click(); assert.equal((await mainState()).clipboard, model.messages[0].text);
    await page.getByRole('button', { name: '复制回复', exact: true }).click(); assert.equal((await mainState()).clipboard, reply);
    await page.getByRole('button', { name: '复制代码', exact: true }).click(); assert.equal((await mainState()).clipboard, code);
    await expect(page.locator('.markdown img, .markdown script')).toHaveCount(0); assert.equal(await page.evaluate(() => window.untrusted), undefined);
    await application.evaluate(() => { globalThis.__chatFoundation.failedCopy = true; });
    const copy = page.getByRole('button', { name: '复制用户消息', exact: true }); await copy.click();
    await expect(page.locator('[data-copy-state="error"]').first()).toBeVisible();
    await application.evaluate(() => { globalThis.__chatFoundation.failedCopy = false; });
    await page.getByRole('button', { name: /复制用户消息/ }).click();
    assert.equal((await mainState()).clipboard, model.messages[0].text);
  });
  await check('search-snippets-all-sources-and-message-anchor', async () => {
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '搜索聊天', exact: true }).getByRole('option')).toHaveCount(0);
    await page.getByRole('dialog', { name: '搜索聊天', exact: true }).locator('input[aria-label="搜索聊天"]').fill('  NeEdLe  ');
    await expect(page.locator('.chat-search-result')).toHaveCount(2); await expect(page.locator('.chat-search-snippet mark')).toHaveCount(2);
    await expect(page.getByRole('dialog', { name: '搜索聊天', exact: true }).getByRole('combobox')).toHaveCount(0);
    await page.getByRole('option', { name: '聊天：旧连接 OpenCode', exact: true }).click();
    await expect(page.locator('[data-search-hit="true"]')).toContainText('搜索命中'); await expect(page.getByRole('combobox', { name: '聊天来源', exact: true })).toHaveValue('agent');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  });
  await check('offline-agent-rename-preserves-unknown-and-source-binding', async () => {
    await more('旧连接 OpenCode').click(); await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名聊天' }); await dialog.getByRole('textbox').fill('OpenCode 本地改名'); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const saved = JSON.parse(await readFile(agentFile)); assert.equal(saved.title, 'OpenCode 本地改名'); assert.deepEqual(saved.turns, agent.turns); assert.deepEqual(saved.messages, agent.messages); assert.deepEqual(saved.source, agent.source); assert.equal(saved.binding, agent.binding);
  });
  await check('pin-archive-restore-are-preferences-with-history-byte-stability', async () => {
    await more('重命名后的聊天').click(); await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await expect(page.locator('.session-button').first()).toContainText('重命名后的聊天');
    const before = await hash(modelFile);
    await more('重命名后的聊天').click(); await page.getByRole('menuitem', { name: '归档', exact: true }).click(); await expect(row('重命名后的聊天')).toHaveCount(0);
    assert.equal(await hash(modelFile), before);
    await page.getByRole('button', { name: '查看已归档聊天', exact: true }).click(); await expect(row('重命名后的聊天')).toBeVisible();
    await row('重命名后的聊天').click(); await expect(page.locator('.chat-archived-banner')).toContainText('已归档');
    await page.evaluate(() => window.screendeck.saveSettings({ baseURL: 'https://example.invalid/v1', modelID: 'synthetic-model', apiKey: 'synthetic-ui-only', rememberKey: false }));
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await composer().fill('归档后 Enter 不得发送'); await composer().press('Enter'); await expect(composer()).toHaveValue('归档后 Enter 不得发送'); assert.equal((await mainState()).requests, 0);
    await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByRole('dialog', { name: '搜索聊天', exact: true }).locator('input[aria-label="搜索聊天"]').fill('needle');
    await expect(page.locator('.chat-search-result')).toHaveCount(2);
    await expect(page.getByRole('option', { name: '聊天：重命名后的聊天', exact: true })).toContainText('已归档');
    await application.close(); application = undefined; await launch();
    await expect(row('重命名后的聊天')).toHaveCount(0); await page.getByRole('button', { name: '查看已归档聊天', exact: true }).click();
    await row('重命名后的聊天').click(); await page.getByRole('button', { name: '恢复聊天', exact: true }).click(); await expect(page.locator('.chat-archived-banner')).toHaveCount(0);
    await page.getByRole('button', { name: '返回最近聊天', exact: true }).click(); await expect(page.locator('.session-button').first()).toContainText('重命名后的聊天'); assert.equal(await hash(modelFile), before);
  });
  await check('input-shortcuts-ime-multiline-height-and-draft-restart', async () => {
    await row('重命名后的聊天').click(); await composer().fill('  输入草稿\n' + '更长的一行文本'.repeat(80));
    await expect.poll(() => composer().evaluate(node => node.clientHeight)).toBe(180);
    await composer().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }); assert.ok((await composer().inputValue()).startsWith('  输入草稿\n'));
    await composer().fill('第一行'); await composer().press('Shift+Enter'); await composer().press('x'); await expect(composer()).toHaveValue('第一行\nx');
    await composer().fill('重启保留的草稿'); await page.waitForTimeout(650);
    await application.close(); application = undefined; await launch(); await row('重命名后的聊天').click(); await expect(composer()).toHaveValue('重启保留的草稿');
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'; await page.keyboard.press(mod + '+k'); await expect(page.getByRole('dialog', { name: '搜索聊天', exact: true }).locator('input[aria-label="搜索聊天"]')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '搜索聊天', exact: true })).toHaveCount(0);
    await page.keyboard.press(mod + '+n'); await expect(composer()).toHaveValue(''); await expect(composer()).toBeFocused();
    await composer().fill('临时新聊天草稿'); await row('重命名后的聊天').click(); await expect(composer()).toHaveValue('重启保留的草稿');
    await composer().fill(''); await expect.poll(() => composer().evaluate(node => node.clientHeight)).toBe(48);
  });
  await check('jump-latest-narrow-layout-and-reduced-motion', async () => {
    await page.locator('.center-content').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible(); await page.getByRole('button', { name: '回到最新', exact: true }).click(); await expect(page.getByRole('button', { name: '回到最新', exact: true })).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860, 680)); await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(860);
    const fit = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, code: document.querySelector('.markdown-code-block')?.getBoundingClientRect().width, composer: document.querySelector('.composer')?.getBoundingClientRect().right })); assert.equal(fit.overflow, false); assert.ok(fit.composer <= 861);
    await page.screenshot({ path: path.join(temporary, 'chat-narrow.png') });
    await page.locator('.markdown-code-block').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(temporary, 'chat-code-narrow.png') });
  });
  assert.equal((await mainState()).requests, 0);
  await application.close(); application = undefined;
  console.log(JSON.stringify({ checks, temporary, modelCalls: 0, agentStarts: 0 }, null, 2));
} catch (error) { console.error(error); if (page) await page.screenshot({ path: path.join(temporary, 'failure.png'), timeout: 5000 }).catch(() => {}); throw error; } finally { if (application) { const timer = setTimeout(() => application?.process().kill('SIGKILL'), 8000); await application.close().catch(() => {}); clearTimeout(timer); } }
