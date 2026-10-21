import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

// Renderer-only fixture: no Electron credentials, user data, or provider requests.
// sessionStorage carries synthetic public metadata across reload; real file IO,
// permissions and store restart behavior are verified by ProviderSettingsStore tests.
const bundle = await build({ entryPoints: ['src/renderer/main.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: 'fixture.js', loader: { '.svg': 'dataurl' }, write: false });
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const url = 'https://renderer-fixture.invalid';
let browser;
let externalRequests = 0;
const checks = [];
const pageErrors = [];
const check = async (name, operation) => { await operation(); checks.push(name); console.log('PASS ' + name); };
const keyInput = page => page.locator('#provider-key');
const composer = page => page.getByRole('textbox', { name: '输入消息', exact: true });
const sendButton = page => page.getByRole('button', { name: '发送消息', exact: true });
const openSettings = page => page.getByRole('button', { name: '设置', exact: true }).click();
const closeSettings = page => page.getByRole('button', { name: '取消', exact: true }).click();
const saveSettings = page => page.getByTestId('settings-save-model').click();
async function assertPublicSettings(page, storage, hasKey) {
  const settings = await page.evaluate(() => window.screendeck.getSettings());
  assert.equal(settings.credentialStorage, storage); assert.equal(settings.hasKey, hasKey);
  assert.deepEqual(Object.keys(settings).sort(), ['baseURL', 'credentialStorage', 'hasKey', 'modelID']);
}
async function assertNoSavedKeyInUI(page, secret) {
  await expect(keyInput(page)).toHaveValue('');
  assert.equal(await page.evaluate(value => document.documentElement.outerHTML.includes(value), secret), false);
  assert.equal(await page.evaluate(value => JSON.stringify(sessionStorage).includes(value), secret), false);
  assert.equal(JSON.stringify(await page.evaluate(() => window.screendeck.getSettings())).includes(secret), false);
}

async function fixturePage(initialSettings) {
  const page = await browser.newPage();
  page.on('pageerror', error => { pageErrors.push(error.message); console.error('Renderer page error: ' + error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('Renderer console error: ' + message.text()); });
  await page.route('**/*', route => {
    const requestURL = new URL(route.request().url());
    if (requestURL.origin !== url) { externalRequests++; return route.abort(); }
    const requestPath = requestURL.pathname;
    return route.fulfill({ contentType: requestPath === '/fixture.js' ? 'text/javascript' : requestPath === '/fixture.css' ? 'text/css' : 'text/html', body: requestPath === '/fixture.js' ? javascript : requestPath === '/fixture.css' ? stylesheet : '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
  });
  await page.addInitScript(initial => {
    const { immediateReject, ...providerSettings } = initial;
    const defaults = { baseURL: 'https://fixture.invalid/v1', modelID: 'fixture-model', ...providerSettings };
    const diskKey = 'fixture-provider-disk';
    const catalogKey = 'fixture-provider-models';
    const saved = sessionStorage.getItem(diskKey);
    let settings = saved ? JSON.parse(saved) : defaults;
    let credentialIdentity = settings.hasKey ? Symbol('stored-fixture-credential') : undefined;
    let catalog = JSON.parse(sessionStorage.getItem(catalogKey) ?? 'null');
    let pendingCatalog;
    if (!saved) sessionStorage.setItem(diskKey, JSON.stringify({ ...defaults, hasKey: defaults.credentialStorage === 'file' && defaults.hasKey, credentialStorage: defaults.credentialStorage === 'file' && defaults.hasKey ? 'file' : 'none' }));
    const listeners = new Set(), taskListeners = new Set(), drafts = new Map();
    let session, pending, rejectSave = false;
    const counts = { creates: 0, sends: 0, stops: 0, saves: 0 };
    const modelCounts = { cacheReads: 0, lists: 0, selections: 0 };
    const emit = event => listeners.forEach(listener => listener(event));
    window.fixture = {
      counts, modelCounts,
      rejectNextSave() { rejectSave = true; },
      reject() { pending.reject(new Error('请求准备失败。请检查模型连接后重试。')); },
      getSession() { return session; },
      accept(status = 'accepted') {
        const time = new Date().toISOString();
        session = { ...session, revision: session.revision + 1, turns: [{ turn_id: 'fixture-turn', client_request_id: 'fixture-request', state: status === 'notSubmitted' ? 'failed' : status === 'uncertain' ? 'unknown' : 'submitting', requested_model: { provider_id: 'chat-completions', model_id: settings.modelID }, created_at: time, updated_at: time, draft_revision: 1 }], messages: [{ message_id: 'fixture-message', turn_id: 'fixture-turn', role: 'user', text: pending.text, created_at: time, updated_at: time }] };
        emit({ type: 'session-updated', session });
        pending.resolve({ status, session });
      },
    };
    window.screendeck = {
      bootstrap: async () => ({ settings, sessions: [], agentSessions: [], taskSessions: [], projects: [], plans: [], chatPreferences: { revision: 0, entries: {} }, diagnostics: [], projectDiagnostics: [], dataRootLabel: 'renderer fixture' }),
      getSettings: async () => settings,
      getProviderModels: async () => {
        modelCounts.cacheReads++;
        return catalog?.baseURL === settings.baseURL ? structuredClone(catalog) : { baseURL: settings.baseURL, modelIDs: [] };
      },
      listProviderModels: async ({ baseURL, apiKey }) => {
        modelCounts.lists++;
        if (!apiKey && (!settings.hasKey || baseURL !== settings.baseURL)) throw new Error('请填写该服务的 API 密钥。');
        pendingCatalog = { baseURL, modelIDs: [settings.modelID], credentialIdentity: apiKey || credentialIdentity };
        return { kind: 'available', modelIDs: [...pendingCatalog.modelIDs] };
      },
      selectProviderModel: async ({ modelID }) => {
        modelCounts.selections++;
        if (modelID !== settings.modelID && !catalog?.modelIDs.includes(modelID)) throw new Error('请选择已保存列表中的模型。');
        settings = { ...settings, modelID };
        emit({ type: 'settings-updated', settings });
        return settings;
      },
      getAgentSources: async () => [{ agentID: 'opencode', name: 'OpenCode', state: 'unavailable', reason: 'stopped' }],
      getOpenCodeStatus: async () => ({ state: 'stopped' }),
      getOpenCodeInstallation: async () => ({ candidates: [] }),
      createSession: async ({ title, scope }) => {
        counts.creates++;
        const time = new Date().toISOString();
        session = { schema_version: 1, conversation_id: 'fixture-session', title, scope: scope ?? { kind: 'local_chat', local_chat_id: 'fixture-local' }, revision: 1, created_at: time, updated_at: time, messages: [], turns: [] };
        return session;
      },
      sendMessage: async ({ text }) => { counts.sends++; if (immediateReject) throw new Error('请求准备失败。请检查模型连接后重试。'); return new Promise((resolve, reject) => { pending = { resolve, reject, text }; }); },
      stopGeneration: async () => { counts.stops++; session = { ...session, revision: session.revision + 1, turns: session.turns.map(turn => ({ ...turn, state: 'cancelled' })) }; emit({ type: 'session-updated', session }); },
      saveSettings: async input => {
        counts.saves++;
        if (rejectSave) { rejectSave = false; throw new Error('无法保存连接设置。当前输入已保留。'); }
        const sameDestination = input.baseURL === settings.baseURL;
        const nextCredential = input.forgetKey ? undefined : input.apiKey || (sameDestination ? credentialIdentity : undefined);
        const connectionChanged = !sameDestination || credentialIdentity !== nextCredential;
        settings = { ...settings, baseURL: input.baseURL, modelID: input.modelID, hasKey: !!nextCredential, credentialStorage: nextCredential ? input.rememberKey !== false ? 'file' : 'memory' : 'none' };
        if (pendingCatalog?.baseURL === settings.baseURL && pendingCatalog.credentialIdentity === nextCredential) {
          catalog = { baseURL: pendingCatalog.baseURL, modelIDs: [...pendingCatalog.modelIDs] };
        } else if (connectionChanged) catalog = { baseURL: settings.baseURL, modelIDs: [] };
        credentialIdentity = nextCredential;
        pendingCatalog = undefined;
        sessionStorage.setItem(catalogKey, JSON.stringify(catalog));
        // Only public metadata enters this renderer fixture's simulated restart state.
        sessionStorage.setItem(diskKey, JSON.stringify({ ...settings, hasKey: settings.credentialStorage === 'file' && settings.hasKey, credentialStorage: settings.credentialStorage === 'file' && settings.hasKey ? 'file' : 'none' }));
        emit({ type: 'settings-updated', settings }); return settings;
      },
      saveDraft: async ({ key, text }) => { drafts.set(key, text); },
      loadDraft: async key => drafts.get(key) ?? '',
      subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      onTaskSessionEvent: callback => { taskListeners.add(callback); return () => taskListeners.delete(callback); },
    };
  }, initialSettings);
  await page.goto(url);
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
  return page;
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.SCREENDECK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SCREENDECK_CHROMIUM_EXECUTABLE } : {}) });
  await check('file-bootstrap-and-reload-need-no-unlock-and-never-reveal-saved-key', async () => {
    const page = await fixturePage({ hasKey: true, credentialStorage: 'file' });
    await openSettings(page);
    await expect(keyInput(page)).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换');
    await expect(keyInput(page)).toHaveValue('');
    await expect(page.getByRole('checkbox', { name: '记住 API 密钥', exact: true })).toHaveCount(0);
    await expect(page.locator('.settings-modal').getByText(/系统加密|钥匙串|解锁|系统授权/)).toHaveCount(0);
    await expect(page.getByTestId('settings-save-model')).toHaveText('校验并保存');
    await saveSettings(page);
    await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
    await assertPublicSettings(page, 'file', true);
    await expect(keyInput(page)).toHaveValue('');
    assert.equal(await page.evaluate(() => window.fixture.counts.sends), 0);
    assert.equal(await page.evaluate(() => window.fixture.modelCounts.lists), 1);
    assert.deepEqual(await page.evaluate(() => window.screendeck.getProviderModels()), { baseURL: 'https://fixture.invalid/v1', modelIDs: ['fixture-model'] });
    await closeSettings(page); await page.reload(); await expect(composer(page)).toBeVisible();
    await assertPublicSettings(page, 'file', true);
    await composer(page).fill('重载后可直接发送'); await expect(sendButton(page)).toBeEnabled();
    await openSettings(page);
    await expect(keyInput(page)).toHaveValue('');
    await expect(keyInput(page)).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换');
    assert.deepEqual(await page.evaluate(() => window.fixture.counts), { creates: 0, sends: 0, stops: 0, saves: 0 });
    assert.equal(await page.evaluate(() => window.fixture.modelCounts.lists), 0);
    await page.close();
  });
  await check('preparation-failure-preserves-draft-and-duplicate-submit-and-stop-boundaries', async () => {
    const page = await fixturePage({ hasKey: true, credentialStorage: 'file' });
    const input = composer(page); await input.fill('保留这条草稿。'); await expect(sendButton(page)).toBeEnabled();
    await input.evaluate(node => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await expect(page.getByRole('button', { name: '正在准备请求', exact: true })).toBeDisabled();
    await expect(page.getByText('正在提交请求…', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.fixture.counts), { creates: 1, sends: 1, stops: 0, saves: 0 });
    await page.evaluate(() => window.fixture.reject()); await expect(input).toHaveValue('保留这条草稿。');
    await expect.poll(() => page.evaluate(() => window.screendeck.loadDraft('new-chat'))).toBe('保留这条草稿。');
    await expect(page.locator('.global-notice').getByRole('button', { name: '打开设置', exact: true })).toBeVisible(); await expect(sendButton(page)).toBeEnabled();
    await sendButton(page).click(); await expect.poll(() => page.evaluate(() => window.fixture.counts.sends)).toBe(2);
    await page.evaluate(() => window.fixture.accept()); await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fixture.counts.stops)).toBe(1); await page.close();
  });
  await check('dispatch-clears-input-and-persisted-draft-before-response-without-clearing-next-input', async () => {
    const page = await fixturePage({ hasKey: true, credentialStorage: 'file' });
    await composer(page).fill('  已发送原文  '); await sendButton(page).click();
    await expect.poll(() => page.evaluate(() => window.fixture.counts.sends)).toBe(1);
    await expect(composer(page)).toHaveValue('');
    const id = await page.evaluate(() => window.fixture.getSession().conversation_id);
    for (const key of ['new-chat', 'session:' + id]) await expect.poll(() => page.evaluate(key => window.screendeck.loadDraft(key), key)).toBe('');
    await composer(page).fill('下一条新草稿'); await page.evaluate(() => window.fixture.accept());
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled();
    await expect(composer(page)).toHaveValue('下一条新草稿');
    await expect.poll(() => page.evaluate(key => window.screendeck.loadDraft(key), 'session:' + id)).toBe('下一条新草稿');
    await page.close();
  });
  await check('late-failure-does-not-overwrite-a-new-draft', async () => {
    const page = await fixturePage({ hasKey: true, credentialStorage: 'file' });
    await composer(page).fill('失败的原发送'); await sendButton(page).click(); await expect(composer(page)).toHaveValue('');
    await composer(page).fill('失败前已经输入的新草稿'); await page.evaluate(() => window.fixture.reject());
    await expect(page.locator('.global-notice')).toBeVisible(); await expect(composer(page)).toHaveValue('失败前已经输入的新草稿');
    await page.close();
  });
  await check('not-submitted-restores-exact-input-but-uncertain-never-requeues-it', async () => {
    for (const status of ['notSubmitted', 'uncertain']) {
      const page = await fixturePage({ hasKey: true, credentialStorage: 'file' });
      const text = '  原输入保留空格\n第二行  ';
      await composer(page).fill(text); await sendButton(page).click(); await expect(composer(page)).toHaveValue('');
      await page.evaluate(status => window.fixture.accept(status), status);
      if (status === 'notSubmitted') await expect(composer(page)).toHaveValue(text);
      else { await expect(composer(page)).toHaveValue(''); await expect(sendButton(page)).toBeDisabled(); }
      assert.equal(await page.evaluate(() => window.fixture.counts.sends), 1); await page.close();
    }
  });
  await check('immediate-request-failure-keeps-draft-retryable', async () => {
    const page = await fixturePage({ hasKey: true, credentialStorage: 'file', immediateReject: true });
    await composer(page).fill('立即失败也保留草稿。'); await sendButton(page).click();
    await expect(composer(page)).toHaveValue('立即失败也保留草稿。'); await expect(page.locator('.global-notice').getByRole('button', { name: '打开设置', exact: true })).toBeVisible(); await expect(sendButton(page)).toBeEnabled(); await page.close();
  });
  await check('only-has-key-grants-model-send-eligibility', async () => {
    for (const [credentialStorage, hasKey, eligible] of [['none', false, false], ['memory', true, true], ['file', true, true], ['file', false, false]]) {
      const page = await fixturePage({ credentialStorage, hasKey }); await composer(page).fill('资格检查');
      if (eligible) await expect(sendButton(page)).toBeEnabled();
      else { await expect(sendButton(page)).toBeDisabled(); await composer(page).press('Enter'); assert.equal(await page.evaluate(() => window.fixture.counts.creates), 0); }
      await page.close();
    }
  });
  await check('legacy-memory-api-expires-on-reload-and-default-validated-save-persists', async () => {
    const page = await fixturePage({ hasKey: false, credentialStorage: 'none' });
    const temporaryKey = 'synthetic-temporary-key-not-a-real-credential';
    const rememberedKey = 'synthetic-remembered-key-not-a-real-credential';
    // Compatibility remains in IPC; the current Settings form has no memory-only switch.
    await page.evaluate(apiKey => window.screendeck.saveSettings({ baseURL: 'https://fixture.invalid/v1', modelID: 'fixture-model', apiKey, rememberKey: false }), temporaryKey);
    await assertPublicSettings(page, 'memory', true);
    await page.reload(); await expect(composer(page)).toBeVisible();
    await assertPublicSettings(page, 'none', false);
    await composer(page).fill('临时密钥退出后不可发送'); await expect(sendButton(page)).toBeDisabled();
    await openSettings(page);
    await expect(page.getByRole('checkbox', { name: '记住 API 密钥', exact: true })).toHaveCount(0);
    await keyInput(page).fill(rememberedKey);
    await page.getByRole('tab', { name: '本地数据', exact: true }).click();
    await page.getByRole('tab', { name: '模型服务', exact: true }).click();
    await expect(keyInput(page)).toHaveValue(rememberedKey);
    await expect(page.getByTestId('settings-save-model')).toHaveText('校验并保存');
    await saveSettings(page);
    await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
    await assertPublicSettings(page, 'file', true);
    await assertNoSavedKeyInUI(page, rememberedKey);
    assert.equal(await page.evaluate(() => window.fixture.modelCounts.lists), 1);
    await closeSettings(page); await page.reload();
    await expect(composer(page)).toBeVisible(); await assertPublicSettings(page, 'file', true);
    await composer(page).fill('文件密钥重载后仍可发送'); await expect(sendButton(page)).toBeEnabled();
    await openSettings(page); await assertNoSavedKeyInUI(page, rememberedKey);
    assert.equal(await page.evaluate(() => window.fixture.modelCounts.lists), 0);
    await page.close();
  });
  await check('failed-settings-save-keeps-input-and-closing-clears-only-unsaved-key', async () => {
    const page = await fixturePage({ hasKey: false, credentialStorage: 'none' }); const unsaved = 'synthetic-unsaved-key-not-a-real-credential';
    await composer(page).fill('保存失败不能丢失聊天草稿'); await openSettings(page); await keyInput(page).fill(unsaved);
    await page.evaluate(() => window.fixture.rejectNextSave()); await saveSettings(page);
    await expect(page.getByText('无法保存连接设置。当前输入已保留。', { exact: true })).toBeVisible(); await expect(keyInput(page)).toHaveValue(unsaved); await assertPublicSettings(page, 'none', false);
    assert.equal(await page.evaluate(() => window.fixture.modelCounts.lists), 1);
    await closeSettings(page); await expect(composer(page)).toHaveValue('保存失败不能丢失聊天草稿'); await openSettings(page); await assertNoSavedKeyInUI(page, unsaved);
    assert.equal(await page.evaluate(() => window.fixture.counts.sends), 0); await page.close();
  });
  assert.equal(externalRequests, 0);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ credentialRenderer: 'passed', checks, duplicateSubmitBlocked: true, preparationHasNoStop: true, failedRequestPreservesDraft: true, fileBootstrapReady: true, savedKeyNeverReturned: true, legacyMemoryAPIExpiresInRestartFixture: true, validationUsesSyntheticMetadataOnly: true, externalRequests,
    limitations: ['Renderer-only synthetic metadata reload; actual plaintext file format, permissions and real store restart are covered by ProviderSettingsStore unit tests. Model-list responses are synthetic; no provider, Agent or real user credentials are used.'] }));
} finally {
  await browser?.close();
}
