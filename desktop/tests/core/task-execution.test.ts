import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalRequest, ExecutionLookup, ExecutionSpec, ExternalObservation, TaskSessionRecord, TaskTurnRecord, TaskTurnRef } from '../../src/shared/task-execution.js';
import { ExecutionError } from '../../src/core/sessions/execution-driver.js';
import { ExecutionRecordStore } from '../../src/core/storage/execution-records.js';
import { TaskDriverFixture } from '../helpers/task-driver-fixture.js';
import { StorageError } from '../../src/core/storage/private-storage.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { TaskSessionHistoryStore, type TaskSessionHistoryStoring } from '../../src/core/sessions/task-session-history-store.js';
import { taskDigest, taskSpecDigest, validateTaskSession } from '../../src/core/sessions/task-session-schema.js';

const model = { provider_id: 'simulation', model_id: 'simulation' };
const ordinary = { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { throw new Error('No ordinary model calls in task tests.'); } };
async function temp() { return mkdtemp(join(await realpath(tmpdir()), 'screendeck-task-core-test-')); }
class MemoryTaskStore implements TaskSessionHistoryStoring {
  records = new Map<string, TaskSessionRecord>();
  saves = 0; failBefore = new Set<number>(); failAfter = new Set<number>();
  async list() { return { records: structuredClone([...this.records.values()]), diagnostics: [] }; }
  async load(id: string) { return structuredClone(this.records.get(id)); }
  async save(record: TaskSessionRecord, revision?: number) {
    this.saves++; if (this.failBefore.has(this.saves)) throw new StorageError('write-failed', 'Injected save failure.');
    validateTaskSession(record); const previous = this.records.get(record.conversation_id);
    if (revision !== previous?.revision || previous && record.revision !== previous.revision) throw new StorageError('revision-changed', 'Injected CAS conflict.');
    const saved = structuredClone(record); saved.revision++; validateTaskSession(saved, true); this.records.set(saved.conversation_id, saved);
    if (this.failAfter.has(this.saves)) throw new StorageError('write-failed', 'Injected lost save receipt.');
    return structuredClone(saved);
  }
}
async function harness(input: { store?: TaskSessionHistoryStoring; driver?: TaskDriverFixture; resolve?: boolean; now?: () => Date; mode?: ExecutionSpec['driver']['mode'] } = {}) {
  const root = await temp(); const store = input.store ?? new MemoryTaskStore(); const driver = input.driver ?? new TaskDriverFixture({ stepDelayMs: 1 });
  const approvals = new Map<string, ApprovalRequest>();
  const manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'sessions')), driver: ordinary, now: input.now, task: { store, driver, ...(input.resolve === false ? {} : { resolveApproval: async id => structuredClone(approvals.get(id)) }) } });
  const session = await manager.createTaskSession({ title: 'Simulation', projectID: `project-${randomUUID()}`, taskID: 'task-001' });
  const sessionRef = { format: 'task-v2' as const, sessionID: session.conversation_id };
  const mode = input.mode ?? 'simulation';
  const spec = (tools: ExecutionSpec['tools'] = { kind: 'none' }, driverID = mode === 'external' ? 'fixture-success' : 'simulation-success'): ExecutionSpec => ({ work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: 'Simulate one item', kind: 'implementation', expectedResult: 'An explicitly simulated result', dependencies: [], inputMessageID: randomUUID(), materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: taskDigest('fixture-workspace') }, driver: { driverID, configDigest: taskDigest('fixture-driver'), mode }, tools });
  const prepare = (value = spec(), clientRequestID = randomUUID()) => manager.prepareTaskTurn({ session: sessionRef, clientRequestID, text: 'Only simulate.', model, spec: value });
  const start = (turn: TaskTurnRef, check: () => void = () => {}) => manager.startTaskTurn({ turn, approvalID: randomUUID(), check, resolved: { workspaceRoot: root, materials: [] } });
  const wait = async (turn: TaskTurnRef, states: TaskTurnRecord['state'][]) => { for (let i = 0; i < 200; i++) { const record = await manager.getTaskTurn(turn); if (states.includes(record.state)) return record; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`Did not reach ${states.join(',')}.`); };
  const approveTool = async (turn: TaskTurnRef, state: 'approved' | 'rejected' = 'approved') => {
    const record = await manager.getTaskTurn(turn); const permission = record.execution.permissions[0]!;
    const now = input.now?.() ?? new Date();
    const approval: ApprovalRequest = { schema_version: 1, kind: 'electron_execution_approval', id: randomUUID(), target: { kind: 'tool', turn, externalRequestID: permission.externalRequestID, actionDigest: permission.actionDigest }, state, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(), decided_at: now.toISOString(), decided_by: 'human' };
    approvals.set(approval.id, approval); return approval;
  };
  return { root, store, driver, manager, approvals, sessionRef, spec, prepare, start, wait, approveTool };
}
const restricted: ExecutionSpec['tools'] = { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] };
const recoveryStates = ['prepared', 'submitting', 'running', 'awaiting_permission', 'cancelling', 'unknown'] as const;
function recoveryRecord(base: TaskSessionRecord, state: typeof recoveryStates[number]): TaskSessionRecord {
  const record = structuredClone(base);
  const turn = record.turns[0]!;
  turn.state = state;
  if (state !== 'prepared') {
    turn.execution.authorizationID = randomUUID();
    turn.execution.external = { runtimeID: 'original-fixture-runtime', connectionGeneration: 'original-fixture-generation', externalSessionID: 'original-fixture-session' };
    if (state === 'awaiting_permission') {
      const action = { kind: 'file-write' as const, path: 'simulation/result.txt', content: 'Synthetic pending action.' };
      turn.execution.permissions.push({ externalRequestID: 'original-fixture-permission', action, actionDigest: taskDigest(action) });
    }
  }
  validateTaskSession(record, true);
  return record;
}

