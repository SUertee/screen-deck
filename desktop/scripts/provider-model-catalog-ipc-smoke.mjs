import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-model-catalog-ui-'));
const root = path.join(temporary, 'preview'), home = path.join(temporary, 'home');
await mkdir(home, { mode: 0o700 });
const fixture = { baseURL: 'https://catalog-ipc.invalid/v1', apiKey: 'synthetic-catalog-ipc-key-not-a-real-credential', modelIDs: ['model-alpha', 'model-beta'] };
const env = { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: root, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects') };
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'DISPLAY', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
const artifacts = path.join(process.cwd(), 'artifacts', 'provider-model-catalog'); await mkdir(artifacts, { recursive: true });
const checks = [], errors = [];
let app, page;
const launch = async () => {
  app = await electron.launch({ args: [process.cwd()], env, timeout: 30_000 });
  await app.evaluate(({ net, session }, data) => {
    globalThis.__catalogFixture = { mode: 'unauthorized', lists: 0, external: 0, submissions: 0 };
    const deny = () => { globalThis.__catalogFixture.external++; throw new Error('Only the synthetic models endpoint is allowed.'); };
    const localFetch = globalThis.fetch.bind(globalThis), localNetFetch = net.fetch.bind(net);
    globalThis.fetch = async (input, init) => {
      if (!/^https?:/i.test(String(input))) return localFetch(input, init);
      if (String(input) !== data.baseURL + '/models') return deny();
      if (init?.method !== 'GET' || init.redirect !== 'manual' || new Headers(init.headers).get('Authorization') !== 'Bearer ' + data.apiKey) throw new Error('Invalid synthetic list request.');
      globalThis.__catalogFixture.lists++;
      return globalThis.__catalogFixture.mode === 'unauthorized'
        ? new Response(JSON.stringify({ error: data.apiKey }), { status: 401 })
        : new Response(JSON.stringify({ data: data.modelIDs.map(id => ({ id, ignored_metadata: 'not a capability claim' })) }), { status: 200 });
    };
    net.fetch = async (input, ...args) => /^https?:/i.test(typeof input === 'string' ? input : input?.url ?? String(input)) ? deny() : localNetFetch(input, ...args);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { globalThis.__catalogFixture.external++; callback({ cancel: true }); });
  }, fixture);
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible({ timeout: 30_000 });
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['send-message', 'send-agent-message', 'start-opencode', 'start-task-execution']) {
      ipcMain.removeHandler('screendeck:' + channel);
      ipcMain.handle('screendeck:' + channel, () => { globalThis.__catalogFixture.submissions++; throw new Error('Model catalog smoke forbids execution.'); });
    }
  });
};
const settings = () => page.evaluate(() => window.screendeck.getSettings());
const counts = () => app.evaluate(() => globalThis.__catalogFixture);
const open = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible(); };
const close = async () => { const value = await counts(); assert.equal(value.external, 0); assert.equal(value.submissions, 0); await app.close(); app = undefined; };
try {
  await launch(); await open();
  await page.locator('#provider-url').fill(fixture.baseURL); await page.locator('#provider-key').fill(fixture.apiKey);
  await page.getByTestId('settings-save-model').click();
  await expect(page.locator('.settings-feedback .notice')).toBeVisible(); await expect(page.locator('#provider-key')).toHaveValue(fixture.apiKey);
  assert.equal((await settings()).hasKey, false); await assert.rejects(readFile(path.join(root, 'credential.json')), { code: 'ENOENT' });
  assert.equal((await page.locator('.settings-feedback').innerText()).includes(fixture.apiKey), false);
  checks.push('real-401-keeps-draft-and-does-not-persist-or-leak-key'); console.log('PASS ' + checks.at(-1));
  await app.evaluate(() => { globalThis.__catalogFixture.mode = 'available'; });
  await page.getByTestId('settings-save-model').click(); await expect(page.locator('#provider-model')).toHaveValue('');
  await expect(page.locator('#provider-model option:checked')).toHaveText('请选择模型'); assert.equal((await settings()).hasKey, false);
  await page.locator('#provider-model').selectOption('model-alpha'); await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
  await expect.poll(async () => (await settings()).credentialStorage).toBe('file'); await expect(page.locator('#provider-key')).toHaveValue('');
  await expect(page.getByTestId('provider-key-status')).toHaveText('已保存');
  assert.equal((await stat(path.join(root, 'credential.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path.join(root, 'credential.json'), 'utf8')).api_key, fixture.apiKey);
  assert.deepEqual(await page.evaluate(() => window.screendeck.getProviderModels()), { baseURL: fixture.baseURL, modelIDs: fixture.modelIDs });
  await page.screenshot({ path: path.join(artifacts, 'settings-saved.png') });
  checks.push('real-discovery-needs-explicit-model-choice-then-persists-file-and-cache'); console.log('PASS ' + checks.at(-1));
  await page.keyboard.press('Escape');
  const draft = page.getByRole('textbox', { name: '输入消息', exact: true }); await draft.fill('切换模型保留草稿，不发送请求。');
  const picker = page.getByRole('button', { name: '选择模型', exact: true }); await expect(picker).toHaveText('model-alpha');
  await picker.click(); await page.screenshot({path: path.join(artifacts, 'composer-model-menu-open.png')}); await page.getByRole('menuitem', {name: '模型设置…', exact: true}).click(); await expect(page.getByRole('dialog', {name: '设置', exact: true})).toBeVisible(); await page.keyboard.press('Escape'); await expect(picker).toBeFocused();
  await picker.click(); await page.getByRole('menuitemradio', {name: 'model-beta', exact: true}).click(); await expect.poll(async () => (await settings()).modelID).toBe('model-beta'); await expect(picker).toBeEnabled(); await expect(picker).toBeFocused();
  await expect(draft).toHaveValue('切换模型保留草稿，不发送请求。'); assert.equal((await counts()).lists, 2);
  assert.equal((await page.evaluate(() => window.screendeck.bootstrap())).sessions.length, 0);
  await page.screenshot({ path: path.join(artifacts, 'composer-model-picker.png') });
  checks.push('composer-selects-saved-model-without-request-or-history-write'); console.log('PASS ' + checks.at(-1));
  await expect.poll(() => page.evaluate(() => window.screendeck.loadDraft('new-chat'))).toBe('切换模型保留草稿，不发送请求。');
  await close();

  await launch(); await expect(page.getByRole('button', { name: '选择模型', exact: true })).toHaveText('model-beta');
  assert.equal((await counts()).lists, 0); assert.equal((await settings()).hasKey, true);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('切换模型保留草稿，不发送请求。');
  await open(); await expect(page.locator('#provider-model')).toHaveValue('model-beta'); await expect(page.locator('#provider-key')).toHaveValue('');
  await expect(page.locator('#provider-key')).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换'); await expect(page.getByTestId('provider-key-status')).toHaveText('已保存');
  assert.equal((await counts()).lists, 0); checks.push('real-restart-restores-key-selection-and-catalog-without-HTTP'); console.log('PASS ' + checks.at(-1)); await close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ providerModelCatalogIPC: 'passed', checks, syntheticListRequests: [2, 0], externalRequests: 0, modelOrAgentSubmissions: 0, pageErrors: errors }));
} finally { await app?.close(); }
