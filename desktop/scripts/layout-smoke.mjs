import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, realpath, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Genuine built Electron renderer, synthetic test-process-only IPC fixtures.
// No source project/history, credentials, model requests, or user app restarts.
const desktopRoot = process.cwd();
const isolatedRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-layout-smoke-'));
const screenshotRoot = path.join(desktopRoot, 'artifacts', 'layout-smoke');
await mkdir(screenshotRoot, { recursive: true });
const launchEnv = { ...process.env, SCREENDECK_PREVIEW_ROOT: isolatedRoot };
for (const name of ['ELECTRON_RUN_AS_NODE', 'SCREENDECK_APP_EXECUTABLE', 'SCREENDECK_INITIAL_PROJECT', 'SCREENDECK_PROVIDER_SCREENSHOT', 'SCREENDECK_OCR_HELPER', 'SCREENDECK_LIVE_SMOKE']) delete launchEnv[name];
const time = '2026-10-12T00:00:00.000Z';
const projectID = 'project-12345678-1234-1234-1234-123456789abc';
const task = {
  schema_version: 1, kind: 'task', project_id: projectID, task_id: 'task-001',
  title: '三栏布局隔离验收', goal: '导航、聊天与任务内容各自占列，顶部对齐。',
  status: 'awaiting_review', plan_version: 1, assignee: 'human', created_at: time,
  updated_at: time, run_ids: [], acceptance: [], references: [], historical: true, is_live: false,
};
const reference = {
  reference_id: 'layout-fixture-document', project_id: projectID, owner_kind: 'task',
  owner_id: task.task_id, label: '布局检查.md', path: 'layout-check.md', source: 'project', preview_type: 'text',
};
const workspace = {
  status: 'ready', project: { schema_version: 2, kind: 'project', project_id: projectID,
    name: '隔离布局测试项目', created_at: time, root_path: path.join(isolatedRoot, 'synthetic-project'),
    history_bound: true, readonly: true },
  tasks: [task], runs: [], artifact_refs: [reference], diagnostics: [], loaded_at: time, historical: true,
};
const fixture = {
  settings: { baseURL: 'https://layout-fixture.invalid/v1', modelID: 'layout-fixture-model', hasKey: false, credentialStorage: 'none' },
  projects: [workspace], sessions: [], plans: [], diagnostics: [], dataRootLabel: '离线隔离布局测试',
};
const checks = [];
const screenshots = [];
let application;
let page;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} != ${expected}`);
const screenshot = async filename => { await page.screenshot({ path: path.join(screenshotRoot, filename) }); screenshots.push(filename); };
const resize = async width => {
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 900), width);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  // CSS geometry can update before matchMedia dispatches its interaction callback.
  await expect.poll(() => page.evaluate(() => {
    const compact = !!document.querySelector('.detail-panel:not([hidden])') && matchMedia('(max-width: 960px)').matches;
    return document.getElementById('center-column').inert === compact;
  })).toBe(true);
};
const geometry = () => page.evaluate(() => {
  const rect = selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const value = node.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
  };
  const panel = document.querySelector('.detail-panel');
  const center = document.getElementById('center-column');
  return { viewport: { width: innerWidth, height: innerHeight }, brand: rect('.brand-header'), sidebar: rect('.sidebar'),
    brandMark: rect('.brand-header .brand-mark'), brandText: rect('.brand-header .brand > span:last-child'), collapse: rect('.brand-header .icon-button'), title: rect('.topbar-title'), headerActions: rect('.topbar-actions'),
    header: rect('.topbar'), center: rect('#center-column'), panel: rect('.detail-panel'), tabs: rect('.panel-tabs'), scrim: rect('.detail-scrim'),
    contextControls: [...document.querySelectorAll('.task-content-tabs button')].map(node => { const box = node.getBoundingClientRect(); return { y: box.y, bottom: box.bottom, height: box.height }; }),
    model: rect('.model-select'), send: rect('.send-button'), composer: rect('.composer'),
    panelPosition: panel ? getComputedStyle(panel).position : null, centerInert: center.inert,
    scrimVisible: getComputedStyle(document.querySelector('.detail-scrim') ?? document.body).display !== 'none',
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    surfaces: Object.fromEntries(['.brand-header', '.sidebar', '.topbar', '#center-column', '.detail-panel'].map(selector => { const style = getComputedStyle(document.querySelector(selector)); return [selector, { borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth, borderBottom: style.borderBottomWidth, topRadius: style.borderTopLeftRadius, bottomRadius: style.borderBottomLeftRadius }]; })) };
});
const split = async label => {
  const value = await geometry();
  near(value.brand.y, 0, `${label} native brand header top`);
  near(value.brand.height, 56, `${label} native brand header height`);
  for (const [name, header] of [['chat', value.header], ['context', value.tabs]]) {
    near(header.y, 8, `${label} ${name} surface top inset`);
    near(header.height, 48, `${label} ${name} inset header height`);
    near(header.bottom, 56, `${label} ${name} header joins body`);
  }
  const contentCenter = value.title.y + value.title.height / 2;
  for (const [name, box] of [['brand mark', value.brandMark], ['brand text', value.brandText], ['collapse', value.collapse], ['header actions', value.headerActions]]) { if (box.width > 0) near(box.y + box.height / 2, contentCenter, `${label} ${name} shares the title centerline`); }
  near(contentCenter, 24, `${label} native titlebar content centerline`);
  near(value.sidebar.y, 56, `${label} sidebar body top`);
  near(value.center.y, 56, `${label} chat body top`);
  near(value.panel.y, 8, `${label} context surface top`);
  near(value.panel.bottom, value.viewport.height - 8, `${label} context surface bottom`);
  near(value.center.bottom, value.viewport.height - 8, `${label} chat surface bottom`);
  near(value.brand.right + 8, value.header.x, `${label} left header gutter`);
  near(value.sidebar.right + 8, value.center.x, `${label} left body gutter`);
  near(value.header.right + 8, value.panel.x, `${label} right header gutter`);
  near(value.center.right + 8, value.panel.x, `${label} right body gutter`);
  near(value.header.x, value.center.x, `${label} continuous chat left edge`);
  near(value.header.right, value.center.right, `${label} continuous chat right edge`);
  near(value.panel.right, value.viewport.width - 8, `${label} right outer inset`);
  for (const selector of ['.brand-header', '.sidebar']) assert.equal(value.surfaces[selector].borderRight, '0px', `${label} no long sidebar rule`);
  assert.equal(value.surfaces['.topbar'].borderBottom, '0px', `${label} no line across chat`);
  assert.equal(value.surfaces['.detail-panel'].borderLeft, '0px', `${label} no long inspector rule`);
  assert.equal(value.surfaces['.topbar'].topRadius, '16px');
  assert.equal(value.surfaces['#center-column'].bottomRadius, '16px');
  assert.equal(value.surfaces['.detail-panel'].topRadius, '16px');
  for (const control of value.contextControls) { assert.ok(control.y >= value.tabs.y && control.bottom <= value.tabs.bottom, `${label} context header controls are not clipped`); assert.ok(control.height >= 44, `${label} context header target stays 44px`); }
  assert.ok(!['absolute', 'fixed'].includes(value.panelPosition), `${label} context must participate in layout`);
  assert.equal(value.centerInert, false, `${label} center remains interactive`);
  assert.equal(value.scrimVisible, false, `${label} has no overlay scrim`);
  assert.equal(value.horizontalOverflow, false, `${label} fits viewport`);
  assert.ok(value.model.right <= value.send.x + 1 || value.model.bottom <= value.send.y + 1 || value.send.bottom <= value.model.y + 1, `${label} model selection does not overlap Send`);
  for (const [name, control] of [['model', value.model], ['send', value.send]]) { assert.ok(control.x >= value.composer.x && control.right <= value.composer.right + 1, `${label} ${name} fits composer width`); assert.ok(control.y >= value.composer.y && control.bottom <= value.composer.bottom + 1, `${label} ${name} fits composer height`); }
  checks.push(label);
  return value;
};
try {
  application = await electron.launch({
    args: [desktopRoot], env: launchEnv, timeout: 30_000,
  });
  page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  // Installed only after ordinary app initialization, inside this isolated process.
  await application.evaluate(({ ipcMain, net, session }, data) => {
    globalThis.__layoutSmokeCounts = { remoteAttempts: 0, submissions: 0, previews: 0 };
    const guard = original => (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (/^https?:/i.test(url)) { globalThis.__layoutSmokeCounts.remoteAttempts++; throw new Error('Offline layout smoke blocks remote requests.'); }
      return original(input, ...args);
    };
    globalThis.fetch = guard(globalThis.fetch.bind(globalThis));
    net.fetch = guard(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      globalThis.__layoutSmokeCounts.remoteAttempts++; callback({ cancel: true });
    });
    ipcMain.removeHandler('screendeck:bootstrap');
    ipcMain.handle('screendeck:bootstrap', () => data.fixture);
    ipcMain.removeHandler('screendeck:preview-artifact');
    ipcMain.handle('screendeck:preview-artifact', (_event, input) => {
      if (input.projectID !== data.reference.project_id || input.referenceID !== data.reference.reference_id) throw new Error('Unknown test fixture reference.');
      globalThis.__layoutSmokeCounts.previews++;
      const text = '# 三栏布局检查\n这是隔离验收材料，不是用户文件。';
      return { type: 'text', reference_id: data.reference.reference_id, label: data.reference.label,
        text, mime_type: 'text/plain', byte_length: Buffer.byteLength(text) };
    });
    ipcMain.removeHandler('screendeck:send-message');
    ipcMain.handle('screendeck:send-message', () => { globalThis.__layoutSmokeCounts.submissions++; throw new Error('Layout smoke never submits messages.'); });
  }, { fixture, reference });
  await page.reload();
  await expect(page.locator('.project-button').filter({ hasText: workspace.project.name })).toBeVisible();
  await page.locator('.project-button').filter({ hasText: workspace.project.name }).click();
  await page.locator('.task-shortcut').filter({ hasText: task.title }).click();
  await expect(page.locator('.detail-heading h1')).toHaveText(task.title);
  const input = page.getByRole('textbox', { name: '输入消息', exact: true });
  for (const width of [1440, 1280, 1080]) {
    await resize(width);
    await split(`three-pane-${width}`);
    // Finish each controlled-input update and draft save before the next resize.
    await input.fill('');
    await expect(input).toHaveValue('');
    await input.fill(`布局 ${width} 输入检查`);
    await expect(input).toHaveValue(`布局 ${width} 输入检查`);
    const draftStatus = page.locator('.composer-draft-status[role="status"].visually-hidden');
    await expect(draftStatus).toHaveText('草稿已保存');
    assert.equal(await draftStatus.evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return rect.width <= 1 && rect.height <= 1 && style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)' && style.display !== 'none' && style.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true'; }), true, 'Draft status stays live without taking visible composer space.');
    await expect.poll(() => page.evaluate(key => window.screendeck.loadDraft(key), `project:${projectID}:task:${task.task_id}`)).toBe(`布局 ${width} 输入检查`);
    await screenshot(`three-pane-${width}.png`);
  }
  checks.push('center-input-at-1080');
  await resize(961);
  await split('three-pane-961-above-compact-boundary');
  await screenshot('three-pane-961.png');
  await resize(1080);
  const opened = await geometry();
  await page.getByRole('button', { name: '收起右栏', exact: true }).click();
  await expect(page.locator('.detail-panel')).toBeHidden();
  const closed = await geometry();
  near(closed.header.right, 1072, 'closed header expands to right edge');
  near(closed.center.right, 1072, 'closed body expands to right edge');
  near(closed.header.width - opened.header.width, opened.panel.width + 8, 'header absorbs closed column and gutter');
  near(closed.center.width - opened.center.width, opened.panel.width + 8, 'body absorbs closed column and gutter');
  await expect(input).toHaveValue('布局 1080 输入检查');
  await page.getByRole('button', { name: '展开右栏', exact: true }).click();
  await split('close-reopen-expands-header-and-body');
  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await split('collapsed-sidebar-three-pane');
  await screenshot('three-pane-collapsed-sidebar.png');
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await resize(1280);
  await page.locator('.artifact-link, .task-material').filter({ hasText: reference.label }).first().click();
  await expect(page.locator('.file-content pre')).toContainText('这是隔离验收材料');
  await expect(page.getByRole('tab', { name: reference.label, exact: true })).toHaveAttribute('aria-selected', 'true');
  await split('file-tab-aligned-three-pane');
  await screenshot('three-pane-file-preview.png');
  await page.getByRole('tab', { name: '任务详情', exact: true }).click();
  await expect(page.locator('.detail-heading h1')).toHaveText(task.title);
  await page.getByRole('tab', { name: '任务详情', exact: true }).focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('tab', { name: '任务详情', exact: true })).toBeFocused();
  assert.equal(await page.getByRole('tab', { name: '任务详情', exact: true }).evaluate(node => getComputedStyle(node).outlineOffset), '-3px');
  checks.push('file-tab-return-to-task');
  for (const tab of ['分工', '时间线', '交付', '概览']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  checks.push('task-content-tabs');
  for (const width of [960, 860]) {
    await resize(width);
    await expect(page.locator('#center-column')).toHaveAttribute('inert', '');
    const compact = await geometry();
    assert.ok(compact.panel.x >= compact.center.x && compact.panel.y >= 0);
    assert.equal(compact.panelPosition, 'absolute', `compact-${width} uses overlay position`);
    near(compact.panel.width, 360, `compact-${width} panel width`);
    near(compact.scrim.x, compact.center.x - 8, `compact-${width} scrim starts at chat body`);
    near(compact.scrim.x, compact.header.x - 8, `compact-${width} scrim starts at chat header`);
    near(compact.panel.right, width - 8, `compact-${width} right edge`);
    near(compact.panel.bottom, compact.viewport.height - 8, `compact-${width} bottom edge`);
    assert.equal(compact.scrimVisible, true);
    assert.equal(compact.horizontalOverflow, false);
    checks.push(`compact-${width}-drawer-in-viewport`);
    await screenshot(`compact-drawer-${width}.png`);
  }
  await resize(1080);
  await split('compact-to-desktop-clears-inert');
  await resize(860);
  await expect(page.locator('#center-column')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click({ position: { x: 12, y: 60 } });
  await expect(page.locator('.detail-panel')).toBeHidden();
  assert.equal(await input.evaluate(node => node.closest('#center-column').inert), false);
  await input.fill('窄窗关闭后可以继续输入');
  await expect(input).toHaveValue('窄窗关闭后可以继续输入');
  checks.push('compact-close-clears-inert-and-restores-input');
  await page.getByRole('button', { name: '展开右栏', exact: true }).click();
  await expect(page.locator('#center-column')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('.detail-panel')).toBeHidden();
  assert.equal(await page.locator('#center-column').evaluate(node => node.inert), false);
  checks.push('compact-escape-close');
  await resize(1440);
  await page.getByRole('button', { name: '展开右栏', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  assert.equal(await page.locator('#app-shell').evaluate(node => node.inert), true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await page.locator('#app-shell').evaluate(node => node.inert), false);
  await split('settings-modal-preserves-three-pane');
  const counts = await application.evaluate(() => globalThis.__layoutSmokeCounts);
  assert.deepEqual(counts, { remoteAttempts: 0, submissions: 0, previews: 1 });
  const report = { layoutSmoke: 'passed', isolatedRoot, checks, screenshots, ...counts,
    limitations: ['Project/task and attachment responses are synthetic IPC test fixtures.', 'No real project history, model calls, credentials, or native traffic-light screenshot verification.'] };
  await writeFile(path.join(screenshotRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await application?.close(); }