test('prepare freezes one input and duplicate start dispatches at most once', async () => {
  const h = await harness();
  try {
    const requestID = randomUUID(); const spec = h.spec(); const turn = await h.prepare(spec, requestID);
    assert.deepEqual(await h.prepare({ ...spec, inputMessageID: randomUUID() }, requestID), turn);
    await assert.rejects(h.prepare({ ...spec, expectedResult: 'Changed' }, requestID), { code: 'conflict' });
    const saved = await h.manager.loadTaskSession(h.sessionRef); const record = saved!.turns[0]!;
    assert.equal(record.execution.specDigest, taskSpecDigest(record.execution.spec, model, 'Only simulate.'));
    assert.equal(h.driver.counts.created, 0);
    await assert.rejects(h.start(turn, () => { throw new StorageError('not-approved', 'No approval.'); }), { code: 'not-approved' });
    assert.equal(h.driver.counts.created, 0);
    const receipts = await Promise.all([h.start(turn), h.start(turn)]);
    assert.deepEqual(receipts.map(value => value.status).sort(), ['already-started', 'started']);
    const completed = await h.wait(turn, ['finished']); assert.match(completed.execution.result!.summary, /模拟/);
    assert.deepEqual(h.driver.counts, { created: 1, submitted: 1, permissions: 0 });
    assert.equal((await h.manager.loadTaskSession(h.sessionRef))!.messages.filter(value => value.role === 'user').length, 1);
  } finally { await h.manager.shutdown(); }
});

test('failed submitting CAS blocks external work; retry saves facts without dispatching', async () => {
  const store = new MemoryTaskStore(); const h = await harness({ store });
  try {
    const turn = await h.prepare(); store.failBefore.add(store.saves + 1);
    await assert.rejects(h.start(turn)); assert.equal(h.driver.counts.created, 0); assert.equal(h.manager.hasTaskPendingWrites(h.sessionRef.sessionID), true);
    await assert.rejects(h.start(turn), { code: 'pending-write' });
    store.failBefore.clear(); await h.manager.retryTaskPendingWrites(h.sessionRef);
    assert.equal(h.manager.hasTaskPendingWrites(h.sessionRef.sessionID), false);
    assert.equal((await h.start(turn)).status, 'already-started'); assert.equal(h.driver.counts.created, 0);
  } finally { await h.manager.shutdown(); }
});

