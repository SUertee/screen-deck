import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { agent, client, type AgentConnection, type PromptResponse, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { ExecutionError } from '../../src/core/execution-driver.js';
import type { AgentChatExecutionEvent, AgentChatRequest } from '../../src/core/agent-chat-driver.js';
import type { AgentChatBinding } from '../../src/shared/agent-chat.js';
import type { OpenCodeAcpConnection, OpenCodeAcpEvent } from '../../src/main/opencode-acp-connection.js';
import { OpenCodeAgentChatAdapter } from '../../src/main/opencode-agent-chat-adapter.js';

const model = { provider_id: 'screendeck', model_id: 'fixture-model' };
const options = (): SessionConfigOption[] => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'screendeck/fixture-model', options: [{ value: 'screendeck/fixture-model', name: 'Fixture model' }] }];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const waitFor = async (condition: () => boolean) => { for (let n = 0; n < 300 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(condition(), 'Fixture condition did not arrive'); };
type Scenario = 'success' | 'hold' | 'tool' | 'permission' | 'replacement' | 'disconnect' | 'error' | 'two-messages' | 'old-message' | 'no-message-id' | 'refusal';

/** Official stable SDK client/agent peers in memory. No process, HTTP or model. */
async function fixture(t: test.TestContext, initial: Scenario = 'success') {
  const counts = { sessions: 0, prompts: 0, models: 0, cancels: 0, loads: 0, permissions: 0, allows: 0 };
  const inputs: { sessionId: string; prompt: unknown }[] = [];
  const listeners = new Set<(event: OpenCodeAcpEvent) => Promise<void>>();
  const holds = new Map<number, ReturnType<typeof deferred<PromptResponse>>>();
  const events: AgentChatExecutionEvent[] = [];
  let peer!: AgentConnection;
  let rpc!: ReturnType<ReturnType<typeof client>['connect']>;
  let scenario = initial;
  let cancelledResponse: PromptResponse | undefined = { stopReason: 'cancelled' };
  let canStart = true;
  const broadcast = async (event: OpenCodeAcpEvent) => {
    for (const listener of listeners) { try { await listener(event); } catch (error) { rpc.close(); throw error; } }
  };
  const app = agent()
    .onConnect(connection => { peer = connection; })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: 'OpenCode', version: '1.19.0' }, authMethods: [] }))
    .onRequest('session/new', ({ params }) => { counts.sessions++; assert.deepEqual(params, { cwd: '/fixture/empty-runtime', mcpServers: [] }); return { sessionId: `native-${counts.sessions}`, configOptions: options(), modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] } }; })
    .onRequest('session/set_config_option', async ({ params, client: remote }) => { counts.models++; assert.equal(params.value, 'screendeck/fixture-model'); await remote.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options() } }); return { configOptions: options() }; })
    .onRequest('session/load', () => { counts.loads++; throw new Error('No implicit resume'); })
    .onNotification('session/cancel', () => { counts.cancels++; if (cancelledResponse) holds.get(counts.prompts)?.resolve(cancelledResponse); })
    .onRequest('session/prompt', async ({ params, client: remote }) => {
      const number = ++counts.prompts;
      inputs.push({ sessionId: params.sessionId, prompt: params.prompt });
      const end = deferred<PromptResponse>(); holds.set(number, end);
      if (scenario === 'disconnect') { peer.close(); return { stopReason: 'end_turn' }; }
      if (scenario === 'error') throw new Error('private-fixture-key private-provider-body');
      if (scenario === 'permission') await remote.request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'forbidden-write', title: 'Write' }, options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }, { kind: 'reject_once', optionId: 'deny', name: 'Deny' }] });
      if (scenario === 'tool') await remote.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'forbidden-tool', title: 'Command', status: 'pending', kind: 'execute' } });
      if (scenario === 'replacement') await remote.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'compaction_update', compactionId: 'replacement', status: 'completed', summary: [{ type: 'text', text: 'Replacement' }] } });
      const messageId = scenario === 'old-message' ? 'assistant-1' : scenario === 'no-message-id' ? undefined : `assistant-${number}`;
      await remote.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text: `Reply ${number}` } } });
      if (scenario === 'two-messages') await remote.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: `second-${number}`, content: { type: 'text', text: 'Other reply' } } });
      await remote.notify('session/update', { sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'foreign', content: { type: 'text', text: 'Other conversation' } } });
      return scenario === 'hold' ? end.promise : { stopReason: scenario === 'refusal' ? 'refusal' : 'end_turn' };
    });
  rpc = client()
    .onNotification('session/update', ({ params }) => broadcast({ type: 'session-update', notification: params }))
    .onRequest('session/request_permission', async ({ params }) => { counts.permissions++; try { await broadcast({ type: 'forbidden-permission', request: params }); } catch { /* Always deny. */ } return { outcome: { outcome: 'selected', optionId: 'deny' } }; })
    .connect(app);
  await rpc.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  let connection: OpenCodeAcpConnection | undefined = { runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', directory: '/fixture/empty-runtime', version: '1.19.0', configDigest: 'a'.repeat(64), model, rpc, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } };
  const adapter = new OpenCodeAgentChatAdapter({ getConnection: () => connection, canStart: () => canStart, requestTimeoutMs: 300, executionTimeoutMs: 900, cancelTimeoutMs: 40 });
  const sessionID = randomUUID();
  const request = (binding?: AgentChatBinding, text = 'Only this input.'): AgentChatRequest => ({ sessionID, turnID: randomUUID(), clientRequestID: randomUUID(), source: { agentID: 'opencode', configDigest: 'a'.repeat(64) }, model: { ...model }, input: text, ...(binding ? { binding } : {}) });
  const run = (input = request(), callback: (event: AgentChatExecutionEvent) => Promise<void> = async event => { events.push(event); }, signal = new AbortController().signal) => adapter.sendTurn(input, callback, signal);
  const binding = () => { const event = events.find(event => event.type === 'bound'); assert.ok(event && event.type === 'bound'); return event.binding; };
  const cancel = (input: AgentChatRequest) => adapter.cancelTurn({ clientRequestID: input.clientRequestID, source: input.source, binding: input.binding ?? binding() });
  const update = (binding: AgentChatBinding, kind: 'text' | 'tool' = 'text', messageID = 'late-assistant') => broadcast({ type: 'session-update', notification: { sessionId: binding.externalSessionID, update: kind === 'text' ? { sessionUpdate: 'agent_message_chunk', messageId: messageID, content: { type: 'text', text: 'Late output' } } : { sessionUpdate: 'tool_call', toolCallId: 'late-tool', title: 'Late tool', status: 'pending' } } });
  t.after(() => { for (const end of holds.values()) end.resolve({ stopReason: 'cancelled' }); rpc.close(); peer.close(); });
  return { adapter, counts, inputs, events, request, run, binding, cancel, update, rpc, end: (number: number, response: PromptResponse) => holds.get(number)!.resolve(response), get connection() { return connection; }, set connection(value: OpenCodeAcpConnection | undefined) { connection = value; }, set scenario(value: Scenario) { scenario = value; }, set canStart(value: boolean) { canStart = value; }, set cancelledResponse(value: PromptResponse | undefined) { cancelledResponse = value; } };
}

