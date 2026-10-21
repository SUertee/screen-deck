import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeWorkItemDispatchGuard } from '../../src/core/tasks/native-work-item-dispatch-guard.js';
import { NativeWorkItemBridge } from '../../src/core/tasks/native-work-item-bridge.js';
import { NativeWorkItemEvidenceService } from '../../src/core/tasks/native-work-item-evidence.js';
import type { NativeHostReport, NativeTaskRef, NativeTaskTransaction, NativeWorkItemAttempt, NativeWorkItemInput, NativeWorkItemOwner } from '../../src/core/tasks/native-work-item-contract.js';
import { AgentExecutionController } from '../../src/core/agents/agent-execution-controller.js';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { AgentSessionHistoryStore } from '../../src/core/sessions/agent-session-history-store.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { NATIVE_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import type { AgentChatDriver } from '../../src/core/sessions/agent-chat-driver.js';
import type { AgentChatReadySource } from '../../src/shared/agent-chat.js';
import type { PreviewPlan } from '../../src/shared/types.js';

async function fixture(t: test.TestContext, outcome: 'finished' | 'failed' | 'cancelled' | 'unknown' | 'denied' = 'finished') {
  const root = await mkdtemp('/private/tmp/screendeck-work-item-test-');
  const directory = join(root, 'workspace'); await mkdir(directory);
  const execution = new AgentExecutionController(root, () => {});
  let source: AgentChatReadySource = { agentID: 'fixture', name: 'Protocol fixture', protocol: 'native', capabilities: NATIVE_AGENT_CAPABILITIES, state: 'ready', configDigest: 'a'.repeat(64), runtimeID: randomUUID(), connectionGeneration: randomUUID(), model: { provider_id: 'fixture', model_id: 'test' } };
  const binding = { runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration, externalSessionID: 'fixture-thread' };
  let sends = 0;
  const native: AgentChatDriver = {
    descriptor: source, getSource: () => source,
    async sendTurn(req, emit) {
      sends++; assert.ok(req.execution); await emit({ type: 'bound', binding }); await emit({ type: 'submitted' });
      await emit({ type: 'tool', tool: { id: 'tool', title: 'Synthetic check', kind: 'command', status: outcome === 'denied' ? 'failed' : 'completed', output: 'protocol observation only' } });
      if (outcome === 'denied') await emit({ type: 'permission', approval: { id: randomUUID(), toolID: 'tool', title: 'Synthetic denied write', detail: 'fixture', canAllow: false } });
      await emit({ type: 'text-delta', text: 'Synthetic result summary' });
      if (outcome !== 'unknown') await emit({ type: 'settled', outcome: outcome === 'denied' ? 'finished' : outcome });
    },
    async cancelTurn() { return { status: 'unknown' }; },
    async replyPermission() { return { status: 'queued' }; },
  };
  const attempts = new Map<string, NativeWorkItemAttempt>();
  const dispatch = new NativeWorkItemDispatchGuard(async sessionID => [...attempts.values()].some(a => a.sessionID === sessionID));
  const wrapped = execution.wrap(dispatch.wrap(native));
  const drivers = { getSource: () => source, resolve: () => wrapped };
  const sessions = new SessionManager({ store: new SessionHistoryStore(join(root, 'chats')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, async execute() { throw new Error('unused'); } }, agent: { store: new AgentSessionHistoryStore(root), drivers }, persistIntervalMs: 0 });
  t.after(async () => { await sessions.shutdown(); await rm(root, { recursive: true, force: true }); });
  const plan: PreviewPlan = { schema_version: 2, kind: 'electron_preview_plan', id: randomUUID(), title: 'Synthetic task', version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), work_items: [{ id: randomUUID(), title: 'Work item', kind: 'implementation', assignee: 'agent', agentID: 'fixture', status: 'planned', expected_result: 'Synthetic artifact passes check', dependencies: [] }] };
  let queue: Promise<unknown> = Promise.resolve(), dependenciesReady = true, approval = 'allow';
  const tx: NativeTaskTransaction = { loadPlan: async () => structuredClone(plan), attempts: async () => structuredClone([...attempts.values()]), saveAttempt: async a => { attempts.set(a.id, structuredClone(a)); } };
  const owner: NativeWorkItemOwner = {
    withTask<T>(_task: NativeTaskRef, op: (tx: NativeTaskTransaction) => Promise<T>): Promise<T> { const next = queue.then(() => op(tx)); queue = next.catch(() => {}); return next; },
    async assertDependencies() { if (!dependenciesReady) throw new Error('dependencies blocked'); },
    async authorizeStart(a, approvalID) { assert.ok(a.inputDigest); if (approval === 'drift') source = { ...source, connectionGeneration: randomUUID() }; else if (approval !== 'allow' || approvalID !== 'explicit-user-approval') throw new Error('approval denied'); },
  };
  const chosen = await execution.choose(directory);
  const input: NativeWorkItemInput = { task: { kind: 'local', planID: plan.id }, planVersion: 1, workItemID: plan.work_items[0].id, clientRequestID: randomUUID(), agentID: 'fixture', context: { workspace: chosen, mode: 'confirm-changes' }, materials: [], text: 'Only synthetic protocol work' };
  const services = { sessions, execution, drivers, dispatch };
  const bridge = new NativeWorkItemBridge(owner, services);
  let report: NativeHostReport = { verifier: 'fixture-only-v1', artifacts: [{ reference: 'fixture://artifact', sha256: 'a'.repeat(64), bytes: 12 }], checks: [{ name: 'fixture check', outcome: 'passed', outputDigest: 'b'.repeat(64) }] }, stale = false;
  const evidence = new NativeWorkItemEvidenceService(owner, services, { inspect: async () => structuredClone(report), verify: async () => { if (stale) throw new Error('artifact changed'); } });
  return { input, bridge, evidence, services, owner, attempts, plan, sends: () => sends, dependencies: (v: boolean) => { dependenciesReady = v; }, approval: (v: string) => { approval = v; }, changeSource: () => { source = { ...source, connectionGeneration: randomUUID() }; }, changeReport: () => { report.checks[0].outcome = 'unknown'; }, stale: () => { stale = true; } };
}
const start = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const a = await f.bridge.prepare(f.input);
  return f.bridge.start(f.input.task, a.id, 'explicit-user-approval');
};
const decision = (digest: string, value: 'accepted' | 'rejected' = 'accepted') => ({ evidenceDigest: digest, decision: value, actor: 'fixture-user', comment: 'Fixture review' });
test('prepare and concurrent duplicate start send once through real SessionManager/controller; review is separate', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.bridge.prepare(f.input), f.bridge.prepare(f.input)]);
  assert.equal(a.id, b.id); assert.equal(f.sends(), 0);
  const results = await Promise.all([f.bridge.start(f.input.task, a.id, 'explicit-user-approval'), f.bridge.start(f.input.task, a.id, 'explicit-user-approval')]);
  assert.equal(f.sends(), 1); assert.equal(results[0].status, 'finished');
  assert.equal((await f.bridge.prepare(f.input)).id, a.id);
  const e = await f.evidence.collect(f.input.task, a.id);
  assert.equal(e.summary, 'Synthetic result summary'); assert.equal(e.native.tools[0].output, 'protocol observation only');
  await f.evidence.decide(f.input.task, a.id, decision(e.digest));
  await f.evidence.decide(f.input.task, a.id, decision(e.digest));
  assert.equal(f.attempts.get(a.id)?.acceptance?.decision, 'accepted');
  assert.equal(f.plan.work_items[0].status, 'planned');
  await assert.rejects(f.evidence.decide(f.input.task, a.id, decision(e.digest, 'rejected')), /不同决定/);
});
test('request identity rejects changed content, selected materials and permission', async t => {
  const f = await fixture(t); await f.bridge.prepare(f.input);
  for (const changes of [{ text: 'changed' }, { context: { ...f.input.context, mode: 'full-access' as const } }, { materials: [{ reference: 'fixture://x', digest: 'c'.repeat(64), summary: 'selected' }] }]) await assert.rejects(f.bridge.prepare({ ...f.input, ...changes }), /更改输入/);
  assert.equal(f.sends(), 0);
});
for (const change of ['version', 'dependency', 'source', 'approval'] as const) test(`${change} change before start blocks submission`, async t => {
  const f = await fixture(t); const a = await f.bridge.prepare(f.input);
  if (change === 'version') f.plan.version++;
  if (change === 'dependency') f.dependencies(false);
  if (change === 'source') f.changeSource();
  if (change === 'approval') f.approval('deny');
  await assert.rejects(f.bridge.start(f.input.task, a.id, 'explicit-user-approval')); assert.equal(f.sends(), 0);
});
for (const outcome of ['failed', 'cancelled', 'unknown', 'denied'] as const) test(`${outcome} cannot auto-complete or accept with passing host fixture report`, async t => {
  const f = await fixture(t, outcome); const a = await start(f);
  assert.equal(a.status, outcome === 'denied' ? 'finished' : outcome);
  const e = await f.evidence.collect(f.input.task, a.id);
  await assert.rejects(f.evidence.decide(f.input.task, a.id, decision(e.digest)));
  await f.evidence.decide(f.input.task, a.id, decision(e.digest, 'rejected'));
  await f.bridge.start(f.input.task, a.id, 'explicit-user-approval'); assert.equal(f.sends(), 1);
  assert.equal(f.plan.work_items[0].status, 'planned');
});
test('native observations alone cannot pass code acceptance; host changes invalidate evidence', async t => {
  const f = await fixture(t); const a = await start(f);
  const withoutHost = new NativeWorkItemEvidenceService(f.owner, f.services);
  const e = await withoutHost.collect(f.input.task, a.id);
  await assert.rejects(withoutHost.decide(f.input.task, a.id, decision(e.digest)), /缺少宿主/);
  const before = await f.evidence.collect(f.input.task, a.id); f.stale();
  await assert.rejects(f.evidence.decide(f.input.task, a.id, decision(before.digest)), /artifact changed/);
  f.changeReport(); await assert.rejects(f.evidence.decide(f.input.task, a.id, decision(before.digest)), /证据已变化/);
});
test('crash after durable dispatch intent cannot resend from reconstructed bridge', async t => {
  const f = await fixture(t); const a = await f.bridge.prepare(f.input);
  f.attempts.set(a.id, { ...a, status: 'dispatching' });
  const restarted = new NativeWorkItemBridge(f.owner, f.services);
  await restarted.start(f.input.task, a.id, 'explicit-user-approval'); assert.equal(f.sends(), 0);
  assert.equal((await restarted.refresh(f.input.task, a.id)).status, 'unknown');
  assert.equal((await restarted.prepare(f.input)).status, 'unknown');
  await assert.rejects(restarted.prepare({ ...f.input, clientRequestID: randomUUID() }), /未解决/);
});
test('result digest and original turn/source binding reject unrelated evidence', async t => {
  const f = await fixture(t); const a = await start(f);
  await assert.rejects(f.evidence.decide(f.input.task, a.id, decision('0'.repeat(64))), /证据已变化/);
  f.attempts.set(a.id, { ...f.attempts.get(a.id)!, clientRequestID: randomUUID() });
  await assert.rejects(f.evidence.collect(f.input.task, a.id), /来源不匹配/);
});

