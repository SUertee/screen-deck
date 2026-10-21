import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { agent, client, type AgentConnection, type PromptResponse, type SessionConfigOption, type SessionNotification } from '@agentclientprotocol/sdk';
import { OpenCodeAcpAdapter } from '../../src/core/agents/opencode/opencode-acp-adapter.js';
import { ExecutionError } from '../../src/core/sessions/execution-driver.js';
import type { OpenCodeAcpConnection, OpenCodeAcpEvent } from '../../src/core/agents/opencode/opencode-acp-connection.js';
import type { ExecutionLookup, ExternalExecutionBinding, TaskEventEnvelope, TaskExecutionRequest } from '../../src/shared/task-execution.js';

const model = { provider_id: 'screendeck', model_id: 'fixture-model' };
const sessionID = 'fixture-native-session';
const modelOptions = (): SessionConfigOption[] => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'screendeck/fixture-model', options: [{ value: 'screendeck/fixture-model', name: 'Fixture model' }] }];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const waitFor = async (predicate: () => boolean) => { for (let count = 0; count < 200 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), 'Fixture condition did not arrive'); };
type Scenario = 'success' | 'hold' | 'tool' | 'permission' | 'replacement' | 'other-session' | 'error' | 'disconnect' | 'two-messages';

async function fixture(t: test.TestContext, scenario: Scenario = 'success') {
  const counts = { sessions: 0, models: 0, prompts: 0, cancels: 0, loads: 0, permissions: 0, allows: 0 };
  const inputs: unknown[] = [];
  const listeners = new Set<(event: OpenCodeAcpEvent) => Promise<void>>();
  const end = deferred<PromptResponse>();
  let peer!: AgentConnection;
  let cancelledResponse: PromptResponse | undefined = { stopReason: 'cancelled' };
  let canStart = true;
  let options = modelOptions();
  let rpc!: ReturnType<ReturnType<typeof client>['connect']>;
  const broadcast = async (event: OpenCodeAcpEvent) => {
    for (const listener of listeners) {
      try { await listener(event); }
      catch (error) { rpc.close(); throw error; }
    }
  };
  const app = agent()
    .onConnect(connection => { peer = connection; })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: 'OpenCode', version: '1.19.0' }, authMethods: [] }))
    .onRequest('session/new', ({ params }) => { counts.sessions++; inputs.push(params); return { sessionId: counts.sessions === 1 ? sessionID : `${sessionID}-${counts.sessions}`, modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] }, configOptions: options }; })
    .onRequest('session/set_config_option', async ({ params, client: remote }) => {
      counts.models++; inputs.push(params);
      await remote.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options } });
      return { configOptions: options };
    })
    .onRequest('session/load', () => { counts.loads++; throw new Error('Loading is deliberately unsupported'); })
    .onNotification('session/cancel', ({ params }) => { counts.cancels++; inputs.push(params); if (cancelledResponse) end.resolve(cancelledResponse); })
    .onRequest('session/prompt', async ({ params, client: remote }) => {
      const sessionID = params.sessionId;
      counts.prompts++; inputs.push(params);
      if (scenario === 'disconnect') { peer.close(); return { stopReason: 'end_turn' }; }
      if (scenario === 'error') throw new Error('Bearer private-fixture-key raw-provider-body');
      if (scenario === 'permission') {
        await remote.request('session/request_permission', { sessionId: sessionID, toolCall: { toolCallId: 'forbidden-write', title: 'Write a file' }, options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }, { kind: 'reject_once', optionId: 'deny', name: 'Deny' }] });
      }
      if (scenario === 'tool') await remote.notify('session/update', { sessionId: sessionID, update: { sessionUpdate: 'tool_call', toolCallId: 'forbidden-command', title: 'Run a command', kind: 'execute', status: 'pending' } });
      if (scenario === 'replacement') await remote.notify('session/update', { sessionId: sessionID, update: { sessionUpdate: 'compaction_update', compactionId: 'replacement', status: 'completed', summary: [{ type: 'text', text: 'Replacement output' }] } });
      if (scenario === 'other-session') await remote.notify('session/update', { sessionId: 'unrelated-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Other conversation' } } });
      await remote.notify('session/update', { sessionId: sessionID, update: { sessionUpdate: 'agent_message_chunk', messageId: 'assistant-1', content: { type: 'text', text: 'Fixture ' } } });
      await remote.notify('session/update', { sessionId: sessionID, update: { sessionUpdate: 'agent_message_chunk', messageId: scenario === 'two-messages' ? 'assistant-2' : 'assistant-1', content: { type: 'text', text: 'reply' } } });
      await remote.notify('session/update', { sessionId: sessionID, update: { sessionUpdate: 'usage_update', used: 12, size: 100 } });
      return scenario === 'hold' ? end.promise : { stopReason: 'end_turn' };
    });
  rpc = client()
    .onNotification('session/update', ({ params }) => broadcast({ type: 'session-update', notification: params }))
    .onRequest('session/request_permission', async ({ params }) => {
      counts.permissions++;
      try { await broadcast({ type: 'forbidden-permission', request: params }); } catch { /* A no-tools violation never grants permission. */ }
      return { outcome: { outcome: 'selected', optionId: 'deny' } };
    }).connect(app);
  await rpc.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  let connection: OpenCodeAcpConnection | undefined = { runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', directory: '/fixture/empty-runtime-directory', version: '1.19.0', configDigest: 'a'.repeat(64), model, rpc, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const adapter = new OpenCodeAcpAdapter({ getConnection: () => connection, canStart: () => canStart, requestTimeoutMs: 300, executionTimeoutMs: 800, cancelTimeoutMs: 40 });
  const request: TaskExecutionRequest = { turn: { session: { format: 'task-v2', sessionID: randomUUID() }, turnID: randomUUID() }, clientRequestID: randomUUID(), model, input: 'Only displayed discussion text.', spec: { work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: 'Fixture discussion', kind: 'discussion', expectedResult: 'Text', dependencies: [], inputMessageID: randomUUID(), workspace: { workspaceID: randomUUID(), bindingDigest: 'b'.repeat(64) }, materials: [], driver: { driverID: 'opencode-acp-no-tools', configDigest: connection.configDigest, mode: 'external' }, tools: { kind: 'none' } }, resolved: { workspaceRoot: '/never-mounted/project', materials: [] } };
  t.after(() => { end.resolve({ stopReason: 'cancelled' }); rpc.close(); peer.close(); });
  const lookup = (binding?: ExternalExecutionBinding): ExecutionLookup => ({ clientRequestID: request.clientRequestID, driver: request.spec.driver, workspace: request.spec.workspace, binding });
  const events: TaskEventEnvelope[] = [];
  const run = (callback: (event: TaskEventEnvelope) => Promise<void> = async event => { events.push(event); }, signal = new AbortController().signal) => adapter.executeTask(request, callback, signal);
  const binding = () => { const event = events.find(value => value.event.type === 'bound')?.event; assert.equal(event?.type, 'bound'); if (event?.type !== 'bound') throw new Error(); return event.binding; };
  return { adapter, request, counts, inputs, events, run, lookup, binding, end, broadcast, rpc, get connection() { return connection; }, set connection(value: OpenCodeAcpConnection | undefined) { connection = value; }, set options(value: SessionConfigOption[]) { options = value; }, set cancelledResponse(value: PromptResponse | undefined) { cancelledResponse = value; }, set canStart(value: boolean) { canStart = value; } };
}