test('lost submitting save receipt adopts only the exact next revision and never resends', async () => {
  const store = new MemoryTaskStore(); const h = await harness({ store, mode: 'external' });
  try {
    const turn = await h.prepare(); store.failAfter.add(store.saves + 1);
    await assert.rejects(h.start(turn)); assert.equal(h.driver.counts.created, 0);
    store.failAfter.clear(); await h.manager.retryTaskPendingWrites(h.sessionRef);
    assert.equal((await h.start(turn)).status, 'already-started'); assert.equal(h.driver.counts.created, 0);
    const restartedDriver = new TaskDriverFixture({ stepDelayMs: 0 });
    const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.root, 'sessions')), driver: ordinary, task: { store, driver: restartedDriver } });
    try { assert.equal((await restarted.loadTaskSession(h.sessionRef))!.turns[0]!.state, 'unknown'); assert.equal((await restarted.reconcileTaskExecution(turn)).state, 'unknown'); assert.equal(restartedDriver.counts.created, 0); }
    finally { await restarted.shutdown(); }
  } finally { await h.manager.shutdown(); }
});

test('authorization expiry checked again after CAS prevents the first driver call', async () => {
  const h = await harness();
  try { const turn = await h.prepare(); let checks = 0; await assert.rejects(h.start(turn, () => { if (++checks === 2) throw new StorageError('not-approved', 'Expired.'); })); assert.equal((await h.manager.getTaskTurn(turn)).state, 'failed'); assert.equal(h.driver.counts.created, 0); }
  finally { await h.manager.shutdown(); }
});

test('separate exact tool decision delivers once, and deny is an explicit simulation outcome', async () => {
  for (const choice of ['approved', 'rejected'] as const) {
    const h = await harness();
    try {
      const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']);
      const approval = await h.approveTool(turn, choice);
      await assert.rejects(h.manager.replyTaskPermission({ turn, approval: { ...approval, target: { ...approval.target, actionDigest: taskDigest('other') } } as ApprovalRequest, check: () => {} }), { code: 'not-approved' });
      assert.equal(h.driver.counts.permissions, 0);
      await Promise.all([h.manager.replyTaskPermission({ turn, approval, check: () => {} }), h.manager.replyTaskPermission({ turn, approval, check: () => {} })]);
      assert.equal((await h.wait(turn, [choice === 'approved' ? 'finished' : 'cancelled'])).execution.permissions[0]!.delivery, 'accepted');
      assert.equal(h.driver.counts.permissions, 1);
      await assert.rejects(readFile(join(h.root, 'simulation/result.txt')), { code: 'ENOENT' });
    } finally { await h.manager.shutdown(); }
  }
});

test('tool decision expiry after sending CAS records unknown without delivering or retrying', async () => {
  const h = await harness();
  try {
    const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']); const approval = await h.approveTool(turn); let checks = 0;
    await assert.rejects(h.manager.replyTaskPermission({ turn, approval, check: () => { if (++checks === 2) throw new StorageError('not-approved', 'Expired.'); } }));
    const saved = await h.manager.getTaskTurn(turn); assert.equal(saved.state, 'unknown'); assert.equal(saved.execution.permissions[0]!.delivery, 'unknown'); assert.equal(h.driver.counts.permissions, 0);
    await h.manager.replyTaskPermission({ turn, approval, check: () => {} }); assert.equal(h.driver.counts.permissions, 0);
  } finally { await h.manager.shutdown(); }
});

