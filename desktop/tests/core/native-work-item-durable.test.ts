import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { AgentSessionHistoryStore } from '../../src/core/sessions/agent-session-history-store.js';
import { AgentExecutionController } from '../../src/core/agents/agent-execution-controller.js';
import { ApprovalService } from '../../src/core/approvals/approval-service.js';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import { createNativeWorkItemRuntime } from '../../src/core/tasks/native-work-item-runtime.js';
import { nativeWorkItemRouteHandlers } from '../../src/core/tasks/native-work-item-routes.js';
import { withNativeTaskGate } from '../../src/core/tasks/native-work-item-durable-owner.js';
import { NATIVE_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import type { NativeWorkItemInput, NativeTaskTransaction } from '../../src/core/tasks/native-work-item-contract.js';
import type { NativeEvidenceSelection } from '../../src/core/tasks/native-work-item-host-verifier.js';
import type { AgentChatDriver } from '../../src/core/sessions/agent-chat-driver.js';
import type { PreviewPlan } from '../../src/shared/types.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp('/private/tmp/screendeck-durable-native-'), workspacePath = join(root, 'workspace'); await mkdir(workspacePath);
  const plans = new TaskOrchestrator(root), approvals = new ApprovalService(root);
  const id = randomUUID();
  const plan = await plans.createPlan('Durable synthetic task', [{ id, title: 'Produce a verified file', kind: 'implementation', assignee: 'agent', agentID: 'fixture', status: 'planned', expected_result: 'JSON answer equals 42', dependencies: [] }], undefined, { schemaVersion: 2 });
  const source = { agentID: 'fixture', name: 'Synthetic Native', protocol: 'native' as const, capabilities: NATIVE_AGENT_CAPABILITIES, state: 'ready' as const, configDigest: 'a'.repeat(64), runtimeID: randomUUID(), connectionGeneration: randomUUID(), model: { provider_id: 'fixture', model_id: 'fixture' } };
  let hold: Promise<void> | undefined, release: (() => void) | undefined;
  let sends = 0, writes = true, failure: 'none' | 'failed' | 'unknown' = 'none';
  const native: AgentChatDriver = {
    descriptor: source, getSource: () => source,
    async sendTurn(request, emit) {
      sends++; await emit({ type: 'bound', binding: { runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration, externalSessionID: request.sessionID } }); await emit({ type: 'submitted' });
      await hold;
      if (writes) await writeFile(join(workspacePath, 'output.json'), '{"answer":42}');
      await emit({ type: 'tool', tool: { id: 'fixture-write', title: 'Protocol fixture writes synthetic file', kind: 'write', status: 'completed' } });
      await emit({ type: 'text-delta', text: 'Synthetic result only' });
      if (failure !== 'unknown') await emit({ type: 'settled', outcome: failure === 'failed' ? 'failed' : 'finished' });
    },
    async cancelTurn() { return { status: 'unknown' }; }, async replyPermission() { return { status: 'queued' }; },
  };
  const runtimes: ReturnType<typeof createNativeWorkItemRuntime>[] = [];
  let v3: PreviewPlan | undefined;
  const create = (shared = false) => {
    const execution = new AgentExecutionController(root, () => {});
    const transactPlan = async <T>(id: string, operation: (plan: PreviewPlan) => Promise<{ plan?: PreviewPlan; value: T }>): Promise<{ value: T; plan?: PreviewPlan }> => withNativeTaskGate(root, { kind: 'local', planID: id }, async () => {
      const current = await plans.loadPlan(id); assert.ok(current); const result = await operation(current); assert.equal(result.plan, undefined); return result;
    });
    const runtime = createNativeWorkItemRuntime({ root, ...(shared ? { transactPlan } : {}), loadPlan: async id => v3?.id === id ? structuredClone(v3) : plans.loadPlan(id), approvals, execution, registrations: [{ driver: native }], actor: () => 'trusted-main-user',
      createSessions: registry => new SessionManager({ store: new SessionHistoryStore(join(root, 'chats')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, async execute() { throw new Error('unused'); } }, agent: { store: new AgentSessionHistoryStore(root), drivers: registry }, persistIntervalMs: 0 }),
    });
    runtimes.push(runtime); return runtime;
  };

  // Workspace selection belongs to the existing controller; use the instance supplied to a runtime below.
  const chosenController = new AgentExecutionController(root, () => {});
  // Factory retains the supplied execution controller via registered drivers; construct a selected runtime.
  const selectedWorkspace = await chosenController.choose(workspacePath);
  const selected = createNativeWorkItemRuntime({ root, loadPlan: async id => v3?.id === id ? structuredClone(v3) : plans.loadPlan(id), approvals, execution: chosenController, registrations: [{ driver: native }], actor: () => 'trusted-main-user', createSessions: registry => new SessionManager({ store: new SessionHistoryStore(join(root, 'chats')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, async execute() {} }, agent: { store: new AgentSessionHistoryStore(root), drivers: registry }, persistIntervalMs: 0 }) });
  runtimes.push(selected);
  t.after(async () => { for (const r of runtimes) await r.sessions.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); });
  const input: NativeWorkItemInput = { task: { kind: 'local', planID: plan.id }, workItemID: id, planVersion: 1, clientRequestID: randomUUID(), agentID: 'fixture', context: { workspace: selectedWorkspace, mode: 'confirm-changes' }, materials: [], text: 'Create only the synthetic artifact' };
  const selection: NativeEvidenceSelection = { artifacts: ['output.json'], checks: [{ name: 'JSON answer is 42', path: 'output.json', kind: 'json-equals', pointer: ['answer'], expected: 42 }, { name: 'Expected bytes occur', path: 'output.json', kind: 'utf8-contains', expected: '42' }] };
  return { root, plans, approvals, workspacePath, runtime: selected, create, input, selection, sends: () => sends, hold: () => { hold = new Promise<void>(resolve => { release = resolve; }); }, release: () => release?.(), write: (v: boolean) => { writes = v; }, failure: (v: typeof failure) => { failure = v; }, v3: () => { v3 = { ...plan, schema_version: 3, task: { goal: 'Explicit v3 goal', completion_conditions: ['Real JSON check'], materials: [{ summary: 'DO NOT SEND UNSELECTED MATERIAL' }] } } as unknown as PreviewPlan; } };
}
async function prepared(f: Awaited<ReturnType<typeof fixture>>) { return f.runtime.prepare(f.input, f.selection); }
async function execute(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await prepared(f), approval = await f.runtime.owner.requestStartApproval(f.input.task, a.id);
  await f.runtime.decideStart(f.input.task, approval.id, 'approved');
  return f.runtime.bridge.start(f.input.task, a.id, approval.id);
}
test('durable owner, real file verifier, real ApprovalService and routes survive reconstruction', async t => {
  const f = await fixture(t), a = await execute(f);
  assert.equal(a.status, 'finished'); assert.equal(f.sends(), 1);
  const e = await f.runtime.evidence.collect(f.input.task, a.id);
  assert.equal(e.host?.artifacts[0].bytes, 13); assert.ok(e.host?.checks.every(c => c.outcome === 'passed'));
  const routes = nativeWorkItemRouteHandlers(f.runtime);
  await routes['task:native:acceptance']({ task: f.input.task, attemptID: a.id, evidenceDigest: e.digest, decision: 'accepted', comment: 'Reviewed actual bytes' });
  const restarted = f.create();
  const restored = await restarted.owner.withTask(f.input.task, tx => tx.attempts());
  assert.equal(restored[0].acceptance?.actor, 'trusted-main-user'); assert.equal(restored[0].acceptance?.decision, 'accepted');
  assert.equal(await restarted.owner.isManagedSession(a.sessionID!), true);
  const e2 = await restarted.evidence.collect(f.input.task, a.id); assert.equal(e2.digest, e.digest);
  const snapshot = await restarted.snapshots.load(a.id, e.digest); assert.deepEqual(snapshot, e);
  await writeFile(join(f.workspacePath, 'output.json'), '{"answer":0}');
  assert.deepEqual(await restarted.snapshots.load(a.id, e.digest), e, 'Historical evidence remains readable without becoming current verification');
  await restarted.bridge.start(f.input.task, a.id, randomUUID()); assert.equal(f.sends(), 1);
  const files = await readdir(join(f.root, 'native-work-item-journals-v1')); assert.equal(files.length, 1);
});
test('separate durable owners serialize request identity and cannot submit the same attempt twice', async t => {
  const f = await fixture(t), a = await prepared(f), second = f.create();
  const [one, two] = await Promise.all([f.runtime.owner.requestStartApproval(f.input.task, a.id), second.owner.requestStartApproval(f.input.task, a.id)]);
  assert.equal(one.id, two.id); await f.runtime.decideStart(f.input.task, one.id, 'approved');
  await Promise.all([f.runtime.bridge.start(f.input.task, a.id, one.id), second.bridge.start(f.input.task, a.id, one.id)]); assert.equal(f.sends(), 1);
});
test('real host checks reject missing files, failed values and changes after evidence collection', async t => {
  const f = await fixture(t); f.write(false); const a = await execute(f);
  const missing = await f.runtime.evidence.collect(f.input.task, a.id); assert.equal(missing.host?.artifacts.length, 0); assert.ok(missing.host?.checks.every(c => c.outcome === 'unknown'));
  await assert.rejects(f.runtime.decideResult(f.input.task, a.id, { evidenceDigest: missing.digest, decision: 'accepted', comment: '' }));
  await writeFile(join(f.workspacePath, 'output.json'), '{"answer":7}');
  const wrong = await f.runtime.evidence.collect(f.input.task, a.id); assert.ok(wrong.host?.checks.some(c => c.outcome === 'failed'));
  await assert.rejects(f.runtime.decideResult(f.input.task, a.id, { evidenceDigest: wrong.digest, decision: 'accepted', comment: '' }));
  await writeFile(join(f.workspacePath, 'output.json'), '{"answer":42}'); const good = await f.runtime.evidence.collect(f.input.task, a.id);
  await writeFile(join(f.workspacePath, 'output.json'), '{"answer":0}');
  await assert.rejects(f.runtime.decideResult(f.input.task, a.id, { evidenceDigest: good.digest, decision: 'accepted', comment: '' }), /证据已变化/);
});
test('unsafe evidence paths, symlinks, absent selection and renderer passed flags do not enable acceptance', async t => {
  const f = await fixture(t);
  for (const path of ['../outside', '/etc/passwd', 'nested/../x']) await assert.rejects(f.runtime.prepare(f.input, { artifacts: [path], checks: [{ kind: 'utf8-contains', name: 'bad', path, expected: 'x' }] }));
  const a = await f.runtime.bridge.prepare(f.input);
  await assert.rejects(f.runtime.owner.requestStartApproval(f.input.task, a.id), /尚未确认/);
  await f.runtime.host.bindSelection(a, f.selection);
  await assert.rejects(f.runtime.host.bindSelection(a, { ...f.selection, checks: [{ ...f.selection.checks[0], passed: true }] } as unknown as NativeEvidenceSelection));
  await writeFile(join(f.root, 'outside'), '{"answer":42}'); await symlink(join(f.root, 'outside'), join(f.workspacePath, 'output.json'));
  const report = await f.runtime.host.inspect(a); assert.ok(report.checks.some(c => c.outcome === 'unknown')); await assert.rejects(f.runtime.host.verify(a, report));
});
test('revocation and rejection are durable, explicit approval never sends by itself', async t => {
  const f = await fixture(t), a = await prepared(f), request = await f.runtime.owner.requestStartApproval(f.input.task, a.id);
  await f.runtime.decideStart(f.input.task, request.id, 'approved'); assert.equal(f.sends(), 0);
  await f.runtime.owner.revokeStartApproval(f.input.task, request.id);
  await assert.rejects(f.runtime.bridge.start(f.input.task, a.id, request.id), /有效/);
  const r2 = await f.runtime.owner.requestStartApproval(f.input.task, a.id); await f.runtime.decideStart(f.input.task, r2.id, 'rejected');
  await assert.rejects(f.runtime.bridge.start(f.input.task, a.id, r2.id)); assert.equal(f.sends(), 0);
});
test('plan mutation uses durable idle state; existing plan CAS stays the sole plan writer', async t => {
  const f = await fixture(t), a = await prepared(f), plan = (await f.plans.loadPlan(f.input.task.planID))!;
  f.plans.configureNativeWorkItems({ assertPlanIdle: p => f.runtime.owner.assertIdle(p), assertProjectIdle: scope => f.runtime.owner.assertProjectIdle(scope) });
  await assert.rejects(f.plans.editPlan(plan.id, 1, { title: 'Blocked' }), /不能修改计划/);
  await f.runtime.bridge.stop(f.input.task, a.id);
  const saved = await f.plans.editPlan(plan.id, 1, { title: 'Allowed' }); assert.equal(saved.version, 2);
  await assert.rejects(f.plans.editPlan(saved.id, 1, { title: 'Stale' }), /版本冲突/);
});
test('shared project gate conflicts with TaskOrchestrator existing task gate rather than creating parallel authority', async t => {
  const f = await fixture(t), scope = { project_id: `project-${randomUUID()}`, task_id: 'task-001' };
  const plan = await f.plans.createPlan('Project', [], scope);
  await assert.rejects(withNativeTaskGate(f.root, { kind: 'project', projectID: scope.project_id, taskID: scope.task_id, planID: plan.id }, () => f.plans.editPlan(plan.id, 1, { title: 'Must lock' })), /另一写入者/);
});
test('closed transactions and modified durable immutable identities are rejected', async t => {
  const f = await fixture(t), a = await prepared(f); let leaked: NativeTaskTransaction | undefined;
  await f.runtime.owner.withTask(f.input.task, async tx => { leaked = tx; await assert.rejects(tx.saveAttempt({ ...a, prompt: 'tampered' }), /指纹/); });
  await assert.rejects(leaked!.attempts(), /事务已结束/);
  const dir = join(f.root, 'native-work-item-journals-v1'), filename = join(dir, (await readdir(dir))[0]);
  const raw = JSON.parse(await readFile(filename, 'utf8')); raw.attempts[0].unknownField = 'forged'; await writeFile(filename, JSON.stringify(raw));
  await assert.rejects(f.create().owner.isManagedSession(a.sessionID!));
});
test('v3 goals and completion conditions are frozen; unselected materials do not enter prompt', async t => {
  const f = await fixture(t); f.v3(); const a = await prepared(f);
  assert.match(a.prompt, /Explicit v3 goal/); assert.match(a.prompt, /Real JSON check/); assert.doesNotMatch(a.prompt, /DO NOT SEND/);
});