test('official SDK v1 saves the native session before one prompt, with no invented submission ID or workspace mount', { timeout: 5000 }, async t => {
  const h = await fixture(t); const saved = deferred<void>();
  const execution = h.run(async event => { h.events.push(event); if (event.event.type === 'bound') await saved.promise; });
  await waitFor(() => h.events.length > 0);
  assert.equal(h.counts.prompts, 0); assert.equal(h.counts.models, 1);
  assert.equal(h.binding().externalSubmissionID, undefined);
  saved.resolve(); await execution;
  assert.equal(h.counts.prompts, 1); assert.equal(h.counts.loads, 0);
  assert.deepEqual(h.inputs[0], { cwd: '/fixture/empty-runtime-directory', mcpServers: [] });
  const input = h.inputs.at(-1) as Record<string, unknown>;
  assert.deepEqual(input, { sessionId: sessionID, prompt: [{ type: 'text', text: h.request.input }] });
  assert.ok(h.events.some(event => event.event.type === 'submitted' && !('externalSubmissionID' in event.event)));
  assert.deepEqual(h.events.filter(event => event.event.type === 'text-delta').map(event => event.event.type === 'text-delta' ? event.event.text : ''), ['Fixture ', 'reply']);
  assert.equal(h.events.at(-1)?.event.type, 'settled');
  assert.deepEqual(h.events.map(event => event.sequence), h.events.map((_event, index) => index + 1));
  const observation = await h.adapter.inspectExecution(h.lookup(h.binding()));
  assert.equal(observation.status, 'finished'); if (observation.status === 'finished') assert.equal(observation.output, 'Fixture reply');
  assert.ok(!h.events.some(event => event.event.type === 'observed-model'));
});