class LostPermissionReceiptDriver extends TaskDriverFixture {
  mismatch = false;
  override async replyPermission(input: Parameters<TaskDriverFixture['replyPermission']>[0]): Promise<{ status: 'accepted' | 'rejected' | 'unknown' }> { await super.replyPermission(input); throw new ExecutionError('network', 'Lost receipt.', true); }
  override async inspectExecution(lookup: ExecutionLookup): Promise<ExternalObservation> {
    const observation = await super.inspectExecution(lookup); if (observation.status === 'unverifiable') return observation;
    return { ...observation, output: 'A later snapshot must not overwrite frozen output.', permissionReceipts: observation.permissionReceipts.map(value => ({ ...value, choice: this.mismatch ? 'deny' : value.choice })) };
  }
}
test('lost tool delivery receipt is not resent; reconciliation matches original choice and freezes terminal output', async () => {
  const driver = new LostPermissionReceiptDriver({ stepDelayMs: 1 }); const h = await harness({ driver });
  try {
    const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']); const approval = await h.approveTool(turn);
    await h.manager.replyTaskPermission({ turn, approval, check: () => {} }); await h.wait(turn, ['finished']);
    assert.equal((await h.manager.getTaskTurn(turn)).execution.permissions[0]!.delivery, 'unknown');
    await h.manager.replyTaskPermission({ turn, approval, check: () => {} }); assert.equal(driver.counts.permissions, 1);
    const before = await h.manager.loadTaskSession(h.sessionRef);
    driver.mismatch = true; await h.manager.reconcileTaskExecution(turn); assert.equal((await h.manager.getTaskTurn(turn)).execution.permissions[0]!.delivery, 'unknown');
    driver.mismatch = false; await h.manager.reconcileTaskExecution(turn); assert.equal((await h.manager.getTaskTurn(turn)).execution.permissions[0]!.delivery, 'accepted');
    const after = await h.manager.loadTaskSession(h.sessionRef); assert.deepEqual(after!.messages, before!.messages); assert.deepEqual(after!.turns[0]!.execution.result, before!.turns[0]!.execution.result);
  } finally { await h.manager.shutdown(); }
});

test('without original approval a native receipt cannot clear an unknown tool delivery', async () => {
  const driver = new LostPermissionReceiptDriver({ stepDelayMs: 1 }); const h = await harness({ driver, resolve: false });
  try { const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']); const approval = await h.approveTool(turn); await h.manager.replyTaskPermission({ turn, approval, check: () => {} }); await h.wait(turn, ['finished']); await h.manager.reconcileTaskExecution(turn); assert.equal((await h.manager.getTaskTurn(turn)).execution.permissions[0]!.delivery, 'unknown'); }
  finally { await h.manager.shutdown(); }
});

test('shutdown while awaiting permission stops local reception promptly and preserves external uncertainty', async () => {
  const h = await harness(); const turn = await h.prepare(h.spec(restricted)); await h.start(turn); const paused = await h.wait(turn, ['awaiting_permission']);
  const shutdown = h.manager.shutdown();
  await Promise.race([shutdown, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Shutdown hung on pending permission.')), 500))]);
  assert.equal((await h.store.load(h.sessionRef.sessionID))!.turns[0]!.state, 'unknown');
  assert.equal((await h.driver.inspectExecution({ clientRequestID: paused.client_request_id, driver: paused.execution.spec.driver, workspace: paused.execution.spec.workspace, binding: paused.execution.external })).status, 'awaiting_permission');
});

test('manual reconcile keeps healthy callbacks active and permission can still complete', async () => {
  const h = await harness();
  try { const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']); assert.equal((await h.manager.reconcileTaskExecution(turn)).state, 'awaiting_permission'); const approval = await h.approveTool(turn); await h.manager.replyTaskPermission({ turn, approval, check: () => {} }); await h.wait(turn, ['finished']); assert.equal(h.driver.counts.permissions, 1); }
  finally { await h.manager.shutdown(); }
});

test('restart fails prepared turns and never turns explicit failure or unknown into replay', async () => {
  const store = new MemoryTaskStore(); const h = await harness({ store, mode: 'external' }); const prepared = await h.prepare(); await h.manager.shutdown();
  const restartedDriver = new TaskDriverFixture({ stepDelayMs: 0 }); const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.root, 'sessions')), driver: ordinary, task: { store, driver: restartedDriver } });
  try { assert.equal((await restarted.loadTaskSession(h.sessionRef))!.turns[0]!.state, 'failed'); assert.equal((await restarted.startTaskTurn({ turn: prepared, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: h.root, materials: [] } })).status, 'not-started'); assert.equal(restartedDriver.counts.created, 0); }
  finally { await restarted.shutdown(); }
  for (const scenario of ['fixture-failure', 'fixture-unknown']) { const item = await harness({ mode: 'external' }); try { const turn = await item.prepare(item.spec({ kind: 'none' }, scenario)); await item.start(turn); assert.equal((await item.wait(turn, [scenario === 'fixture-failure' ? 'failed' : 'unknown'])).execution.result, undefined); await item.start(turn); assert.equal(item.driver.counts.created, 1); } finally { await item.manager.shutdown(); } }
});

