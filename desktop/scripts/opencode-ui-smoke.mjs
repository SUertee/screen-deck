import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Built production-default IPC/UI + a Node protocol fixture. This is NOT an
// official-binary or real-model integration test. All records and keys are synthetic.
const desktopRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-opencode-ui-'));
const projectRoot = path.join(temporaryRoot, 'project'), privateRoot = path.join(temporaryRoot, 'private'), previewRoot = path.join(temporaryRoot, 'preview');
const fixtureRoot = path.join(temporaryRoot, 'fixture'), artifactRoot = path.join(desktopRoot, 'artifacts', 'opencode-ui-smoke');
const launchHome = path.join(temporaryRoot, 'home');
const binaryPath = path.join(fixtureRoot, 'node-protocol-fixture');
const projectID = `project-${randomUUID()}`, timestamp = '2026-10-13T00:00:00.000Z';
const fixtureKey = 'gui-only-fixture-key', modelID = 'gui-fixture-model';
const providerURL = 'https://fixture.example/v1';
const identity = { schema_version: 2, kind: 'project', project_id: projectID, name: 'OpenCode GUI 隔离项目', created_at: timestamp };
const task = { schema_version: 1, kind: 'task', project_id: projectID, task_id: 'task-001', title: '验证无工具讨论授权', goal: '合成 GUI 验收任务，不读取私人数据、不调用真实模型。', status: 'draft', plan_version: 1, assignee: 'human', created_at: timestamp, updated_at: timestamp, run_ids: [], acceptance: [{ id: 'preserve-source', description: '保留源任务与普通聊天', verification: 'not_checked', requires_human: true }], references: [] };
const history = { schema_version: 1, kind: 'project_history', project_id: projectID, source_root: projectRoot, created_at: timestamp, project: { schema_version: 1, kind: 'project', project_id: projectID, name: identity.name, created_at: timestamp, timezone: 'Asia/Shanghai', mode: 'manual_pilot', references: [] }, migration: { backup_path: path.join(temporaryRoot, 'synthetic-unopened-backup'), migrated_at: timestamp } };
const conversationID = randomUUID(), ordinaryTurnID = randomUUID();
const ordinary = { schema_version: 1, conversation_id: conversationID, title: '普通聊天保持原样', scope: { kind: 'project', project_id: projectID, task_id: task.task_id }, created_at: timestamp, updated_at: timestamp, revision: 1, turns: [{ turn_id: ordinaryTurnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'saved-offline-model' }, state: 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }], messages: ['user', 'assistant'].map((role, index) => ({ message_id: randomUUID(), turn_id: ordinaryTurnID, role, text: `离线普通聊天原文 ${index + 1}`, created_at: timestamp, updated_at: timestamp })) };
const namespace = path.join(privateRoot, 'projects', projectID), ordinaryFile = path.join(previewRoot, 'sessions', '2026', '10', '13', `${conversationID}.json`);
for (const directory of [path.join(projectRoot, '.screendeck'), ...['tasks', 'runs', 'artifacts'].map(name => path.join(namespace, name)), path.dirname(ordinaryFile), fixtureRoot, artifactRoot, launchHome]) await mkdir(directory, { recursive: true });
const sources = [[path.join(projectRoot, '.screendeck', 'project.json'), identity], [path.join(namespace, 'history.json'), history], [path.join(namespace, 'tasks', 'task-001.json'), task], [ordinaryFile, ordinary]];
for (const [filename, value] of sources) await writeFile(filename, JSON.stringify(value));
const hashes = await Promise.all(sources.map(async ([filename]) => [filename, createHash('sha256').update(await readFile(filename)).digest('hex')]));
await writeFile(binaryPath, `#!${process.execPath}\n${await readFile(path.join(desktopRoot, 'tests', 'fixtures', 'opencode-ui-runtime.mjs'), 'utf8')}`, { mode: 0o700 });
const launchEnv = {};
for (const name of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) launchEnv[name] = process.env[name];
Object.assign(launchEnv, { HOME: launchHome, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: previewRoot, SCREENDECK_PROJECT_HISTORY_ROOT: privateRoot, SCREENDECK_INITIAL_PROJECT: projectRoot });

