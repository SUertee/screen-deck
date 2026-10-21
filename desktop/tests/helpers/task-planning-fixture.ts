import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type test from 'node:test';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { AgentSessionHistoryStore } from '../../src/core/sessions/agent-session-history-store.js';
import { AgentExecutionController } from '../../src/core/agents/agent-execution-controller.js';
import { ApprovalService } from '../../src/core/approvals/approval-service.js';
import { createNativeWorkItemRuntime } from '../../src/core/tasks/native-work-item-runtime.js';
import { NativePermissionRequests } from '../../src/core/agents/native-tools.js';
import { NATIVE_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import { currentPlanningCandidates } from '../../src/main/task-planning-module.js';
import type { AgentChatDriver } from '../../src/core/sessions/agent-chat-driver.js';
import type { PlanningModel } from '../../src/core/tasks/task-planning-contract.js';
export async function taskPlanningFixture(t: test.TestContext, behavior: 'success' | 'failed' | 'unknown' | 'permission' = 'success') {
  const root = await mkdtemp('/private/tmp/screendeck-planning-test-'), directory = join(root, 'workspace'); await mkdir(directory);
  const plans = new TaskOrchestrator(root, { formalTasks: true }), execution = new AgentExecutionController(root, () => {}), approvals = new ApprovalService(root), permissions = new NativePermissionRequests();
  const sources = ['alpha', 'beta'].map(agentID => ({ agentID, name: agentID, protocol: 'native' as const, capabilities: NATIVE_AGENT_CAPABILITIES, state: 'ready' as const, configDigest: agentID === 'alpha' ? 'a'.repeat(64) : 'b'.repeat(64), runtimeID: randomUUID(), connectionGeneration: randomUUID(), model: { provider_id: 'fixture', model_id: `${agentID}-model` } }));
  let sends = 0; const nativeRequests: string[] = [];
  const drivers: AgentChatDriver[] = sources.map(source => ({ descriptor: source, getSource: () => source,
    async sendTurn(req, emit) {
      sends++; nativeRequests.push(source.agentID);
      const binding = { runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration, externalSessionID: req.sessionID };
      await emit({ type: 'bound', binding }); await emit({ type: 'submitted' });
      await emit({ type: 'tool', tool: { id: 'fixture-write', title: 'Fixture writes', kind: 'write', status: 'pending' } });
      let allow = true;
      if (behavior === 'permission') allow = await permissions.ask({ source: req.source, binding, clientRequestID: req.clientRequestID }, { toolID: 'fixture-write', title: 'Fixture permission', detail: 'Synthetic', canAllow: true }, emit, 10000);
      if (allow) await writeFile(join(directory, `${source.agentID}.json`), '{"passed":true}');
      await emit({ type: 'tool', tool: { id: 'fixture-write', title: 'Fixture writes', kind: 'write', status: allow ? 'completed' : 'failed' } });
      await emit({ type: 'text-delta', text: 'Protocol fixture result' });
      if (behavior !== 'unknown') await emit({ type: 'settled', outcome: behavior === 'failed' ? 'failed' : 'finished' });
    },
    async replyPermission(lookup, id, choice) { return permissions.reply(lookup, id, choice); },
    async cancelTurn(lookup) { permissions.cancel(lookup); return { status: 'unknown' }; },
  }));
  const runtime = createNativeWorkItemRuntime({ root, execution, approvals, loadPlan: id => plans.loadPlan(id), transactPlan: (id, op) => plans.transactPlan(id, op), actor: () => 'fixture-user', registrations: drivers.map(driver => ({ driver })), createSessions: registry => new SessionManager({ store: new SessionHistoryStore(join(root, 'chats')), driver: { capabilities: { chat: true, tools: false, remoteAbort: false, remoteSessions: false }, async execute() { throw new Error('unused'); } }, agent: { store: new AgentSessionHistoryStore(root), drivers: registry }, persistIntervalMs: 0 }) });
  plans.configureNativeWorkItems({ assertPlanIdle: p => runtime.owner.assertIdle(p), assertProjectIdle: s => runtime.owner.assertProjectIdle(s) });
  const workspace = await execution.choose(directory);
  const firstID = randomUUID(), secondID = randomUUID();
  const workItems = [ { id: firstID, title: 'First', kind: 'implementation' as const, assignee: 'agent' as const, agentID: 'alpha', model: sources[0].model, status: 'planned' as const, expected_result: 'alpha JSON passed is true', dependencies: [] }, { id: secondID, title: 'Second', kind: 'validation' as const, assignee: 'agent' as const, agentID: 'beta', model: sources[1].model, status: 'planned' as const, expected_result: 'beta JSON passed is true', dependencies: [firstID] } ];
  const plan = await plans.createPlan('Main task: verify two files', workItems, undefined, { schemaVersion: 3 });
  const draft = { steps: [{ key: 'first', title: 'First', kind: 'implementation' as const, completion_conditions: ['alpha JSON passed is true'], dependencies: [], candidateIDs: ['native-alpha', 'human'], preferredCandidateID: 'native-alpha' }, { key: 'second', title: 'Second', kind: 'validation' as const, completion_conditions: ['beta JSON passed is true'], dependencies: ['first'], candidateIDs: ['native-beta'], preferredCandidateID: 'native-beta' }] };
  let modelCalls = 0;
  const model: PlanningModel = { async capture() { return { source: { kind: 'chat-completions', requestedModel: { provider_id: 'fixture', model_id: 'planning-model' }, configDigest: 'c'.repeat(64) }, async generate() { modelCalls++; return { text: JSON.stringify(draft), observedModel: { provider_id: 'fixture', model_id: 'planning-model' } }; } }; } };
  const setup = (agentID: string) => ({ context: { workspace, mode: 'confirm-changes' as const }, materials: [], text: 'Only the confirmed synthetic work item', selection: { artifacts: [`${agentID}.json`], checks: [{ name: `${agentID} actual content`, path: `${agentID}.json`, kind: 'json-equals' as const, pointer: ['passed'], expected: true }] } });
  t.after(async () => { await runtime.sessions.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, plans, runtime, execution, plan, sources, draft, model, setup, modelCalls: () => modelCalls, sends: () => sends, nativeRequests, candidates: () => currentPlanningCandidates(runtime) };
}
export async function until<T>(operation: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 250; n++) { const value = await operation(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 4)); }
  throw new Error('Fixture condition not reached');
}
