import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Built production-default IPC/UI + a Node SDK 1.8 ACP v1 fixture. This is NOT an
// official-binary or real-model integration test. All records and keys are synthetic.
const desktopRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-opencode-acp-ui-'));
const projectRoot = path.join(temporaryRoot, 'project'), privateRoot = path.join(temporaryRoot, 'private'), previewRoot = path.join(temporaryRoot, 'preview');
const fixtureRoot = path.join(temporaryRoot, 'fixture'), artifactRoot = path.join(desktopRoot, 'artifacts', 'opencode-acp-ui-smoke');
const launchHome = path.join(temporaryRoot, 'home');
const binaryPath = path.join(fixtureRoot, 'node-acp-fixture.mjs');
const projectID = `project-${randomUUID()}`, timestamp = '2026-10-13T00:00:00.000Z';
const fixtureKey = 'gui-only-fixture-key', modelID = 'gui-fixture-model';
const identity = { schema_version: 2, kind: 'project', project_id: projectID, name: 'ACP GUI 隔离项目', created_at: timestamp };
const task = { schema_version: 1, kind: 'task', project_id: projectID, task_id: 'task-001', title: '验证无工具讨论授权', goal: '合成 GUI 验收任务，不读取私人数据、不调用真实模型。', status: 'draft', plan_version: 1, assignee: 'human', created_at: timestamp, updated_at: timestamp, run_ids: [], acceptance: [{ id: 'preserve-source', description: '保留源任务与普通聊天', verification: 'not_checked', requires_human: true }], references: [] };
const tasks = [task, ...['验证 ACP 显式失败', '验证 ACP 取消终结', '验证 ACP 断连未知', '读取旧 HTTP 执行记录', '验证 ACP RPC 错误脱敏'].map((title, index) => ({ ...task, task_id: 'task-00' + (index + 2), title }))];
const history = { schema_version: 1, kind: 'project_history', project_id: projectID, source_root: projectRoot, created_at: timestamp, project: { schema_version: 1, kind: 'project', project_id: projectID, name: identity.name, created_at: timestamp, timezone: 'Asia/Shanghai', mode: 'manual_pilot', references: [] }, migration: { backup_path: path.join(temporaryRoot, 'synthetic-unopened-backup'), migrated_at: timestamp } };
const conversationID = randomUUID(), ordinaryTurnID = randomUUID();
const ordinary = { schema_version: 1, conversation_id: conversationID, title: '普通聊天保持原样', scope: { kind: 'project', project_id: projectID, task_id: task.task_id }, created_at: timestamp, updated_at: timestamp, revision: 1, turns: [{ turn_id: ordinaryTurnID, client_request_id: randomUUID(), requested_model: { provider_id: 'synthetic', model_id: 'saved-offline-model' }, state: 'finished', created_at: timestamp, updated_at: timestamp, draft_revision: 0 }], messages: ['user', 'assistant'].map((role, index) => ({ message_id: randomUUID(), turn_id: ordinaryTurnID, role, text: `离线普通聊天原文 ${index + 1}`, created_at: timestamp, updated_at: timestamp })) };
const namespace = path.join(privateRoot, 'projects', projectID), ordinaryFile = path.join(previewRoot, 'sessions', '2026', '10', '13', `${conversationID}.json`);
for (const directory of [path.join(projectRoot, '.screendeck'), ...['tasks', 'runs', 'artifacts'].map(name => path.join(namespace, name)), path.dirname(ordinaryFile), fixtureRoot, artifactRoot, launchHome]) await mkdir(directory, { recursive: true });
const sources = [[path.join(projectRoot, '.screendeck', 'project.json'), identity], [path.join(namespace, 'history.json'), history], ...tasks.map(value => [path.join(namespace, 'tasks', value.task_id + '.json'), value]), [ordinaryFile, ordinary]];
for (const [filename, value] of sources) await writeFile(filename, JSON.stringify(value));
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const legacyRecord = state => {
  const sessionID = randomUUID(), turnID = randomUUID(), inputID = randomUUID(), model = { provider_id: 'screendeck', model_id: 'saved-http-model' }, text = '原 HTTP 冻结输入。';
  const spec = { work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: '旧 HTTP ' + state, kind: 'discussion', expectedResult: '已保存的 HTTP 文本。', dependencies: [], inputMessageID: inputID, materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: 'a'.repeat(64) }, driver: { driverID: 'opencode-no-tools', mode: 'external', configDigest: 'b'.repeat(64) }, tools: { kind: 'none' } };
  const execution = { spec, specDigest: digest({ spec, model, text }), authorizationID: randomUUID(), external: { runtimeID: 'legacy_http_runtime', connectionGeneration: 'legacy_http_generation', externalSessionID: 'legacy_http_session_' + state, externalSubmissionID: 'legacy_http_message_' + state }, eventReceipts: [], permissions: [] };
  if (state === 'finished') execution.result = { summary: '原 HTTP 文本已完成。', artifacts: [], evidence: [] };
  return { schema_version: 2, kind: 'electron_task_session', conversation_id: sessionID, title: '旧 HTTP ' + state, scope: { kind: 'project', project_id: projectID, task_id: tasks[4].task_id }, created_at: timestamp, updated_at: timestamp, revision: 1, turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: model, state, created_at: timestamp, updated_at: timestamp, draft_revision: 0, execution }], messages: [{ message_id: inputID, turn_id: turnID, role: 'user', text, created_at: timestamp, updated_at: timestamp }, { message_id: randomUUID(), turn_id: turnID, role: 'assistant', text: state === 'finished' ? '原 HTTP 助手正文，保持可读。' : '原 HTTP 未完成片段。', created_at: timestamp, updated_at: timestamp }] };
};
const legacyFinished = legacyRecord('finished'), legacyUnknown = legacyRecord('unknown');
await mkdir(path.join(previewRoot, 'task-sessions-v2'), { recursive: true });
for (const record of [legacyFinished, legacyUnknown]) await writeFile(path.join(previewRoot, 'task-sessions-v2', record.conversation_id + '.json'), JSON.stringify(record));
const hashes = await Promise.all(sources.map(async ([filename]) => [filename, createHash('sha256').update(await readFile(filename)).digest('hex')]));
const sdkURL = pathToFileURL(path.join(desktopRoot, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')).href;
await writeFile(binaryPath, '#!' + process.execPath + '\n' + 'globalThis.__SCREENDECK_ACP_FIXTURE_SDK_URL = ' + JSON.stringify(sdkURL) + ';\n' + await readFile(path.join(desktopRoot, 'tests', 'fixtures', 'opencode-acp-ui-runtime.mjs'), 'utf8'), { mode: 0o700 });
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
const thread = () => page.locator('.task-execution-history');
const turnRef = record => ({ session: { format: 'task-v2', sessionID: record.conversation_id }, turnID: record.turns[0].turn_id });
const stateOf = reference => page.evaluate(async value => (await window.screendeck.loadTaskSession(value.session)).turns.find(item => item.turn_id === value.turnID), reference);
const waitState = (reference, state) => expect.poll(async () => (await stateOf(reference)).state, { timeout: 30_000 }).toBe(state);
const selectTask = async index => {
  await resize(1440, 940);
  const shortcut = page.locator('.task-shortcut').filter({ hasText: tasks[index].title });
  if (!await shortcut.isVisible()) await page.locator('.project-button').filter({ hasText: identity.name }).click();
  await shortcut.click();
  if (await page.getByRole('button', { name: '展开右栏', exact: true }).isVisible()) await page.getByRole('button', { name: '展开右栏', exact: true }).click();
};
const openHistory = async (index, record) => {
  await selectTask(index);
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: '查看试运行记录：' + record.title, exact: true }).click();
  await expect(thread()).toBeVisible();
};
const prepareScenario = async (index, marker) => {
  const result = await page.evaluate(async ({ projectID, taskID, title, marker }) => {
    const api = window.screendeck, options = await api.getTaskExecutionOptions({ projectID, taskID });
    const empty = await api.createPlan({ title, scope: { project_id: projectID, task_id: taskID } });
    const plan = await api.savePlan({ plan: { ...empty, work_items: [{ id: crypto.randomUUID(), title, kind: 'discussion', assignee: 'unassigned', expected_result: '仅合成文本，无工具。', dependencies: [], status: 'planned' }] }, expectedVersion: empty.version });
    const record = await api.createTaskSession({ title, projectID, taskID });
    const authorization = await api.requestExecutionAuthorization({ planID: plan.id, expectedPlanVersion: plan.version, workItemID: plan.work_items[0].id, session: { format: 'task-v2', sessionID: record.conversation_id }, clientRequestID: crypto.randomUUID(), text: marker + ' 仅使用本次合成输入，不读取项目或使用工具。', materialIDs: [], workspaceID: options.workspace.workspaceID, driverID: 'opencode-acp-no-tools', model: options.model, tools: { kind: 'none' } });
    return { record, ...authorization };
  }, { projectID, taskID: tasks[index].task_id, title: tasks[index].title, marker });
  assert.equal((await stateOf(result.turn)).state, 'prepared');
  const before = (await runtimeCounts()).promptSubmissions;
  await page.evaluate(value => window.screendeck.decideApproval({ requestID: value, choice: 'approve' }), result.request.id);
  assert.equal((await runtimeCounts()).promptSubmissions, before);
  await page.evaluate(value => window.screendeck.startExecution({ turn: value.turn, approvalID: value.request.id }), result);
  return result;
};
const assertNoPublicSecrets = async () => {
  const publicData = await page.evaluate(async () => ({ bootstrap: await window.screendeck.bootstrap(), settings: await window.screendeck.getSettings(), status: await window.screendeck.getOpenCodeStatus(), events: window.__acpPublicEvents ?? [] }));
  assert.equal(JSON.stringify(publicData).includes(fixtureKey), false, 'public IPC/event data must not expose the synthetic main-process key');
  assert.equal((await page.locator('body').innerText()).includes(fixtureKey), false, 'rendered errors must be sanitized');
};