test('a binding save failure and a revoked generation never issue the prompt', { timeout: 5000 }, async t => {
  for (const revoke of [false, true]) {
    const h = await fixture(t);
    await assert.rejects(h.run(async event => { if (event.event.type === 'bound') { if (revoke) h.connection = { ...h.connection!, connectionGeneration: 'another-generation' }; else throw new Error('Fixture save failure'); } }));
    assert.equal(h.counts.prompts, 0);
  }
});

test('settings changed during task binding persistence prevent prompt but preserve original submitted finish and cancel', { timeout: 5000 }, async t => {
  const h = await fixture(t); const saved = deferred<void>();
  const execution = h.run(async event => { h.events.push(event); if (event.event.type === 'bound') await saved.promise; });
  const rejected = assert.rejects(execution, error => error instanceof ExecutionError && error.attempted);
  await waitFor(() => h.events.some(event => event.event.type === 'bound'));
  h.canStart = false; saved.resolve(); await rejected;
  assert.equal(h.counts.prompts, 0); assert.equal(h.counts.sessions, 1);
  for (const cancel of [false, true]) {
    const active = await fixture(t, 'hold'); const running = active.run();
    await waitFor(() => active.counts.prompts === 1); active.canStart = false;
    if (cancel) assert.deepEqual(await active.adapter.cancelExecution(active.lookup(active.binding())), { status: 'confirmed' });
    else active.end.resolve({ stopReason: 'end_turn' });
    await running;
    assert.equal((await active.adapter.inspectExecution(active.lookup(active.binding()))).status, cancel ? 'cancelled' : 'finished');
    assert.equal(active.counts.prompts, 1); assert.equal(active.counts.sessions, 1);
  }
});

test('duplicate local calls cannot create or prompt another native session', { timeout: 5000 }, async t => {
  const h = await fixture(t); await h.run(); await assert.rejects(h.run());
  assert.equal(h.counts.sessions, 1); assert.equal(h.counts.prompts, 1);
  assert.equal('execute' in h.adapter, false);
  assert.equal(h.adapter.taskCapabilities.reconcile, false); assert.equal(h.adapter.taskCapabilities.permissionReply, false);
});

test('wrong driver, model, configuration, tools, materials, work kind and slash commands fail before ACP calls', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  for (const mutate of [
    (r: TaskExecutionRequest) => { r.spec.driver.driverID = 'opencode-no-tools'; },
    (r: TaskExecutionRequest) => { r.model.model_id = 'another'; },
    (r: TaskExecutionRequest) => { r.spec.driver.configDigest = 'b'.repeat(64); },
    (r: TaskExecutionRequest) => { r.spec.kind = 'implementation'; },
    (r: TaskExecutionRequest) => { r.spec.tools = { kind: 'restricted', readRoots: [], writeRoots: [], commands: [] }; },
    (r: TaskExecutionRequest) => { r.spec.materials = [{ referenceID: 'fixture', contentDigest: 'c'.repeat(64) }]; },
    (r: TaskExecutionRequest) => { r.resolved.materials = [{ reference: { referenceID: 'fixture', contentDigest: 'c'.repeat(64) }, bytes: new Uint8Array() }]; },
    (r: TaskExecutionRequest) => { r.input = ' /init'; },
  ]) { const input = structuredClone(h.request); mutate(input); await assert.rejects(h.adapter.executeTask(input, async () => {}, new AbortController().signal)); }
  assert.equal(h.counts.sessions, 0); assert.equal(h.counts.prompts, 0);
});

test('text persistence is serialized and must finish before the terminal event', { timeout: 5000 }, async t => {
  const h = await fixture(t); const saved = deferred<void>(); let writes = 0;
  const execution = h.run(async event => { h.events.push(event); if (event.event.type === 'text-delta' && ++writes === 1) await saved.promise; });
  await waitFor(() => writes === 1); assert.equal(h.events.some(event => event.event.type === 'settled'), false);
  saved.resolve(); await execution; assert.equal(writes, 2); assert.equal(h.events.at(-1)?.event.type, 'settled');
});

test('other sessions are ignored and original lookup identity cannot be redirected', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'other-session'); await h.run();
  const native = h.binding();
  for (const changed of [{ ...native, externalSessionID: 'other' }, { ...native, runtimeID: 'other' }, { ...native, externalSubmissionID: 'pretend-native-id' }]) {
    assert.equal((await h.adapter.inspectExecution(h.lookup(changed))).status, 'unverifiable');
    assert.equal((await h.adapter.cancelExecution(h.lookup(changed))).status, 'unknown');
  }
  assert.equal(h.counts.cancels, 0); assert.equal(h.counts.loads, 0);
  h.connection = { ...h.connection!, connectionGeneration: 'replaced' };
  assert.equal((await h.adapter.inspectExecution(h.lookup(native))).status, 'unverifiable');
});

