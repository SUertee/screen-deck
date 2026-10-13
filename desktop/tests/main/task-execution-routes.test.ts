import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../../src/core/session-manager.js';
import { SessionHistoryStore } from '../../src/core/session-history-store.js';
import { TaskSessionHistoryStore } from '../../src/core/task-session-history-store.js';
import { TaskOrchestrator } from '../../src/core/task-orchestrator.js';
import { FakeTaskExecutionDriver } from '../../src/core/fake-task-execution-driver.js';
import { ApprovalService } from '../../src/core/approval-service.js';
import { installTaskExecutionRoutes } from '../../src/main/task-execution-routes.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { ProjectWorkspaceReader } from '../../src/projects/reader.js';
import type { ProjectWorkspaceResult } from '../../src/projects/types.js';
import type { AuthorizationInput, PreparedAuthorization, TaskExecutionOptions, TaskSessionEvent, TaskSessionRecord, TaskTurnRef } from '../../src/shared/task-execution.js';

async function harness() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-task-ipc-test-'));
  const projectRoot = join(root, 'project'); const previewRoot = join(root, 'preview');
  const projectID = `project-${randomUUID()}`; const taskID = 'task-001';
  await mkdir(join(projectRoot, '.screendeck'), { recursive: true });
  const identity = JSON.stringify({ schema_version: 2, kind: 'project', project_id: projectID, name: 'Fixture', created_at: '2026-10-12T00:00:00.000Z' });
  await writeFile(join(projectRoot, '.screendeck', 'project.json'), identity);
  const source: ProjectWorkspaceResult = {
    status: 'ready', project: { schema_version: 2, kind: 'project', project_id: projectID, name: 'Fixture', created_at: '2026-10-12T00:00:00.000Z', root_path: projectRoot, history_bound: true, readonly: true },
    tasks: [{ schema_version: 1, kind: 'task', project_id: projectID, task_id: taskID, title: 'Fixture task', goal: 'Simulated execution only', status: 'draft', plan_version: 1, assignee: 'human', created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z', run_ids: [], acceptance: [], references: [], historical: true, is_live: false }],
    runs: [], artifact_refs: [], diagnostics: [], loaded_at: '2026-10-12T00:00:00.000Z', historical: true,
  };
  const driver = new FakeTaskExecutionDriver({ stepDelayMs: 5 });
  const approvals = new ApprovalService(previewRoot);
  let ordinaryCalls = 0;
  const taskStore = new TaskSessionHistoryStore(previewRoot);
  const manager = new SessionManager({ store: new SessionHistoryStore(join(previewRoot, 'sessions')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { ordinaryCalls += 1; } }, task: { store: taskStore, driver, resolveApproval: id => approvals.loadExecutionApproval(id) } });
  const plans = new TaskOrchestrator(previewRoot);
  const handlers = new Map<string, (input: unknown) => unknown>(); const events: TaskSessionEvent[] = [];
  const host = { handle: (name: string, operation: (input: unknown) => unknown) => handlers.set(name, operation), broadcastTask: (event: TaskSessionEvent) => events.push(event) } as unknown as ElectronHost;
  const projects = { get: (id: string) => id === projectID ? structuredClone(source) : null, preview: () => { throw new Error('Fixture has no selected material.'); } } as unknown as ProjectWorkspaceReader;
  installTaskExecutionRoutes({ manager, plans, host, projects, previewRoot, approvals });
  async function invoke<T>(channel: string, input: unknown): Promise<T> {
    const result = await handlers.get(channel)!(input) as { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  }
  const options = await invoke<TaskExecutionOptions>('task-execution-options', { projectID, taskID });
  const session = await invoke<TaskSessionRecord>('create-task-session', { title: 'Task chat', projectID, taskID });
  const itemID = randomUUID();
  const plan = await plans.createPlan('Execution fixture', [{ id: itemID, title: 'Simulate work', kind: 'implementation', assignee: 'unassigned', expected_result: 'An explicitly simulated result', dependencies: [], status: 'planned' }], { project_id: projectID, task_id: taskID });
  const input = (extra: Partial<AuthorizationInput> = {}): AuthorizationInput => ({ planID: plan.id, expectedPlanVersion: plan.version, workItemID: itemID, session: { format: 'task-v2', sessionID: session.conversation_id }, clientRequestID: randomUUID(), text: 'Only simulate this work item.', materialIDs: [], workspaceID: options.workspace.workspaceID, driverID: 'simulation-success', model: options.model, tools: { kind: 'none' }, ...extra });
  const waitState = async (ref: TaskTurnRef, states: string[]) => {
    for (let count = 0; count < 150; count++) { const turn = await manager.getTaskTurn(ref); if (states.includes(turn.state)) return turn; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Simulation did not reach the expected state.');
  };
  return { root, previewRoot, projectRoot, identity, source, options, session, plan, driver, taskStore, manager, plans, invoke, input, waitState, events, ordinaryCalls: () => ordinaryCalls };
}

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
    assert.equal(finished.requested_model.provider_id, 'simulation');
    assert.ok(h.events.some(event => event.type === 'task-session-updated'));
    assert.equal(await readFile(join(h.projectRoot, '.screendeck', 'project.json'), 'utf8'), h.identity);
    assert.deepEqual(h.source.tasks[0]!.run_ids, []);
    assert.equal((await h.plans.loadPlan(h.plan.id))?.work_items[0]?.status, 'planned');
  } finally { await h.manager.shutdown(); }
});

