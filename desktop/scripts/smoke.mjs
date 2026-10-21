import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, realpath, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const live = process.env.SCREENDECK_LIVE_SMOKE === '1';
const isolatedRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-smoke-'));
const root = live ? process.env.SCREENDECK_PREVIEW_ROOT ?? path.join(os.homedir(), '.screendeck', 'previews', 'electron-v1') : isolatedRoot;
const screenshotRoot = path.join(process.cwd(), 'artifacts');
await mkdir(screenshotRoot, { recursive: true });
const launchEnv = { ...process.env, SCREENDECK_PREVIEW_ROOT: root };
delete launchEnv.ELECTRON_RUN_AS_NODE;
if (!live) { delete launchEnv.SCREENDECK_PROVIDER_SCREENSHOT; delete launchEnv.SCREENDECK_OCR_HELPER; delete launchEnv.SCREENDECK_INITIAL_PROJECT; }
let application;
const launch = env => electron.launch({
  ...(process.env.SCREENDECK_APP_EXECUTABLE ? { executablePath: process.env.SCREENDECK_APP_EXECUTABLE } : {}),
  args: process.env.SCREENDECK_APP_EXECUTABLE ? [] : [process.cwd()], env, timeout: 30_000,
});
try {
  application = await launch(launchEnv);
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process]), ['undefined', 'undefined']);
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('这是一条只保存在本地的草稿。');
  const draftStatus = page.locator('.composer-draft-status[role="status"].visually-hidden');
  await expect(draftStatus).toHaveText('草稿已保存');
  assert.equal(await draftStatus.evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return rect.width <= 1 && rect.height <= 1 && style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)' && style.display !== 'none' && style.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true'; }), true, 'Draft status stays available to assistive technology without visible chrome.');
  await expect.poll(() => page.evaluate(() => window.screendeck.loadDraft('new-chat'))).toBe('这是一条只保存在本地的草稿。');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  assert.equal(await page.locator('#provider-key').inputValue(), '');
  const publicSettings = await page.evaluate(() => window.screendeck.getSettings());
  assert.deepEqual(Object.keys(publicSettings).sort(), ['baseURL', 'credentialStorage', 'hasKey', 'modelID']);
  assert.equal(await page.locator('#app-shell').evaluate(node => node.inert), true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '折叠侧栏' }).click();
  await page.getByRole('button', { name: '展开侧栏' }).click();
  const invalid = await page.evaluate(async () => {
    try { await window.screendeck.createSession({ title: 'invalid', unexpected: true }); return false; } catch { return true; }
  });
  assert.equal(invalid, true);
  await page.screenshot({ path: path.join(screenshotRoot, live ? 'workbench-live.png' : 'workbench-new-chat.png') });
  if (live) {
    assert.ok(publicSettings.hasKey, 'Authorized key must be configured before live smoke.');
    await input.fill('请用一句中文简短说明你已收到这条测试消息。不要调用工具，也不要访问文件。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.message.assistant .message-body')).not.toBeEmpty({ timeout: 150_000 });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible({ timeout: 150_000 });
    const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
    const record = bootstrap.sessions.filter(value => value.title.startsWith('请用一句中文')).sort((a,b) => b.created_at.localeCompare(a.created_at))[0];
    assert.ok(record); assert.equal(record.turns.at(-1).state, 'finished');
    assert.ok(record.messages.at(-1).text.trim());
    const sessionID = record.conversation_id;
    console.log(JSON.stringify({ liveChat: 'passed', sessionID, requestedModel: record.turns.at(-1).requested_model.model_id, observedModel: record.turns.at(-1).observed_model?.model_id, replyCharacters: record.messages.at(-1).text.length, projects: bootstrap.projects.length }));
    await page.getByRole('button', { name: '打开 Deck', exact: true }).click();
    await expect.poll(() => application.windows().length).toBe(2);
    const deck = application.windows().find(window => window !== page);
    await expect(deck.getByRole('heading', { name: record.title, exact: true })).toBeVisible();
    await deck.close();
    await page.screenshot({ path: path.join(screenshotRoot, 'chat-live.png') });
    await application.close(); application = undefined;
    const restartEnv = { ...launchEnv }; delete restartEnv.SCREENDECK_PROVIDER_SCREENSHOT; delete restartEnv.SCREENDECK_OCR_HELPER;
    application = await launch(restartEnv);
    const restarted = await application.firstWindow();
    await expect(restarted.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
    const recovered = await restarted.evaluate(id => window.screendeck.loadSession(id), sessionID);
    assert.equal(recovered.turns.at(-1).state, 'finished');
    assert.equal(recovered.messages.at(-1).text, record.messages.at(-1).text);
    console.log(JSON.stringify({ restartRecovery: 'passed', credentialStorage: (await restarted.evaluate(() => window.screendeck.getSettings())).credentialStorage }));
  } else {
    const memorySettings = await page.evaluate(() => window.screendeck.saveSettings({ baseURL: 'https://example.com/v1', modelID: 'test-model', apiKey: 'fixture-key-not-a-real-secret', rememberKey: false }));
    assert.equal(memorySettings.hasKey, true); assert.equal(memorySettings.credentialStorage, 'memory');
    await application.close(); application = undefined;
    application = await launch(launchEnv);
    const restarted = await application.firstWindow();
    await expect(restarted.getByRole('textbox', { name: '输入消息' })).toHaveValue('这是一条只保存在本地的草稿。');
    const recovered = await restarted.evaluate(() => window.screendeck.bootstrap());
    assert.equal(recovered.settings.hasKey, false); assert.equal(recovered.settings.credentialStorage, 'none'); assert.equal(recovered.settings.modelID, 'test-model');
    assert.equal(recovered.diagnostics.length, 0);
    console.log(JSON.stringify({ desktopSmoke: 'passed', isolation: 'passed', draftRestart: 'passed', memoryCredentialCleared: true }));
  }
} finally { await application?.close(); }