const installGuards = async instance => { await instance.evaluate(({ net, session, dialog, ipcMain }, binaryPath) => {
    globalThis.__opencodeAcpUICounts = { chooserCalls: 0, remoteAttempts: 0, localRequests: 0, ordinarySends: 0 };
    const wrap = original => (input, ...args) => {
      const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
      if (['http:', 'https:'].includes(url.protocol)) {
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { globalThis.__opencodeAcpUICounts.remoteAttempts++; throw new Error('GUI fixture blocks external requests.'); }
        globalThis.__opencodeAcpUICounts.localRequests++; throw new Error('ACP stdio fixture forbids HTTP.');
      }
      return original(input, ...args);
    };
    globalThis.fetch = wrap(globalThis.fetch.bind(globalThis)); net.fetch = wrap(net.fetch.bind(net));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { const url = new URL(details.url); const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); if (!local) globalThis.__opencodeAcpUICounts.remoteAttempts++; callback({ cancel: true }); });
    dialog.showOpenDialog = async () => { globalThis.__opencodeAcpUICounts.chooserCalls++; return { canceled: false, filePaths: [binaryPath] }; };
    // A click on ordinary Send would be a test failure, never a provider call.
    const install = () => { ipcMain.removeHandler('screendeck:send-message'); ipcMain.handle('screendeck:send-message', () => { globalThis.__opencodeAcpUICounts.ordinarySends++; throw new Error('GUI smoke never submits ordinary chat.'); }); };
    globalThis.__installOpenCodeUISendGuard = install;
  }, binaryPath); };