test('two Agent turns reuse one native context and send only each current input, without Task or replay', { timeout: 5000 }, async t => {
  const h = await fixture(t); const ready = h.adapter.getSource(); assert.ok(ready);
  assert.equal(ready.agentID, 'opencode'); assert.equal(ready.runtimeID, 'fixture-runtime'); assert.equal(ready.connectionGeneration, 'fixture-generation');
  await h.run(h.request(undefined, 'First question.')); await h.run(h.request(h.binding(), 'Second question.'));
  assert.equal(h.counts.sessions, 1); assert.equal(h.counts.prompts, 2); assert.equal(h.counts.loads, 0);
  assert.deepEqual(h.inputs, [{ sessionId: 'native-1', prompt: [{ type: 'text', text: 'First question.' }] }, { sessionId: 'native-1', prompt: [{ type: 'text', text: 'Second question.' }] }]);
  assert.equal(h.events.filter(event => event.type === 'bound').length, 1);
  assert.deepEqual(h.events.filter(event => event.type === 'text-delta').map(event => event.type === 'text-delta' && event.text), ['Reply 1', 'Reply 2']);
  assert.equal(h.events.filter(event => event.type === 'settled' && event.outcome === 'finished').length, 2);
  assert.ok(!h.events.some(event => event.type === 'observed-model'));
});

