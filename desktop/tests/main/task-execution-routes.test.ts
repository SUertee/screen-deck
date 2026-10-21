import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { TaskSessionHistoryStore } from '../../src/core/sessions/task-session-history-store.js';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import { ApprovalService } from '../../src/core/approvals/approval-service.js';
import { installTaskExecutionRoutes, type TaskDriverRegistration } from '../../src/main/task-execution-routes.js';
import { ExecutionError } from '../../src/core/sessions/execution-driver.js';
import type { TaskExecutionDriver } from '../../src/core/sessions/task-execution-driver.js';
import { StorageError } from '../../src/core/storage/private-storage.js';
import { canonicalDigest } from '../../src/core/storage/execution-records.js';
import { ExecutionAcceptanceStore } from '../../src/core/tasks/execution-acceptance-store.js';
import { taskResultDigest, taskSpecDigest } from '../../src/core/sessions/task-session-schema.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { ProjectWorkspaceReader } from '../../src/projects/reader.js';
import type { ProjectWorkspaceResult } from '../../src/projects/types.js';
import type { AuthorizationInput, DriverRef, ExecutionLookup, ExecutionResult, ExternalExecutionBinding, ExternalObservation, ExecutionSpec, PreparedAuthorization, TaskEventEnvelope, TaskExecutionOptions, TaskExecutionRequest, TaskSessionEvent, TaskSessionRecord, TaskTurnRecord, TaskTurnRef } from '../../src/shared/task-execution.js';
import type { ModelSelection } from '../../src/shared/types.js';

/** Protocol fixture only: no runtime process, HTTP, provider settings, files or tools. */
class ExternalFixtureDriver implements TaskExecutionDriver {
  readonly capabilities = { chat: false, tools: false, remoteSessions: true, remoteAbort: false };
  readonly taskCapabilities = { reconcile: true, confirmedCancel: false, permissionReply: false, enforcedToolScope: false };
  readonly counts = { created: 0, submitted: 0, permissions: 0 };
  readonly requests: TaskExecutionRequest[] = [];
  inspections = 0;
  loseReceipt = false;
  unverifiable = false;
  requestTool = false;
  result: ExecutionResult = { summary: 'External fixture text response.', artifacts: [], evidence: [] };
  private readonly attempts = new Map<string, { binding: ExternalExecutionBinding; model: ModelSelection; finished: boolean }>();
  async execute(): Promise<void> { assert.fail('Task fixture must not call ordinary chat.'); }
  async executeTask(request: TaskExecutionRequest, onEvent: (event: TaskEventEnvelope) => Promise<void>): Promise<void> {
    this.counts.created++; this.requests.push(structuredClone(request));
    const attempt = { binding: { runtimeID: 'fixture-runtime', connectionGeneration: request.spec.driver.configDigest, externalSessionID: randomUUID() } as ExternalExecutionBinding, model: request.model, finished: false };
    this.attempts.set(request.clientRequestID, attempt);
    let sequence = 0;
    const emit = (event: TaskEventEnvelope['event']) => onEvent({ eventID: `${request.turn.turnID}:${++sequence}`, sequence, event });
    await emit({ type: 'bound', binding: structuredClone(attempt.binding) });
    attempt.binding.externalSubmissionID = randomUUID(); this.counts.submitted++;
    await emit({ type: 'submitted', externalSubmissionID: attempt.binding.externalSubmissionID });
    if (this.requestTool) { await emit({ type: 'permission-request', externalRequestID: 'forbidden-tool', action: { kind: 'file-read', path: 'source.txt' } }); return; }
    await emit({ type: 'text-delta', text: this.result.summary });
    attempt.finished = true;
    if (this.loseReceipt) throw new ExecutionError('network', 'Fixture lost final receipt.', true);
    await emit({ type: 'settled', outcome: 'finished', result: structuredClone(this.result) });
  }
  async inspectExecution(lookup: ExecutionLookup): Promise<ExternalObservation> {
    this.inspections++;
    const attempt = this.attempts.get(lookup.clientRequestID);
    if (this.unverifiable || !attempt || canonicalDigest(attempt.binding) !== canonicalDigest(lookup.binding)) return { status: 'unverifiable', reason: 'Original fixture binding missing.' };
    const base = { binding: structuredClone(attempt.binding), observedModel: attempt.model, output: this.result.summary, permissionReceipts: [] };
    return attempt.finished ? { ...base, status: 'finished', result: structuredClone(this.result) } : { ...base, status: 'running' };
  }
  async cancelExecution(): Promise<{ status: 'unknown' }> { return { status: 'unknown' }; }
  async replyPermission(): Promise<{ status: 'rejected' }> { this.counts.permissions++; return { status: 'rejected' }; }
}

