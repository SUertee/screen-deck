import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { TaskSequentialQueueService } from '../../src/core/tasks/task-sequential-queue.js';
import { taskPlanningFixture, until } from '../helpers/task-planning-fixture.js';
import type { TaskSequentialView } from '../../src/core/tasks/task-sequential-queue.js';
const queue = (f: Awaited<ReturnType<typeof taskPlanningFixture>>) => new TaskSequentialQueueService({ root: f.root, plans: f.plans, runtime: f.runtime, execution: f.execution });
async function approve(f: Awaited<ReturnType<typeof taskPlanningFixture>>, v: TaskSequentialView) { const r = await f.runtime.owner.requestStartApproval(v.queue.task, v.attemptID!); await f.runtime.decideStart(v.queue.task, r.id, 'approved'); return r.id; }
async function accept(f: Awaited<ReturnType<typeof taskPlanningFixture>>, v: TaskSequentialView) { const e = await f.runtime.evidence.collect(v.queue.task, v.attemptID!); await f.runtime.decideResult(v.queue.task, v.attemptID!, { evidenceDigest: e.digest, decision: 'accepted', comment: 'Fixture checks reviewed' }); }
test('two actual native candidates execute in dependency order, pausing for every start and acceptance', async t => {
  const f = await taskPlanningFixture(t), service = queue(f), request = { taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() };
  let v = await service.create(request); assert.equal(v.phase, 'needs-preparation'); assert.equal(f.sends(), 0);
  assert.equal((await service.create(request)).queue.id, v.queue.id);
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('alpha')); assert.equal(v.phase, 'needs-start'); assert.equal(f.sends(), 0);
  const firstAttempt = v.attemptID, approvalID = await approve(f, v);
  await service.startNext(f.plan.id, v.queue.id, approvalID); await service.startNext(f.plan.id, v.queue.id, approvalID);
  v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'needs-acceptance'); assert.equal(f.sends(), 1);
  assert.equal((await service.prepareNext(f.plan.id, v.queue.id, f.setup('beta'))).phase, 'needs-acceptance'); assert.equal(f.sends(), 1);
  await accept(f, v); v = await service.inspect(f.plan.id, v.queue.id); assert.equal(v.phase, 'needs-preparation'); assert.equal(v.completed, 1);
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('beta')); assert.notEqual(v.attemptID, firstAttempt); const secondApproval = await approve(f, v);
  await service.startNext(f.plan.id, v.queue.id, secondApproval); v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'needs-acceptance'); await accept(f, v);
  v = await queue(f).inspect(f.plan.id, v.queue.id); assert.equal(v.phase, 'complete'); assert.deepEqual(f.nativeRequests, ['alpha', 'beta']);
  assert.ok((await f.plans.loadPlan(f.plan.id))!.work_items.every(w => w.status === 'planned')); assert.equal(v.automaticExecution, false);
});
for (const behavior of ['failed', 'unknown'] as const) test(`${behavior} pauses after one submission and survives queue reconstruction`, async t => {
  const f = await taskPlanningFixture(t, behavior), service = queue(f); let v = await service.create({ taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() });
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('alpha')); await service.startNext(f.plan.id, v.queue.id, await approve(f, v));
  v = await until(() => queue(f).inspect(f.plan.id, v.queue.id), v => v.phase === `paused-${behavior}`);
  await service.prepareNext(f.plan.id, v.queue.id, f.setup('beta')); await service.startNext(f.plan.id, v.queue.id, randomUUID()); assert.equal(f.sends(), 1); assert.equal(v.completed, 0);
});
test('native tool approval is observed as a pause; denial cannot unlock the next work item', async t => {
  const f = await taskPlanningFixture(t, 'permission'), service = queue(f); let v = await service.create({ taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() });
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('alpha')); await service.startNext(f.plan.id, v.queue.id, await approve(f, v));
  v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'needs-tool-approval');
  const a = await f.runtime.owner.withTask(v.queue.task, async tx => (await tx.attempts()).find(a => a.id === v.attemptID)!);
  const session = await f.runtime.sessions.loadAgentSession(a.sessionID!), turn = session!.turns.at(-1)!, execution = await f.execution.read(a.sessionID!, turn.turn_id);
  await f.execution.decide({ sessionID: a.sessionID!, turnID: turn.turn_id, approvalID: execution!.approvals[0].id, decision: 'deny' });
  v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'needs-acceptance');
  const e = await f.runtime.evidence.collect(v.queue.task, v.attemptID!); await assert.rejects(f.runtime.decideResult(v.queue.task, v.attemptID!, { evidenceDigest: e.digest, decision: 'accepted', comment: '' }));
  assert.equal((await service.prepareNext(f.plan.id, v.queue.id, f.setup('beta'))).phase, 'needs-acceptance'); assert.equal(f.sends(), 1);
});
test('stopped queue stays stopped and does not treat native unknown as cancellation confirmation', async t => {
  const f = await taskPlanningFixture(t, 'unknown'), service = queue(f); let v = await service.create({ taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() });
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('alpha')); await service.startNext(f.plan.id, v.queue.id, await approve(f, v));
  v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'paused-unknown'); v = await service.stop(f.plan.id, v.queue.id);
  assert.equal(v.phase, 'stopped'); assert.equal(v.unresolvedAttemptIDs.length, 1);
  await service.prepareNext(f.plan.id, v.queue.id, f.setup('beta')); assert.equal(f.sends(), 1);
});
test('version drift and changed accepted artifacts pause instead of silently advancing', async t => {
  const f = await taskPlanningFixture(t), service = queue(f); let v = await service.create({ taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() });
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('alpha')); await service.startNext(f.plan.id, v.queue.id, await approve(f, v)); v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'needs-acceptance'); await accept(f, v);
  await writeFile(join(f.root, 'workspace', 'alpha.json'), '{"passed":false}'); assert.equal((await service.inspect(f.plan.id, v.queue.id)).phase, 'paused-evidence'); assert.equal(f.sends(), 1);
  await f.plans.editPlan(f.plan.id, 1, { title: 'New task version' }); assert.equal((await service.inspect(f.plan.id, v.queue.id)).phase, 'paused-stale');
});
test('unbound crash preparation is adopted, never resent; human assignment stays a handoff', async t => {
  const f = await taskPlanningFixture(t), service = queue(f); let v = await service.create({ taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() });
  const entry = v.queue.entries[0], setup = f.setup('alpha'); const a = await f.runtime.prepare({ task: v.queue.task, planVersion: 1, workItemID: entry.workItemID, clientRequestID: entry.clientRequestID, agentID: 'alpha', context: setup.context, materials: [], text: setup.text }, setup.selection);
  v = await queue(f).inspect(f.plan.id, v.queue.id); assert.equal(v.attemptID, a.id); assert.equal(v.phase, 'needs-start'); assert.equal(f.sends(), 0);
  await service.stop(f.plan.id, v.queue.id);
  const plan = (await f.plans.loadPlan(f.plan.id))!, first = plan.work_items[0]; const { agentID: _agent, model: _model, ...human } = first;
  const changed = await f.plans.savePlan({ ...plan, work_items: [{ ...human, assignee: 'human' }, plan.work_items[1]] }, 1);
  assert.equal((await service.create({ taskID: changed.id, expectedVersion: changed.version, clientRequestID: randomUUID() })).phase, 'waiting-human');
});
test('reversed stored order still chooses a dependency-ready item; queue cannot bypass its item approval', async t => {
  const f = await taskPlanningFixture(t), p = f.plan;
  const reversed = await f.plans.savePlan({ ...p, work_items: [...p.work_items].reverse() }, 1), service = queue(f);
  let v = await service.create({ taskID: p.id, expectedVersion: reversed.version, clientRequestID: randomUUID() }); assert.equal(v.workItemID, p.work_items[0].id);
  v = await service.prepareNext(p.id, v.queue.id, f.setup('alpha'));
  await assert.rejects(service.startNext(p.id, v.queue.id, randomUUID()), /有效/); assert.equal(f.sends(), 0);
  assert.equal((await service.inspect(p.id, v.queue.id)).phase, 'needs-start');
});
test('explicit rejection pauses the queue and does not create a retry attempt', async t => {
  const f = await taskPlanningFixture(t), service = queue(f); let v = await service.create({ taskID: f.plan.id, expectedVersion: 1, clientRequestID: randomUUID() });
  v = await service.prepareNext(f.plan.id, v.queue.id, f.setup('alpha')); await service.startNext(f.plan.id, v.queue.id, await approve(f, v)); v = await until(() => service.inspect(f.plan.id, v.queue.id), v => v.phase === 'needs-acceptance');
  const e = await f.runtime.evidence.collect(v.queue.task, v.attemptID!); await f.runtime.decideResult(v.queue.task, v.attemptID!, { evidenceDigest: e.digest, decision: 'rejected', comment: 'Need another approach' });
  assert.equal((await service.prepareNext(f.plan.id, v.queue.id, f.setup('beta'))).phase, 'paused-rejected');
  assert.equal((await f.runtime.owner.withTask(v.queue.task, tx => tx.attempts())).length, 1); assert.equal(f.sends(), 1);
});
