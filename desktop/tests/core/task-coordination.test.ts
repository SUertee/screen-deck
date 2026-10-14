import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApprovalService } from '../../src/core/approval-service.js';
import { TaskOrchestrator } from '../../src/core/task-orchestrator.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { SessionHistoryStore } from '../../src/core/session-history-store.js';
import { TaskSessionHistoryStore } from '../../src/core/task-session-history-store.js';
import { FakeTaskExecutionDriver } from '../../src/core/fake-task-execution-driver.js';
import { canonicalDigest } from '../../src/core/execution-records.js';
import { taskDigest, taskResultDigest } from '../../src/core/task-session-schema.js';
import type { ExecutionDriver } from '../../src/core/execution-driver.js';
import type { AuthorizationInput, TaskTurnRecord, TaskTurnRef, ToolPolicy } from '../../src/shared/task-execution.js';
import type { PlanWorkItem } from '../../src/shared/types.js';

const model = { provider_id: 'simulation', model_id: 'simulation-v1' };
const date = '2026-10-12T01:00:00.000Z';
const ref = (): TaskTurnRef => ({ session: { format: 'task-v2', sessionID: randomUUID() }, turnID: randomUUID() });
const temp = async () => mkdtemp(join(await realpath(tmpdir()), 'screendeck-task-coordination-'));
const work = (dependencies: string[] = []): PlanWorkItem => ({ id: randomUUID(), title: 'Verify simulation', kind: 'validation', assignee: 'unassigned', expected_result: 'Simulation fact', dependencies, status: 'planned' });
const chat: ExecutionDriver = { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, async execute() { assert.fail('Task simulation must not call the chat driver'); } };
async function fixture(items: PlanWorkItem[] = [work()]) {
  const root = await temp();
  const scope = { project_id: `project-${randomUUID()}`, task_id: 'task-001' };
  const taskStore = new TaskSessionHistoryStore(root); const driver = new FakeTaskExecutionDriver({ stepDelayMs: 0 });
  const approvals = new ApprovalService(root); const manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'sessions')), driver: chat, task: { store: taskStore, driver } });
  const workspace = { workspaceID: randomUUID(), bindingDigest: 'a'.repeat(64) };
  const configuration = { manager, approvals, resolveWorkspace: async () => ({ workspace, root }), driverRef: (driverID: string) => ({ driverID, configDigest: 'b'.repeat(64), mode: 'simulation' as const }), resolveMaterials: async () => [], verifyResult: async () => {}, actor: () => 'test-user' };
  const plans = new TaskOrchestrator(root); plans.configureExecution(configuration);
  const plan = await plans.createPlan('Simulation plan', items, scope);
  const session = await manager.createTaskSession({ title: 'Task', projectID: scope.project_id, taskID: scope.task_id });
  const input = (itemID = items[0]!.id, tools: ToolPolicy = { kind: 'none' }): AuthorizationInput => ({ planID: plan.id, expectedPlanVersion: plan.version, workItemID: itemID, session: { format: 'task-v2', sessionID: session.conversation_id }, clientRequestID: randomUUID(), text: 'Simulate only', materialIDs: [], workspaceID: workspace.workspaceID, driverID: 'simulation-success', model, tools });
  return { root, scope, taskStore, driver, approvals, manager, workspace, configuration, plans, plan, session, input };
}
async function waitState(manager: SessionManager, turn: TaskTurnRef, state: TaskTurnRecord['state']): Promise<TaskTurnRecord> {
  for (let index = 0; index < 100; index++) { const record = await manager.getTaskTurn(turn); if (record.state === state) return record; await new Promise<void>(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Task did not become ${state}`);
}
async function approveAndStart(f: Awaited<ReturnType<typeof fixture>>, input = f.input()) {
  const prepared = await f.plans.requestExecutionAuthorization(input);
  await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'approve' });
  assert.equal((await f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id })).status, 'started');
  return prepared;
}

test('new approvals enforce one immutable target, CAS decisions, expiry and invalidation while retaining old API bytes', async () => {
  const root = await temp(); let time = new Date(date);
  const service = new ApprovalService(root, { now: () => time, actor: () => 'test-user' });
  const old = await service.recordDecision({ context: { action: 'preview', parameters: {}, workspace: root, planID: randomUUID(), planVersion: 1 }, decision: 'approved', decidedBy: 'legacy-user' });
  const oldFile = join(root, 'preview-approvals', `${old.id}.json`); const oldBytes = await readFile(oldFile);
  const turn = ref(); const target = { kind: 'execution' as const, turn, specDigest: 'a'.repeat(64) };
  const pending = await service.request(target); assert.equal(pending.state, 'pending');
  assert.deepEqual(await service.request(target), pending);
  await assert.rejects(service.request({ ...target, specDigest: 'b'.repeat(64) }), /范围已改变/);
  await assert.rejects(service.assertValid(pending.id, target), /审批未通过/);
  const approved = await service.decide(pending.id, 'approve');
  assert.deepEqual(await service.decide(pending.id, 'approve'), approved);
  await assert.rejects(service.decide(pending.id, 'reject'), /相反/);
  await service.assertValid(pending.id, target);
  const invalidated = await service.invalidate(pending.id, 'Edited plan');
  assert.equal(invalidated.state, 'approved'); assert.equal(invalidated.state === 'approved' && invalidated.decided_at, approved.state === 'approved' && approved.decided_at);
  await assert.rejects(new ApprovalService(root).assertValid(pending.id, target), /已过期|原范围/);
  const expires = await service.request({ ...target, turn: ref() }); time = new Date(time.getTime() + 16 * 60 * 1000);
  await assert.rejects(service.decide(expires.id, 'approve'), /过期/);
  assert.deepEqual(await readFile(oldFile), oldBytes); assert.equal(await service.isApproved(old.id, old.context), true);
  assert.equal((await readdir(join(root, 'execution-approvals-v1'))).length, 2);
});

test('tool approval identity is Turn plus request ID; a changed action conflicts and unsafe records fail closed', async () => {
  const root = await temp(); const service = new ApprovalService(root); const turn = ref();
  const target = { kind: 'tool' as const, turn, externalRequestID: 'request-1', actionDigest: 'c'.repeat(64) };
  const record = await service.request(target);
  await assert.rejects(service.request({ ...target, actionDigest: 'd'.repeat(64) }), /范围已改变/);
  await assert.rejects(service.request({ ...target, turn: { ...turn, session: { ...turn.session, format: 'chat-v1' } } } as never), /引用无效/);
  const file = join(root, 'execution-approvals-v1', `${record.id}.json`);
  await writeFile(file, JSON.stringify({ ...record, revision: 1 })); const bytes = await readFile(file);
  await assert.rejects(service.decide(record.id, 'approve'), /字段无效/); assert.deepEqual(await readFile(file), bytes);
  const lock = join(root, '.execution-approvals-v1.write.lock'); await writeFile(lock, 'other-writer');
  await assert.rejects(service.request({ ...target, turn: ref() }), /另一写入者/); assert.equal(await readFile(lock, 'utf8'), 'other-writer');
});

test('save, request, approve, start and manual acceptance remain separate; duplicates never resubmit or rewrite a decision', async () => {
  const f = await fixture();
  try {
    const input = f.input(); const prepared = await f.plans.requestExecutionAuthorization(input);
    assert.equal(f.driver.counts.created, 0); assert.equal((await f.manager.getTaskTurn(prepared.turn)).state, 'prepared');
    assert.deepEqual(await f.plans.requestExecutionAuthorization(input), prepared);
    await assert.rejects(f.plans.requestExecutionAuthorization({ ...input, text: 'Changed input' }), /不能更换/);
    await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'approve' }); assert.equal(f.driver.counts.created, 0);
    const starts = await Promise.all([f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id }), f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id })]);
    assert.deepEqual(starts.map(value => value.status), ['started', 'already-started']);
    await waitState(f.manager, prepared.turn, 'finished'); assert.deepEqual(f.driver.counts, { created: 1, submitted: 1, permissions: 0 });
    const review = await f.plans.getWorkItemReview(prepared.turn); assert.equal(review.acceptance, undefined);
    const accepted = await f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' });
    assert.deepEqual(await f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' }), accepted);
    await assert.rejects(f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: review.resultDigest, choice: 'reject' }), /不同验收/);
    await assert.rejects(f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: 'f'.repeat(64), choice: 'accept' }), /摘要已变化/);
    assert.deepEqual((await f.plans.getWorkItemReview(prepared.turn)).acceptance, accepted);
    const freshPlans = new TaskOrchestrator(f.root); freshPlans.configureExecution(f.configuration);
    assert.deepEqual((await freshPlans.getWorkItemReview(prepared.turn)).acceptance, accepted);
    assert.equal((await f.plans.loadPlan(f.plan.id))?.work_items[0]?.status, 'planned');
  } finally { await f.manager.shutdown(); }
});

test('external coordination requires trusted registration and refuses tools or materials before resolving them', async () => {
  const f = await fixture(); let materialReads = 0;
  const external = { ...f.configuration, driverRef: (driverID: string) => ({ driverID, configDigest: 'b'.repeat(64), mode: 'external' as const }), resolveMaterials: async () => { materialReads++; return []; } };
  try {
    const unregistered = new TaskOrchestrator(f.root); unregistered.configureExecution(external);
    const input = { ...f.input(), driverID: 'fixture-external', model: { provider_id: 'fixture-provider', model_id: 'fixture-model' } };
    await assert.rejects(unregistered.requestExecutionAuthorization(input), /尚未注册/);
    const registered = new TaskOrchestrator(f.root); registered.configureExecution({ ...external, validateSelection: () => {} });
    await assert.rejects(registered.requestExecutionAuthorization({ ...input, tools: { kind: 'restricted', readRoots: ['.'], writeRoots: [], commands: [] } }), /仅支持本次输入/);
    await assert.rejects(registered.requestExecutionAuthorization({ ...input, materialIDs: ['source-reference'] }), /仅支持本次输入/);
    assert.equal(materialReads, 0); assert.equal(f.driver.counts.created, 0); assert.deepEqual((await f.manager.loadTaskSession(input.session))!.turns, []);
  } finally { await f.manager.shutdown(); }
});

test('editing an approved prepared plan invalidates permission, settles Turn, then writes version; partial failures preserve old plan bytes', async () => {
  const f = await fixture();
  try {
    const prepared = await f.plans.requestExecutionAuthorization(f.input()); const decided = await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'approve' });
    const file = join(f.root, 'preview-plans', `${f.plan.id}.json`); const bytes = await readFile(file);
    const original = f.manager.failPreparedTaskTurn.bind(f.manager);
    f.manager.failPreparedTaskTurn = async () => { throw new Error('injected settlement failure'); };
    await assert.rejects(f.plans.savePlan({ ...f.plan, title: 'Edited' }, 1), /settlement failure/);
    assert.deepEqual(await readFile(file), bytes);
    const invalidated = await f.approvals.loadExecutionApproval(prepared.request.id); assert.equal(invalidated?.state, 'approved'); assert.ok(invalidated?.invalidation);
    assert.equal(invalidated?.state === 'approved' && invalidated.decided_at, decided.state === 'approved' && decided.decided_at);
    await assert.rejects(f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id }), /injected settlement failure/); assert.equal(f.driver.counts.created, 0);
    f.manager.failPreparedTaskTurn = original;
    const saved = await f.plans.savePlan({ ...f.plan, title: 'Edited' }, 1); assert.equal(saved.version, 2); assert.equal((await f.manager.getTaskTurn(prepared.turn)).state, 'failed');
    await assert.rejects(f.plans.savePlan(f.plan, 1), /版本冲突/);
  } finally { await f.manager.shutdown(); }
});

test('rejected startup remains a recorded human decision and settles prepared Turn without execution', async () => {
  const f = await fixture();
  try {
    const prepared = await f.plans.requestExecutionAuthorization(f.input());
    const rejected = await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'reject' });
    assert.equal(rejected.state, 'rejected'); assert.equal((await f.manager.getTaskTurn(prepared.turn)).state, 'failed'); assert.equal(f.driver.counts.created, 0);
    const repeated = await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'reject' });
    const { invalidation, ...originalDecision } = repeated; assert.deepEqual(originalDecision, rejected); assert.ok(invalidation);
    const next = await f.plans.requestExecutionAuthorization(f.input()); assert.notEqual(next.turn.turnID, prepared.turn.turnID);
    await f.plans.cancelExecution(next.turn); assert.equal((await f.manager.getTaskTurn(next.turn)).state, 'cancelled'); assert.equal(f.driver.counts.created, 0);
  } finally { await f.manager.shutdown(); }
});

test('all Sessions of a task share a gate, and a second coordinator never steals an O_EXCL task lock', async () => {
  const f = await fixture();
  try {
    let release!: () => void; let reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { reached = resolve; });
    const first = new TaskOrchestrator(f.root); first.configureExecution({ ...f.configuration, resolveWorkspace: async () => { reached(); await blocked; return { workspace: f.workspace, root: f.root }; } });
    const second = new TaskOrchestrator(f.root); second.configureExecution(f.configuration);
    const pending = first.requestExecutionAuthorization(f.input()); await entered;
    await assert.rejects(second.requestExecutionAuthorization(f.input()), /另一写入者/);
    const lock = join(f.root, `.task-${canonicalDigest(f.scope)}.lock`); const token = await readFile(lock); assert.ok(token.length);
    release(); const prepared = await pending; assert.equal(f.driver.counts.created, 0);
    const otherSession = await f.manager.createTaskSession({ title: 'Same task, another chat', projectID: f.scope.project_id, taskID: f.scope.task_id });
    await assert.rejects(second.requestExecutionAuthorization({ ...f.input(), session: { format: 'task-v2', sessionID: otherSession.conversation_id } }), /同一任务有未决/);
    await f.plans.cancelExecution(prepared.turn);
    const independent = await second.requestExecutionAuthorization({ ...f.input(), session: { format: 'task-v2', sessionID: otherSession.conversation_id } }); assert.ok(independent.turn.turnID);
    assert.equal((await f.manager.loadTaskSession({ format: 'task-v2', sessionID: f.session.conversation_id }))?.turns.length, 1);
  } finally { await f.manager.shutdown(); }
});

test('unknown result blocks restart, new Session attempts, plan edits and acceptance; reconciliation never resubmits', async () => {
  const f = await fixture();
  try {
    const prepared = await approveAndStart(f, { ...f.input(), driverID: 'simulation-unknown' }); await waitState(f.manager, prepared.turn, 'unknown');
    assert.equal((await f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id })).status, 'unknown');
    assert.equal((await f.plans.reconcileExecution(prepared.turn)).state, 'unknown'); assert.equal(f.driver.counts.submitted, 1);
    const session = await f.manager.createTaskSession({ title: 'Another task conversation', projectID: f.scope.project_id, taskID: f.scope.task_id });
    await assert.rejects(f.plans.requestExecutionAuthorization({ ...f.input(), session: { format: 'task-v2', sessionID: session.conversation_id } }), /同一任务有未决/);
    await assert.rejects(f.plans.savePlan({ ...f.plan, title: 'Cannot edit unknown' }, 1), /未核对结果/);
    await assert.rejects(f.plans.getWorkItemReview(prepared.turn), /仅可验收/);
    assert.deepEqual(f.driver.counts, { created: 1, submitted: 1, permissions: 0 });
  } finally { await f.manager.shutdown(); }
});

test('tool permission is a second approval and one delivery; repeat reply after completion returns original receipt', async () => {
  const f = await fixture();
  try {
    const tools: ToolPolicy = { kind: 'restricted', readRoots: [], writeRoots: ['simulation'], commands: [] };
    const prepared = await approveAndStart(f, f.input(undefined, tools)); await waitState(f.manager, prepared.turn, 'awaiting_permission');
    const requests = await f.plans.listExecutionApprovals(prepared.turn); const tool = requests.find(value => value.target.kind === 'tool'); assert.ok(tool); assert.equal(f.driver.counts.permissions, 0);
    assert.equal((await f.plans.listExecutionApprovals(prepared.turn)).filter(value => value.target.kind === 'tool').length, 1);
    await assert.rejects(f.plans.replyToolPermission({ turn: prepared.turn, approvalID: tool.id }), /尚未决定/);
    await f.plans.decideApproval({ requestID: tool.id, choice: 'approve' }); assert.equal(f.driver.counts.permissions, 0);
    const receipt = await f.plans.replyToolPermission({ turn: prepared.turn, approvalID: tool.id }); assert.equal(receipt.delivery, 'accepted');
    await waitState(f.manager, prepared.turn, 'finished');
    assert.deepEqual(await f.plans.replyToolPermission({ turn: prepared.turn, approvalID: tool.id }), receipt); assert.equal(f.driver.counts.permissions, 1);
    assert.equal((await f.plans.decideApproval({ requestID: tool.id, choice: 'approve' })).state, 'approved');
  } finally { await f.manager.shutdown(); }
});

test('dependencies need acceptance of the same plan version; planned/completed labels grant no authority', async () => {
  const first = work(); first.status = 'completed'; const second = work([first.id]); const f = await fixture([first, second]);
  try {
    await assert.rejects(f.plans.requestExecutionAuthorization(f.input(second.id)), /尚无当前计划版本/);
    const prepared = await approveAndStart(f, f.input(first.id)); await waitState(f.manager, prepared.turn, 'finished');
    const review = await f.plans.getWorkItemReview(prepared.turn); const accepted = await f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' });
    const dependent = await f.plans.requestExecutionAuthorization(f.input(second.id));
    assert.deepEqual((await f.manager.getTaskTurn(dependent.turn)).execution.spec.dependencies, [{ workItemID: first.id, acceptanceID: accepted.id }]);
    await f.plans.cancelExecution(dependent.turn); const v2 = await f.plans.savePlan(f.plan, 1);
    await assert.rejects(f.plans.requestExecutionAuthorization({ ...f.input(second.id), expectedPlanVersion: v2.version }), /尚无当前计划版本/);
  } finally { await f.manager.shutdown(); }
});

test('terminal Turn with unconfirmed permission still blocks task edits, new attempts and review after restart', async () => {
  const f = await fixture(); const prepared = await approveAndStart(f); await waitState(f.manager, prepared.turn, 'finished'); await f.manager.shutdown();
  const record = await f.taskStore.load(f.session.conversation_id); assert.ok(record); const turn = record.turns[0]!;
  const action = { kind: 'file-write' as const, path: 'simulation/result.txt', content: 'simulation only' };
  turn.execution.permissions.push({ externalRequestID: 'uncertain-receipt', action, actionDigest: taskDigest(action), approvalID: randomUUID(), delivery: 'unknown' }); await f.taskStore.save(record, record.revision);
  const restarted = new SessionManager({ store: new SessionHistoryStore(join(f.root, 'sessions')), driver: chat, task: { store: new TaskSessionHistoryStore(f.root), driver: new FakeTaskExecutionDriver({ stepDelayMs: 0 }) } });
  const plans = new TaskOrchestrator(f.root); plans.configureExecution({ ...f.configuration, manager: restarted });
  try {
    await assert.rejects(plans.requestExecutionAuthorization(f.input()), /同一任务有未决/);
    await assert.rejects(plans.savePlan({ ...f.plan, title: 'Blocked' }, 1), /未核对结果/);
    await assert.rejects(plans.getWorkItemReview(prepared.turn), /仅可验收/);
  } finally { await restarted.shutdown(); }
});


test('expired preparation settles locally and preserves its decided approval before new preparation', async () => {
  const f = await fixture();
  try {
    const prepared = await f.plans.requestExecutionAuthorization(f.input()); const decided = await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'approve' });
    const future = new TaskOrchestrator(f.root); future.configureExecution({ ...f.configuration, now: () => new Date(Date.now() + 16 * 60 * 1000) });
    const requests = await future.listExecutionApprovals(prepared.turn);
    assert.equal((await f.manager.getTaskTurn(prepared.turn)).state, 'failed'); assert.equal(requests[0]!.state, 'approved'); assert.ok(requests[0]!.invalidation);
    assert.equal(requests[0]!.state === 'approved' && requests[0]!.decided_at, decided.state === 'approved' && decided.decided_at);
    assert.equal((await future.startExecution({ turn: prepared.turn, approvalID: prepared.request.id })).status, 'not-started'); assert.equal(f.driver.counts.created, 0);
    const next = await future.requestExecutionAuthorization(f.input()); assert.notEqual(next.turn.turnID, prepared.turn.turnID);
  } finally { await f.manager.shutdown(); }
});

test('saved finished review remains readable when new artifact verification is unavailable', async () => {
  const f = await fixture();
  try {
    const prepared = await approveAndStart(f); await waitState(f.manager, prepared.turn, 'finished'); const view = await f.plans.getWorkItemReview(prepared.turn);
    const accepted = await f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: view.resultDigest, choice: 'accept' });
    const reader = new TaskOrchestrator(f.root); reader.configureExecution({ ...f.configuration, verifyResult: async () => { throw new Error('Source unavailable'); } });
    assert.deepEqual((await reader.getWorkItemReview(prepared.turn)).acceptance, accepted);
    await assert.rejects(reader.reviewWorkItem({ turn: prepared.turn, resultDigest: view.resultDigest, choice: 'accept' }), /Source unavailable/);
  } finally { await f.manager.shutdown(); }
});

test('simulation keeps the existing digest and stored acceptance even when only assistant message bytes change', async () => {
  const f = await fixture();
  try {
    const prepared = await approveAndStart(f); const turn = await waitState(f.manager, prepared.turn, 'finished');
    const view = await f.plans.getWorkItemReview(prepared.turn);
    assert.equal(view.resultDigest, taskDigest({ specDigest: turn.execution.specDigest, result: turn.execution.result ?? null }));
    assert.equal(taskResultDigest(turn), view.resultDigest, 'the old simulation call shape remains valid');
    const accepted = await f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: view.resultDigest, choice: 'accept' });
    const file = join(f.root, 'execution-acceptances-v1', `${accepted.id}.json`); const bytes = await readFile(file);
    const record = (await f.taskStore.load(f.session.conversation_id))!;
    const assistant = record.messages.find(message => message.turn_id === prepared.turn.turnID && message.role === 'assistant')!;
    assistant.text = 'Only simulation Message bytes changed; the original result contract is retained.'; assistant.message_id = randomUUID();
    await f.taskStore.save(record, record.revision);
    const retained = await f.plans.getWorkItemReview(prepared.turn);
    assert.equal(retained.resultDigest, view.resultDigest); assert.deepEqual(retained.acceptance, accepted); assert.deepEqual(await readFile(file), bytes);
    assert.equal(f.driver.counts.created, 1);
  } finally { await f.manager.shutdown(); }
});