try {
  application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
  application.process().stderr?.on('data', bytes => console.error(`[electron] ${String(bytes).replaceAll(fixtureKey, '[synthetic-key]').slice(0, 4096)}`));
  application.process().once('exit', (code, signal) => console.log(`Electron process exited: code=${code} signal=${signal}`));
  await installGuards(application);
  page = await application.firstWindow({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
  await application.evaluate(() => globalThis.__installOpenCodeUISendGuard());
  await page.evaluate(() => { window.__acpPublicEvents = []; window.screendeck.onTaskSessionEvent(event => window.__acpPublicEvents.push(event)); });
  await resize(1440, 940);
  const bootstrap = await page.evaluate(() => window.screendeck.bootstrap());
  assert.equal(bootstrap.projects[0]?.status, 'ready');
  assert.deepEqual(bootstrap.sessions.find(value => value.conversation_id === conversationID), ordinary);

  await check('default-startup-has-no-runtime-or-simulation-driver', async () => {
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    assert.equal((await application.evaluate(() => globalThis.__opencodeAcpUICounts)).chooserCalls, 0);
    const options = await page.evaluate(({ projectID, taskID }) => window.screendeck.getTaskExecutionOptions({ projectID, taskID }), { projectID, taskID: task.task_id });
    assert.equal(options.drivers.some(driver => driver.mode === 'simulation'), false);
  });
  await check('settings-save-and-explicit-choice-before-connect-verified-fixture', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole('tab', { name: '编码工具', exact: true }).click();
    await expect(modal.getByRole('region', { name: 'OpenCode 执行器' }).getByText('未启动', { exact: true })).toBeVisible();
    await modal.getByRole('tab', { name: '模型服务', exact: true }).click();
    await modal.getByLabel('API 地址', { exact: true }).fill('https://fixture.example/v1');
    await modal.getByLabel('模型名称', { exact: true }).fill(modelID);
    await modal.getByLabel('API 密钥', { exact: true }).fill(fixtureKey);
    await modal.getByLabel('记住 API 密钥', { exact: true }).uncheck();
    await modal.getByRole('button', { name: '保存连接', exact: true }).click();
    await modal.getByRole('tab', { name: '编码工具', exact: true }).click();
    await modal.getByTestId('opencode-binary-choose').click();
    await expect(modal.getByTestId('opencode-runtime-start')).toBeEnabled();
    const metadata = await runtimeCounts();
    for (const key of ['versionChecks', 'configChecks', 'acpStarts', 'sessionCreates', 'promptSubmissions']) assert.equal(metadata[key] ?? 0, 0, `manual choice must not invoke ${key}`);
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    await modal.getByTestId('opencode-runtime-start').click();
    await expect(modal.getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0', { timeout: 30_000 });
    await expect(modal.getByTestId('opencode-runtime-status')).toContainText(modelID);
    await expect(modal.getByRole('tabpanel', { name: '编码工具', exact: true })).toContainText('ACP v1');
    assert.deepEqual(await publicStatus(), { state: 'ready', version: '1.19.0', model: { provider_id: 'screendeck', model_id: modelID }, requiresRestart: false });
    const counts = await runtimeCounts();
    assert.equal(counts.controls.independentHome, true); assert.equal(counts.controls.independentXDG, true);
    assert.equal(counts.controls.configurationWritable, false); assert.equal(counts.controls.discoveryDisabled, true); assert.equal(counts.controls.inheritedSensitiveEnvironment, false);
    assert.equal(counts.controls.titleDisabled, true, 'the controlled ACP configuration must disable background title generation');
    assert.equal(counts.controls.providerURL, 'https://fixture.example/v1'); assert.equal(counts.promptSubmissions, 0);
    assert.equal((await application.evaluate(() => globalThis.__opencodeAcpUICounts)).chooserCalls, 1);
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
    assert.equal(prepared.turn.execution.spec.driver.driverID, 'opencode-acp-no-tools'); assert.equal(prepared.turn.execution.spec.driver.mode, 'external');
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
    const saved = await turn(); assert.ok(saved.execution.authorizationID); assert.ok(saved.execution.external?.externalSessionID); assert.equal(saved.execution.external.externalSubmissionID, undefined);
    const requests = await page.evaluate(value => window.screendeck.listExecutionApprovals(value), ref());
    const request = requests.find(value => value.target.kind === 'execution');
    const duplicate = await page.evaluate(({ turn, approvalID }) => window.screendeck.startExecution({ turn, approvalID }), { turn: ref(), approvalID: request.id });
    assert.equal(duplicate.status, 'already-started');
    const counts = await runtimeCounts(); assert.equal(counts.sessionCreates, 1); assert.equal(counts.promptSubmissions, 1); assert.equal(counts.modelSelections, 1);
    assert.equal(counts.controls.toolPolicyDenied, true); assert.equal(counts.lastPrompt.partCount, 1); assert.equal(counts.lastPrompt.hasMessageID, false);
    const messages = (await page.evaluate(value => window.screendeck.loadTaskSession(value), ref().session)).messages;
    assert.equal(counts.lastPrompt.input, messages.find(value => value.role === 'user').text);
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
    await modal.getByRole('tab', { name: '编码工具', exact: true }).click();
    await modal.getByRole('button', { name: '关闭执行器', exact: true }).click();
    await expect(modal.getByRole('region', { name: 'OpenCode 执行器' }).getByText('未启动', { exact: true })).toBeVisible();
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    const counts = await runtimeCounts(); assert.equal(counts.stopped, 1); assert.equal(counts.promptSubmissions, 1); assert.equal(counts.externalModelRequests, 0); assert.deepEqual(counts.protocolProblems, []); assert.equal(counts.loadCalls, 0);
    const appCounts = await application.evaluate(() => globalThis.__opencodeAcpUICounts); assert.equal(appCounts.remoteAttempts, 0); assert.equal(appCounts.ordinarySends, 0); assert.equal(appCounts.chooserCalls, 1);
    await screenshot('opencode-runtime-stopped-1440x940.png');
  });
  await check('remembered-explicit-acp-reconnect-does-not-open-chooser-or-prompt', async () => {
    const modal = page.getByRole('dialog', { name: '设置', exact: true });
    await modal.getByTestId('opencode-runtime-start').click();
    await expect(modal.getByTestId('opencode-runtime-status')).toContainText('已连接 1.19.0', { timeout: 30_000 });
    assert.equal((await runtimeCounts()).promptSubmissions, 1);
    assert.equal((await application.evaluate(() => globalThis.__opencodeAcpUICounts)).chooserCalls, 1);
    await modal.getByRole('button', { name: '完成', exact: true }).click();
  });
  await check('old-http-records-remain-readable-and-never-enter-the-acp-connection', async () => {
    const before = await runtimeCounts();
    const finishedRef = turnRef(legacyFinished), unknownRef = turnRef(legacyUnknown);
    const loaded = await page.evaluate(value => window.screendeck.loadTaskSession(value), finishedRef.session);
    assert.deepEqual(loaded, legacyFinished);
    await openHistory(4, legacyFinished);
    await expect(thread().getByRole('region', { name: '执行输出', exact: true })).toContainText('原 HTTP 助手正文，保持可读。');
    const review = await page.evaluate(value => window.screendeck.getWorkItemReview(value), finishedRef);
    assert.equal(review.acceptance, undefined); assert.deepEqual(review.result, legacyFinished.turns[0].execution.result);
    await openHistory(4, legacyUnknown);
    await thread().getByRole('button', { name: '核对原尝试', exact: true }).click();
    await expect(thread().locator('.execution-unknown')).toBeVisible();
    const unknown = await stateOf(unknownRef);
    assert.equal(unknown.state, 'unknown'); assert.deepEqual(unknown.execution.external, legacyUnknown.turns[0].execution.external); assert.equal(unknown.execution.result, undefined);
    const after = await runtimeCounts();
    for (const key of ['sessionCreates', 'promptSubmissions', 'loadCalls', 'cancelNotifications']) assert.equal(after[key], before[key]);
    assert.equal(after.legacyBindingSeen, false);
    await screenshot('acp-legacy-http-readable-1440x940.png');
  });
  await check('acp-refusal-is-an-explicit-failure-without-a-reviewable-result', async () => {
    const scenario = await prepareScenario(1, '[fixture:refusal]');
    await waitState(scenario.turn, 'failed');
    assert.equal((await stateOf(scenario.turn)).execution.result, undefined);
    await openHistory(1, scenario.record);
    await expect(thread().locator('.execution-attempt[data-state="failed"]')).toBeVisible();
    await expect(thread().getByRole('button', { name: '接受本次成果', exact: true })).toHaveCount(0);
    assert.equal((await runtimeCounts()).refusals, 1);
    await screenshot('acp-refusal-failed-1440x940.png');
  });
  await check('acp-rpc-failure-never-becomes-reviewable-or-exposes-the-key', async () => {
    const scenario = await prepareScenario(5, '[fixture:failure]');
    await expect.poll(async () => ['failed', 'unknown'].includes((await stateOf(scenario.turn)).state), { timeout: 30_000 }).toBe(true);
    const saved = await stateOf(scenario.turn);
    assert.equal(saved.execution.result, undefined);
    await openHistory(5, scenario.record);
    await expect(thread().getByRole('button', { name: '接受本次成果', exact: true })).toHaveCount(0);
    await assertNoPublicSecrets(); assert.equal((await runtimeCounts()).failures, 1);
    await screenshot('acp-error-not-reviewable-1440x940.png');
  });
  await check('acp-cancel-notification-only-confirms-after-the-original-cancelled-response', async () => {
    const scenario = await prepareScenario(2, '[fixture:hold]');
    await waitState(scenario.turn, 'running');
    await openHistory(2, scenario.record);
    await expect(thread().getByRole('region', { name: '执行输出', exact: true })).toContainText('等待取消的合成片段');
    await thread().getByRole('button', { name: '停止这次执行', exact: true }).click();
    await waitState(scenario.turn, 'cancelled');
    const counts = await runtimeCounts();
    assert.equal(counts.cancelNotifications, 1); assert.equal(counts.cancelledResponses, 1);
    assert.equal((await stateOf(scenario.turn)).execution.result, undefined);
    await expect(thread().getByRole('button', { name: '接受本次成果', exact: true })).toHaveCount(0);
    await screenshot('acp-cancelled-confirmed-1440x940.png');
  });
  let disconnected;
  await check('acp-disconnect-stays-unknown-and-does-not-resend-or-load', async () => {
    disconnected = await prepareScenario(3, '[fixture:disconnect]');
    await waitState(disconnected.turn, 'unknown');
    await openHistory(3, disconnected.record);
    const saved = await stateOf(disconnected.turn), before = await runtimeCounts();
    assert.ok(saved.execution.external.externalSessionID); assert.equal(saved.execution.external.externalSubmissionID, undefined);
    assert.equal(saved.execution.result, undefined);
    await thread().getByRole('button', { name: '核对原尝试', exact: true }).click();
    await waitState(disconnected.turn, 'unknown');
    const receipt = await page.evaluate(value => window.screendeck.startExecution({ turn: value.turn, approvalID: value.request.id }), disconnected);
    assert.equal(receipt.status, 'unknown');
    const after = await runtimeCounts();
    for (const key of ['sessionCreates', 'promptSubmissions', 'loadCalls']) assert.equal(after[key], before[key]);
    await expect(thread().getByRole('button', { name: '接受本次成果', exact: true })).toHaveCount(0);
    await screenshot('acp-disconnected-unknown-1440x940.png');
  });
  let beforeRestartCounts;
  await check('app-restart-preserves-acp-unknown-and-http-history-without-restarting-or-replaying', async () => {
    const original = await stateOf(disconnected.turn);
    beforeRestartCounts = await application.evaluate(() => globalThis.__opencodeAcpUICounts);
    const before = await runtimeCounts();
    await application.close(); application = undefined;
    application = await electron.launch({ args: [desktopRoot], env: launchEnv, timeout: 30_000 });
    await installGuards(application);
    page = await application.firstWindow({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible({ timeout: 30_000 });
    await application.evaluate(() => globalThis.__installOpenCodeUISendGuard());
    await page.evaluate(() => { window.__acpPublicEvents = []; window.screendeck.onTaskSessionEvent(event => window.__acpPublicEvents.push(event)); });
    assert.deepEqual(await publicStatus(), { state: 'stopped' });
    const recovered = await stateOf(disconnected.turn);
    assert.equal(recovered.state, 'unknown'); assert.deepEqual(recovered.execution.external, original.execution.external); assert.deepEqual(recovered.execution.spec, original.execution.spec);
    await openHistory(3, disconnected.record);
    await thread().getByRole('button', { name: '核对原尝试', exact: true }).click();
    assert.equal((await stateOf(disconnected.turn)).state, 'unknown');
    const old = await page.evaluate(value => window.screendeck.loadTaskSession(value), turnRef(legacyFinished).session);
    assert.deepEqual(old, legacyFinished); assert.equal((await stateOf(turnRef(legacyUnknown))).state, 'unknown');
    const after = await runtimeCounts();
    for (const key of ['acpStarts', 'sessionCreates', 'promptSubmissions', 'loadCalls']) assert.equal(after[key], before[key]);
    assert.equal(after.legacyBindingSeen, false);
    await screenshot('acp-restart-no-replay-1440x940.png');
  });
  await check('public-data-and-source-records-remain-isolated-after-all-acp-boundaries', async () => {
    await assertNoPublicSecrets();
    for (const [filename, expected] of hashes) assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), expected);
    const data = await page.evaluate(() => window.screendeck.bootstrap());
    assert.deepEqual(data.sessions.find(value => value.conversation_id === conversationID), ordinary);
    assert.equal(data.projects[0].tasks.every(value => value.status === 'draft'), true);
    const counts = await runtimeCounts();
    assert.equal(counts.promptSubmissions, 5); assert.equal(counts.sessionCreates, 5); assert.equal(counts.externalModelRequests, 0); assert.equal(counts.loadCalls, 0); assert.deepEqual(counts.protocolProblems, []);
    const current = await application.evaluate(() => globalThis.__opencodeAcpUICounts);
    for (const value of [beforeRestartCounts, current]) { assert.equal(value.remoteAttempts, 0); assert.equal(value.localRequests, 0); assert.equal(value.ordinarySends, 0); }
    assert.equal(current.chooserCalls, 0);
  });
  const report = { opencodeAcpUISmoke: 'passed', fixture: 'generated Node SDK 1.8 ACP v1 agent; production-default main/preload/renderer', checks, screenshots, runtimeCounts: await runtimeCounts(), appCounts: { beforeRestart: beforeRestartCounts, afterRestart: await application.evaluate(() => globalThis.__opencodeAcpUICounts) }, temporaryRoot, guardScope: 'Guards begin after Electron launch; ordinary-send guard begins after initialization. Counts cover smoke interactions, not prelaunch/bootstrap.', limitations: ['Official stable ACP v1 SDK agent fixture; not an official OpenCode binary, model, tools, or OS sandbox test.', 'All tasks, history, ordinary chat, plan and credential were generated in temporary directories.', 'The native chooser is stubbed only inside this isolated Electron process; public runtime status contains no connection secrets.'] };
  await rm(path.join(artifactRoot, 'failure.json'), { force: true }); await rm(path.join(artifactRoot, 'failure.png'), { force: true });
  await writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) {
  if (page) { try { await screenshot('failure.png'); } catch { /* keep original error */ } }
  await writeFile(path.join(artifactRoot, 'failure.json'), JSON.stringify({ currentCheck, checks, screenshots, temporaryRoot, error: String(error).replaceAll(fixtureKey, '[fixture-key]') }, null, 2) + '\n'); throw error;
} finally { await application?.close(); }