test('reading legacy simulation and mixed sessions preserves original states and every file byte', async () => {
  const root = await temp();
  const seedStore = new TaskSessionHistoryStore(root);
  const h = await harness({ store: seedStore });
  await h.prepare(h.spec(restricted));
  await h.manager.shutdown();
  const base = (await seedStore.load(h.sessionRef.sessionID))!;
  const records = recoveryStates.map(state => recoveryRecord(base, state));

  const mixed = recoveryRecord(base, 'prepared');
  const externalTurn = structuredClone(mixed.turns[0]!);
  externalTurn.turn_id = randomUUID();
  externalTurn.client_request_id = randomUUID();
  externalTurn.state = 'running';
  externalTurn.execution.authorizationID = randomUUID();
  externalTurn.execution.external = { runtimeID: 'other-fixture-runtime', connectionGeneration: 'other-fixture-generation', externalSessionID: 'other-fixture-session' };
  externalTurn.execution.spec.driver = { ...externalTurn.execution.spec.driver, mode: 'external', driverID: 'fixture-success' };
  const externalMessages = mixed.messages.map(message => ({ ...structuredClone(message), message_id: randomUUID(), turn_id: externalTurn.turn_id }));
  const externalInput = externalMessages.find(message => message.role === 'user')!;
  externalTurn.execution.spec.inputMessageID = externalInput.message_id;
  externalTurn.execution.specDigest = taskSpecDigest(externalTurn.execution.spec, externalTurn.requested_model, externalInput.text);
  mixed.turns.push(externalTurn);
  mixed.messages.push(...externalMessages);
  validateTaskSession(mixed, true);
  records.push(mixed);

  const file = join(root, 'task-sessions-v2', `${h.sessionRef.sessionID}.json`);
  for (const [index, record] of records.entries()) {
    await writeFile(file, `${JSON.stringify(record, null, 3)}\n`);
    const bytes = await readFile(file);
    const disk = new TaskSessionHistoryStore(root);
    let saves = 0;
    const readonlyStore: TaskSessionHistoryStoring = {
      load: (id, options) => disk.load(id, options),
      list: options => disk.list(options),
      save: async () => { saves++; throw new Error('Legacy history must not be saved during recovery.'); },
    };
    const driver = new TaskDriverFixture({ stepDelayMs: 0 });
    const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.root, 'sessions')), driver: ordinary, task: { store: readonlyStore, driver } });
    try {
      if (index % 2 === 0) assert.deepEqual((await restarted.listTaskSessions()).records, [record]);
      assert.deepEqual(await restarted.loadTaskSession(h.sessionRef), record);
      assert.deepEqual((await restarted.listTaskSessions()).records, [record]);
      assert.deepEqual(await restarted.getTaskTurn({ session: h.sessionRef, turnID: record.turns[0]!.turn_id }), record.turns[0]);
      assert.equal(restarted.hasTaskPendingWrites(h.sessionRef.sessionID), false);
      assert.equal(saves, 0);
      assert.deepEqual(driver.counts, { created: 0, submitted: 0, permissions: 0 });
    } finally { await restarted.shutdown(); }
    assert.deepEqual(await readFile(file), bytes);
  }
});

