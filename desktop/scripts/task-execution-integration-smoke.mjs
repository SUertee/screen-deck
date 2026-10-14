import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Genuine main/preload/renderer IPC with entirely generated source and preview data.
const temp = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-task-integration-'));
const root = path.join(temp, 'project'); const privateRoot = path.join(temp, 'private'); const previewRoot = path.join(temp, 'preview');
const projectID = `project-${randomUUID()}`; const taskID = 'task-001'; const namespace = path.join(privateRoot, 'projects', projectID); const time = '2026-10-12T00:00:00.000Z';
const identity = { schema_version: 2, kind: 'project', project_id: projectID, name: '隔离模拟项目', created_at: time };
const task = { schema_version: 1, kind: 'task', project_id: projectID, task_id: taskID, title: '验证聊天授权闭环', goal: '仅使用假执行器', status: 'draft', plan_version: 1, assignee: 'human', created_at: time, updated_at: time, run_ids: [], acceptance: [{ id: 'source-preserved', description: '来源记录保持原样', verification: 'not_checked', requires_human: true }], references: [] };
const history = { schema_version: 1, kind: 'project_history', project_id: projectID, source_root: root, created_at: time, project: { schema_version: 1, kind: 'project', project_id: projectID, name: identity.name, created_at: time, timezone: 'Asia/Shanghai', mode: 'manual_pilot', references: [] }, migration: { backup_path: path.join(temp, 'unopened-backup'), migrated_at: time } };
for (const folder of [path.join(root, '.screendeck'), ...['tasks', 'runs', 'artifacts'].map(name => path.join(namespace, name)), path.join(process.cwd(), 'artifacts')]) await mkdir(folder, { recursive: true });
const source = [[path.join(root, '.screendeck', 'project.json'), identity], [path.join(namespace, 'history.json'), history], [path.join(namespace, 'tasks', `${taskID}.json`), task]];
for (const [filename, value] of source) await writeFile(filename, JSON.stringify(value));
const sourceHashes = await Promise.all(source.map(async ([filename]) => [filename, createHash('sha256').update(await readFile(filename)).digest('hex')]));
const launchEnv = { ...process.env, SCREENDECK_TEST_TASK_EXECUTION: 'simulation', SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: privateRoot, SCREENDECK_INITIAL_PROJECT: root };
delete launchEnv.ELECTRON_RUN_AS_NODE; delete launchEnv.SCREENDECK_PROVIDER_SCREENSHOT; delete launchEnv.SCREENDECK_OCR_HELPER;
let application;
const launch = () => electron.launch({ args: [process.cwd()], env: launchEnv, timeout: 30_000 });
const guard = async instance => instance.evaluate(({ net }) => {
  globalThis.__taskSmokeNetworkAttempts = 0;
  const wrap = original => (input, ...args) => { const url = typeof input === 'string' ? input : input?.url ?? String(input); if (/^https?:/i.test(url)) { globalThis.__taskSmokeNetworkAttempts++; throw new Error('Offline fixture forbids remote requests'); } return original(input, ...args); };
  globalThis.fetch = wrap(globalThis.fetch.bind(globalThis)); net.fetch = wrap(net.fetch.bind(net));
});
try {
  application = await launch(); await guard(application);
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(bootstrap.projects[0]?.status, 'ready', JSON.stringify(bootstrap.diagnostics));
  const plan = await page.evaluate(async ({ projectID, taskID }) => {
    const empty = await window.screendeck.createPlan({ title: '已保存模拟计划', scope: { project_id: projectID, task_id: taskID } });
    return window.screendeck.savePlan({ plan: { ...empty, work_items: [{ id: crypto.randomUUID(), title: '模拟一个文件成果', kind: 'implementation', assignee: 'unassigned', expected_result: '明确标注的模拟成果', dependencies: [], status: 'planned' }] }, expectedVersion: empty.version });
  }, { projectID, taskID });
  // Setup uses the real API solely in this generated test fixture. No public simulator controls.
  const prepared = await page.evaluate(async ({ projectID, taskID, plan }) => {
    const options = await window.screendeck.getTaskExecutionOptions({ projectID, taskID });
    const session = await window.screendeck.createTaskSession({ title: '已有试运行记录', projectID, taskID });
    return window.screendeck.requestExecutionAuthorization({
      planID: plan.id, expectedPlanVersion: plan.version, workItemID: plan.work_items[0].id,
      session: { format: 'task-v2', sessionID: session.conversation_id },
      clientRequestID: crypto.randomUUID(), text: '模拟一个文件成果', materialIDs: [],
      workspaceID: options.workspace.workspaceID, driverID: 'simulation-success', model: options.model,
      tools: { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] },
    });
  }, { projectID, taskID, plan });
  const ref = prepared.turn;
  let record = await page.evaluate(ref => window.screendeck.loadTaskSession(ref.session), ref);
  assert.equal(record.turns[0].state, 'prepared');
  assert.equal(record.turns[0].execution.external, undefined);
  const approval = await page.evaluate(requestID => window.screendeck.decideApproval({ requestID, choice: 'approve' }), prepared.request.id);
  record = await page.evaluate(ref => window.screendeck.loadTaskSession(ref.session), ref);
  assert.equal(record.turns[0].state, 'prepared');
  assert.equal(record.turns[0].execution.external, undefined);
  await page.evaluate(({ turn, approvalID }) => window.screendeck.startExecution({ turn, approvalID }), { turn: ref, approvalID: approval.id });
  await page.reload();
  await page.locator('.project-button').filter({ hasText: identity.name }).click();
  await page.locator('.task-shortcut').filter({ hasText: task.title }).first().click();
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: '查看试运行记录：已有试运行记录', exact: true }).click();
  await expect(page.getByRole('region', { name: '试运行历史记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许这一次', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许这一次', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送本次许可', exact: true })).toBeVisible();
  const paused = await page.evaluate(ref => window.screendeck.loadTaskSession(ref.session), ref);
  assert.equal(paused.turns[0].state, 'awaiting_permission'); assert.equal(paused.turns[0].execution.permissions[0].delivery, undefined);
  await page.screenshot({ path: path.join(process.cwd(), 'artifacts', 'task-execution-tool-approved.png') });
  await page.getByRole('button', { name: '发送本次许可', exact: true }).click();
  await expect(page.getByRole('button', { name: '接受本次成果', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '接受本次成果', exact: true }).click();
  await expect(page.getByText('你已接受这份模拟成果', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(process.cwd(), 'artifacts', 'task-execution-accepted.png') });
  const review = await page.evaluate(ref => window.screendeck.getWorkItemReview(ref), ref);
  assert.equal(review.acceptance.decision, 'accepted');
  const invalid = await page.evaluate(async ref => { try { await window.screendeck.cancelExecution({ ...ref, workspaceRoot: '/outside' }); return false; } catch (error) { return error.code === 'invalid-input'; } }, ref);
  assert.equal(invalid, true);
  assert.equal(await application.evaluate(() => globalThis.__taskSmokeNetworkAttempts), 0);
  await application.close(); application = undefined;
  application = await launch(); await guard(application);
  const restarted = await application.firstWindow();
  await expect(restarted.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
  const recovered = await restarted.evaluate(ref => window.screendeck.loadTaskSession(ref.session), ref);
  assert.equal(recovered.turns[0].state, 'finished');
  const recoveredBootstrap = await restarted.evaluate(() => window.screendeck.bootstrap());
  assert.equal(recoveredBootstrap.taskSessions[0].conversation_id, ref.session.sessionID);
  assert.equal((await restarted.evaluate(ref => window.screendeck.getWorkItemReview(ref), ref)).acceptance.decision, 'accepted');
  const settings = await restarted.evaluate(() => window.screendeck.getSettings()); assert.equal(settings.hasKey, false);
  const freshPlan = await restarted.evaluate(id => window.screendeck.bootstrap().then(state => state.plans.find(plan => plan.id === id)), plan.id);
  assert.equal(freshPlan.work_items[0].status, 'planned');
  for (const [filename, hash] of sourceHashes) assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), hash);
  assert.equal(await application.evaluate(() => globalThis.__taskSmokeNetworkAttempts), 0);
  console.log(JSON.stringify({ taskExecutionIPC: 'passed', approvalStartSeparated: true, toolDecisionDeliverySeparated: true, manualAcceptance: true, restartAcceptance: true, sourceFilesUnchanged: true, remoteAttempts: 0, temp }));
} finally { await application?.close(); }