test('managed sessions reject ordinary chat sends without work-item dispatch permission', async t => {
  const f = await fixture(t); const a = await f.bridge.prepare(f.input);
  const result = await f.services.sessions.sendAgentMessage({ sessionID: a.sessionID!, text: 'Bypass work-item approval' });
  assert.equal(result.status, 'notSubmitted'); assert.equal(f.sends(), 0);
});
test('prepared cancellation is local; stale plan cannot accept a finished result', async t => {
  const f = await fixture(t); const a = await f.bridge.prepare(f.input);
  await f.bridge.stop(f.input.task, a.id); assert.equal(f.attempts.get(a.id)?.status, 'cancelled'); assert.equal(f.sends(), 0);
  const next = { ...f.input, clientRequestID: randomUUID() }; const b = await f.bridge.prepare(next);
  await f.bridge.start(f.input.task, b.id, 'explicit-user-approval'); const e = await f.evidence.collect(f.input.task, b.id);
  f.plan.version++; await assert.rejects(f.evidence.decide(f.input.task, b.id, decision(e.digest)), /计划版本已变化/);
});

test('connection drift after start approval is caught at native adapter dispatch boundary', async t => {
  const f = await fixture(t); const a = await f.bridge.prepare(f.input); f.approval('drift');
  const result = await f.bridge.start(f.input.task, a.id, 'explicit-user-approval');
  assert.equal(result.status, 'failed'); assert.equal(f.sends(), 0);
});