test('unexpected tools, permission, replacement and a second assistant never produce a finished result', { timeout: 5000 }, async t => {
  for (const scenario of ['tool', 'permission', 'replacement', 'two-messages'] as const) {
    const h = await fixture(t, scenario); await assert.rejects(h.run());
    assert.ok(!h.events.some(event => event.event.type === 'settled' && event.event.outcome === 'finished'));
    assert.equal(h.counts.allows, 0); assert.equal(h.counts.prompts, 1);
  }
});

test('cancel is confirmed only by the same original prompt cancelled response', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'hold'); const execution = h.run();
  await waitFor(() => h.counts.prompts === 1);
  assert.deepEqual(await h.adapter.cancelExecution(h.lookup(h.binding())), { status: 'confirmed' });
  await execution;
  assert.equal(h.counts.cancels, 1); assert.equal(h.counts.prompts, 1);
  assert.equal((await h.adapter.inspectExecution(h.lookup(h.binding()))).status, 'cancelled');
});

test('cancel notification and a normal finish are not confirmed cancellation', { timeout: 5000 }, async t => {
  for (const response of [undefined, { stopReason: 'end_turn' } as PromptResponse]) {
    const h = await fixture(t, 'hold'); h.cancelledResponse = response;
    const execution = h.run(); const done = execution.catch(() => undefined);
    await waitFor(() => h.counts.prompts === 1);
    assert.deepEqual(await h.adapter.cancelExecution(h.lookup(h.binding())), { status: 'unknown' });
    h.end.resolve({ stopReason: 'end_turn' }); await done;
    assert.equal(h.counts.prompts, 1);
  }
});

test('cancelling before the bound save completes closes the local send gate without inventing a remote receipt', { timeout: 5000 }, async t => {
  const h = await fixture(t); const saved = deferred<void>();
  const execution = h.run(async event => { h.events.push(event); if (event.event.type === 'bound') await saved.promise; });
  await waitFor(() => h.events.length > 0);
  assert.deepEqual(await h.adapter.cancelExecution(h.lookup()), { status: 'unknown' });
  saved.resolve(); await assert.rejects(execution); assert.equal(h.counts.prompts, 0); assert.equal(h.counts.cancels, 0);
});

test('disconnect and private prompt errors stay unknown, redacted and never reload or resend', { timeout: 5000 }, async t => {
  for (const scenario of ['disconnect', 'error'] as const) {
    const h = await fixture(t, scenario);
    await assert.rejects(h.run(), error => error instanceof Error && !/private-fixture-key|raw-provider-body/.test(error.message));
    assert.equal((await h.adapter.inspectExecution(h.lookup(h.binding()))).status, 'unverifiable');
    await assert.rejects(h.run()); assert.equal(h.counts.prompts, 1); assert.equal(h.counts.loads, 0);
  }
});

test('local shutdown promptly stops reception; a new adapter cannot reconcile or reissue the old prompt', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'hold'); const controller = new AbortController(); const execution = h.run(undefined, controller.signal);
  await waitFor(() => h.counts.prompts === 1); controller.abort(); await assert.rejects(execution);
  assert.equal(h.counts.cancels, 0);
  const restarted = new OpenCodeAcpAdapter({ getConnection: () => h.connection });
  assert.equal((await restarted.inspectExecution(h.lookup(h.binding()))).status, 'unverifiable');
  assert.equal((await restarted.cancelExecution(h.lookup(h.binding()))).status, 'unknown');
  assert.equal(h.counts.prompts, 1); assert.equal(h.counts.loads, 0);
});

test('evicting the bounded terminal cache loses inspection evidence but never reopens the original submit claim', { timeout: 5000 }, async t => {
  const h = await fixture(t); const firstRequest = structuredClone(h.request);
  await h.run(); const firstLookup = h.lookup(h.binding());
  for (let index = 0; index < 64; index++) { h.request.clientRequestID = randomUUID(); h.request.turn.turnID = randomUUID(); await h.run(); }
  assert.equal(h.counts.prompts, 65); assert.equal((await h.adapter.inspectExecution(firstLookup)).status, 'unverifiable');
  await assert.rejects(h.adapter.executeTask(firstRequest, async () => {}, new AbortController().signal));
  assert.equal(h.counts.prompts, 65); assert.equal(h.counts.sessions, 65); assert.equal(h.counts.loads, 0);
});
