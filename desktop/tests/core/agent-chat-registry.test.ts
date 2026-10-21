import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentChatRegistry } from '../../src/core/agents/agent-chat-registry.js';
import type { AgentChatDriver, AgentChatRequest, AgentChatLookup } from '../../src/core/sessions/agent-chat-driver.js';
import { AgentSessionLifecycle } from '../../src/core/sessions/agent-session-lifecycle.js';
import { AgentSessionHistoryStore } from '../../src/core/sessions/agent-session-history-store.js';
import { TEXT_AGENT_CAPABILITIES, type AgentDescriptor } from '../../src/shared/agent-capabilities.js';
import type { AgentChatReadySource } from '../../src/shared/agent-chat.js';

class Fixture implements AgentChatDriver {
  readonly descriptor: AgentDescriptor;
  source: AgentChatReadySource | undefined;
  reads = 0;
  prompts: AgentChatRequest[] = [];
  stops: AgentChatLookup[] = [];
  onPrompt?: () => Promise<void>;
  onStop?: () => void;
  constructor(id: string, protocol: AgentDescriptor['protocol']) {
    this.descriptor = { agentID: id, name: id.toUpperCase(), protocol, capabilities: { ...TEXT_AGENT_CAPABILITIES } };
    this.source = { ...structuredClone(this.descriptor), state: 'ready', configDigest: (id === 'alpha' ? 'a' : 'b').repeat(64), runtimeID: randomUUID(), connectionGeneration: randomUUID(), model: { provider_id: id, model_id: `${id}-model` } };
  }
  getSource() { this.reads++; return structuredClone(this.source); }
  async sendTurn(request: AgentChatRequest, emit: Parameters<AgentChatDriver['sendTurn']>[1]) {
    assert.equal(request.source.agentID, this.descriptor.agentID);
    if (!request.binding) await emit({ type: 'bound', binding: { runtimeID: this.source!.runtimeID, connectionGeneration: this.source!.connectionGeneration, externalSessionID: `${this.descriptor.agentID}-${randomUUID()}` } });
    this.prompts.push(structuredClone(request));
    await emit({ type: 'submitted' });
    await this.onPrompt?.();
    await emit({ type: 'text-delta', text: `${this.descriptor.agentID}:${request.input}` });
    await emit({ type: 'settled', outcome: 'finished' });
  }
  async cancelTurn(lookup: AgentChatLookup) { this.stops.push(structuredClone(lookup)); this.onStop?.(); return { status: 'unknown' as const }; }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-agent-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = new Fixture('alpha', 'acp'), beta = new Fixture('beta', 'native');
  const registry = new AgentChatRegistry([{ driver: alpha }, { driver: beta }]);
  const store = new AgentSessionHistoryStore(root);
  const lifecycle = new AgentSessionLifecycle(store, registry);
  t.after(() => lifecycle.shutdown());
  return { alpha, beta, registry, store, lifecycle, root };
}

test('registration is inert, rejects duplicate/invalid identities, and never falls back to another Agent', () => {
  const alpha = new Fixture('alpha', 'acp'), beta = new Fixture('beta', 'native');
  const registry = new AgentChatRegistry([{ driver: alpha }, { driver: beta }]);
  assert.equal(alpha.reads + beta.reads, 0);
  assert.equal(registry.resolve('unknown'), undefined);
  assert.equal(registry.getSource('unknown'), undefined);
  assert.equal(alpha.reads + beta.reads, 0);
  assert.throws(() => new AgentChatRegistry([{ driver: alpha }, { driver: alpha }]), /重复/);
  (beta.descriptor as unknown as { agentID: unknown }).agentID = undefined;
  assert.throws(() => new AgentChatRegistry([{ driver: beta }]), /无效/);
  assert.equal(alpha.prompts.length + beta.prompts.length, 0);
});

test('source enumeration returns whitelisted isolated metadata and effective capabilities, without credentials', () => {
  const alpha = new Fixture('alpha', 'acp');
  Object.assign(alpha.source!, { credential: 'synthetic-secret', binaryPath: '/synthetic/private/path', rpc: 'synthetic-sdk' });
  const registry = new AgentChatRegistry([{ driver: alpha }]);
  const sources = registry.listSources();
  assert.equal(sources[0].protocol, 'acp'); assert.equal(sources[0].state, 'ready');
  assert.equal(JSON.stringify(sources).includes('synthetic'), false);
  (sources[0].capabilities as { tools: boolean }).tools = true;
  assert.equal(registry.listSources()[0].capabilities.tools, false);
  assert.equal(alpha.prompts.length, 0);
  alpha.source = undefined;
  assert.equal(registry.listSources()[0].state, 'unavailable');
});

test('unsupported capability profiles and mismatched readiness are unavailable before dispatch', async t => {
  const { registry, alpha, beta, lifecycle } = await fixture(t);
  alpha.source!.agentID = 'beta';
  assert.equal((registry.listSources()[0] as { reason: string }).reason, 'invalid-source');
  await assert.rejects(lifecycle.create({ title: 'wrong', agentID: 'alpha' }), /尚未就绪/);
  beta.source!.capabilities = { ...TEXT_AGENT_CAPABILITIES, tools: true };
  await assert.rejects(lifecycle.create({ title: 'changed', agentID: 'beta' }), /尚未就绪/);
  assert.equal(beta.prompts.length + alpha.prompts.length, 0);
  for (const capability of ['streaming', 'nativeContext', 'tools', 'approvals', 'resume', 'modelSelection'] as const) {
    const driver = new Fixture('alpha', 'native');
    driver.descriptor.capabilities = { ...TEXT_AGENT_CAPABILITIES, [capability]: !TEXT_AGENT_CAPABILITIES[capability] };
    driver.source = { ...driver.source!, ...driver.descriptor };
    const unsupported = new AgentChatRegistry([{ driver }]);
    assert.equal((unsupported.listSources()[0] as { reason: string }).reason, 'unsupported');
    assert.equal(driver.reads, 0);
  }
});

