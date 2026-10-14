import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Production main/preload/renderer, with real settings IPC against generated roots.
// Guards only forbidden side effects; no bootstrap, settings or UI fixture mocks.
const desktopRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-settings-layout-'));
const previewRoot = path.join(temporaryRoot, 'preview');
const privateRoot = path.join(temporaryRoot, 'private');
const launchHome = path.join(temporaryRoot, 'home');
const artifactRoot = path.join(desktopRoot, 'artifacts', 'settings-layout-smoke');
await Promise.all([previewRoot, privateRoot, artifactRoot, launchHome].map(directory => mkdir(directory, { recursive: true })));
const launchEnv = {};
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) launchEnv[name] = process.env[name];
Object.assign(launchEnv, { HOME: launchHome, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: privateRoot });
const fixtureURL = 'https://settings-layout.invalid/v1';
const fixtureModel = 'settings-layout-fixture-model';
const fixtureKey = 'settings-layout-synthetic-key-not-a-real-credential';
const checks = [], screenshots = [];
let application, page, currentCheck = 'launch', initialSaveGeometry;
const check = async (name, operation) => { currentCheck = name; await operation(); checks.push(name); console.log(`PASS ${name}`); };
const modal = () => page.getByRole('dialog', { name: '设置', exact: true });
const panel = section => modal().getByTestId(`settings-panel-${section}`);
const tab = name => modal().getByRole('tab', { name, exact: true });
const screenshot = async filename => { await page.screenshot({ path: path.join(artifactRoot, filename) }); screenshots.push(filename); };
const resize = async (width, height) => {
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
};
const counts = () => application.evaluate(() => globalThis.__settingsLayoutCounts);
const scrollContentTop = async () => {
  const content = modal().locator('.settings-content');
  await content.evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(0);
};
const verifyFocus = async () => assert.deepEqual(await page.evaluate(() => ({ inside: !!document.activeElement?.closest('[role="dialog"]'), hidden: !!document.activeElement?.closest('[hidden], [inert]') })), { inside: true, hidden: false });
const verifyFit = async () => {
  const geometry = await modal().evaluate(node => {
    const box = node.getBoundingClientRect(); const content = node.querySelector('.settings-content');
    return { viewportWidth: innerWidth, viewportHeight: innerHeight, left: box.left, right: box.right, top: box.top, bottom: box.bottom, documentWidth: document.documentElement.scrollWidth, contentWidth: content?.clientWidth, contentScrollWidth: content?.scrollWidth };
  });
  assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewportWidth + 1, JSON.stringify(geometry));
  assert.ok(geometry.top >= -1 && geometry.bottom <= geometry.viewportHeight + 1, JSON.stringify(geometry));
  assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1, JSON.stringify(geometry));
  assert.ok(geometry.contentWidth > 0 && geometry.contentScrollWidth <= geometry.contentWidth + 1, JSON.stringify(geometry));
  const content = modal().locator('.settings-content');
  const vertical = await content.evaluate(node => ({ height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
  if (vertical.scrollHeight > vertical.height + 1) {
    assert.ok(['auto', 'scroll'].includes(vertical.overflow), JSON.stringify(vertical));
    await content.hover(); await page.mouse.wheel(0, vertical.scrollHeight * 2);
    await expect.poll(() => content.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
  }
  await expect(modal().getByRole('tabpanel').getByRole('button').last()).toBeInViewport({ ratio: 1 });
};
const openSettings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(modal()).toBeVisible(); };

try {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
  await application.evaluate(({ net, session, dialog }) => {
    globalThis.__settingsLayoutCounts = { networkAttempts: 0, ordinarySends: 0, taskStarts: 0, runtimeStarts: 0, runtimeStops: 0, chooserCalls: 0 };
    const guard = original => (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (/^https?:/i.test(url)) { globalThis.__settingsLayoutCounts.networkAttempts++; throw new Error('Settings layout smoke forbids all HTTP.'); }
      return original(input, ...args);
    };
    globalThis.fetch = guard(globalThis.fetch.bind(globalThis)); net.fetch = guard(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { globalThis.__settingsLayoutCounts.networkAttempts++; callback({ cancel: true }); });
    dialog.showOpenDialog = async () => { globalThis.__settingsLayoutCounts.chooserCalls++; throw new Error('Settings layout smoke must not choose or launch a runtime.'); };
  });
  page = await application.firstWindow({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  // Install after initialization so real registered handlers cannot replace guards.
  await application.evaluate(({ ipcMain }) => {
    for (const [channel, counter] of [['send-message', 'ordinarySends'], ['start-task-execution', 'taskStarts'], ['start-opencode', 'runtimeStarts'], ['stop-opencode', 'runtimeStops']]) {
      ipcMain.removeHandler(`screendeck:${channel}`);
      ipcMain.handle(`screendeck:${channel}`, () => { globalThis.__settingsLayoutCounts[counter]++; throw new Error('Forbidden side effect in settings layout smoke.'); });
    }
  });
  const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  assert.deepEqual(bootstrap.projects, []); assert.deepEqual(bootstrap.sessions, []); assert.equal(bootstrap.settings.hasKey, false);
  assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
  await resize(1440, 940);

  await check('empty-chat-starts-with-two-columns-and-no-empty-context-panel', async () => {
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
    await expect(page.locator('.detail-panel')).toBeHidden();
    assert.equal(await page.locator('.workbench').evaluate(node => node.classList.contains('has-detail')), false);
    await expect(page.getByRole('button', { name: '展开右栏', exact: true })).toHaveCount(0);
  });
  await check('large-settings-opens-models-and-keeps-three-panels-mounted', async () => {
    await openSettings();
    await expect(tab('模型服务')).toHaveAttribute('aria-selected', 'true');
    for (const name of ['模型服务', '编码工具', '本地数据']) await expect(tab(name)).toBeVisible();
    await expect(panel('models')).toBeVisible(); await expect(panel('tools')).toBeHidden(); await expect(panel('data')).toBeHidden();
    for (const section of ['models', 'tools', 'data']) await expect(panel(section)).toHaveCount(1);
    await expect(modal().locator('.settings-layout')).toBeVisible(); await expect(modal().locator('.settings-content')).toBeVisible();
    const box = await modal().boundingBox(); assert.ok(box.width > 700 && box.height > 400, JSON.stringify(box));
    assert.equal(await page.locator('#app-shell').evaluate(node => node.inert), true);
    await expect(panel('models').getByLabel('API 地址', { exact: true })).toHaveValue(bootstrap.settings.baseURL);
    await expect(panel('models').getByLabel('模型名称', { exact: true })).toHaveValue(bootstrap.settings.modelID);
    initialSaveGeometry = await modal().getByTestId('settings-save-model').evaluate(node => {
      const content = node.closest('.settings-content');
      const button = node.getBoundingClientRect(), frame = content.getBoundingClientRect();
      const left = frame.left + content.clientLeft, top = frame.top + content.clientTop;
      return { scrollTop: content.scrollTop, button: { left: button.left, top: button.top, right: button.right, bottom: button.bottom }, visibleContent: { left, top, right: left + content.clientWidth, bottom: top + content.clientHeight } };
    });
    assert.equal(initialSaveGeometry.scrollTop, 0, 'initial default model panel must not scroll itself');
    const { button, visibleContent } = initialSaveGeometry;
    assert.ok(button.left >= visibleContent.left - 1 && button.right <= visibleContent.right + 1 && button.top >= visibleContent.top - 1 && button.bottom <= visibleContent.bottom + 1, `initial save button must fit inside the content viewport: ${JSON.stringify(initialSaveGeometry)}`);
    await verifyFit(); await screenshot('settings-models-1440x940-scrolled.png');
    await scrollContentTop(); await screenshot('settings-models-1440x940.png');
  });
  await check('category-content-isolated-and-runtime-stays-stopped', async () => {
    await expect(panel('models').getByLabel('API 地址', { exact: true })).toBeVisible();
    await expect(modal().getByRole('region', { name: 'OpenCode 执行器', exact: true })).toBeHidden();
    await tab('编码工具').click(); await expect(panel('tools')).toBeVisible(); await expect(panel('models')).toBeHidden();
    await expect(modal().getByLabel('API 密钥', { exact: true })).toBeHidden(); await expect(modal().getByTestId('settings-save-model')).toBeHidden();
    await expect(modal().getByTestId('opencode-runtime-status')).toContainText('未启动');
    await scrollContentTop(); await screenshot('settings-tools-1440x940.png');
    await tab('本地数据').click(); await expect(panel('data')).toBeVisible(); await expect(panel('tools')).toBeHidden();
    await expect(modal().getByLabel('API 地址', { exact: true })).toBeHidden(); await expect(modal().getByTestId('opencode-runtime-start')).toBeHidden();
    await expect(panel('data')).toContainText(bootstrap.dataRootLabel); await screenshot('settings-data-1440x940.png');
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
  });
  await check('category-keyboard-navigation-uses-visible-panel-and-focus-trap', async () => {
    await tab('模型服务').click(); await tab('模型服务').focus(); await page.keyboard.press('ArrowRight');
    await expect(tab('编码工具')).toHaveAttribute('aria-selected', 'true'); await expect(tab('编码工具')).toBeFocused();
    await page.keyboard.press('End'); await expect(tab('本地数据')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home'); await expect(tab('模型服务')).toHaveAttribute('aria-selected', 'true');
    for (let index = 0; index < 24; index++) { await page.keyboard.press('Tab'); await verifyFocus(); }
    for (let index = 0; index < 6; index++) { await page.keyboard.press('Shift+Tab'); await verifyFocus(); }
    await page.evaluate(() => document.querySelector('.composer textarea').focus()); await verifyFocus();
  });
  await check('switching-categories-retains-nonsecret-and-synthetic-key-drafts', async () => {
    await panel('models').getByLabel('API 地址', { exact: true }).fill(fixtureURL);
    await panel('models').getByLabel('模型名称', { exact: true }).fill(fixtureModel);
    await panel('models').getByLabel('API 密钥', { exact: true }).fill(fixtureKey);
    await tab('编码工具').click(); await expect(modal().getByTestId('opencode-runtime-start')).toBeDisabled();
    await tab('本地数据').click(); await tab('模型服务').click();
    await expect(panel('models').getByLabel('API 地址', { exact: true })).toHaveValue(fixtureURL);
    await expect(panel('models').getByLabel('模型名称', { exact: true })).toHaveValue(fixtureModel);
    await expect(panel('models').getByLabel('API 密钥', { exact: true })).toHaveValue(fixtureKey);
    assert.equal((await page.evaluate(() => window.screendeck.getSettings())).hasKey, false, 'typing and switching categories must not save a credential');
  });
  await check('escape-clears-only-unsaved-key-and-restores-opening-focus', async () => {
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
    assert.equal(await page.locator('#app-shell').evaluate(node => node.inert), false);
    await openSettings();
    await expect(tab('模型服务')).toHaveAttribute('aria-selected', 'true');
    await expect(panel('models').getByLabel('API 地址', { exact: true })).toHaveValue(fixtureURL);
    await expect(panel('models').getByLabel('模型名称', { exact: true })).toHaveValue(fixtureModel);
    await expect(panel('models').getByLabel('API 密钥', { exact: true })).toHaveValue('');
    assert.equal((await page.evaluate(() => window.screendeck.getSettings())).hasKey, false);
  });
  await check('composer-model-button-targets-models-after-a-different-category', async () => {
    await tab('编码工具').click(); await page.keyboard.press('Escape');
    await page.locator('.model-select').click(); await expect(tab('模型服务')).toHaveAttribute('aria-selected', 'true');
    await expect(panel('models')).toBeVisible(); await expect(panel('tools')).toBeHidden();
    await page.keyboard.press('Escape'); await expect(page.locator('.model-select')).toBeFocused();
    await openSettings();
  });
  await check('real-settings-save-stores-synthetic-memory-key-without-starting-runtime', async () => {
    await panel('models').getByLabel('API 密钥', { exact: true }).fill(fixtureKey);
    await panel('models').getByLabel('记住 API 密钥', { exact: true }).uncheck();
    await modal().getByTestId('settings-save-model').click();
    await expect.poll(() => page.evaluate(() => window.screendeck.getSettings())).toEqual({ baseURL: fixtureURL, modelID: fixtureModel, hasKey: true, credentialStorage: 'memory' });
    await expect(panel('models').getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await tab('编码工具').click();
    await expect(modal().getByTestId('opencode-runtime-start')).toBeDisabled();
    await expect(modal().getByTestId('opencode-binary-choose')).toBeEnabled();
    assert.deepEqual(await page.evaluate(() => window.screendeck.getOpenCodeStatus()), { state: 'stopped' });
    assert.deepEqual(await counts(), { networkAttempts: 0, ordinarySends: 0, taskStarts: 0, runtimeStarts: 0, runtimeStops: 0, chooserCalls: 0 });
  });
  for (const [width, height] of [[1440, 940], [1280, 900], [860, 780]]) await check(`settings-all-categories-fit-${width}x${height}`, async () => {
    await resize(width, height);
    for (const [name, section] of [['模型服务', 'models'], ['编码工具', 'tools'], ['本地数据', 'data']]) {
      await tab(name).click(); await expect(panel(section)).toBeVisible(); await verifyFit();
      await tab(name).focus(); await verifyFocus();
      if (width === 860 || width === 1280 && section === 'models') {
        if (section === 'models') await screenshot(`settings-${section}-${width}x${height}-scrolled.png`);
        await scrollContentTop(); await screenshot(`settings-${section}-${width}x${height}.png`);
      }
    }
    await page.keyboard.press('Tab'); await verifyFocus();
  });
  await check('close-leaves-normal-composer-and-zero-network-or-execution-side-effects', async () => {
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible(); await expect(page.locator('.detail-panel')).toBeHidden();
    assert.equal(await page.locator('#app-shell').evaluate(node => node.inert), false);
    const saved = await page.evaluate(() => window.screendeck.bootstrap()); assert.deepEqual(saved.sessions, []); assert.deepEqual(saved.taskSessions ?? [], []); assert.deepEqual(saved.projects, []);
    assert.deepEqual(await counts(), { networkAttempts: 0, ordinarySends: 0, taskStarts: 0, runtimeStarts: 0, runtimeStops: 0, chooserCalls: 0 });
  });
  const report = { settingsLayoutSmoke: 'passed', checks, screenshots, initialSaveGeometry, temporaryRoot, ...await counts(), guardScope: 'Network guard installed after Electron launch; execution guards installed after the first screen. Counts cover settings interactions, not prelaunch/bootstrap.', limitations: ['Generated private/preview roots only; production bootstrap and settings IPC were used.', 'Only forbidden model, execution, runtime and native chooser side effects were guarded.', 'No real key, model request, OpenCode process, user data, installation or migration.'] };
  await rm(path.join(artifactRoot, 'failure.json'), { force: true }); await rm(path.join(artifactRoot, 'failure.png'), { force: true });
  await writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
} catch (error) {
  if (page) { try { await screenshot('failure.png'); } catch { /* Preserve the original failure. */ } }
  await writeFile(path.join(artifactRoot, 'failure.json'), `${JSON.stringify({ currentCheck, checks, screenshots, temporaryRoot, error: String(error).replaceAll(fixtureKey, '[synthetic-key]') }, null, 2)}\n`); throw error;
} finally { await application?.close(); }