function externalRegistration() {
  const state = { ready: true, generation: 'c'.repeat(64), model: { provider_id: 'fixture-provider', model_id: 'fixture-model' } as ModelSelection };
  const driverRef = (): DriverRef => ({ driverID: 'opencode-no-tools', configDigest: state.generation, mode: 'external' });
  let verified = 0;
  const registration: TaskDriverRegistration = {
    current: () => ({ drivers: state.ready ? [driverRef()] : [], model: state.model }),
    verifyResult: turn => {
      if (!state.ready || canonicalDigest(turn.execution.spec.driver) !== canonicalDigest(driverRef())) throw new StorageError('conflict', 'Fixture runtime generation changed.');
      verified++;
    },
  };
  return { state, registration, verified: () => verified };
}

async function harness(configuration: { driver?: ExternalFixtureDriver; execution?: TaskDriverRegistration | null } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-task-ipc-test-'));
  const projectRoot = join(root, 'project'); const previewRoot = join(root, 'preview');
  const projectID = `project-${randomUUID()}`; const taskID = 'task-001';
  await mkdir(join(projectRoot, '.screendeck'), { recursive: true });
  const identity = JSON.stringify({ schema_version: 2, kind: 'project', project_id: projectID, name: 'Fixture', created_at: '2026-10-12T00:00:00.000Z' });
  await writeFile(join(projectRoot, '.screendeck', 'project.json'), identity);
  const source: ProjectWorkspaceResult = {
    status: 'ready', project: { schema_version: 2, kind: 'project', project_id: projectID, name: 'Fixture', created_at: '2026-10-12T00:00:00.000Z', root_path: projectRoot, history_bound: true, readonly: true },
    tasks: [{ schema_version: 1, kind: 'task', project_id: projectID, task_id: taskID, title: 'Fixture task', goal: 'Synthetic text execution only', status: 'draft', plan_version: 1, assignee: 'human', created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z', run_ids: [], acceptance: [], references: [], historical: true, is_live: false }],
    runs: [], artifact_refs: [], diagnostics: [], loaded_at: '2026-10-12T00:00:00.000Z', historical: true,
  };
  const driver = configuration.driver ?? new ExternalFixtureDriver();
  const execution = configuration.execution === null ? undefined : configuration.execution ?? externalRegistration().registration;
  const approvals = new ApprovalService(previewRoot);
  let ordinaryCalls = 0;
  const taskStore = new TaskSessionHistoryStore(previewRoot);
  const manager = new SessionManager({ store: new SessionHistoryStore(join(previewRoot, 'sessions')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { ordinaryCalls += 1; } }, task: { store: taskStore, driver, resolveApproval: id => approvals.loadExecutionApproval(id) } });
  const plans = new TaskOrchestrator(previewRoot);
  const handlers = new Map<string, (input: unknown) => unknown>(); const events: TaskSessionEvent[] = [];
  const host = { handle: (name: string, operation: (input: unknown) => unknown) => handlers.set(name, operation), broadcastTask: (event: TaskSessionEvent) => events.push(event) } as unknown as ElectronHost;
  const projects = { get: (id: string) => id === projectID ? structuredClone(source) : null, preview: () => { throw new Error('Fixture has no selected material.'); } } as unknown as ProjectWorkspaceReader;
  installTaskExecutionRoutes({ manager, plans, host, projects, previewRoot, approvals, ...(execution ? { execution } : {}) });
  async function invoke<T>(channel: string, input: unknown): Promise<T> {
    const result = await handlers.get(channel)!(input) as { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  }
  const workspaceHash = canonicalDigest([projectID, projectRoot]);
  const options: TaskExecutionOptions = execution ? await invoke('task-execution-options', { projectID, taskID }) : { workspace: { workspaceID: `${workspaceHash.slice(0, 8)}-${workspaceHash.slice(8, 12)}-${workspaceHash.slice(12, 16)}-${workspaceHash.slice(16, 20)}-${workspaceHash.slice(20, 32)}`, bindingDigest: '0'.repeat(64) }, drivers: [], model: { provider_id: 'fixture-provider', model_id: 'fixture-model' } };
  const session = await invoke<TaskSessionRecord>('create-task-session', { title: 'Task chat', projectID, taskID });
  const itemID = randomUUID();
  const plan = await plans.createPlan('Execution fixture', [{ id: itemID, title: 'Review the explicit input', kind: 'implementation', assignee: 'unassigned', expected_result: 'A text response for separate human review', dependencies: [], status: 'planned' }], { project_id: projectID, task_id: taskID });
  const input = (extra: Partial<AuthorizationInput> = {}): AuthorizationInput => ({ planID: plan.id, expectedPlanVersion: plan.version, workItemID: itemID, session: { format: 'task-v2', sessionID: session.conversation_id }, clientRequestID: randomUUID(), text: 'Only this explicitly selected input.', materialIDs: [], workspaceID: options.workspace.workspaceID, driverID: 'opencode-no-tools', model: options.model, tools: { kind: 'none' }, ...extra });
  const waitState = async (ref: TaskTurnRef, states: string[]) => {
    for (let count = 0; count < 150; count++) { const turn = await manager.getTaskTurn(ref); if (states.includes(turn.state)) return turn; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('External fixture did not reach the expected state.');
  };
  return { root, previewRoot, projectRoot, identity, source, options, session, plan, driver, approvals, taskStore, manager, plans, invoke, input, waitState, events, ordinaryCalls: () => ordinaryCalls };
}

test('missing external registration refuses options and preparation without a simulation fallback', async () => {
  const h = await harness({ execution: null });
  try {
    const scope = { projectID: h.session.scope.project_id, taskID: h.session.scope.task_id };
    await assert.rejects(h.invoke('task-execution-options', scope), { code: 'unsupported' });
    for (const driverID of ['opencode-no-tools', 'simulation-success']) await assert.rejects(h.invoke('request-execution-authorization', h.input({ driverID })), { code: 'unsupported' });
    assert.deepEqual(await h.manager.loadTaskSession({ format: 'task-v2', sessionID: h.session.conversation_id }), h.session);
    assert.deepEqual(h.driver.counts, { created: 0, submitted: 0, permissions: 0 });
    assert.equal(h.driver.inspections, 0); assert.equal(h.ordinaryCalls(), 0);
  } finally { await h.manager.shutdown(); }
});

test('legacy simulation sessions, approvals and acceptance stay readable and byte-identical while all mutation routes refuse them', async () => {
  const h = await harness();
  try {
    const record = structuredClone(h.session), model = { provider_id: 'simulation', model_id: 'simulation-v1' };
    const now = record.created_at, refs: TaskTurnRef[] = [], approvalIDs: string[] = [];
    for (const state of ['finished', 'prepared', 'awaiting_permission', 'unknown'] as const) {
      const turnID = randomUUID(), inputMessageID = randomUUID(), text = `Saved legacy ${state}`;
      const spec: ExecutionSpec = { work: { planID: h.plan.id, planVersion: h.plan.version, workItemID: h.plan.work_items[0]!.id }, title: text, kind: 'implementation', expectedResult: 'Saved history only', dependencies: [], inputMessageID, materials: [], workspace: h.options.workspace, driver: { driverID: 'simulation-success', configDigest: 'd'.repeat(64), mode: 'simulation' }, tools: state === 'awaiting_permission' ? { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] } : { kind: 'none' } };
      const ref: TaskTurnRef = { session: { format: 'task-v2', sessionID: record.conversation_id }, turnID }; refs.push(ref);
      const turn: TaskTurnRecord = { turn_id: turnID, client_request_id: randomUUID(), requested_model: model, state, created_at: now, updated_at: now, draft_revision: 0, execution: { spec, specDigest: taskSpecDigest(spec, model, text), eventReceipts: [], permissions: [], ...(state === 'prepared' ? {} : { authorizationID: randomUUID(), external: { runtimeID: 'old-runtime', connectionGeneration: 'old-generation', externalSessionID: randomUUID() } }), ...(state === 'finished' ? { result: { summary: 'Previously saved simulation result', artifacts: [], evidence: [] } } : {}) } };
      if (state === 'awaiting_permission') {
        const action = { kind: 'file-write' as const, path: 'simulation/result.txt', content: 'Saved proposal; no actual write.' };
        turn.execution.permissions.push({ externalRequestID: randomUUID(), action, actionDigest: canonicalDigest(action) });
      }
      record.turns.push(turn);
      record.messages.push({ message_id: inputMessageID, turn_id: turnID, role: 'user', text, created_at: now, updated_at: now });
      if (state === 'finished') record.messages.push({ message_id: randomUUID(), turn_id: turnID, role: 'assistant', text: 'Previously saved simulation text', created_at: now, updated_at: now });
    }
    const saved = await h.taskStore.save(record, record.revision);
    const prepared = saved.turns[1]!, permission = saved.turns[2]!.execution.permissions[0]!;
    const approvals = [await h.approvals.request({ kind: 'execution', turn: refs[1]!, specDigest: prepared.execution.specDigest }), await h.approvals.request({ kind: 'tool', turn: refs[2]!, externalRequestID: permission.externalRequestID, actionDigest: permission.actionDigest })];
    approvalIDs.push(...approvals.map(value => value.id));
    const resultDigest = taskResultDigest(saved.turns[0]!);
    const accepted = await new ExecutionAcceptanceStore(h.previewRoot).record({ turn: refs[0]!, resultDigest, decision: 'accepted', actor: 'old-user', now: new Date(now) });
    const files = [join(h.taskStore.root, `${record.conversation_id}.json`), ...approvals.map(value => join(h.previewRoot, 'execution-approvals-v1', `${value.id}.json`)), join(h.previewRoot, 'execution-acceptances-v1', `${accepted.id}.json`)];
    const before = await Promise.all(files.map(file => readFile(file)));
    assert.deepEqual(await h.invoke('load-task-session', refs[0]!.session), saved);
    assert.deepEqual(await h.invoke('list-execution-approvals', refs[1]), [approvals[0]]);
    assert.deepEqual((await h.invoke<{ acceptance: unknown }>('get-work-item-review', refs[0])).acceptance, accepted);
    for (const [channel, input] of [
      ['request-execution-authorization', h.input()],
      ['decide-execution-approval', { requestID: approvalIDs[0], choice: 'approve' }],
      ['decide-execution-approval', { requestID: approvalIDs[1], choice: 'reject' }],
      ['start-task-execution', { turn: refs[1], approvalID: approvalIDs[0] }],
      ['cancel-task-execution', refs[1]], ['cancel-task-execution', refs[2]],
      ['reply-task-permission', { turn: refs[2], approvalID: approvalIDs[1] }],
      ['reconcile-task-execution', refs[3]],
      ['review-work-item', { turn: refs[0], resultDigest, choice: 'reject' }],
      ['retry-task-pending-writes', refs[0]!.session],
    ] as const) await assert.rejects(h.invoke(channel, input), { code: 'unsupported' }, channel);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    assert.deepEqual(h.driver.counts, { created: 0, submitted: 0, permissions: 0 }); assert.equal(h.driver.inspections, 0);
  } finally { await h.manager.shutdown(); }
});

test('fixed task IPC keeps save, approve, start and acceptance separate and never submits a duplicate', async () => {
  const h = await harness();
  try {
    const ordinary = await h.manager.createSession('Existing ordinary chat');
    assert.deepEqual(await h.manager.loadSession(ordinary.conversation_id), ordinary, 'enabling task execution must preserve ordinary history lookup');
    assert.equal(h.driver.counts.created, 0, 'saving a plan must not execute');
    const requestInput = h.input();
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', requestInput);
    const repeated = await h.invoke<PreparedAuthorization>('request-execution-authorization', requestInput);
    assert.deepEqual(repeated, prepared, 'duplicate request returns the saved original attempt');
    await assert.rejects(h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), { code: 'not-approved' });
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    assert.equal(h.driver.counts.created, 0, 'approval alone must not submit');
    const starts = await Promise.allSettled([h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id })]);
    assert.ok(starts.some(result => result.status === 'fulfilled'));
    const finished = await h.waitState(prepared.turn, ['finished']);
    assert.deepEqual(h.driver.counts, { created: 1, submitted: 1, permissions: 0 });
    assert.equal(h.ordinaryCalls(), 0);
    assert.deepEqual(await h.manager.loadSession(ordinary.conversation_id), ordinary, 'task attempts must not double-write ordinary history');
    const review = await h.invoke<{ resultDigest: string; acceptance?: unknown }>('get-work-item-review', prepared.turn);
    assert.equal(review.acceptance, undefined, 'finished is not accepted');
    await assert.rejects(h.invoke('review-work-item', { turn: prepared.turn, resultDigest: '0'.repeat(64), choice: 'accept' }), { code: 'conflict' });
    const decision = { turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' };
    const accepted = await h.invoke('review-work-item', decision);
    assert.deepEqual(await h.invoke('review-work-item', decision), accepted);
    assert.equal((await h.manager.getTaskTurn(prepared.turn)).state, 'finished');
    assert.equal(finished.requested_model.provider_id, 'fixture-provider');
    assert.ok(h.events.some(event => event.type === 'task-session-updated'));
    assert.equal(await readFile(join(h.projectRoot, '.screendeck', 'project.json'), 'utf8'), h.identity);
    assert.deepEqual(h.source.tasks[0]!.run_ids, []);
    assert.equal((await h.plans.loadPlan(h.plan.id))?.work_items[0]?.status, 'planned');
  } finally { await h.manager.shutdown(); }
});

test('unknown attempts block plan edits and new starts, and reload never replays them', async () => {
  const driver = new ExternalFixtureDriver(); driver.loseReceipt = true; driver.unverifiable = true;
  const h = await harness({ driver });
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id });
    await h.waitState(prepared.turn, ['unknown']);
    await assert.rejects(h.plans.savePlan({ ...h.plan, title: 'Do not silently change an unresolved attempt' }, h.plan.version));
    await assert.rejects(h.invoke('request-execution-authorization', h.input()));
    const reconciled = await h.invoke<{ state: string }>('reconcile-task-execution', prepared.turn);
    assert.equal(reconciled.state, 'unknown');
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }).catch(() => undefined);
    assert.equal(h.driver.counts.created, 1);
    const restartedDriver = new ExternalFixtureDriver();
    const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.previewRoot, 'sessions')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { throw new Error('No ordinary execution'); } }, task: { store: new TaskSessionHistoryStore(h.previewRoot), driver: restartedDriver } });
    try { assert.equal((await restarted.loadTaskSession(prepared.turn.session))?.turns.at(-1)?.state, 'unknown'); assert.equal((await restarted.reconcileTaskExecution(prepared.turn)).state, 'unknown'); assert.equal(restartedDriver.counts.created, 0); }
    finally { await restarted.shutdown(); }
  } finally { await h.manager.shutdown(); }
});