test('tool approval binds an exact action and requires a separate single delivery', async () => {
  const h = await harness();
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input({ tools: { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] } }));
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id });
    const paused = await h.waitState(prepared.turn, ['awaiting_permission']);
    assert.equal(paused.execution.permissions[0]?.action.kind, 'file-write');
    const approvals = await h.invoke<Array<{ id: string; target: { kind: string } }>>('list-execution-approvals', prepared.turn);
    const tool = approvals.find(approval => approval.target.kind === 'tool')!;
    assert.ok(tool);
    await assert.rejects(h.invoke('reply-task-permission', { turn: prepared.turn, approvalID: tool.id }), { code: 'not-approved' });
    await h.invoke('decide-execution-approval', { requestID: tool.id, choice: 'approve' });
    assert.equal(h.driver.counts.permissions, 0);
    await h.invoke('reply-task-permission', { turn: prepared.turn, approvalID: tool.id });
    await h.waitState(prepared.turn, ['finished']);
    // A repeated delivery cannot permit a second action, even if the first UI receipt was lost.
    await h.invoke('reply-task-permission', { turn: prepared.turn, approvalID: tool.id }).catch(() => undefined);
    assert.equal(h.driver.counts.permissions, 1);
  } finally { await h.manager.shutdown(); }
});

test('unknown attempts block plan edits and new starts, and reload never replays them', async () => {
  const h = await harness();
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input({ driverID: 'simulation-unknown' }));
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id });
    await h.waitState(prepared.turn, ['unknown']);
    await assert.rejects(h.plans.savePlan({ ...h.plan, title: 'Do not silently change an unresolved attempt' }, h.plan.version));
    await assert.rejects(h.invoke('request-execution-authorization', h.input()));
    const reconciled = await h.invoke<{ state: string }>('reconcile-task-execution', prepared.turn);
    assert.equal(reconciled.state, 'unknown');
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id }).catch(() => undefined);
    assert.equal(h.driver.counts.created, 1);
    const restartedDriver = new FakeTaskExecutionDriver({ stepDelayMs: 1 });
    const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.previewRoot, 'sessions')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { throw new Error('No ordinary execution'); } }, task: { store: new TaskSessionHistoryStore(h.previewRoot), driver: restartedDriver } });
    try { assert.equal((await restarted.loadTaskSession(prepared.turn.session))?.turns.at(-1)?.state, 'unknown'); assert.equal((await restarted.reconcileTaskExecution(prepared.turn)).state, 'unknown'); assert.equal(restartedDriver.counts.created, 0); }
    finally { await restarted.shutdown(); }
  } finally { await h.manager.shutdown(); }
});

test('confirmed cancellation closes an unanswered tool wait without inventing a permission receipt', async () => {
  const h = await harness();
  try {
    const prepared = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input({ tools: { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] } }));
    await h.invoke('decide-execution-approval', { requestID: prepared.request.id, choice: 'approve' });
    await h.invoke('start-task-execution', { turn: prepared.turn, approvalID: prepared.request.id });
    await h.waitState(prepared.turn, ['awaiting_permission']);
    const cancelled = await h.invoke<{ state: string; execution: { permissions: Array<{ delivery?: string }> } }>('cancel-task-execution', prepared.turn);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.execution.permissions[0]?.delivery, undefined, 'nothing was delivered; do not forge a rejection receipt');
    assert.equal(h.driver.counts.permissions, 0);
    const next = await h.invoke<PreparedAuthorization>('request-execution-authorization', h.input());
    assert.notEqual(next.turn.turnID, prepared.turn.turnID);
    assert.equal(h.driver.counts.created, 1, 'new preparation still needs a new approval and explicit start');
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