test('explicit v3 material mapping validates digest and screen confirmation, without auto-selecting', async () => {
  const { selectNativeTaskMaterials, validateNativeTaskMaterials, nativeReferenceForPlan } = await import('../../src/core/tasks/native-work-item-task-adapter.js');
  const material = { id: randomUUID(), title: 'Confirmed note', summary: 'Chosen summary', source: { kind: 'note', reference: 'note://selected', label: 'Note' } };
  const plan = { id: randomUUID(), schema_version: 3, task: { goal: 'Goal', completion_conditions: [], materials: [material] } } as unknown as PreviewPlan;
  assert.deepEqual(selectNativeTaskMaterials(plan, []), []);
  const selected = selectNativeTaskMaterials(plan, [material.id]); assert.equal(selected[0].summary, 'Chosen summary');
  const a = { input: { materials: selected } } as unknown as Parameters<typeof validateNativeTaskMaterials>[1]; await validateNativeTaskMaterials(plan, a);
  await assert.rejects(validateNativeTaskMaterials(plan, { input: { materials: [{ ...selected[0], summary: 'Forged' }] } } as typeof a));
  material.source.kind = 'screen'; assert.throws(() => selectNativeTaskMaterials(plan, [material.id]), /确认标识/);
  assert.deepEqual(nativeReferenceForPlan({ kind: 'local', planID: plan.id }, plan), { kind: 'local', planID: plan.id });
  assert.throws(() => nativeReferenceForPlan({ kind: 'project', projectID: 'wrong', taskID: 'wrong' }, plan));
});