test('replacing project identity after approval blocks the first external call', async () => {
  const h = await harness();
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await writeFile(join(h.projectRoot, '.screendeck', 'project.json'), JSON.stringify({ ...JSON.parse(h.identity), created_at: '2026-10-11T00:00:00.000Z' }));
    await assert.rejects(h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), { code: 'conflict' });
    assert.equal(h.driver.counts.created, 0);
  } finally { await h.manager.shutdown(); }
});

test('task IPC rejects renderer-supplied identities, paths, real models and stale project bindings before execution', async () => {
  const h = await harness();
  try {
    for (const invalid of [
      { ...h.input(), workspaceRoot: '/outside' },
      { ...h.input(), decided_by: 'renderer' },
      h.input({ workspaceID: randomUUID() }),
      h.input({ materialIDs: ['../../credentials.json'] }),
      h.input({ model: { provider_id: 'real-model-provider', model_id: 'real-model' } }),
      h.input({ tools: { kind: 'restricted', readRoots: [], writeRoots: ['../outside'], commands: [] } }),
      h.input({ tools: { kind: 'restricted', readRoots: [], writeRoots: [], commands: [{ argv: ['touch', 'bad'], cwd: '.' }] } }),
    ]) await assert.rejects(h.invoke('request-execution-authorization', invalid));
    h.source.status = 'stale';
    await assert.rejects(h.invoke('request-execution-authorization', h.input()), { code: 'conflict' });
    assert.equal(h.driver.counts.created, 0); assert.equal(h.ordinaryCalls(), 0);
  } finally { await h.manager.shutdown(); }
});