test('external-only restart settles preparation or records uncertainty without rebinding or dispatching', async () => {
  const root = await temp();
  const seedStore = new TaskSessionHistoryStore(root);
  const h = await harness({ store: seedStore, mode: 'external' });
  const ref = await h.prepare(h.spec(restricted));
  await h.manager.shutdown();
  const base = (await seedStore.load(h.sessionRef.sessionID))!;
  const file = join(root, 'task-sessions-v2', `${h.sessionRef.sessionID}.json`);

  for (const state of recoveryStates) {
    const seeded = recoveryRecord(base, state);
    await writeFile(file, `${JSON.stringify(seeded, null, 3)}\n`);
    const disk = new TaskSessionHistoryStore(root);
    let saves = 0;
    const store: TaskSessionHistoryStoring = {
      load: (id, options) => disk.load(id, options),
      list: options => disk.list(options),
      save: (record, revision) => { saves++; return disk.save(record, revision); },
    };
    const driver = new TaskDriverFixture({ stepDelayMs: 0 });
    const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.root, 'sessions')), driver: ordinary, task: { store, driver } });
    try {
      const loaded = (await restarted.loadTaskSession(h.sessionRef))!;
      const turn = loaded.turns[0]!;
      assert.equal(turn.state, state === 'prepared' ? 'failed' : 'unknown');
      assert.equal(saves, state === 'unknown' ? 0 : 1);
      assert.equal(loaded.revision, seeded.revision + saves);
      assert.deepEqual(turn.execution, seeded.turns[0]!.execution);
      assert.deepEqual(loaded.messages, seeded.messages);
      assert.equal(turn.execution.specDigest, taskSpecDigest(turn.execution.spec, turn.requested_model, loaded.messages.find(message => message.message_id === turn.execution.spec.inputMessageID)!.text));
      assert.equal((await restarted.startTaskTurn({ turn: ref, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: h.root, materials: [] } })).status, state === 'prepared' ? 'not-started' : 'unknown');
      assert.deepEqual(driver.counts, { created: 0, submitted: 0, permissions: 0 });
    } finally { await restarted.shutdown(); }
  }
});

test('task store strictly validates a new format and byte CAS, and both formats reject colliding identities', async () => {
  const root = await temp(); const store = new TaskSessionHistoryStore(root); const h = await harness({ store });
  try {
    const turn = await h.prepare(); const initial = await store.load(h.sessionRef.sessionID); assert.ok(initial);
    const other = new TaskSessionHistoryStore(root); const second = await other.load(h.sessionRef.sessionID); second!.title = 'Other writer'; await other.save(second!, second!.revision);
    await assert.rejects(store.save({ ...initial, title: 'Stale writer' }, initial.revision), /修改|冲突/);
    const file = join(root, 'task-sessions-v2', `${h.sessionRef.sessionID}.json`); const saved = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...saved, api_key: 'synthetic-forbidden-field' })); await assert.rejects(new TaskSessionHistoryStore(root).load(h.sessionRef.sessionID), /字段无效/);
    await writeFile(file, JSON.stringify(saved));
    const chat = new SessionHistoryStore(join(root, 'sessions')); const now = '2026-10-12T00:00:00.000Z';
    await chat.save({ schema_version: 1, conversation_id: h.sessionRef.sessionID, title: 'Collision', scope: { kind: 'local_chat', local_chat_id: h.sessionRef.sessionID }, created_at: now, updated_at: now, revision: 0, turns: [], messages: [] });
    await assert.rejects(new TaskSessionHistoryStore(root).load(h.sessionRef.sessionID), { code: 'duplicate-session' });
    const manager = new SessionManager({ store: chat, driver: ordinary, task: { store: new TaskSessionHistoryStore(root), driver: h.driver } });
    try { await assert.rejects(manager.loadSession(turn.session.sessionID), { code: 'duplicate-session' }); const listing = await manager.listSessions(); assert.equal(listing.records.length, 0); assert.equal(listing.diagnostics.length, 1); const tasks = await manager.listTaskSessions(); assert.equal(tasks.records.length, 0); assert.equal(tasks.diagnostics.length, 1); }
    finally { await manager.shutdown(); }
    assert.equal(JSON.parse(await readFile(file, 'utf8')).schema_version, 2);
  } finally { await h.manager.shutdown(); }
});


test('missing any required tool capability rejects before dispatch', async () => {
  for (const key of ['tools', 'reconcile', 'confirmedCancel', 'permissionReply', 'enforcedToolScope']) {
    const driver = new TaskDriverFixture({ stepDelayMs: 0 });
    const field = key === 'tools' ? 'capabilities' : 'taskCapabilities';
    Object.defineProperty(driver, field, { value: { ...driver[field], [key]: false } });
    const h = await harness({ driver });
    try { const turn = await h.prepare(h.spec(restricted)); await assert.rejects(h.start(turn), { code: 'unsupported' }); assert.equal((await h.manager.getTaskTurn(turn)).state, 'prepared'); assert.equal(driver.counts.created, 0); }
    finally { await h.manager.shutdown(); }
  }
});