const checks = [], screenshots = []; let application, page, currentCheck = 'launch', prepared;
const check = async (name, operation) => { currentCheck = name; await operation(); checks.push(name); console.log(`PASS ${name}`); };
const screenshot = async filename => { await page.screenshot({ path: path.join(artifactRoot, filename) }); screenshots.push(filename); };
const runtimeCounts = async () => { try { return JSON.parse(await readFile(path.join(fixtureRoot, 'runtime-counts.json'), 'utf8')); } catch { return { sessionCreates: 0, promptSubmissions: 0 }; } };
const ref = () => ({ session: { format: 'task-v2', sessionID: prepared.record.conversation_id }, turnID: prepared.turn.turn_id });
const turn = () => page.evaluate(async value => (await window.screendeck.loadTaskSession(value.session)).turns.find(turn => turn.turn_id === value.turnID), ref());
const resize = async (width, height) => {
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
};
const publicStatus = async () => {
  const status = await page.evaluate(() => window.screendeck.getOpenCodeStatus());
  assert.deepEqual(Object.keys(status).sort(), status.state === 'ready' ? ['model', 'requiresRestart', 'state', 'version'] : ['state']);
  assert.equal(JSON.stringify(status).includes(fixtureKey), false); return status;
};
const saveUnverifiedModel = async modal => {
  const before = (await application.evaluate(() => globalThis.__opencodeUICounts)).modelCatalogChecks;
  await application.evaluate(() => { globalThis.__opencodeUIModelCheckAllowed = true; });
  try {
    await modal.getByRole('button', { name: '校验并保存', exact: true }).click();
    await expect(modal.getByRole('button', { name: '保存（未验证）', exact: true })).toBeEnabled();
    await expect(modal.getByRole('status').filter({ hasText: '服务不支持模型列表。' })).toBeVisible();
  } finally { await application.evaluate(() => { globalThis.__opencodeUIModelCheckAllowed = false; }); }
  await modal.getByRole('button', { name: '保存（未验证）', exact: true }).click();
  await expect(modal.getByRole('status').filter({ hasText: '连接已保存，模型未验证。' })).toBeVisible();
  await expect(modal.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await expect(modal.getByLabel('API 密钥', { exact: true })).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换');
  assert.equal((await application.evaluate(() => globalThis.__opencodeUICounts)).modelCatalogChecks, before + 1);
};

try {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
  application.process().stderr?.on('data', bytes => console.error(`[electron] ${String(bytes).replaceAll(fixtureKey, '[synthetic-key]').slice(0, 4096)}`));
  application.process().once('exit', (code, signal) => console.log(`Electron process exited: code=${code} signal=${signal}`));
  await application.evaluate(({ net, session, dialog, ipcMain }, { binaryPath, providerURL, fixtureKey }) => {
    globalThis.__opencodeUIModelCheckAllowed = false;
    globalThis.__opencodeUICounts = { chooserCalls: 0, remoteAttempts: 0, localRequests: 0, ordinarySends: 0, modelCatalogChecks: 0 };
    const wrap = original => (input, ...args) => {
      const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
      const method = String(args[0]?.method ?? input?.method ?? 'GET').toUpperCase();
      const headers = new Headers(args[0]?.headers ?? input?.headers);
      // Model-directory discovery is outside this Agent regression; fulfill only the exact synthetic request.
      if (globalThis.__opencodeUIModelCheckAllowed && url.href === providerURL + '/models' && method === 'GET' && headers.get('authorization') === 'Bearer ' + fixtureKey) {
        globalThis.__opencodeUICounts.modelCatalogChecks++; return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      if (['http:', 'https:'].includes(url.protocol)) {
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { globalThis.__opencodeUICounts.remoteAttempts++; throw new Error('GUI fixture blocks external requests.'); }
        globalThis.__opencodeUICounts.localRequests++;
      }
      return original(input, ...args);
    };
    globalThis.fetch = wrap(globalThis.fetch.bind(globalThis)); net.fetch = wrap(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const url = new URL(details.url); const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); if (!local) globalThis.__opencodeUICounts.remoteAttempts++; callback({ cancel: !local }); });
    dialog.showOpenDialog = async () => { globalThis.__opencodeUICounts.chooserCalls++; return { canceled: false, filePaths: [binaryPath] }; };
    // A click on ordinary Send would be a test failure, never a provider call.
    const install = () => { ipcMain.removeHandler('screendeck:send-message'); ipcMain.handle('screendeck:send-message', () => { globalThis.__opencodeUICounts.ordinarySends++; throw new Error('GUI smoke never submits ordinary chat.'); }); };
    globalThis.__installOpenCodeUISendGuard = install;
  }, { binaryPath, providerURL, fixtureKey });
  page = await application.firstWindow({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  await application.evaluate(() => globalThis.__installOpenCodeUISendGuard());
  await resize(1440, 940);
  const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(bootstrap.projects[0]?.status, 'ready');
  assert.deepEqual(bootstrap.sessions.find(value => value.conversation_id === conversationID), ordinary);

  await check('default-startup-has-no-runtime-or-simulation-driver', async () => {
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    assert.equal((await application.evaluate(() => globalThis.__opencodeUICounts)).chooserCalls, 0);
    const options = await page.evaluate(({ projectID, taskID }) => window.screendeck.getTaskExecutionOptions({ projectID, taskID }), { projectID, taskID: task.task_id });
    assert.equal(options.drivers.some(driver => driver.mode === 'simulation'), false);
  });
  await check('settings-save-and-explicit-choice-before-connect-verified-fixture', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole('tab', { name: 'Agent 设置', exact: true }).click();
    await expect(modal.getByRole('region', { name: 'OpenCode 执行器' }).getByText('未启动', { exact: true })).toBeVisible();
    await modal.getByRole('tab', { name: '模型服务', exact: true }).click();
    await modal.getByLabel('API 地址', { exact: true }).fill(providerURL);
    await modal.getByLabel('模型', { exact: true }).fill(modelID);
    await modal.getByLabel('API 密钥', { exact: true }).fill(fixtureKey);
    await saveUnverifiedModel(modal);
    await modal.getByRole('tab', { name: 'Agent 设置', exact: true }).click();
    await modal.getByTestId('opencode-binary-choose').click();
    await expect(modal.getByTestId('opencode-runtime-start')).toBeEnabled();
    const metadata = await runtimeCounts();
    for (const key of ['versionChecks', 'runtimeStarts', 'sessionCreates', 'promptSubmissions']) assert.equal(metadata[key] ?? 0, 0, `manual choice must not invoke ${key}`);
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    await modal.getByTestId('opencode-runtime-start').click();
    await expect(modal.getByText(`已连接 1.19.0 · ${modelID} · 无工具`, { exact: true })).toBeVisible({ timeout: 30_000 });
    assert.deepEqual(await publicStatus(), { state: 'ready', version: '1.19.0', model: { provider_id: 'screendeck', model_id: modelID }, requiresRestart: false });
    const counts = await runtimeCounts();
    assert.equal(counts.controls.independentHome, true); assert.equal(counts.controls.independentXDG, true);
    assert.equal(counts.controls.configurationWritable, false); assert.equal(counts.controls.discoveryDisabled, true); assert.equal(counts.controls.inheritedSensitiveEnvironment, false);
    assert.equal(counts.controls.providerURL, 'https://fixture.example/v1'); assert.equal(counts.promptSubmissions, 0);
    assert.equal((await application.evaluate(() => globalThis.__opencodeUICounts)).chooserCalls, 1);
    await screenshot('opencode-runtime-ready-1440x940.png');
    await modal.getByRole('button', { name: '完成', exact: true }).click();
  });
  await check('real-plan-ui-saves-discussion-without-submitting', async () => {
    await page.locator('.project-button').filter({ hasText: identity.name }).click();
    await page.locator('.task-shortcut').filter({ hasText: task.title }).click();
    await page.getByRole('tab', { name: '分工', exact: true }).click();
    await page.getByRole('button', { name: '编辑计划', exact: true }).click();
    await page.getByRole('button', { name: '添加工作项', exact: true }).click();
    await page.getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('给出可审核的讨论建议');
    await page.getByRole('combobox', { name: '工作项 1 类型', exact: true }).selectOption('discussion');
    await page.getByRole('combobox', { name: '工作项 1 分工', exact: true }).selectOption('unassigned');
    await page.getByRole('textbox', { name: '工作项 1 预期结果', exact: true }).fill('一份仅包含文本的建议，不读取项目或调用工具');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect(page.locator('.saved-status')).toContainText('已保存预览计划');
    await page.getByRole('button', { name: '收起编辑', exact: true }).click();
    await expect(page.getByRole('button', { name: '用 OpenCode 讨论', exact: true })).toBeEnabled();
    assert.equal((await runtimeCounts()).sessionCreates, 0); assert.equal((await runtimeCounts()).promptSubmissions, 0);
  });
  await check('discussion-entry-freezes-prepared-requested-model-without-any-prompt', async () => {
    await page.getByRole('button', { name: '用 OpenCode 讨论', exact: true }).click();
    await expect(page.getByRole('heading', { name: '执行授权', exact: true })).toBeVisible();
    const data = await page.evaluate(() => window.screendeck.bootstrap());
    const record = data.taskSessions.find(value => value.scope.project_id === projectID && value.scope.task_id === task.task_id);
    prepared = { record, turn: record.turns[0] };
    assert.equal(prepared.turn.state, 'prepared'); assert.equal(prepared.turn.execution.external, undefined); assert.equal(prepared.turn.execution.authorizationID, undefined);
    assert.deepEqual(prepared.turn.requested_model, { provider_id: 'screendeck', model_id: modelID });
    assert.equal(prepared.turn.execution.spec.driver.driverID, 'opencode-no-tools'); assert.equal(prepared.turn.execution.spec.driver.mode, 'external');
    assert.deepEqual(prepared.turn.execution.spec.tools, { kind: 'none' }); assert.deepEqual(prepared.turn.execution.spec.materials, []);
    await expect(page.locator('.execution-receipt')).toContainText(`请求 screendeck/${modelID}`);
    await expect(page.locator('.task-execution-history .simulation-badge')).toHaveCount(0);
    assert.equal((await runtimeCounts()).sessionCreates, 0); assert.equal((await runtimeCounts()).promptSubmissions, 0);
    await page.getByText('查看本次冻结范围', { exact: true }).click();
    await screenshot('opencode-prepared-1440x940.png');
  });
  await check('narrow-approval-keeps-explicit-decision-and-start-with-keyboard-focus', async () => {
    await resize(860, 780);
    if (await page.locator('.detail-panel').isVisible()) await page.getByRole('button', { name: '关闭任务详情', exact: true }).click({ position: { x: 12, y: 70 } });
    await expect(page.locator('.detail-panel')).toBeHidden();
    const approve = page.getByRole('button', { name: '批准这次执行', exact: true });
    await approve.focus(); await expect(approve).toBeFocused();
    await screenshot('opencode-approval-860x780.png');
    await page.keyboard.press('Enter');
    const start = page.getByRole('button', { name: '开始这次执行', exact: true });
    await expect(start).toBeVisible(); await expect(start).toBeFocused();
    const saved = await turn(); assert.equal(saved.state, 'prepared'); assert.equal(saved.execution.authorizationID, undefined); assert.equal(saved.execution.external, undefined);
    assert.equal((await runtimeCounts()).promptSubmissions, 0);
    await screenshot('opencode-approved-not-started-860x780.png');
  });
  await check('separate-start-submits-once-and-only-complete-text-is-reviewable', async () => {
    await page.getByRole('button', { name: '开始这次执行', exact: true }).click();
    await expect.poll(async () => (await turn()).state, { timeout: 30_000 }).toBe('finished');
    await expect(page.getByRole('region', { name: '执行输出', exact: true })).toContainText('GUI 夹具文本成果');
    await expect(page.getByRole('heading', { name: '执行结束，等待成果验收', exact: true })).toBeVisible();
    const saved = await turn(); assert.ok(saved.execution.authorizationID); assert.ok(saved.execution.external?.externalSubmissionID);
    const requests = await page.evaluate(value => window.screendeck.listExecutionApprovals(value), ref());
    const request = requests.find(value => value.target.kind === 'execution');
    const duplicate = await page.evaluate(({ turn, approvalID }) => window.screendeck.startExecution({ turn, approvalID }), { turn: ref(), approvalID: request.id });
    assert.equal(duplicate.status, 'already-started');
    const counts = await runtimeCounts(); assert.equal(counts.sessionCreates, 1); assert.equal(counts.promptSubmissions, 1); assert.equal(counts.eventConnections, 1);
    assert.deepEqual(counts.prompt.tools, { '*': false }); assert.equal(counts.prompt.partCount, 1);
    const messages = (await page.evaluate(value => window.screendeck.loadTaskSession(value), ref().session)).messages;
    assert.equal(counts.prompt.input, messages.find(value => value.role === 'user').text);
    const review = await page.evaluate(value => window.screendeck.getWorkItemReview(value), ref()); assert.equal(review.acceptance, undefined);
    await screenshot('opencode-text-finished-860x780.png');
  });
  await check('human-acceptance-is-separate-and-source-task-and-chat-remain-unchanged', async () => {
    await page.getByRole('textbox', { name: '验收意见（可选）', exact: true }).fill('仅接受这份 GUI 夹具文本，不代表真实工具成果。');
    await page.getByRole('button', { name: '接受本次成果', exact: true }).click();
    await expect(page.locator('.execution-review[data-decision="accepted"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: '你已接受这份文本成果', exact: true })).toBeVisible();
    const review = await page.evaluate(value => window.screendeck.getWorkItemReview(value), ref()); assert.equal(review.acceptance.decision, 'accepted');
    assert.equal((await turn()).state, 'finished');
    for (const [filename, expected] of hashes) assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), expected);
    const data = await page.evaluate(() => window.screendeck.bootstrap()); assert.deepEqual(data.sessions.find(value => value.conversation_id === conversationID), ordinary); assert.equal(data.projects[0].tasks[0].status, 'draft');
    await screenshot('opencode-text-accepted-860x780.png');
  });
  await check('explicit-runtime-close-reports-stopped-without-extra-submission', async () => {
    await resize(1440, 940);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '设置', exact: true });
    await modal.getByRole('tab', { name: 'Agent 设置', exact: true }).click();
    await modal.getByRole('button', { name: '关闭执行器', exact: true }).click();
    await expect(modal.getByRole('region', { name: 'OpenCode 执行器' }).getByText('未启动', { exact: true })).toBeVisible();
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    const counts = await runtimeCounts(); assert.equal(counts.stopped, 1); assert.equal(counts.promptSubmissions, 1); assert.equal(counts.externalModelRequests, 0); assert.equal(counts.unexpectedRoutes, 0); assert.equal(counts.directoryMismatches, 0);
    const appCounts = await application.evaluate(() => globalThis.__opencodeUICounts); assert.equal(appCounts.remoteAttempts, 0); assert.equal(appCounts.ordinarySends, 0); assert.equal(appCounts.chooserCalls, 1);
    await screenshot('opencode-runtime-stopped-1440x940.png');
  });
  const report = { opencodeUISmoke: 'passed', fixture: 'generated Node protocol server; production-default main/preload/renderer', checks, screenshots, runtimeCounts: await runtimeCounts(), appCounts: await application.evaluate(() => globalThis.__opencodeUICounts), temporaryRoot, limitations: ['Not an official OpenCode binary, model, tools, or OS sandbox test.', 'Only the exact synthetic provider models GET with its synthetic Bearer key is fulfilled locally with HTTP 404; model discovery is outside this Agent regression.', 'All tasks, history, ordinary chat, plan and credential were generated in temporary directories.', 'The native chooser is stubbed only inside this isolated Electron process; public runtime status contains no connection secrets.'] };
  await rm(path.join(artifactRoot, 'failure.json'), { force: true }); await rm(path.join(artifactRoot, 'failure.png'), { force: true });
  await writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) {
  if (page) { try { await screenshot('failure.png'); } catch { /* keep original error */ } }
  await writeFile(path.join(artifactRoot, 'failure.json'), JSON.stringify({ currentCheck, checks, screenshots, temporaryRoot, error: String(error).replaceAll(fixtureKey, '[fixture-key]') }, null, 2) + '\n'); throw error;
} finally { await application?.close(); }
