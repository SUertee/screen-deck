import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalService } from '../../src/core/approvals/approval-service.js';
import { DecisionEngine } from '../../src/core/tasks/decision-engine.js';
import { executionRecordID } from '../../src/core/storage/execution-records.js';
import { TaskDriverFixture } from '../helpers/task-driver-fixture.js';
import { StorageError } from '../../src/core/storage/private-storage.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { TaskOrchestrator, type TaskExecutionConfiguration, type TaskOrchestratorDependencies } from '../../src/core/tasks/task-orchestrator.js';
import { TaskSessionHistoryStore, type TaskSessionHistoryStoring } from '../../src/core/sessions/task-session-history-store.js';
import type { AcceptanceRecord, AuthorizationInput, TaskTurnRef } from '../../src/shared/task-execution.js';
import type { PlanWorkItem, PreviewPlan } from '../../src/shared/types.js';

// Compile-time regression: a deferred rejection cannot replace the final synchronous gate.
function synchronousGateContract() {
  // @ts-expect-error Promise<void> must not satisfy the final authorization check.
  const invalid: TaskExecutionConfiguration['approvals']['assertCurrent'] = async () => {};
  return invalid;
}

const temporaryRoot = () => realpath(tmpdir()).then(root => mkdtemp(join(root, 'screendeck-task-dependencies-')));
const workItem = (): PlanWorkItem => ({ id: randomUUID(), title: 'Synthetic discussion', kind: 'discussion', assignee: 'unassigned', expected_result: 'Text only', dependencies: [], status: 'planned' });

function memoryPlans() {
  const records = new Map<string, PreviewPlan>();
  const saves: boolean[] = [];
  const store: NonNullable<TaskOrchestratorDependencies['planStore']> = {
    load: async id => structuredClone(records.get(id)),
    list: async () => structuredClone([...records.values()]),
    save: async (plan, existing) => {
      assert.equal(records.has(plan.id), existing);
      saves.push(existing); records.set(plan.id, structuredClone(plan));
      return structuredClone(plan);
    },
  };
  return { store, saves };
}

function memoryAcceptances() {
  const records = new Map<string, AcceptanceRecord>();
  const calls = { load: 0, list: 0, find: 0, record: 0 };
  const store: NonNullable<TaskOrchestratorDependencies['acceptanceStore']> = {
    load: async id => { calls.load++; return structuredClone(records.get(id)); },
    list: async () => { calls.list++; return structuredClone([...records.values()]); },
    find: async (turn, resultDigest) => { calls.find++; return structuredClone(records.get(executionRecordID({ turn, resultDigest }))); },
    record: async input => {
      calls.record++;
      const id = executionRecordID({ turn: input.turn, resultDigest: input.resultDigest });
      const record: AcceptanceRecord = { schema_version: 1, kind: 'electron_execution_acceptance', id, turn: structuredClone(input.turn), resultDigest: input.resultDigest, decision: input.decision, decided_by: input.actor, decided_at: input.now.toISOString() };
      records.set(id, record); return structuredClone(record);
    },
  };
  return { store, calls };
}

async function fixture(dependencies: TaskOrchestratorDependencies = {}, rejectAfterCAS = false) {
  const root = await temporaryRoot();
  const driver = new TaskDriverFixture({ stepDelayMs: 0 });
  const service = new ApprovalService(root);
  const disk = new TaskSessionHistoryStore(root);
  const facts = { submittingSaved: false, synchronousChecks: 0 };
  const taskStore: TaskSessionHistoryStoring = {
    load: id => disk.load(id), list: () => disk.list(),
    save: async (record, revision) => {
      const saved = await disk.save(record, revision);
      if (saved.turns.some(turn => turn.state === 'submitting')) facts.submittingSaved = true;
      return saved;
    },
  };
  const approvals: TaskExecutionConfiguration['approvals'] = {
    request: target => service.request(target),
    loadExecutionApproval: id => service.loadExecutionApproval(id),
    listExecutionApprovals: turn => service.listExecutionApprovals(turn),
    decide: (id, choice, actor) => service.decide(id, choice, actor),
    invalidate: (id, reason) => service.invalidate(id, reason),
    invalidateTurn: (turn, reason) => service.invalidateTurn(turn, reason),
    assertValid: (id, target, now) => service.assertValid(id, target, now),
    assertCurrent: (approval, target, now) => {
      service.assertCurrent(approval, target, now); facts.synchronousChecks++;
      if (rejectAfterCAS && facts.submittingSaved) throw new StorageError('not-approved', 'Synthetic final gate rejection.');
      return undefined;
    },
  };
  const manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'sessions')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { assert.fail('No model calls in dependency tests.'); } }, task: { store: taskStore, driver } });
  const plans = new TaskOrchestrator(root, dependencies);
  const scope = { project_id: `project-${randomUUID()}`, task_id: 'task-001' };
  const workspace = { workspaceID: randomUUID(), bindingDigest: 'a'.repeat(64) };
  const configuration: TaskExecutionConfiguration = { manager, approvals, resolveWorkspace: async () => ({ workspace, root }), driverRef: driverID => ({ driverID, configDigest: 'b'.repeat(64), mode: 'simulation' }), validateSelection: () => {}, resolveMaterials: async () => [], verifyResult: async () => {}, actor: () => 'synthetic-user' };
  plans.configureExecution(configuration);
  const item = workItem(); const plan = await plans.createPlan('Synthetic plan', [item], scope);
  const session = await manager.createTaskSession({ title: 'Synthetic task', projectID: scope.project_id, taskID: scope.task_id });
  const input: AuthorizationInput = { planID: plan.id, expectedPlanVersion: plan.version, workItemID: item.id, session: { format: 'task-v2', sessionID: session.conversation_id }, clientRequestID: randomUUID(), text: 'Synthetic input only', materialIDs: [], workspaceID: workspace.workspaceID, driverID: 'simulation-success', model: { provider_id: 'simulation', model_id: 'simulation-v1' }, tools: { kind: 'none' } };
  return { root, plans, manager, driver, input, facts };
}