test('binding persistence is awaited, and a failed save has no prompt attempted', { timeout: 5000 }, async t => {
  const h = await fixture(t); const saved = deferred<void>();
  const running = h.run(h.request(), async event => { h.events.push(event); if (event.type === 'bound') await saved.promise; });
  await waitFor(() => h.events.some(event => event.type === 'bound')); assert.equal(h.counts.prompts, 0);
  saved.resolve(); await running; assert.equal(h.counts.prompts, 1);
  const failed = await fixture(t);
  await assert.rejects(failed.run(failed.request(), async event => { if (event.type === 'bound') throw new Error('save failed'); }), error => error instanceof ExecutionError && error.attempted === false);
  assert.equal(failed.counts.prompts, 0);
});

test('configuration change after the last preparation await blocks prompt, while active cancel uses original raw identity', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  await assert.rejects(h.run(h.request(), async event => { h.events.push(event); if (event.type === 'bound') h.canStart = false; }), error => error instanceof ExecutionError && !error.attempted);
  assert.equal(h.counts.prompts, 0); assert.equal(h.adapter.getSource(), undefined);
  const active = await fixture(t, 'hold'); const input = active.request(); const executing = active.run(input);
  await waitFor(() => active.counts.prompts === 1); active.canStart = false;
  assert.equal(active.adapter.getSource(), undefined); assert.deepEqual(await active.cancel(input), { status: 'confirmed' }); await executing;
});

test('stale source, model, slash commands and invented binding cannot create or redirect a native session', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  for (const mutate of [(r: AgentChatRequest) => { r.source.agentID = 'other'; }, (r: AgentChatRequest) => { r.source.configDigest = 'b'.repeat(64); }, (r: AgentChatRequest) => { r.model.model_id = 'other'; }, (r: AgentChatRequest) => { r.input = ' /init'; }, (r: AgentChatRequest) => { r.binding = { runtimeID: 'invented', connectionGeneration: 'invented', externalSessionID: 'invented' }; }]) {
    const input = h.request(); mutate(input); await assert.rejects(h.run(input), error => error instanceof ExecutionError && !error.attempted);
  }
  assert.equal(h.counts.sessions, 0); await h.run(); const binding = h.binding();
  for (const changed of [{ ...binding, externalSessionID: 'other' }, { ...binding, runtimeID: 'other' }, { ...binding, connectionGeneration: 'other' }]) await assert.rejects(h.run(h.request(changed)));
  await assert.rejects(h.run(h.request())); // A persisted binding cannot be silently replaced.
  const hijacked = h.request(binding); hijacked.sessionID = randomUUID(); await assert.rejects(h.run(hijacked));
  h.connection = { ...h.connection!, connectionGeneration: 'restarted' }; await assert.rejects(h.run(h.request(binding)));
  assert.equal(h.counts.sessions, 1); assert.equal(h.counts.prompts, 1); assert.equal(h.counts.loads, 0);
});

test('concurrent sends and duplicate local IDs refuse a second prompt, including after completion', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'hold'); const first = h.request(); const running = h.run(first);
  await waitFor(() => h.counts.prompts === 1);
  await assert.rejects(h.run(first)); await assert.rejects(h.run(h.request(h.binding())));
  h.end(1, { stopReason: 'end_turn' }); await running;
  await assert.rejects(h.run({ ...first, binding: h.binding() }));
  assert.equal(h.counts.sessions, 1); assert.equal(h.counts.prompts, 1);
});

test('old assistant IDs and missing subsequent IDs cannot attribute text to the next turn', { timeout: 5000 }, async t => {
  for (const scenario of ['old-message', 'no-message-id'] as const) {
    const h = await fixture(t); await h.run(); h.scenario = scenario;
    await assert.rejects(h.run(h.request(h.binding())), error => error instanceof ExecutionError && error.attempted);
    assert.equal(h.events.filter(event => event.type === 'settled').length, 1);
    assert.equal(h.events.filter(event => event.type === 'text-delta').length, 1);
    assert.equal(h.counts.sessions, 1); assert.equal(h.counts.prompts, 2);
  }
});

test('late execution events between turns seal the original native context', { timeout: 5000 }, async t => {
  for (const kind of ['text', 'tool'] as const) {
    const h = await fixture(t); await h.run(); await assert.rejects(h.update(h.binding(), kind));
    await assert.rejects(h.run(h.request(h.binding()))); assert.equal(h.counts.prompts, 1);
  }
});

