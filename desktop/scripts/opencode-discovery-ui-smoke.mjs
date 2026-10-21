import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Real main/preload/renderer; only generated HOME/PATH, records and Node ACP
// executables. Discovery is real metadata inspection, not a mocked candidate API.
const desktopRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-opencode-discovery-ui-'));
const homeRoot = path.join(temporaryRoot, 'home'), pathRoot = path.join(temporaryRoot, 'path-bin');
const previewRoot = path.join(temporaryRoot, 'preview'), privateRoot = path.join(temporaryRoot, 'private');
const artifactRoot = path.join(desktopRoot, 'artifacts', 'opencode-discovery-ui-smoke');
const standardBinary = path.join(homeRoot, '.opencode', 'bin', 'opencode'), pathBinary = path.join(pathRoot, 'opencode');
const badBinary = path.join(temporaryRoot, 'manual', 'incompatible-opencode');
const fixtureKey = 'discovery-ui-only-synthetic-key', modelID = 'discovery-ui-fixture-model';
const providerURL = 'https://discovery-fixture.invalid/v1';
for (const directory of [homeRoot, pathRoot, previewRoot, privateRoot, artifactRoot]) await mkdir(directory, { recursive: true });
const sdkURL = pathToFileURL(path.join(desktopRoot, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')).href;
const fixtureSource = '#!' + process.execPath + '\n' + 'globalThis.__SCREENDECK_ACP_FIXTURE_SDK_URL = ' + JSON.stringify(sdkURL) + ';\n' + await readFile(path.join(desktopRoot, 'tests', 'fixtures', 'opencode-acp-ui-runtime.mjs'), 'utf8');
const generateBinary = async filename => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, fixtureSource, { mode: 0o700 }); };
const launchEnv = {};
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) launchEnv[name] = process.env[name];
Object.assign(launchEnv, { HOME: homeRoot, PATH: pathRoot, SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: privateRoot });
const checks = [], screenshots = [], appCounts = []; let application, page, currentCheck = 'launch', standardID, pathID, locationBackup;
const check = async (name, perform) => { currentCheck = name; await perform(); checks.push(name); console.log('PASS ' + name); };
const runtimeCounts = async filename => { try { return JSON.parse(await readFile(path.join(path.dirname(filename), 'runtime-counts.json'), 'utf8')); } catch { return { versionChecks: 0, configChecks: 0, acpStarts: 0, promptSubmissions: 0, sessionCreates: 0, externalModelRequests: 0 }; } };
const locationFile = path.join(previewRoot, 'local-state', createHash('sha256').update('opencode-binary').digest('hex') + '.json');
const allRuntimeCounts = async () => ({ standard: await runtimeCounts(standardBinary), path: await runtimeCounts(pathBinary) });
const installation = () => page.evaluate(() => window.screendeck.getOpenCodeInstallation());
const modal = () => page.getByRole('dialog', { name: '设置', exact: true });
const tools = () => modal().getByRole('region', { name: 'OpenCode 执行器', exact: true });
const screenshot = async filename => { await page.screenshot({ path: path.join(artifactRoot, filename) }); screenshots.push(filename); };
const resize = async (width, height) => { await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height }); await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]); };
const refresh = async () => { await tools().getByTestId('opencode-runtime-refresh').click(); await expect(tools().getByTestId('opencode-runtime-refresh')).toBeEnabled(); };
const openTools = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await modal().getByRole('tab', { name: 'Agent 设置', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-refresh')).toBeEnabled(); };
const saveUnverifiedModel = async () => {
  const before = (await application.evaluate(() => globalThis.__discoveryUICounts)).modelCatalogChecks;
  await application.evaluate(() => { globalThis.__discoveryUIModelCheckAllowed = true; });
  try {
    await modal().getByRole('button', { name: '校验并保存', exact: true }).click();
    await expect(modal().getByRole('button', { name: '保存（未验证）', exact: true })).toBeEnabled();
    await expect(modal().getByRole('status').filter({ hasText: '服务不支持模型列表。' })).toBeVisible();
  } finally { await application.evaluate(() => { globalThis.__discoveryUIModelCheckAllowed = false; }); }
  await modal().getByRole('button', { name: '保存（未验证）', exact: true }).click();
  await expect(modal().getByRole('status').filter({ hasText: '连接已保存，模型未验证。' })).toBeVisible();
  await expect(modal().getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await expect(modal().getByLabel('API 密钥', { exact: true })).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换');
  assert.equal((await application.evaluate(() => globalThis.__discoveryUICounts)).modelCatalogChecks, before + 1);
};
const saveKey = async () => { await modal().getByRole('tab', { name: '模型服务', exact: true }).click(); await modal().getByLabel('API 地址', { exact: true }).fill(providerURL); await modal().getByLabel('模型', { exact: true }).fill(modelID); await modal().getByLabel('API 密钥', { exact: true }).fill(fixtureKey); await saveUnverifiedModel(); await modal().getByRole('tab', { name: 'Agent 设置', exact: true }).click(); };
const chooserResult = async filename => application.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => { globalThis.__discoveryUICounts.chooserCalls++; return filename ? { canceled: false, filePaths: [filename] } : { canceled: true, filePaths: [] }; }; }, filename);
const noProcesses = async () => { for (const value of Object.values(await allRuntimeCounts())) for (const key of ['versionChecks', 'configChecks', 'acpStarts', 'promptSubmissions', 'sessionCreates']) assert.equal(value[key], 0, key + ' must stay zero during metadata reads'); };
const launch = async () => {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
  application.process().stderr?.on('data', bytes => console.error('[electron] ' + String(bytes).replaceAll(fixtureKey, '[synthetic-key]').slice(0, 4096)));
  await application.evaluate(({ net, session, dialog, shell }, { providerURL, fixtureKey }) => {
    globalThis.__discoveryUIModelCheckAllowed = false;
    globalThis.__discoveryUICounts = { chooserCalls: 0, installLinks: [], httpAttempts: 0, ordinarySends: 0, modelCatalogChecks: 0 };
    const wrap = original => (input, ...args) => {
      const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
      const method = String(args[0]?.method ?? input?.method ?? 'GET').toUpperCase();
      const headers = new Headers(args[0]?.headers ?? input?.headers);
      // Model-directory discovery is outside this executable-discovery regression.
      if (globalThis.__discoveryUIModelCheckAllowed && url.href === providerURL + '/models' && method === 'GET' && headers.get('authorization') === 'Bearer ' + fixtureKey) {
        globalThis.__discoveryUICounts.modelCatalogChecks++; return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      if (['http:', 'https:'].includes(url.protocol)) { globalThis.__discoveryUICounts.httpAttempts++; throw new Error('Discovery GUI fixture blocks HTTP.'); }
      return original(input, ...args);
    };
    globalThis.fetch = wrap(globalThis.fetch.bind(globalThis)); net.fetch = wrap(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { globalThis.__discoveryUICounts.httpAttempts++; callback({ cancel: true }); });
    dialog.showOpenDialog = async () => { globalThis.__discoveryUICounts.chooserCalls++; return { canceled: true, filePaths: [] }; };
    shell.openExternal = async url => { globalThis.__discoveryUICounts.installLinks.push(url); };
  }, { providerURL, fixtureKey });
  page = await application.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(15_000);
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('screendeck:send-message'); ipcMain.handle('screendeck:send-message', () => { globalThis.__discoveryUICounts.ordinarySends++; throw new Error('Discovery GUI never sends ordinary chat.'); }); });
  assert.equal(await application.evaluate(() => process.env.HOME), homeRoot); assert.equal(await application.evaluate(() => process.env.PATH), pathRoot);
  await resize(1440, 940);
};
const verifyFit = async () => {
  const value = await modal().evaluate(node => { const r = node.getBoundingClientRect(), content = node.querySelector('.settings-content'); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth }; });
  assert.ok(value.left >= 0 && value.right <= value.width + 1 && value.top >= 0 && value.bottom <= value.height + 1, JSON.stringify(value)); assert.ok(value.pageWidth <= value.width + 1 && value.contentScrollWidth <= value.contentWidth + 1, JSON.stringify(value));
  for (const node of await tools().getByRole('button').all()) { const rect = await node.boundingBox(); assert.ok(rect.width > 0); assert.equal(await node.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap'); }
};

try {
  await launch();
  await check('settings-mount-does-metadata-only-discovery-with-missing-state', async () => {
    await openTools(); assert.deepEqual(await installation(), { candidates: [] });
    await expect(tools().getByTestId('opencode-installation-status')).toHaveText('未检测到 OpenCode'); await expect(tools().getByTestId('opencode-runtime-start')).toBeDisabled();
    await noProcesses(); assert.equal((await application.evaluate(() => globalThis.__discoveryUICounts)).chooserCalls, 0); await screenshot('opencode-missing-1440x940.png');
  });
  await check('explicit-manual-cancel-and-install-help-do-not-connect-or-install', async () => {
    await tools().getByRole('button', { name: '手动选择程序', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-refresh')).toBeEnabled(); assert.deepEqual(await installation(), { candidates: [] });
    await tools().getByRole('button', { name: '安装说明', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-refresh')).toBeEnabled();
    const value = await application.evaluate(() => globalThis.__discoveryUICounts); assert.equal(value.chooserCalls, 1); assert.deepEqual(value.installLinks, ['https://opencode.ai/docs/']); await noProcesses();
  });
  await check('standard-home-location-is-detected-without-version-probe-or-start', async () => {
    await generateBinary(standardBinary); await refresh(); const found = await installation(); assert.equal(found.candidates.length, 1);
    assert.equal(found.candidates[0].path, await realpath(standardBinary)); assert.equal(found.candidates[0].source, 'standard'); standardID = found.candidates[0].id;
    await expect(tools().getByTestId('opencode-installation-status')).toHaveText('已找到，尚未连接'); await expect(tools().getByTestId('opencode-installation-path')).toHaveAttribute('title', await realpath(standardBinary)); await noProcesses(); await screenshot('opencode-found-1440x940.png');
  });
  await check('fresh-multiple-candidates-without-preference-require-explicit-selection', async () => {
    await generateBinary(pathBinary); await page.keyboard.press('Escape'); await openTools();
    const found = await installation(); assert.equal(found.candidates.length, 2); assert.equal(found.preferredID, undefined);
    await expect(tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true })).toHaveValue('');
    await expect(tools().getByTestId('opencode-runtime-start')).toBeDisabled();
    await tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true }).selectOption(standardID);
    await noProcesses(); await rm(pathBinary); await refresh();
  });
  await check('saving-synthetic-model-config-remains-separate-from-connecting', async () => { await saveKey(); await expect(tools().getByTestId('opencode-runtime-start')).toBeEnabled(); await noProcesses(); });
  await check('single-candidate-explicit-connect-does-not-open-native-chooser', async () => {
    const before = (await application.evaluate(() => globalThis.__discoveryUICounts)).chooserCalls;
    await tools().getByRole('button', { name: '连接 OpenCode', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0', { timeout: 30_000 });
    assert.equal((await application.evaluate(() => globalThis.__discoveryUICounts)).chooserCalls, before);
    const value = await runtimeCounts(standardBinary); assert.equal(value.versionChecks, 1); assert.equal(value.configChecks, 1); assert.equal(value.acpStarts, 1); assert.equal(value.promptSubmissions, 0); assert.equal(value.controls.titleDisabled, true);
    await screenshot('opencode-connected-1440x940.png');
  });
  await check('corrupt-temporary-location-on-refresh-preserves-known-ready-and-stop', async () => {
    locationBackup = await readFile(locationFile); await writeFile(locationFile, JSON.stringify({ schema_version: 99, kind: 'opencode_binary_location', binaryPath: standardBinary }));
    await refresh(); await expect(tools().getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0');
    await expect(tools().getByRole('button', { name: '关闭执行器', exact: true })).toBeEnabled();
    await expect(tools().getByTestId('opencode-installation-status')).toContainText('程序位置未确认');
    await expect(tools().locator('.settings-feedback')).toContainText('已连接的执行器仍可关闭');
  });
  await check('reopening-with-unreadable-location-still-reads-runtime-and-can-stop', async () => {
    try {
      await page.keyboard.press('Escape'); await openTools();
      await expect(tools().getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0');
      await expect(tools().getByRole('button', { name: '关闭执行器', exact: true })).toBeEnabled();
      await screenshot('opencode-location-error-still-ready-1440x940.png');
      await tools().getByRole('button', { name: '关闭执行器', exact: true }).click();
      await expect(tools().getByTestId('opencode-runtime-status')).toHaveText('未启动');
      await expect(tools().getByTestId('opencode-runtime-start')).toBeDisabled();
    } finally { await writeFile(locationFile, locationBackup); locationBackup = undefined; }
    await refresh(); await tools().getByRole('button', { name: '连接 OpenCode', exact: true }).click();
    await expect(tools().getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0', { timeout: 30_000 });
    assert.equal((await runtimeCounts(standardBinary)).acpStarts, 2);
  });
  await check('stop-and-app-restart-remember-canonical-path-without-auto-connection', async () => {
    await tools().getByRole('button', { name: '关闭执行器', exact: true }).click(); await expect(tools().getByTestId('opencode-installation-status')).toHaveText('已找到，尚未连接');
    const before = await allRuntimeCounts(); appCounts.push(await application.evaluate(() => globalThis.__discoveryUICounts)); await application.close(); application = undefined;
    await launch(); await openTools(); const found = await installation(); assert.equal(found.preferredID, standardID); assert.equal(found.candidates[0].source, 'remembered'); assert.equal(found.candidates[0].path, await realpath(standardBinary));
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
    for (const name of ['standard', 'path']) for (const key of ['versionChecks', 'configChecks', 'acpStarts', 'promptSubmissions']) assert.equal((await allRuntimeCounts())[name][key], before[name][key]);
  });
  await check('multiple-canonical-candidates-use-native-select-and-remembered-preference', async () => {
    await generateBinary(pathBinary); await refresh(); const found = await installation(); assert.equal(found.candidates.length, 2); assert.equal(found.preferredID, standardID);
    const canonical = await realpath(pathBinary), fromPath = found.candidates.find(value => value.path === canonical); assert.equal(fromPath.source, 'path'); pathID = fromPath.id;
    await expect(tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true })).toHaveValue(standardID);
    await tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true }).selectOption(pathID);
    await expect(tools().getByTestId('opencode-installation-path')).toHaveAttribute('title', canonical);
    assert.equal((await runtimeCounts(pathBinary)).versionChecks, 0); assert.equal(await tools().getByRole('textbox').count(), 0);
  });
  await check('dirty-model-gate-preserves-candidate-without-starting', async () => {
    await saveKey(); await modal().getByRole('tab', { name: '模型服务', exact: true }).click(); await modal().getByLabel('模型', { exact: true }).fill('unsaved-synthetic-model');
    await modal().getByRole('tab', { name: 'Agent 设置', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-start')).toBeDisabled();
    await expect(tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true })).toHaveValue(pathID);
    assert.equal((await runtimeCounts(pathBinary)).versionChecks, 0);
    await tools().getByRole('button', { name: '回到模型服务', exact: true }).click(); await modal().getByLabel('模型', { exact: true }).fill(modelID); await saveUnverifiedModel(); await modal().getByRole('tab', { name: 'Agent 设置', exact: true }).click();
  });
  await check('explicit-candidate-id-connects-selected-path-without-fallback', async () => {
    await tools().getByRole('button', { name: '连接 OpenCode', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0', { timeout: 30_000 });
    const value = await allRuntimeCounts(); assert.equal(value.path.acpStarts, 1); assert.equal(value.standard.acpStarts, 2); assert.equal(value.path.promptSubmissions, 0);
    const found = await installation(); assert.equal(found.preferredID, pathID); assert.equal(found.candidates.find(value => value.id === pathID).source, 'remembered');
    await tools().getByRole('button', { name: '关闭执行器', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-refresh')).toBeEnabled();
  });
  await check('manual-choice-only-adds-metadata-and-incompatible-version-never-falls-back', async () => {
    await mkdir(path.dirname(badBinary), { recursive: true });
    await writeFile(badBinary, '#!' + process.execPath + '\nimport {readFileSync,writeFileSync} from "node:fs"; import path from "node:path";const file=path.join(path.dirname(process.argv[1]),"bad-counts.json");let n;try{n=JSON.parse(readFileSync(file,"utf8"))}catch{n={versionChecks:0,unexpected:0}}if(process.argv.includes("--version")){n.versionChecks++;writeFileSync(file,JSON.stringify(n));console.log("0.0.1")}else{n.unexpected++;writeFileSync(file,JSON.stringify(n));process.exitCode=1}\n', { mode: 0o700 });
    await chooserResult(badBinary); const before = await allRuntimeCounts(); await tools().getByRole('button', { name: '手动选择程序', exact: true }).click(); await expect(tools().getByTestId('opencode-runtime-refresh')).toBeEnabled();
    const found = await installation(), candidate = found.candidates.find(value => value.path === badBinary); assert.ok(candidate); assert.equal(candidate.source, 'manual');
    await expect(tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true })).toHaveValue(candidate.id); assert.deepEqual(await allRuntimeCounts(), before);
    await tools().getByRole('button', { name: '连接 OpenCode', exact: true }).click();
    await expect(tools().locator('.settings-feedback')).toContainText('OpenCode 版本不匹配'); await expect(tools().locator('.settings-feedback')).toContainText('1.19.0');
    const visibleText = await page.locator('body').innerText(); assert.equal(visibleText.includes('screendeck:start-opencode'), false); assert.equal(visibleText.includes('Error invoking remote method'), false);
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
    assert.deepEqual(JSON.parse(await readFile(path.join(path.dirname(badBinary), 'bad-counts.json'), 'utf8')), { versionChecks: 1, unexpected: 0 }); assert.deepEqual(await allRuntimeCounts(), before);
    await screenshot('opencode-incompatible-1440x940.png'); await refresh();
  });
  await check('pending-native-choice-after-modal-close-cannot-replace-new-selection', async () => {
    await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { globalThis.__discoveryUICounts.chooserCalls++; return new Promise(resolve => { globalThis.__resolveDiscoveryChooser = resolve; }); }; });
    await tools().getByRole('button', { name: '手动选择程序', exact: true }).click(); await expect(tools()).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); await openTools();
    await tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true }).selectOption(pathID);
    await application.evaluate((_electron, filename) => globalThis.__resolveDiscoveryChooser({ canceled: false, filePaths: [filename] }), standardBinary);
    await expect.poll(async () => (await installation()).preferredID).toBe(standardID);
    await expect(tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true })).toHaveValue(pathID);
    assert.equal((await runtimeCounts(standardBinary)).acpStarts, 2); assert.equal((await runtimeCounts(pathBinary)).acpStarts, 1);
  });
  await check('narrow-candidate-paths-and-keyboard-focus-fit-settings', async () => {
    await resize(860, 780); await refresh(); await verifyFit(); const select = tools().getByRole('combobox', { name: 'OpenCode 安装位置', exact: true });
    await select.focus(); await expect(select).toBeFocused(); assert.notEqual(await select.evaluate(node => getComputedStyle(node).outlineWidth), '0px');
    await expect(tools().getByTestId('opencode-installation-path')).toHaveAttribute('title', await realpath(pathBinary)); await screenshot('opencode-multiple-narrow-focus-860x780.png');
    for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]') && !document.activeElement?.closest('[hidden],[inert]')), true); }
    await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused(); await resize(1440, 940); await openTools(); await screenshot('opencode-multiple-1440x940.png');
  });
  await check('standalone-eight-state-preview-preserves-tokens-and-touch-labels', async () => {
    const previewPath = path.resolve(desktopRoot, '..', 'docs/design/assets/frontend/previews/OpenCodeDiscovery.preview.html'); const waiting = application.waitForEvent('window');
    await application.evaluate(async ({ BrowserWindow }, filename) => { const window = new BrowserWindow({ show: false, width: 1040, height: 980, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); await window.loadFile(filename); }, previewPath);
    const preview = await waiting; await expect(preview.locator('[data-preview-state]')).toHaveCount(8); const first = preview.locator('[data-preview-state="default"] button'); await first.focus(); await expect(first).toBeFocused(); await first.evaluate(node => node.blur());
    assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await preview.screenshot({ path: path.join(artifactRoot, 'opencode-discovery-eight-states.png') }); screenshots.push('opencode-discovery-eight-states.png');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.isVisible())?.setContentSize(320, 1100));
    assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const button of await preview.locator('button').all()) assert.ok((await button.boundingBox()).height >= 44);
    await preview.close();
  });
  await check('metadata-status-and-settings-expose-no-key-and-submit-no-chat', async () => {
    const data = await page.evaluate(async () => ({ installation: await window.screendeck.getOpenCodeInstallation(), status: await window.screendeck.getOpenCodeStatus(), bootstrap: await window.screendeck.bootstrap() }));
    assert.equal(JSON.stringify(data).includes(fixtureKey), false); assert.equal((await page.locator('body').innerText()).includes(fixtureKey), false);
    assert.deepEqual(data.bootstrap.sessions, []); assert.deepEqual(data.bootstrap.agentSessions, []); assert.deepEqual(data.bootstrap.taskSessions, []);
    for (const value of Object.values(await allRuntimeCounts())) { assert.equal(value.promptSubmissions, 0); assert.equal(value.sessionCreates, 0); assert.equal(value.externalModelRequests, 0); }
    appCounts.push(await application.evaluate(() => globalThis.__discoveryUICounts)); for (const value of appCounts) { assert.equal(value.httpAttempts, 0); assert.equal(value.ordinarySends, 0); }
  });
  const report = { opencodeDiscoveryUISmoke: 'passed', checks, screenshots, temporaryRoot, runtimeCounts: await allRuntimeCounts(), appCounts, fixture: 'real production IPC with generated Node SDK ACP fixture in standard HOME and controlled PATH', limitations: ['Only temporary generated HOME/PATH/private/preview data are inspected.', 'Only the exact synthetic provider models GET with its synthetic Bearer key is fulfilled locally with HTTP 404; model discovery is outside this executable-discovery regression.', 'Native chooser and fixed official guide opening are intercepted inside the isolated Electron process.', 'No real OpenCode, installation, model, or private user credential is used; version/config probes happen only after explicit Connect.', 'Guards begin after Electron launch/initialization and counts cover smoke interactions.'] };
  await rm(path.join(artifactRoot, 'failure.json'), { force: true }); await rm(path.join(artifactRoot, 'failure.png'), { force: true }); await writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) {
  if (page) try { await screenshot('failure.png'); } catch { /* retain original error */ }
  await writeFile(path.join(artifactRoot, 'failure.json'), JSON.stringify({ currentCheck, checks, screenshots, temporaryRoot, error: String(error).replaceAll(fixtureKey, '[fixture-key]') }, null, 2) + '\n'); throw error;
} finally { if (locationBackup) await writeFile(locationFile, locationBackup); await application?.close(); }