test('local owner uses A planGate lock filename; a held plan lock blocks preparation', async t => {
  const f = await fixture(t);
  const { withExclusiveLock } = await import('../../src/core/storage/private-storage.js');
  await withExclusiveLock(join(f.root, `.plan-${f.input.task.planID}.lock`), async () => { await assert.rejects(prepared(f), /另一写入者/); });
  assert.equal(f.sends(), 0);
});

test('unknown survives a fresh factory and never gets another submission', async t => {
  const f = await fixture(t); f.failure('unknown'); const a = await execute(f);
  assert.equal(a.status, 'unknown'); const fresh = f.create();
  const restored = await fresh.bridge.refresh(f.input.task, a.id); assert.equal(restored.status, 'unknown');
  await fresh.bridge.start(f.input.task, a.id, randomUUID()); assert.equal(f.sends(), 1);
  const evidence = await fresh.evidence.collect(f.input.task, a.id);
  await assert.rejects(fresh.decideResult(f.input.task, a.id, { evidenceDigest: evidence.digest, decision: 'accepted', comment: '' }));
});

test('owner uses supplied shared transactPlan gate without taking the same filesystem lock again', async t => {
  const f = await fixture(t), a = await prepared(f), shared = f.create(true);
  const request = await shared.owner.requestStartApproval(f.input.task, a.id);
  await shared.decideStart(f.input.task, request.id, 'approved');
  const result = await shared.bridge.start(f.input.task, a.id, request.id);
  assert.equal(result.status, 'finished'); assert.equal(f.sends(), 1);
  const evidence = await shared.evidence.collect(f.input.task, a.id);
  await shared.decideResult(f.input.task, a.id, { evidenceDigest: evidence.digest, decision: 'accepted', comment: '' });
});