test('unsubmitted preparation is not inspected or converted into unknown', async () => {
  const h = await harness(); let inspections = 0;
  h.driver.inspectExecution = async () => { inspections++; return { status: 'unverifiable', reason: 'No external attempt exists.' }; };
  try {
    const turn = await h.prepare(); assert.equal((await h.manager.reconcileTaskExecution(turn)).state, 'prepared');
    assert.equal(inspections, 0); assert.equal((await h.manager.cancelTaskExecution(turn)).state, 'cancelled');
    assert.equal((await h.manager.reconcileTaskExecution(turn)).state, 'cancelled'); assert.equal(inspections, 0);
    assert.equal(h.driver.counts.created, 0);
  } finally { await h.manager.shutdown(); }
});

test('confirmed inspection closes an undelivered permission after restart without inventing a delivery', async () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const h = await harness({ mode: 'external' }); const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']); await h.manager.shutdown();
    const inspect = h.driver.inspectExecution.bind(h.driver);
    h.driver.inspectExecution = async lookup => { const value = await inspect(lookup); if (value.status === 'unverifiable') return value; return { binding: value.binding, output: value.output, permissionReceipts: [], status }; };
    const restarted = new SessionManager({ store: new SessionHistoryStore(join(h.root, 'sessions')), driver: ordinary, task: { store: h.store, driver: h.driver } });
    try {
      const settled = await restarted.reconcileTaskExecution(turn); assert.equal(settled.state, status); assert.equal(settled.execution.permissions[0]!.delivery, undefined);
      await restarted.prepareTaskTurn({ session: h.sessionRef, clientRequestID: randomUUID(), text: 'A new separately authorized attempt', model, spec: h.spec() });
      assert.equal(h.driver.counts.created, 1); assert.equal(h.driver.counts.permissions, 0);
    } finally { await restarted.shutdown(); }
  }
});

test('permission final preflight rejects expiry after returning from the queue without delivery', async () => {
  const h = await harness();
  try {
    const turn = await h.prepare(h.spec(restricted)); await h.start(turn); await h.wait(turn, ['awaiting_permission']); const approval = await h.approveTool(turn); let checks = 0;
    await assert.rejects(h.manager.replyTaskPermission({ turn, approval, check: () => { if (++checks === 3) throw new StorageError('not-approved', 'Expired just before dispatch.'); } }), { code: 'not-approved' });
    assert.equal(h.driver.counts.permissions, 0); assert.equal((await h.manager.getTaskTurn(turn)).execution.permissions[0]!.delivery, 'unknown');
  } finally { await h.manager.shutdown(); }
});

test('invalid event identity, unknown event and missing final result stay unknown without replay', async () => {
  const invalid = [
    { eventID: '', sequence: 1, event: { type: 'text-delta', text: 'invalid' } },
    { eventID: 'one', sequence: 1, event: { type: 'unknown-event' } },
    { eventID: 'one', sequence: 1, event: { type: 'settled', outcome: 'finished' } },
  ];
  for (const envelope of invalid) {
    const driver = new TaskDriverFixture();
    driver.executeTask = async (_request, onEvent) => { driver.counts.created++; await onEvent(envelope as never); };
    const h = await harness({ driver });
    try { const turn = await h.prepare(); await h.start(turn); const record = await h.wait(turn, ['unknown']); assert.equal(record.execution.result, undefined); await h.start(turn); assert.equal(driver.counts.created, 1); }
    finally { await h.manager.shutdown(); }
  }
});

test('schema rejects finished without result and delivery without its original decision', async () => {
  const h = await harness();
  try {
    const turn = await h.prepare(); const record = (await h.manager.loadTaskSession(h.sessionRef))!;
    record.turns[0]!.state = 'finished'; record.turns[0]!.execution.authorizationID = randomUUID(); assert.throws(() => validateTaskSession(record));
    record.turns[0]!.execution.result = { summary: 'Simulation', artifacts: [], evidence: [] };
    const action = { kind: 'file-write' as const, path: 'simulation/result.txt', content: 'Simulation' };
    record.turns[0]!.execution.permissions = [{ externalRequestID: 'one', action, actionDigest: taskDigest(action), delivery: 'accepted' }]; assert.throws(() => validateTaskSession(record));
    assert.equal((await h.manager.getTaskTurn(turn)).state, 'prepared');
  } finally { await h.manager.shutdown(); }
});