async function finished(manager: SessionManager, turn: TaskTurnRef) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await manager.getTaskTurn(turn)).state === 'finished') return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic task did not finish.');
}

test('optional memory stores and a custom decision engine replace defaults without execution or disk writes', async t => {
  const parent = await temporaryRoot(); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'never-created'); const planStore = memoryPlans(); const acceptance = memoryAcceptances();
  let recommendations = 0;
  const decisionEngine = new DecisionEngine({ recommend: async context => { recommendations++; assert.equal(context.planVersion, 2); return { candidate: 'human', reasons: ['Injected decision source'], advisory: true }; } });
  const plans = new TaskOrchestrator(root, { planStore: planStore.store, acceptanceStore: acceptance.store, decisionEngine });
  const created = await plans.createPlan('Memory plan', [workItem()]);
  assert.deepEqual(await plans.loadPlan(created.id), created);
  const saved = await plans.savePlan({ ...created, title: 'Revised memory plan' }, created.version);
  assert.equal(saved.version, 2); assert.deepEqual(await plans.listPlans(), [saved]);
  const advice = await plans.recommendations(saved);
  assert.equal(recommendations, 1); assert.deepEqual(advice[0].recommendation, { candidate: 'human', reasons: ['Injected decision source'], advisory: true });
  assert.deepEqual(await plans.loadPlan(saved.id), saved); assert.deepEqual(planStore.saves, [false, true]);
  assert.deepEqual(acceptance.calls, { load: 0, list: 0, find: 0, record: 0 });
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('injected acceptance find and record retain the coordinator resultDigest gate', async t => {
  const acceptance = memoryAcceptances(); const f = await fixture({ acceptanceStore: acceptance.store });
  t.after(async () => { await f.manager.shutdown(); await rm(f.root, { recursive: true, force: true }); });
  const prepared = await f.plans.requestExecutionAuthorization(f.input);
  await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'approve' });
  const starts = await Promise.all([f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id }), f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id })]);
  assert.deepEqual(starts.map(value => value.status), ['started', 'already-started']); await finished(f.manager, prepared.turn);
  assert.deepEqual(f.driver.counts, { created: 1, submitted: 1, permissions: 0 });
  const review = await f.plans.getWorkItemReview(prepared.turn); assert.equal(review.acceptance, undefined);
  const wrongDigest = (review.resultDigest[0] === 'a' ? 'b' : 'a') + review.resultDigest.slice(1);
  await assert.rejects(f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: wrongDigest, choice: 'accept' }), { code: 'conflict' });
  assert.equal(acceptance.calls.record, 0);
  const accepted = await f.plans.reviewWorkItem({ turn: prepared.turn, resultDigest: review.resultDigest, choice: 'accept' });
  assert.equal(acceptance.calls.record, 1); assert.equal(accepted.resultDigest, review.resultDigest);
  assert.deepEqual((await f.plans.getWorkItemReview(prepared.turn)).acceptance, accepted); assert.equal(acceptance.calls.find, 2);
  await assert.rejects(stat(join(f.root, 'execution-acceptances-v1')), { code: 'ENOENT' });
});

test('typed approval forwarding preserves the synchronous final gate after submitting CAS', async t => {
  const f = await fixture({}, true);
  t.after(async () => { await f.manager.shutdown(); await rm(f.root, { recursive: true, force: true }); });
  const prepared = await f.plans.requestExecutionAuthorization(f.input);
  const frozen = await f.manager.getTaskTurn(prepared.turn);
  assert.ok(prepared.request.target.kind === 'execution'); assert.equal(prepared.request.target.specDigest, frozen.execution.specDigest);
  await f.plans.decideApproval({ requestID: prepared.request.id, choice: 'approve' });
  assert.deepEqual(f.driver.counts, { created: 0, submitted: 0, permissions: 0 });
  await assert.rejects(f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id }), { code: 'not-approved' });
  assert.equal(f.facts.submittingSaved, true); assert.equal(f.facts.synchronousChecks, 2);
  const rejected = await f.manager.getTaskTurn(prepared.turn);
  assert.equal(rejected.state, 'failed'); assert.equal(rejected.execution.authorizationID, prepared.request.id);
  assert.equal(rejected.execution.specDigest, frozen.execution.specDigest);
  assert.equal((await f.plans.startExecution({ turn: prepared.turn, approvalID: prepared.request.id })).status, 'already-started');
  assert.deepEqual(f.driver.counts, { created: 0, submitted: 0, permissions: 0 });
});