test('dependencies require accepted current native evidence, then detect later artifact changes', async t => {
  const f = await fixture(t), plan = (await f.plans.loadPlan(f.input.task.planID))!;
  const dependent = { ...plan.work_items[0], id: randomUUID(), title: 'Dependent', dependencies: [plan.work_items[0].id] };
  const saved = await f.plans.savePlan({ ...plan, work_items: [...plan.work_items, dependent] }, plan.version); f.input.planVersion = saved.version;
  const a = await execute(f), evidence = await f.runtime.evidence.collect(f.input.task, a.id);
  const nextInput = { ...f.input, workItemID: dependent.id, clientRequestID: randomUUID() };
  await assert.rejects(f.runtime.prepare(nextInput, f.selection), /依赖/);
  await f.runtime.decideResult(f.input.task, a.id, { evidenceDigest: evidence.digest, decision: 'accepted', comment: '' });
  const next = await f.runtime.prepare(nextInput, f.selection); await f.runtime.bridge.stop(f.input.task, next.id);
  await writeFile(join(f.workspacePath, 'output.json'), '{"answer":0}');
  await assert.rejects(f.runtime.prepare({ ...nextInput, clientRequestID: randomUUID() }, f.selection), /依赖/);
});


test('start receipt returns during a live native turn and duplicate begin never resends', async t => {
  const f = await fixture(t); f.hold();
  try {
    const a = await prepared(f), approval = await f.runtime.owner.requestStartApproval(f.input.task, a.id);
    await f.runtime.decideStart(f.input.task, approval.id, 'approved');
    const receipt = await Promise.race([f.runtime.begin(f.input.task, a.id, approval.id), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Start blocked on native completion')), 2000); timer.unref(); })]);
    assert.equal(receipt.status, 'dispatching'); assert.equal(receipt.id, a.id);
    const duplicate = await f.runtime.begin(f.input.task, a.id, approval.id); assert.equal(duplicate.id, a.id);
    const deadline = Date.now() + 2000;
    while (!f.sends() && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sends(), 1);
    f.release();
    let current = await f.runtime.bridge.refresh(f.input.task, a.id);
    while (current.status === 'dispatching' && Date.now() < deadline) { await new Promise<void>(resolve => setTimeout(resolve, 10)); current = await f.runtime.bridge.refresh(f.input.task, a.id); }
    assert.equal(current.status, 'finished'); assert.equal(f.sends(), 1);
  } finally { f.release(); }
});
