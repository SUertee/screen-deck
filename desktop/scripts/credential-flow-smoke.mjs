import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

// Renderer-only fixture: no Electron credentials, user data, or provider requests.
const bundle = await build({ entryPoints: ['src/renderer/main.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: 'fixture.js', write: false });
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const url = 'https://renderer-fixture.invalid';
let browser;

async function fixturePage(settings) {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const requestPath = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: requestPath === '/fixture.js' ? 'text/javascript' : requestPath === '/fixture.css' ? 'text/css' : 'text/html', body: requestPath === '/fixture.js' ? javascript : requestPath === '/fixture.css' ? stylesheet : '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
  });
  await page.addInitScript(initialSettings => {
    const { immediateReject, ...providerSettings } = initialSettings;
    let settings = { baseURL: 'https://fixture.invalid/v1', modelID: 'fixture-model', ...providerSettings };
    const listeners = new Set();
    const drafts = new Map();
    let session;
    let pending;
    const counts = { creates: 0, sends: 0, stops: 0, saves: 0 };
    const emit = event => listeners.forEach(listener => listener(event));
    window.fixture = {
      counts,
      reject() { pending.reject(new Error('无法读取已保存密钥。请重试，或在设置中填写新密钥。')); },
      accept() {
        settings = { ...settings, hasKey: true, credentialStorage: 'encrypted' };
        emit({ type: 'settings-updated', settings });
        const time = new Date().toISOString();
        session = { ...session, revision: session.revision + 1, turns: [{ turn_id: 'fixture-turn', client_request_id: 'fixture-request', state: 'submitting', requested_model: { provider_id: 'chat-completions', model_id: settings.modelID }, created_at: time, updated_at: time, draft_revision: 1 }], messages: [{ message_id: 'fixture-message', turn_id: 'fixture-turn', role: 'user', text: pending.text, created_at: time, updated_at: time }] };
        emit({ type: 'session-updated', session });
        pending.resolve({ status: 'accepted', session });
      },
    };
    window.screendeck = {
      bootstrap: async () => ({ settings, sessions: [], projects: [], plans: [], diagnostics: [], dataRootLabel: 'renderer fixture' }),
      getSettings: async () => settings,
      createSession: async ({ title, scope }) => {
        counts.creates++;
        const time = new Date().toISOString();
        session = { schema_version: 1, conversation_id: 'fixture-session', title, scope: scope ?? { kind: 'local_chat', local_chat_id: 'fixture-local' }, revision: 1, created_at: time, updated_at: time, messages: [], turns: [] };
        return session;
      },
      sendMessage: async ({ text }) => { counts.sends++; if (immediateReject) throw new Error('无法读取已保存密钥。请重试，或在设置中填写新密钥。'); return new Promise((resolve, reject) => { pending = { resolve, reject, text }; }); },
      stopGeneration: async () => { counts.stops++; session = { ...session, revision: session.revision + 1, turns: session.turns.map(turn => ({ ...turn, state: 'cancelled' })) }; emit({ type: 'session-updated', session }); },
      saveSettings: async input => { counts.saves++; settings = { ...settings, baseURL: input.baseURL, modelID: input.modelID }; if (input.apiKey) settings = { ...settings, hasKey: true, credentialStorage: input.rememberKey ? 'encrypted' : 'memory' }; if (input.forgetKey) settings = { ...settings, hasKey: false, credentialStorage: 'none' }; emit({ type: 'settings-updated', settings }); return settings; },
      saveDraft: async ({ key, text }) => { drafts.set(key, text); },
      loadDraft: async key => drafts.get(key) ?? '',
      subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    };
  }, settings);
  await page.goto(url);
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
  return page;
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.SCREENDECK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SCREENDECK_CHROMIUM_EXECUTABLE } : {}) });
  const locked = await fixturePage({ hasKey: false, credentialStorage: 'locked' });
  await locked.getByRole('button', { name: '设置', exact: true }).click();
  await expect(locked.locator('#provider-key')).toHaveAttribute('placeholder', '已保存密钥；留空继续使用');
  await expect(locked.locator('#provider-key')).toHaveValue('');
  await expect(locked.getByRole('checkbox', { name: '记住 API 密钥', exact: true })).toBeChecked();
  await expect(locked.getByText('发送时会自动读取已保存密钥；如系统提示，请完成授权。', { exact: true })).toBeVisible();
  await expect(locked.getByText(/解锁/)).toHaveCount(0);
  await locked.locator('#provider-model').fill('changed-fixture-model');
  await locked.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(locked.getByText('连接设置已保存。发送时会自动读取已保存密钥。', { exact: true })).toBeVisible();
  assert.equal(await locked.evaluate(() => window.fixture.counts.sends), 0, 'Saving settings must not load credentials or send.');
  await locked.getByRole('button', { name: '完成', exact: true }).click();
  const input = locked.getByRole('textbox', { name: '输入消息' });
  await input.fill('保留这条草稿。');
  await expect(locked.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await input.evaluate(node => {
    // Same browser task catches races hidden by an awaited double-click.
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await expect(locked.getByRole('button', { name: '正在准备请求', exact: true })).toBeDisabled();
  await expect(locked.getByText('正在读取已保存密钥；如系统提示，请完成授权。', { exact: true })).toBeVisible();
  await expect(locked.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  assert.deepEqual(await locked.evaluate(() => window.fixture.counts), { creates: 1, sends: 1, stops: 0, saves: 1 });
  await locked.evaluate(() => window.fixture.reject());
  await expect(input).toHaveValue('保留这条草稿。');
  await expect(locked.locator('.global-notice').getByRole('button', { name: '打开设置', exact: true })).toBeVisible();
  await expect(locked.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await locked.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => locked.evaluate(() => window.fixture.counts.sends)).toBe(2);
  await locked.evaluate(() => window.fixture.accept());
  await expect(input).toHaveValue('');
  await expect(locked.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled();
  await locked.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(() => locked.evaluate(() => window.fixture.counts.stops)).toBe(1);
  await locked.close();

  const immediate = await fixturePage({ hasKey: false, credentialStorage: 'locked', immediateReject: true });
  await immediate.getByRole('textbox', { name: '输入消息' }).fill('立即失败也保留草稿。');
  await immediate.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(immediate.getByRole('textbox', { name: '输入消息' })).toHaveValue('立即失败也保留草稿。');
  await expect(immediate.locator('.global-notice').getByRole('button', { name: '打开设置', exact: true })).toBeVisible();
  await expect(immediate.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await immediate.close();

  for (const [credentialStorage, hasKey, eligible] of [['none', false, false], ['memory', true, true], ['encrypted', true, true]]) {
    const page = await fixturePage({ credentialStorage, hasKey });
    const input = page.getByRole('textbox', { name: '输入消息' });
    await input.fill('资格检查');
    if (eligible) await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    else {
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await input.press('Enter');
      assert.equal(await page.evaluate(() => window.fixture.counts.creates), 0);
    }
    await page.close();
  }
  console.log(JSON.stringify({ credentialRenderer: 'passed', lockedEligible: true, duplicateSubmitBlocked: true, preparationHasNoStop: true, deniedKeyPreservesDraft: true, settingsSaveNeverReadsKey: true, realRequestStillStoppable: true, networkRequests: 0 }));
} finally {
  await browser?.close();
}