test('ACP and native adapters serve separate conversations, bindings and models without history assembly', async t => {
  const { lifecycle, alpha, beta } = await fixture(t);
  const a = await lifecycle.create({ title: 'A', agentID: 'alpha' });
  const b = await lifecycle.create({ title: 'B', agentID: 'beta' });
  const firstA = await lifecycle.send({ sessionID: a.conversation_id, text: 'a1' });
  const firstB = await lifecycle.send({ sessionID: b.conversation_id, text: 'b1' });
  await lifecycle.send({ sessionID: a.conversation_id, text: 'a2' });
  await lifecycle.send({ sessionID: b.conversation_id, text: 'b2' });
  assert.deepEqual(alpha.prompts.map(x => x.input), ['a1', 'a2']);
  assert.deepEqual(beta.prompts.map(x => x.input), ['b1', 'b2']);
  assert.deepEqual(alpha.prompts[1].binding, firstA.session.binding);
  assert.deepEqual(beta.prompts[1].binding, firstB.session.binding);
  assert.notDeepEqual(firstA.session.binding, firstB.session.binding);
  assert.equal(alpha.prompts[1].model.model_id, 'alpha-model');
  assert.equal(beta.prompts[1].model.model_id, 'beta-model');
  assert.equal('messages' in alpha.prompts[1], false);
  // Capability metadata is a live view, not a new field or migration in persisted history.
  assert.equal('capabilities' in firstA.session.source, false);
  assert.equal('protocol' in firstB.session.source, false);
});

test('missing or stopped original Agent never hands an existing conversation to a ready alternative', async t => {
  const { lifecycle, alpha, beta, store } = await fixture(t);
  const a = await lifecycle.create({ title: 'A', agentID: 'alpha' });
  await lifecycle.send({ sessionID: a.conversation_id, text: 'once' });
  const before = await store.load(a.conversation_id);
  alpha.source = undefined;
  await assert.rejects(lifecycle.send({ sessionID: a.conversation_id, text: 'no' }), /尚未就绪/);
  const missing = new AgentSessionLifecycle(store, new AgentChatRegistry([{ driver: beta }]));
  assert.equal((await missing.load(a.conversation_id))?.source.agentID, 'alpha');
  await assert.rejects(missing.send({ sessionID: a.conversation_id, text: 'no' }), /尚未就绪/);
  assert.equal(beta.prompts.length, 0);
  assert.deepEqual(await store.load(a.conversation_id), before);
  await missing.shutdown();
});

test('capability drift during persistence prevents prompt; unregistered creation writes nothing', async t => {
  const { registry, alpha, store } = await fixture(t);
  const saves = { count: 0 };
  const lifecycle = new AgentSessionLifecycle({ ...store, load: (...args) => store.load(...args), list: (...args) => store.list(...args), save: async (...args) => {
    const result = await store.save(...args);
    if (++saves.count === 3) alpha.source!.capabilities = { ...TEXT_AGENT_CAPABILITIES, tools: true };
    return result;
  } }, registry);
  await assert.rejects(lifecycle.create({ title: 'unknown', agentID: 'not-registered' }), /尚未就绪/);
  assert.equal(saves.count, 0);
  const session = await lifecycle.create({ title: 'A', agentID: 'alpha' });
  const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'no prompt' });
  assert.equal(result.status, 'notSubmitted'); assert.equal(alpha.prompts.length, 0);
  await lifecycle.shutdown();
});


test('stopping a live turn still uses its original adapter and binding after readiness changes', async t => {
  const { lifecycle, alpha, beta } = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { release = resolve; });
  alpha.onPrompt = async () => { entered(); await stopped; };
  alpha.onStop = release;
  const session = await lifecycle.create({ title: 'A', agentID: 'alpha' });
  const sending = lifecycle.send({ sessionID: session.conversation_id, text: 'slow' });
  await started;
  alpha.source = undefined;
  await lifecycle.stop(session.conversation_id);
  const result = await sending;
  assert.equal(alpha.stops.length, 1); assert.equal(beta.stops.length, 0);
  assert.deepEqual(alpha.stops[0].binding, result.session.binding);
  assert.equal(beta.prompts.length, 0); assert.equal(alpha.prompts.length, 1);
});


test('runtime metadata errors and malformed bindings stay unavailable without leaking diagnostics', () => {
  const alpha = new Fixture('alpha', 'native');
  const registry = new AgentChatRegistry([{ driver: alpha }]);
  alpha.source!.runtimeID = 'not-a-runtime';
  assert.equal((registry.listSources()[0] as { reason: string }).reason, 'invalid-source');
  alpha.getSource = () => { throw new Error('synthetic-private-runtime-error'); };
  const listing = registry.listSources();
  assert.equal((listing[0] as { reason: string }).reason, 'invalid-source');
  assert.equal(JSON.stringify(listing).includes('synthetic-private'), false);
  assert.equal(alpha.prompts.length, 0);
});