test('refreshing the project registry during submitting persistence prevents the first call', async () => {
  const h = await harness();
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    const save = h.taskStore.save.bind(h.taskStore);
    h.taskStore.save = async (record, revision) => {
      const saved = await save(record, revision);
      if (record.turns.some(turn => turn.state === 'submitting')) h.source.loaded_at = '2026-10-12T01:00:00.000Z';
      return saved;
    };
    await assert.rejects(h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), { code: 'conflict' });
    assert.equal((await h.manager.getTaskTurn(prepared.turn)).state, 'failed');
    assert.deepEqual(h.driver.counts, { created: 0, submitted: 0, permissions: 0 });
    assert.equal((await h.invoke<{ status: string }>('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id })).status, 'already-started', 'the original submission right is never reused');
    assert.equal(h.driver.counts.created, 0);
  } finally { await h.manager.shutdown(); }
});

test('registered external text follows authorization, one start and separate acceptance without changing ordinary or task history', async () => {
  const registered = externalRegistration(); const driver = new ExternalFixtureDriver();
  const h = await harness({ driver, execution: registered.registration });
  try {
    const ordinary = await h.manager.createSession('Preserved ordinary fixture');
    const ordinaryStore = new SessionHistoryStore(join(h.previewRoot, 'sessions'));
    await ordinaryStore.load(ordinary.conversation_id);
    const turnID = randomUUID(); const time = ordinary.created_at;
    const seeded = await ordinaryStore.save({ ...ordinary, turns: [{ turn_id: turnID, client_request_id: randomUUID(), requested_model: registered.state.model, state: 'finished', created_at: time, updated_at: time, draft_revision: 0 }], messages: [{ message_id: randomUUID(), turn_id: turnID, role: 'user', text: 'Ordinary fixture question.', created_at: time, updated_at: time }, { message_id: randomUUID(), turn_id: turnID, role: 'assistant', text: 'Preserved ordinary fixture answer.', created_at: time, updated_at: time }] }, ordinary.revision);
    const ordinaryFile = join(h.previewRoot, 'sessions', ...time.slice(0, 10).split('-'), `${ordinary.conversation_id}.json`);
    const bytes = await readFile(ordinaryFile); const source = structuredClone(h.source);
    const input = h.input(); const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', input);
    assert.deepEqual(await h.invoke('request-execution-authorization', input), prepared);
    await assert.rejects(h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), { code: 'not-approved' });
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' }); assert.equal(driver.counts.created, 0);
    assert.equal((await h.invoke<{ status: string }>('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id })).status, 'started');
    const finished = await h.waitState(prepared.turn, ['finished']);
    assert.equal((await h.invoke<{ status: string }>('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id })).status, 'already-started');
    assert.equal(finished.execution.spec.driver.mode, 'external'); assert.equal(finished.requested_model.provider_id, 'fixture-provider');
    assert.equal(driver.requests[0]!.input, input.text); assert.deepEqual(driver.requests[0]!.resolved.materials, []); assert.deepEqual(driver.requests[0]!.spec.tools, { kind: 'none' });
    const review = await h.invoke<{ resultDigest: string; result: ExecutionResult; acceptance?: unknown }>('get-work-item-review', prepared.turn);
    assert.equal(review.result.summary, driver.result.summary); assert.equal(review.acceptance, undefined);
    await h.invoke('review-work-item', { turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' }); assert.equal(registered.verified(), 1);
    assert.deepEqual(driver.counts, { created: 1, submitted: 1, permissions: 0 }); assert.equal(h.ordinaryCalls(), 0);
    assert.deepEqual(await readFile(ordinaryFile), bytes); assert.deepEqual(await h.manager.loadSession(ordinary.conversation_id), seeded);
    assert.deepEqual(h.source, source); assert.equal((await h.plans.loadPlan(h.plan.id))!.work_items[0]!.status, 'planned');
    assert.equal((await h.manager.listSessions()).records.length, 1);
  } finally { await h.manager.shutdown(); }
});

test('external IPC rejects unregistered targets, arbitrary models, tools, materials and paths before preparation', async () => {
  const registered = externalRegistration(); const driver = new ExternalFixtureDriver();
  const h = await harness({ driver, execution: registered.registration });
  try {
    for (const invalid of [
      h.input({ driverID: 'https://unregistered.invalid' }),
      h.input({ driverID: 'simulation-success' }),
      h.input({ model: { provider_id: 'another-provider', model_id: 'fixture-model' } }),
      h.input({ model: { ...registered.state.model, variant: 'unregistered-variant' } }),
      h.input({ model: { provider_id: 'simulation', model_id: 'simulation-v1' } }),
      h.input({ tools: { kind: 'restricted', readRoots: ['.'], writeRoots: [], commands: [] } }),
      h.input({ materialIDs: ['project-material'] }),
    ]) await assert.rejects(h.invoke('request-execution-authorization', invalid), { code: 'unsupported' });
    await assert.rejects(h.invoke('request-execution-authorization', { ...h.input(), workspaceRoot: '/outside' }), { code: 'invalid-input' });
    await assert.rejects(h.invoke('request-execution-authorization', h.input({ workspaceID: randomUUID() })), { code: 'conflict' });
    assert.deepEqual((await h.manager.loadTaskSession(h.input().session))!.turns, []); assert.equal(driver.counts.created, 0); assert.equal(h.ordinaryCalls(), 0);
  } finally { await h.manager.shutdown(); }
});

test('an unready runtime exposes no registered driver and cannot prepare or consume old approval', async () => {
  const registered = externalRegistration(); registered.state.ready = false;
  const driver = new ExternalFixtureDriver(); const h = await harness({ driver, execution: registered.registration });
  try {
    assert.deepEqual(h.options.drivers, []);
    await assert.rejects(h.invoke('request-execution-authorization', h.input()), { code: 'unsupported' });
    registered.state.ready = true;
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    registered.state.ready = false;
    await assert.rejects(h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), { code: 'unsupported' });
    assert.equal(driver.counts.created, 0); assert.equal((await h.manager.getTaskTurn(prepared.turn)).execution.authorizationID, undefined);
  } finally { await h.manager.shutdown(); }
});

test('external config and model changes invalidate frozen approval including the final check after submitting CAS', async () => {
  for (const change of ['generation', 'model', 'after-cas'] as const) {
    const registered = externalRegistration(); const driver = new ExternalFixtureDriver();
    const h = await harness({ driver, execution: registered.registration });
    try {
      const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
      await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
      if (change === 'generation') registered.state.generation = 'd'.repeat(64);
      else if (change === 'model') registered.state.model = { provider_id: 'fixture-provider', model_id: 'another-configured-model' };
      else {
        const save = h.taskStore.save.bind(h.taskStore);
        h.taskStore.save = async (record, revision) => { const saved = await save(record, revision); if (record.turns.some(turn => turn.state === 'submitting')) registered.state.generation = 'd'.repeat(64); return saved; };
      }
      await assert.rejects(h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }), { code: change === 'model' ? 'unsupported' : 'conflict' });
      assert.deepEqual(driver.counts, { created: 0, submitted: 0, permissions: 0 });
      if (change === 'after-cas') {
        assert.equal((await h.manager.getTaskTurn(prepared.turn)).state, 'failed');
        assert.equal((await h.invoke<{ status: string }>('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id })).status, 'already-started');
        assert.equal(driver.counts.created, 0);
      }
    } finally { await h.manager.shutdown(); }
  }
});

test('external lost completion receipt stays unknown until original binding is inspected without resubmission', async () => {
  const registered = externalRegistration(); const driver = new ExternalFixtureDriver(); driver.loseReceipt = true;
  const h = await harness({ driver, execution: registered.registration });
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }); await h.waitState(prepared.turn, ['unknown']);
    assert.equal((await h.invoke<{ status: string }>('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id })).status, 'unknown');
    await assert.rejects(h.invoke('get-work-item-review', prepared.turn), { code: 'conflict' });
    const reconciled = await h.invoke<{ state: string }>('reconcile-task-execution', prepared.turn); assert.equal(reconciled.state, 'finished');
    assert.equal(driver.inspections, 1); assert.equal(driver.counts.created, 1);
    const review = await h.invoke<{ resultDigest: string }>('get-work-item-review', prepared.turn);
    await h.invoke('review-work-item', { turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' });
    assert.equal(driver.counts.created, 1); assert.equal(driver.counts.permissions, 0);
  } finally { await h.manager.shutdown(); }
});

test('external unexpected tools and file results never acquire permission or artifact acceptance', async () => {
  for (const scenario of ['tool', 'artifact', 'stale-result'] as const) {
    const registered = externalRegistration(); const driver = new ExternalFixtureDriver(); driver.requestTool = scenario === 'tool';
    if (scenario === 'artifact') driver.result.artifacts = [{ referenceID: 'unregistered-file', contentDigest: 'e'.repeat(64) }];
    const h = await harness({ driver, execution: registered.registration });
    try {
      const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
      await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
      await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id });
      const turn = await h.waitState(prepared.turn, [scenario === 'tool' ? 'unknown' : 'finished']);
      if (scenario === 'tool') { assert.deepEqual(turn.execution.permissions, []); await assert.rejects(h.invoke('get-work-item-review', prepared.turn), { code: 'conflict' }); }
      else {
        const review = await h.invoke<{ resultDigest: string; acceptance?: unknown }>('get-work-item-review', prepared.turn);
        if (scenario === 'stale-result') registered.state.generation = 'd'.repeat(64);
        await assert.rejects(h.invoke('review-work-item', { turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' }), { code: scenario === 'artifact' ? 'unsupported' : 'conflict' });
        assert.equal((await h.invoke<{ acceptance?: unknown }>('get-work-item-review', prepared.turn)).acceptance, undefined);
      }
      assert.equal(driver.counts.permissions, 0); assert.equal(registered.verified(), 0); assert.equal((await h.plans.loadPlan(h.plan.id))!.work_items[0]!.status, 'planned');
    } finally { await h.manager.shutdown(); }
  }
});

test('external review binds exact assistant identity and text while later turns do not invalidate the result', async () => {
  const registered = externalRegistration(); const driver = new ExternalFixtureDriver();
  const h = await harness({ driver, execution: registered.registration });
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }); await h.waitState(prepared.turn, ['finished']);
    const original = await h.invoke<{ resultDigest: string; result: ExecutionResult }>('get-work-item-review', prepared.turn);
    const later = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    assert.equal((await h.invoke<{ resultDigest: string }>('get-work-item-review', prepared.turn)).resultDigest, original.resultDigest, 'another Turn and newer Session revision must not change the old result');
    await h.invoke('cancel-task-execution', later.turn);
    const record = (await h.taskStore.load(prepared.turn.session.sessionID))!;
    const assistant = record.messages.find(message => message.turn_id === prepared.turn.turnID && message.role === 'assistant')!;
    assistant.text = 'A different external body under the same constant summary.';
    await h.taskStore.save(record, record.revision);
    const changed = await h.invoke<{ resultDigest: string; result: ExecutionResult }>('get-work-item-review', prepared.turn);
    assert.deepEqual(changed.result, original.result); assert.notEqual(changed.resultDigest, original.resultDigest);
    await assert.rejects(h.invoke('review-work-item', { turn: prepared.turn, resultDigest: original.resultDigest, choice: 'accept' }), { code: 'conflict' });
    const sameBody = (await h.taskStore.load(prepared.turn.session.sessionID))!;
    sameBody.messages.find(message => message.turn_id === prepared.turn.turnID && message.role === 'assistant')!.message_id = randomUUID();
    await h.taskStore.save(sameBody, sameBody.revision);
    assert.notEqual((await h.invoke<{ resultDigest: string }>('get-work-item-review', prepared.turn)).resultDigest, changed.resultDigest, 'replacing the original assistant identity is a different result');
    assert.equal(driver.counts.created, 1); assert.equal(h.ordinaryCalls(), 0);
  } finally { await h.manager.shutdown(); }
});

test('external review refuses missing, duplicate and mismatched assistant snapshots rather than hashing fallback text', async () => {
  for (const invalid of ['missing', 'duplicate', 'wrong-session'] as const) {
    const registered = externalRegistration(); const driver = new ExternalFixtureDriver();
    const h = await harness({ driver, execution: registered.registration });
    try {
      const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
      await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
      await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }); await h.waitState(prepared.turn, ['finished']);
      const view = await h.invoke<{ resultDigest: string }>('get-work-item-review', prepared.turn);
      const record = (await h.taskStore.load(prepared.turn.session.sessionID))!;
      const turn = record.turns.find(value => value.turn_id === prepared.turn.turnID)!;
      assert.throws(() => taskResultDigest(turn), { code: 'conflict' });
      assert.throws(() => taskResultDigest({ ...turn, execution: { ...turn.execution, result: { summary: 'A different Turn snapshot', artifacts: [], evidence: [] } } }, record), { code: 'conflict' });
      if (invalid === 'wrong-session') {
        const load = h.manager.loadTaskSession.bind(h.manager);
        h.manager.loadTaskSession = async ref => { const snapshot = await load(ref); if (snapshot) snapshot.conversation_id = randomUUID(); return snapshot; };
      } else {
        const assistant = record.messages.find(message => message.turn_id === turn.turn_id && message.role === 'assistant')!;
        if (invalid === 'missing') record.messages = record.messages.filter(message => message.message_id !== assistant.message_id);
        else record.messages.push({ ...assistant, message_id: randomUUID() });
        await h.taskStore.save(record, record.revision);
      }
      await assert.rejects(h.invoke('get-work-item-review', prepared.turn), { code: 'conflict' });
      await assert.rejects(h.invoke('review-work-item', { turn: prepared.turn, resultDigest: view.resultDigest, choice: 'accept' }), { code: 'conflict' });
      assert.equal(registered.verified(), 0); assert.equal(driver.counts.created, 1);
    } finally { await h.manager.shutdown(); }
  }
});

test('a changed external assistant body cannot inherit old acceptance in request or frozen dependency startup', async () => {
  const registered = externalRegistration(); const driver = new ExternalFixtureDriver();
  const h = await harness({ driver, execution: registered.registration });
  try {
    const first = h.plan.work_items[0]!; const second = { ...first, id: randomUUID(), title: 'Review accepted text', dependencies: [first.id] };
    const plan = await h.plans.savePlan({ ...h.plan, work_items: [first, second] }, h.plan.version);
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input({ expectedPlanVersion: plan.version }));
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }); await h.waitState(prepared.turn, ['finished']);
    const original = await h.invoke<{ resultDigest: string }>('get-work-item-review', prepared.turn);
    const accepted = await h.invoke<{ id: string }>('review-work-item', { turn: prepared.turn, resultDigest: original.resultDigest, choice: 'accept' });
    const acceptanceFile = join(h.previewRoot, 'execution-acceptances-v1', `${accepted.id}.json`); const bytes = await readFile(acceptanceFile);
    const dependent = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input({ expectedPlanVersion: plan.version, workItemID: second.id }));
    await h.invoke('decide-execution-approval', { requestID: dependent.request.id, choice: 'approve' });
    const record = (await h.taskStore.load(prepared.turn.session.sessionID))!;
    record.messages.find(message => message.turn_id === prepared.turn.turnID && message.role === 'assistant')!.text = 'Changed body while ExecutionResult.summary is unchanged.';
    await h.taskStore.save(record, record.revision);
    const current = await h.invoke<{ resultDigest: string; acceptance?: unknown }>('get-work-item-review', prepared.turn);
    assert.notEqual(current.resultDigest, original.resultDigest); assert.equal(current.acceptance, undefined);
    await assert.rejects(h.invoke('review-work-item', { turn: prepared.turn, resultDigest: original.resultDigest, choice: 'accept' }), { code: 'conflict' });
    await assert.rejects(h.invoke('start-task-execution', { turn: dependent.turn, approvalID: dependent.request.id }), { code: 'conflict' });
    assert.equal((await h.manager.getTaskTurn(dependent.turn)).execution.authorizationID, undefined); assert.equal(driver.counts.created, 1);
    await h.invoke('cancel-task-execution', dependent.turn);
    await assert.rejects(h.invoke('request-execution-authorization', h.input({ expectedPlanVersion: plan.version, workItemID: second.id })), { code: 'conflict' });
    assert.deepEqual(await readFile(acceptanceFile), bytes, 'the old decision remains as the old version rather than being rewritten');
  } finally { await h.manager.shutdown(); }
});
