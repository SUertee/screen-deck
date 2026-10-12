import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, realpath, mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Offline, genuine Electron integration only. Never import a key or submit a model request.
const desktopRoot = process.cwd();
const requestedProject = process.env.SCREENDECK_PROJECT_SMOKE_ROOT;
assert.ok(requestedProject && path.isAbsolute(requestedProject), 'Set SCREENDECK_PROJECT_SMOKE_ROOT to the explicit absolute project path.');
const originalProject = await realpath(requestedProject);
const sourceRecordDirectory = path.join(originalProject, '.screendeck');
const sourceIdentityFile = path.join(sourceRecordDirectory, 'project.json');
const sourceDirectoryInfo = await lstat(sourceRecordDirectory);
const sourceIdentityInfo = await lstat(sourceIdentityFile);
assert.ok(sourceDirectoryInfo.isDirectory() && !sourceDirectoryInfo.isSymbolicLink(), 'The explicit project record directory must not be a symlink.');
assert.ok(sourceIdentityInfo.isFile() && !sourceIdentityInfo.isSymbolicLink(), 'The explicit project identity must be a regular file.');
const identity = JSON.parse(await readFile(sourceIdentityFile, 'utf8'));
assert.match(identity.project_id, /^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'A stable project ID is required to locate the exact private history namespace.');
const privateHistoryRoot = path.join(os.homedir(), '.screendeck', 'projects', identity.project_id);
const isolatedRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-project-smoke-'));
const screenshotRoot = path.join(desktopRoot, 'artifacts');
await mkdir(screenshotRoot, { recursive: true });
const recordHashes = async () => {
  const result = [];
  const hashFile = async (filename, label) => { result.push([label, createHash('sha256').update(await readFile(filename)).digest('hex')]); };
  const inspect = async (filename) => {
    try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const visit = async (directory, label) => {
    const info = await inspect(directory);
    if (!info) { result.push([label, 'absent']); return; }
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Read-only source record directories must not be symlinks.');
    result.push([label, 'directory']);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const recordLabel = `${label}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), 'Read-only source record entries must not be symlinks.');
      if (entry.isDirectory()) await visit(filename, recordLabel);
      else if (entry.isFile() && entry.name.endsWith('.json')) await hashFile(filename, recordLabel);
    }
  };
  await visit(path.join(originalProject, '.screendeck'), 'project/.screendeck');
  const privateInfo = await inspect(privateHistoryRoot);
  assert.ok(!privateInfo || privateInfo.isDirectory() && !privateInfo.isSymbolicLink(), 'The exact private project namespace must not be a symlink.');
  result.push(['private', privateInfo ? 'directory' : 'absent']);
  const historyFile = path.join(privateHistoryRoot, 'history.json');
  const historyInfo = await inspect(historyFile);
  if (historyInfo) {
    assert.ok(historyInfo.isFile() && !historyInfo.isSymbolicLink(), 'The private history binding must be a regular file.');
    await hashFile(historyFile, 'private/history.json');
  } else result.push(['private/history.json', 'absent']);
  for (const folder of ['tasks', 'runs']) await visit(path.join(privateHistoryRoot, folder), `private/${folder}`);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
};
const beforeHashes = await recordHashes();
const launchEnv = { ...process.env, SCREENDECK_PREVIEW_ROOT: isolatedRoot, SCREENDECK_INITIAL_PROJECT: originalProject };
for (const name of ['ELECTRON_RUN_AS_NODE', 'SCREENDECK_PROVIDER_SCREENSHOT', 'SCREENDECK_OCR_HELPER', 'SCREENDECK_LIVE_SMOKE']) delete launchEnv[name];
const launchApplication = () => electron.launch({
  ...(process.env.SCREENDECK_APP_EXECUTABLE ? { executablePath: process.env.SCREENDECK_APP_EXECUTABLE } : {}),
  args: process.env.SCREENDECK_APP_EXECUTABLE ? [] : [desktopRoot], env: launchEnv, timeout: 30_000,
});
let application;
const screenshots = [];
const limitations = ['Page screenshots exclude native macOS traffic lights.', 'No real model requests or credentials are used in this test.'];
const installNetworkGuard = async (instance) => {
  // Test-process-only network guard; preserve local file protocol rendering.
  await instance.evaluate(({ net }) => {
    globalThis.__projectSmokeRemoteAttempts = 0;
    const guard = (original) => (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (/^https?:/i.test(url)) { globalThis.__projectSmokeRemoteAttempts++; throw new Error('Offline project smoke blocks remote requests.'); }
      return original(input, ...args);
    };
    globalThis.fetch = guard(globalThis.fetch.bind(globalThis));
    net.fetch = guard(net.fetch.bind(net));
  });
};
try {
  application = await launchApplication();
  await installNetworkGuard(application);
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  const initial = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(initial.settings.hasKey, false);
  assert.equal(initial.settings.credentialStorage, 'none');
  assert.equal(initial.sessions.length, 0);
  assert.equal(initial.plans.length, 0);
  const workspace = initial.projects.find(value => value.project?.root_path === originalProject);
  assert.ok(workspace?.project, 'Explicit original project must be registered read-only.');
  assert.equal(workspace.project.readonly, true);
  assert.ok(workspace.tasks.length, 'A real readable task is required; this test does not seed fabricated tasks.');
  const task = workspace.tasks[0];
  const projectID = workspace.project.project_id;
  assert.equal(projectID, identity.project_id);
  const originalTasks = structuredClone(workspace.tasks);
  const originalRuns = structuredClone(workspace.runs);
  const session = await page.evaluate(async ({ projectID, taskID }) => {
    const record = await window.screendeck.createSession({ title: '离线隔离验收聊天', scope: { kind: 'project', project_id: projectID, task_id: taskID } });
    await window.screendeck.saveDraft({ key: 'session:' + record.conversation_id, text: '只属于这次隔离会话的草稿。' });
    return record;
  }, { projectID, taskID: task.task_id });
  const input = page.getByRole('textbox', { name: '输入消息' });
  const recent = page.locator('.session-button').filter({ hasText: session.title });
  await recent.click();
  await expect(input).toHaveValue('只属于这次隔离会话的草稿。');
  await page.locator('.project-button').filter({ hasText: workspace.project.name }).click();
  await page.locator('.task-shortcut').filter({ hasText: task.title }).first().click();
  await expect(page.locator('.topbar-title')).toHaveText('任务讨论');
  await expect(page.locator('.session-button.active')).toHaveCount(0);
  await expect(input).not.toHaveValue('只属于这次隔离会话的草稿。');
  await expect(page.locator('.detail-heading h1')).toHaveText(task.title);
  // Only explicit recent-chat navigation restores that exact session/draft.
  await recent.click();
  await expect(recent).toHaveClass(/active/);
  await expect(input).toHaveValue('只属于这次隔离会话的草稿。');
  const detailPanel = page.locator('.detail-panel');
  if (!await detailPanel.isVisible()) await page.getByRole('button', { name: '任务详情', exact: true }).click();
  const screenshot = async (filename) => { await page.screenshot({ path: path.join(screenshotRoot, filename) }); screenshots.push(filename); };
  const assertConversation = async () => { await expect(recent).toHaveClass(/active/); await expect(input).toHaveValue('只属于这次隔离会话的草稿。'); };
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  for (const title of ['目标', '过程', '决定', '产物']) await expect(detailPanel.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(detailPanel.getByText('原记录没有单独保存决定。', { exact: true })).toBeVisible();
  await assertConversation();
  await screenshot('project-task-overview-wide.png');
  await page.getByRole('tab', { name: '分工', exact: true }).click();
  await page.getByRole('button', { name: '添加工作项', exact: true }).click();
  await page.getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('隔离验收：确认下一步分工');
  await page.getByRole('textbox', { name: '工作项 1 预期结果', exact: true }).fill('保存一项未执行的独立预览计划。');
  await page.getByRole('combobox', { name: '工作项 1 类型', exact: true }).selectOption('implementation');
  await page.getByRole('combobox', { name: '工作项 1 分工', exact: true }).selectOption('human');
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.locator('.saved-status')).toContainText('已保存预览计划', { timeout: 15_000 });
  const saved = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(saved.plans.length, 1);
  const plan = saved.plans[0];
  assert.equal(plan.kind, 'electron_preview_plan');
  assert.deepEqual(plan.scope, { project_id: projectID, task_id: task.task_id });
  assert.equal(plan.version, 2);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0].assignee, 'human');
  assert.equal(plan.work_items[0].status, 'planned');
  assert.equal(plan.work_items[0].model, undefined);
  assert.equal('task_id' in plan, false);
  await page.getByRole('button', { name: '规则建议', exact: true }).click();
  await expect(page.locator('.plan-suggestion')).toBeVisible();
  await assertConversation();
  await screenshot('project-task-division-wide.png');
  for (const [tab, filename] of [['时间线', 'project-task-timeline-wide.png'], ['交付', 'project-task-delivery-wide.png']]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await assertConversation();
    await screenshot(filename);
  }
  let artifactPreview = 'not-available';
  await page.getByRole('tab', { name: '交付', exact: true }).click();
  const readable = workspace.artifact_refs.filter(ref => ref.preview_type !== 'unsupported' && (ref.owner_kind === 'task' && ref.owner_id === task.task_id || ref.owner_kind === 'run' && workspace.runs.some(run => run.run_id === ref.owner_id && run.task_id === task.task_id)));
  for (const reference of readable) {
    const link = page.locator('.artifact-link').filter({ hasText: reference.label }).first();
    if (!await link.isVisible()) { await page.getByRole('tab', { name: '概览', exact: true }).click(); }
    const candidate = page.locator('.artifact-link').filter({ hasText: reference.label }).first();
    if (!await candidate.isVisible()) continue;
    await candidate.click();
    await expect.poll(async () => page.locator('.file-content pre, .file-content img, .file-content .notice').count()).toBeGreaterThan(0);
    if (await page.locator('.file-content .notice').count()) { limitations.push('Registered attachment could not be read: ' + await page.locator('.file-content .notice').innerText()); break; }
    await expect(page.locator('.file-header')).toContainText(reference.label);
    await assertConversation();
    artifactPreview = 'passed';
    await screenshot('project-attachment-preview-wide.png');
    await page.getByRole('tab', { name: '任务详情', exact: true }).click();
    break;
  }
  if (artifactPreview === 'not-available') limitations.push('No visible readable task/run attachment was available for this selected real task.');
  await page.getByRole('tab', { name: '任务详情', exact: true }).click();
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860, 800));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(860);
  await expect(page.locator('#center-column')).toHaveAttribute('inert', '');
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('.detail-panel').getBoundingClientRect();
    const header = document.querySelector('.topbar').getBoundingClientRect();
    const send = document.querySelector('.send-button').getBoundingClientRect();
    const model = document.querySelector('.model-select').getBoundingClientRect();
    const tabs = document.querySelector('.detail-tabs').getBoundingClientRect();
    return { viewport: innerWidth, panel: { left: panel.left, right: panel.right, top: panel.top, width: panel.width }, headerBottom: header.bottom, overlap: model.right > send.left, tabsInside: tabs.left >= panel.left && tabs.right <= panel.right, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(geometry.panel.right, 860);
  assert.equal(geometry.panel.width, 360);
  assert.equal(geometry.panel.top, 0);
  assert.equal(geometry.overlap, false);
  assert.equal(geometry.tabsInside, true);
  assert.equal(geometry.horizontalOverflow, false);
  await assertConversation();
  await screenshot('project-task-overview-narrow.png');
  await page.getByRole('tab', { name: '分工', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue(plan.work_items[0].title);
  await screenshot('project-task-division-narrow.png');
  await page.getByRole('button', { name: '关闭详情面板', exact: true }).click();
  await expect(page.locator('.detail-panel')).toHaveCount(0);
  assert.equal(await page.locator('#center-column').evaluate(node => node.inert), false);
  await assertConversation();
  const refreshed = await page.evaluate(id => window.screendeck.refreshProject(id), projectID);
  assert.deepEqual(refreshed.tasks, originalTasks);
  assert.deepEqual(refreshed.runs, originalRuns);
  const finalState = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(finalState.settings.hasKey, false);
  assert.equal(finalState.sessions.length, 1);
  assert.equal(finalState.sessions[0].conversation_id, session.conversation_id);
  assert.equal(finalState.sessions[0].turns.length, 0);
  assert.equal(finalState.sessions[0].messages.length, 0);
  assert.deepEqual(finalState.plans[0].work_items, plan.work_items);
  // A genuine standalone legacy-format plan is not automatically assigned to any task.
  const legacyPlan = await page.evaluate(() => window.screendeck.createPlan({ title: '独立旧格式计划，不自动归属任务' }));
  assert.equal(legacyPlan.scope, undefined);
  assert.equal(await application.evaluate(() => globalThis.__projectSmokeRemoteAttempts), 0);
  await application.close(); application = undefined;
  application = await launchApplication();
  await installNetworkGuard(application);
  const restarted = await application.firstWindow();
  await expect(restarted.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  const recovered = await restarted.evaluate(() => window.screendeck.bootstrap());
  assert.equal(recovered.settings.hasKey, false);
  const recoveredPlan = recovered.plans.find(value => value.id === plan.id);
  assert.deepEqual(recoveredPlan.scope, { project_id: projectID, task_id: task.task_id });
  assert.deepEqual(recoveredPlan.work_items, plan.work_items);
  await restarted.locator('.project-button').filter({ hasText: workspace.project.name }).click();
  await restarted.locator('.task-shortcut').filter({ hasText: task.title }).first().click();
  await restarted.getByRole('tab', { name: '分工', exact: true }).click();
  await expect(restarted.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue(plan.work_items[0].title);
  await expect(restarted.locator('#existing-plan')).toHaveValue(plan.id);
  await expect(restarted.locator('#existing-plan option')).toHaveCount(2);
  await expect(restarted.locator('#existing-plan option').filter({ hasText: legacyPlan.title })).toHaveCount(0);
  if (workspace.tasks[1]) {
    await restarted.locator('.task-shortcut').filter({ hasText: workspace.tasks[1].title }).first().click();
    await restarted.getByRole('tab', { name: '分工', exact: true }).click();
    await expect(restarted.locator('#existing-plan')).toHaveCount(0);
    await expect(restarted.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveCount(0);
  }
  await restarted.evaluate(({ projectID, taskID }) => window.screendeck.createPlan({ title: '同任务第二份预览计划，必须显式选择', scope: { project_id: projectID, task_id: taskID } }), { projectID, taskID: task.task_id });
  assert.equal(await application.evaluate(() => globalThis.__projectSmokeRemoteAttempts), 0);
  await application.close(); application = undefined;
  application = await launchApplication();
  await installNetworkGuard(application);
  const multiple = await application.firstWindow();
  await expect(multiple.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  await multiple.locator('.project-button').filter({ hasText: workspace.project.name }).click();
  await multiple.locator('.task-shortcut').filter({ hasText: task.title }).first().click();
  await multiple.getByRole('tab', { name: '分工', exact: true }).click();
  await expect(multiple.locator('#existing-plan')).toHaveValue('');
  await expect(multiple.locator('#existing-plan option')).toHaveCount(3);
  await expect(multiple.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveCount(0);
  await multiple.locator('#existing-plan').selectOption(plan.id);
  await expect(multiple.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue(plan.work_items[0].title);
  assert.equal(await application.evaluate(() => globalThis.__projectSmokeRemoteAttempts), 0);
  await application.close(); application = undefined;
  assert.deepEqual(await recordHashes(), beforeHashes);
  console.log(JSON.stringify({ projectSmoke: 'passed', isolatedRoot, taskCount: workspace.tasks.length, runCount: workspace.runs.length, sourceRecordsUnchanged: true, sourceRecordHashCount: beforeHashes.filter(([, digest]) => digest !== 'absent' && digest !== 'directory').length, privateHistoryHashed: true, stableConversation: true, previewPlan: 'saved-not-executed', restartPlanAssociation: 'passed', otherTaskPlanIsolation: workspace.tasks[1] ? 'passed' : 'not-available', legacyUnscopedPlanExcluded: true, multiplePlansRequireExplicitSelection: true, artifactPreview, narrowDrawer: geometry, remoteAttempts: 0, screenshots, limitations }));
} finally { await application?.close(); }
