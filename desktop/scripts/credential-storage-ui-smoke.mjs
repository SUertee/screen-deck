import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real main/preload/settings UI; every file and credential is synthetic and isolated.
// Only the exact synthetic model-list request is mocked; all real HTTP is refused.
const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-credential-file-ui-'));
const preview = path.join(temporary, 'preview');
const home = path.join(temporary, 'home');
await Promise.all([preview, home].map(directory => mkdir(directory, { mode: 0o700 })));
const legacy = Buffer.from('synthetic-old-ciphertext-not-a-real-credential');
await writeFile(path.join(preview, 'credential.bin'), legacy, { mode: 0o600 });
const key = 'synthetic-file-ui-key-not-a-real-credential';
const preferences = { baseURL: 'https://credential-storage.invalid/v1', modelID: 'file-storage-fixture' };
const env = { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: preview, SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temporary, 'projects') };
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'DISPLAY', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
const checks = [];
const modelListCounts = [];
let application, page;
const launch = async () => {
  application = await electron.launch({ args: [process.cwd()], env, timeout: 30_000 });
  await application.evaluate(({ net, session }, fixture) => {
    globalThis.__credentialFileCounts = { externalRequests: 0, submissions: 0, modelLists: 0 };
    globalThis.__credentialFileExpectedKey = fixture.key;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const requestURL = input => typeof input === 'string' ? input : input?.url ?? String(input);
    globalThis.fetch = async (input, init) => {
      const url = requestURL(input);
      if (url === fixture.baseURL + '/models' && init?.method === 'GET' && init.redirect === 'manual' && new Headers(init.headers).get('authorization') === `Bearer ${globalThis.__credentialFileExpectedKey}`) {
        globalThis.__credentialFileCounts.modelLists++;
        return new Response(JSON.stringify({ object: 'list', data: [{ id: fixture.modelID, object: 'model' }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (/^https?:/i.test(url)) {
        globalThis.__credentialFileCounts.externalRequests++;
        throw new Error('Credential file smoke forbids unmocked HTTP.');
      }
      return originalFetch(input, init);
    };
    const originalNetFetch = net.fetch.bind(net);
    net.fetch = (input, ...args) => {
      if (/^https?:/i.test(requestURL(input))) {
        globalThis.__credentialFileCounts.externalRequests++;
        throw new Error('Credential file smoke forbids Electron HTTP.');
      }
      return originalNetFetch(input, ...args);
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      globalThis.__credentialFileCounts.externalRequests++;
      callback({ cancel: true });
    });
  }, { ...preferences, key });
  page = await application.firstWindow();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible({ timeout: 30_000 });
  await application.evaluate(({ ipcMain }) => {
    // Guard after initialization so registered handlers cannot replace these guards.
    for (const channel of ['send-message', 'send-agent-message', 'start-opencode', 'start-task-execution']) {
      ipcMain.removeHandler(`screendeck:${channel}`);
      ipcMain.handle(`screendeck:${channel}`, () => {
        globalThis.__credentialFileCounts.submissions++;
        throw new Error('Credential file smoke forbids external execution.');
      });
    }
  });
};
const close = async expectedModelLists => {
  const counts = await application.evaluate(() => globalThis.__credentialFileCounts);
  assert.deepEqual(counts, { externalRequests: 0, submissions: 0, modelLists: expectedModelLists });
  modelListCounts.push(counts.modelLists);
  await application.close();
  application = undefined;
};
const open = async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
};
const settings = () => page.evaluate(() => window.screendeck.getSettings());
const save = async () => {
  await expect(page.getByTestId('settings-save-model')).toHaveText('校验并保存');
  await page.getByTestId('settings-save-model').click();
};
const checkPublic = async (storage, hasKey) => {
  const value = await settings();
  assert.deepEqual(value, { ...preferences, hasKey, credentialStorage: storage });
  assert.equal(JSON.stringify(value).includes(key), false);
  if (await page.locator('#provider-key').count()) await expect(page.locator('#provider-key')).toHaveValue('');
};
try {
  await launch();
  const initial = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(initial.settings.hasKey, false);
  assert.equal(initial.settings.credentialStorage, 'none');
  assert.ok(initial.diagnostics.some(value => value.includes('旧版密钥未导入')));
  await open();
  await expect(page.getByRole('checkbox', { name: '记住 API 密钥', exact: true })).toHaveCount(0);
  await page.locator('#provider-url').fill(preferences.baseURL);
  await page.locator('#provider-model').fill(preferences.modelID);
  await page.locator('#provider-key').fill(key);
  await save();
  await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
  await checkPublic('file', true);
  await expect(page.locator('#provider-key')).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换');
  assert.deepEqual(JSON.parse(await readFile(path.join(preview, 'credential.json'), 'utf8')), { schema_version: 1, base_url: preferences.baseURL, api_key: key });
  if (process.platform !== 'win32') assert.equal((await stat(path.join(preview, 'credential.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(path.join(preview, 'provider.toml'), 'utf8')).includes(key), false);
  assert.deepEqual(await readFile(path.join(preview, 'credential.bin')), legacy);
  checks.push('validated-settings-save-writes-private-plaintext-and-preserves-legacy');
  await close(1);

  await launch();
  await checkPublic('file', true);
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('仅检查发送资格，不发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await open();
  await expect(page.locator('#provider-key')).toHaveValue('');
  await expect(page.locator('#provider-key')).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换');
  await expect(page.getByRole('dialog').getByText(/系统加密|系统授权|钥匙串|解锁/)).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.screendeck.getProviderModels()), { baseURL: preferences.baseURL, modelIDs: [preferences.modelID] });
  // Legacy callers may still explicitly choose memory mode; the current UI has no switch.
  await page.evaluate(value => window.screendeck.saveSettings({ ...value, rememberKey: false }), preferences);
  await checkPublic('memory', true);
  assert.equal(JSON.parse(await readFile(path.join(preview, 'credential.json'), 'utf8')), null);
  checks.push('real-restart-loads-file-and-explicit-legacy-memory-api-clears-persistence');
  await close(0);

  await launch();
  await checkPublic('none', false);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await open();
  await page.locator('#provider-key').fill(key);
  await save();
  await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
  await checkPublic('file', true);
  await expect(page.getByRole('button', { name: '移除已保存密钥', exact: true })).toHaveCount(0);
  const replacement = 'synthetic-replacement-file-ui-key';
  await application.evaluate((_electron, value) => { globalThis.__credentialFileExpectedKey = value; }, replacement);
  await page.locator('#provider-key').fill(replacement); await save();
  await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('settings-save-model')).toBeEnabled(); await checkPublic('file', true);
  assert.deepEqual(JSON.parse(await readFile(path.join(preview, 'credential.json'), 'utf8')), {schema_version: 1, base_url: preferences.baseURL, api_key: replacement});
  // Legacy removal IPC remains compatible; the settings page exposes editing only.
  await page.evaluate(value => window.screendeck.saveSettings({...value, forgetKey: true}), preferences);
  await checkPublic('none', false);
  assert.equal(JSON.parse(await readFile(path.join(preview, 'credential.json'), 'utf8')), null);
  assert.deepEqual(await readFile(path.join(preview, 'credential.bin')), legacy);
  checks.push('real-restart-key-edit-replaces-file-and-legacy-removal-preserves-old-file');
  await close(2);
  console.log(JSON.stringify({ credentialFileIPC: 'passed', checks, syntheticModelListRequestsPerLaunch: modelListCounts, externalRequests: 0, modelOrAgentSubmissions: 0, realCredentialsRead: false }));
} finally {
  await application?.close();
}