test('late chunk or tool while terminal persistence waits cannot reopen an already settled context', { timeout: 5000 }, async t => {
  for (const kind of ['text', 'tool'] as const) {
    const h = await fixture(t); const saved = deferred<void>(); let settling = false;
    const running = h.run(h.request(), async event => { h.events.push(event); if (event.type === 'settled') { settling = true; await saved.promise; } });
    const rejected = assert.rejects(running);
    await waitFor(() => settling);
    const late = h.update(h.binding(), kind); const lateRejected = assert.rejects(late);
    saved.resolve(); await rejected; await lateRejected;
    assert.equal(h.events.filter(event => event.type === 'settled').length, 1);
    assert.equal(h.events.filter(event => event.type === 'text-delta').length, 1);
    await assert.rejects(h.run(h.request(h.binding()))); assert.equal(h.counts.prompts, 1);
  }
});

test('tools, permissions, replacements and additional assistant messages never become finished Agent replies', { timeout: 5000 }, async t => {
  for (const scenario of ['tool', 'permission', 'replacement', 'two-messages'] as const) {
    const h = await fixture(t, scenario);
    await assert.rejects(h.run(), error => error instanceof ExecutionError && error.attempted);
    assert.ok(!h.events.some(event => event.type === 'settled' && event.outcome === 'finished'));
    assert.equal(h.counts.prompts, 1); assert.equal(h.counts.allows, 0); assert.equal(h.counts.loads, 0);
    await assert.rejects(h.run(h.request(h.binding()))); assert.equal(h.counts.prompts, 1);
  }
});

test('only the original cancelled prompt proof permits a safely saved continuation', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'hold'); const first = h.request(); const running = h.run(first);
  await waitFor(() => h.counts.prompts === 1); assert.deepEqual(await h.cancel(first), { status: 'confirmed' }); await running;
  assert.equal(h.events.at(-1)?.type, 'settled'); assert.ok(h.events.some(event => event.type === 'settled' && event.outcome === 'cancelled'));
  h.scenario = 'success'; await h.run(h.request(h.binding())); assert.equal(h.counts.prompts, 2); assert.equal(h.counts.sessions, 1);
});

test('an unconfirmed cancel never reuses native context even if the original prompt later returns end_turn', { timeout: 5000 }, async t => {
  for (const cancelledResponse of [undefined, { stopReason: 'end_turn' } as PromptResponse]) {
    const h = await fixture(t, 'hold'); h.cancelledResponse = cancelledResponse; const first = h.request(); const running = h.run(first);
    await waitFor(() => h.counts.prompts === 1); assert.deepEqual(await h.cancel(first), { status: 'unknown' });
    h.end(1, { stopReason: 'end_turn' }); await running;
    await assert.rejects(h.run(h.request(h.binding()))); assert.equal(h.counts.prompts, 1);
  }
});

test('local stop does not claim remote cancellation, and disconnect or private errors remain redacted without replay', { timeout: 5000 }, async t => {
  const local = await fixture(t, 'hold'); const controller = new AbortController(); const running = local.run(local.request(), undefined, controller.signal);
  await waitFor(() => local.counts.prompts === 1); controller.abort(); await assert.rejects(running); assert.equal(local.counts.cancels, 0);
  await assert.rejects(local.run(local.request(local.binding()))); assert.equal(local.counts.prompts, 1);
  for (const scenario of ['disconnect', 'error'] as const) {
    const h = await fixture(t, scenario); await assert.rejects(h.run(), error => error instanceof ExecutionError && error.attempted && !/private-fixture-key|private-provider-body/.test(error.message));
    assert.equal(h.counts.prompts, 1); assert.equal(h.counts.loads, 0);
    await assert.rejects(h.run(h.request(h.binding()))); assert.equal(h.counts.prompts, 1);
  }
});

test('an explicit failed stop reason is saved but cannot continue the failed native context', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'refusal'); await h.run(); assert.ok(h.events.some(event => event.type === 'settled' && event.outcome === 'failed'));
  await assert.rejects(h.run(h.request(h.binding()))); assert.equal(h.counts.prompts, 1);
});

test('evicting terminal proof does not allow a continuous chat client request to be resubmitted', { timeout: 5000 }, async t => {
  const h = await fixture(t); const first = h.request(); await h.run(first); const binding = h.binding();
  for (let n = 0; n < 64; n++) await h.run(h.request(binding));
  await assert.rejects(h.run({ ...first, binding })); assert.equal(h.counts.prompts, 65); assert.equal(h.counts.sessions, 1); assert.equal(h.counts.loads, 0);
});