test('new task and execution record creation enforce the directory capacity before writing', async () => {
  const root = await temp(); const h = await harness();
  try {
    const record = structuredClone((await h.store.load(h.sessionRef.sessionID))!); record.revision = 0; record.conversation_id = randomUUID();
    const taskStore = new TaskSessionHistoryStore(root); const executions = new ExecutionRecordStore<{ id: string }>(root, 'execution-approvals-v1', value => value as { id: string });
    const directories = [taskStore.root, executions.directory];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      for (let start = 0; start < 2000; start += 100) await Promise.all(Array.from({ length: 100 }, () => writeFile(join(directory, `${randomUUID()}.json`), '{}')));
    }
    await assert.rejects(taskStore.save(record), { code: 'too-large' }); let operationCalled = false;
    await assert.rejects(executions.update(randomUUID(), current => { operationCalled = true; return current ?? { id: randomUUID() }; }), { code: 'too-large' });
    assert.equal(operationCalled, false); await assert.rejects(readFile(join(taskStore.root, `${record.conversation_id}.json`)), { code: 'ENOENT' });
  } finally { await h.manager.shutdown(); }
});

test('submitted without a remote ID keeps the original binding and finishes without inventing identity', async () => {
  for (const oldID of [undefined, 'existing-native-message']) {
    const h = await harness();
    h.driver.executeTask = async (request, onEvent) => {
      h.driver.counts.created++;
      const binding = { runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', externalSessionID: 'fixture-session', ...(oldID ? { externalSubmissionID: oldID } : {}) };
      await onEvent({ eventID: 'bound', sequence: 1, event: { type: 'bound', binding } });
      h.driver.counts.submitted++;
      await onEvent({ eventID: 'submitted', sequence: 2, event: { type: 'submitted' } });
      await onEvent({ eventID: 'text', sequence: 3, event: { type: 'text-delta', text: 'ACP synthetic answer' } });
      await onEvent({ eventID: 'settled', sequence: 4, event: { type: 'settled', outcome: 'finished', result: { summary: 'ACP synthetic answer', artifacts: [], evidence: [] } } });
    };
    try {
      const ref = await h.prepare(); await h.start(ref); const turn = await h.wait(ref, ['finished']);
      assert.equal(turn.execution.external?.externalSubmissionID, oldID);
      assert.equal(Object.hasOwn(turn.execution.external!, 'externalSubmissionID'), oldID !== undefined);
      assert.equal(turn.observed_model, undefined);
      assert.equal((await h.start(ref)).status, 'already-started'); assert.equal(h.driver.counts.submitted, 1);
      const saved = await h.manager.loadTaskSession(h.sessionRef); validateTaskSession(saved, true);
    } finally { await h.manager.shutdown(); }
  }
});

test('requestable cancellation is sent even without confirmation capability and remains unknown', async () => {
  const h = await harness(); let cancellations = 0;
  Object.defineProperty(h.driver, 'taskCapabilities', { value: Object.freeze({ ...h.driver.taskCapabilities, confirmedCancel: false }) });
  h.driver.cancelExecution = async () => { cancellations++; return { status: 'unknown' }; };
  h.driver.executeTask = async (_request, onEvent, signal) => {
    h.driver.counts.created++;
    await onEvent({ eventID: 'bound', sequence: 1, event: { type: 'bound', binding: { runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', externalSessionID: 'fixture-session' } } });
    await onEvent({ eventID: 'submitted', sequence: 2, event: { type: 'submitted' } });
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  try {
    const ref = await h.prepare(); await h.start(ref); await h.wait(ref, ['running']);
    assert.equal((await h.manager.cancelTaskExecution(ref)).state, 'unknown'); assert.equal(cancellations, 1);
    assert.equal((await h.start(ref)).status, 'unknown'); assert.equal(h.driver.counts.created, 1);
  } finally { await h.manager.shutdown(); }
});
