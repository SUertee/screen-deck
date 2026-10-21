import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { ExecutionError } from '../../src/core/sessions/execution-driver.js';
import { OpenCodeAdapter, type OpenCodeConnection } from '../../src/core/agents/opencode/opencode-adapter.js';
import type { ExecutionLookup, ExternalExecutionBinding, TaskEventEnvelope, TaskExecutionRequest } from '../../src/shared/task-execution.js';

const model = { provider_id: 'screendeck', model_id: 'fixture-model' };
const deny = [{ permission: '*', pattern: '*', action: 'deny' }];
const sessionID = 'ses_00000000000011111111111111';
const assistantID = 'msg_00000000000022222222222222';
type Scenario = 'success' | 'lost-receipt' | 'idle' | 'permission' | 'tool' | 'error' | 'no-ready' | 'disconnect' | 'conflict' | 'regression' | 'redirect';

async function fixture(t: test.TestContext, scenario: Scenario = 'success') {
  const streams = new Set<ServerResponse>();
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown>; directory: string | null; authorization?: string }> = [];
  let messages: unknown[] = []; let promptID = ''; let aborted = false; let status = 'busy'; let serial = 0;
  const events = (type: string, properties: Record<string, unknown> = {}, id = `evt_${++serial}`) => {
    const packet = { id, type, properties }; for (const stream of streams) stream.write(`data: ${JSON.stringify(packet)}\n\n`); return packet;
  };
  const user = () => ({ info: { id: promptID, sessionID, role: 'user', time: { created: 1 }, model: { providerID: model.provider_id, modelID: model.model_id } }, parts: [{ id: 'prt_user', sessionID, messageID: promptID, type: 'text', text: 'Only explicit input.' }] });
  const assistant = (text = 'Fixture reply', completed = true, finish: unknown = 'stop', error?: unknown) => ({
    info: { id: assistantID, sessionID, role: 'assistant', parentID: promptID, providerID: model.provider_id, modelID: model.model_id, time: { created: 2, ...(completed ? { completed: 3 } : {}) }, ...(finish === undefined ? {} : { finish }), ...(error ? { error } : {}) },
    parts: [{ id: 'prt_assistant', sessionID, messageID: assistantID, type: 'text', text }],
  });
  const finish = () => { messages = [user(), assistant()]; status = 'idle'; events('message.updated', { sessionID, info: (messages[1] as ReturnType<typeof assistant>).info }); };
  const json = (res: ServerResponse, value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture.invalid'); const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown> | undefined; try { if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(); return; }
    calls.push({ path: url.pathname, method: req.method!, body, directory: url.searchParams.get('directory'), authorization: req.headers.authorization });
    if (scenario === 'redirect' && url.pathname === '/session') { res.writeHead(302, { Location: 'http://example.invalid/secret' }); res.end(); return; }
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); streams.add(res); res.on('close', () => streams.delete(res));
      if (scenario !== 'no-ready') res.write(`data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', properties: {} })}\n\n`);
      return;
    }
    if (url.pathname === '/session' && req.method === 'POST') { json(res, { id: sessionID, directory: '/fixture/isolated-runtime', permission: deny }); return; }
    if (url.pathname === `/session/${sessionID}`) { json(res, { id: sessionID, directory: '/fixture/isolated-runtime', permission: deny }); return; }
    if (url.pathname === `/session/${sessionID}/message`) { json(res, messages); return; }
    if (url.pathname === '/session/status') { json(res, status === 'idle' ? {} : { [sessionID]: { type: status } }); return; }
    if (url.pathname === `/permission/per_fixture/reply`) { json(res, true); return; }
    if (url.pathname === `/session/${sessionID}/abort`) { if (aborted) messages = [user(), assistant('Partial', true, undefined, { name: 'MessageAbortedError', data: { message: 'private detail' } })]; json(res, true); return; }
    if (url.pathname === `/session/${sessionID}/prompt_async`) {
      promptID = body!.messageID as string;
      messages = [user(), assistant('Fixture reply', false, undefined)];
      if (scenario === 'success') finish();
      if (scenario === 'lost-receipt') { finish(); res.destroy(); return; }
      if (scenario === 'idle') { status = 'idle'; events('session.idle', { sessionID }); }
      if (scenario === 'permission') events('permission.asked', { sessionID, id: 'per_fixture', permission: 'write', patterns: ['secret.txt'] });
      if (scenario === 'tool') (messages[1] as ReturnType<typeof assistant>).parts.push({ id: 'prt_tool', sessionID, messageID: assistantID, type: 'tool', text: 'Tool is forbidden' });
      if (scenario === 'error') messages = [user(), assistant('', true, undefined, { name: 'APIError', data: { message: 'Bearer secret-key private-response' } })];
      if (scenario === 'disconnect') for (const stream of streams) stream.end();
      if (scenario === 'conflict') { events('message.updated', { sessionID }, 'evt_same'); events('session.idle', { sessionID }, 'evt_same'); }
      if (scenario === 'regression') messages = [user(), assistant('Long prefix', false, undefined)];
      res.writeHead(204); res.end(); return;
    }
    json(res, { error: 'Unknown fixture route, no external network' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let connection: OpenCodeConnection | undefined = { baseURL: `http://127.0.0.1:${address.port}/`, authorization: `Basic ${Buffer.from('fixture:password').toString('base64')}`, runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', directory: '/fixture/isolated-runtime', version: '1.19.0', configDigest: 'a'.repeat(64), model };
  const adapter = new OpenCodeAdapter({ getConnection: () => connection, requestTimeoutMs: 400, executionTimeoutMs: 1600, pollIntervalMs: 10 });
  const request: TaskExecutionRequest = { turn: { session: { format: 'task-v2', sessionID: randomUUID() }, turnID: randomUUID() }, clientRequestID: randomUUID(), spec: { work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: 'Fixture', kind: 'discussion', expectedResult: 'An explicit no-tools reply', dependencies: [], inputMessageID: randomUUID(), materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: 'b'.repeat(64) }, driver: { driverID: 'opencode', configDigest: connection.configDigest, mode: 'external' }, tools: { kind: 'none' } }, model, input: 'Only explicit input.', resolved: { workspaceRoot: '/never-mounted/project-root', materials: [] } };
  const lookup = (binding: ExternalExecutionBinding): ExecutionLookup => ({ clientRequestID: request.clientRequestID, workspace: request.spec.workspace, driver: request.spec.driver, binding });
  return { adapter, request, calls, events, finish, lookup, assistant, user, get messages() { return messages; }, set messages(value: unknown[]) { messages = value; }, get connection() { return connection; }, set connection(value: OpenCodeConnection | undefined) { connection = value; }, get aborted() { return aborted; }, set aborted(value: boolean) { aborted = value; }, set status(value: string) { status = value; } };
}
const count = (calls: Array<{ path: string }>, path: string) => calls.filter(call => call.path === path).length;
const wait = async (predicate: () => boolean) => { for (let index = 0; index < 200 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'Fixture condition did not arrive'); };
const controller = () => new AbortController();

test('bind saves a preselected submission before subscription and the single prompt, using only the runtime directory', { timeout: 5000 }, async t => {
  const h = await fixture(t); const emitted: TaskEventEnvelope[] = []; let release!: () => void;
  const saved = new Promise<void>(resolve => { release = resolve; });
  const execution = h.adapter.executeTask(h.request, async event => { emitted.push(event); if (event.event.type === 'bound') await saved; }, controller().signal);
  await wait(() => emitted.length === 1);
  assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), 0); assert.equal(count(h.calls, '/event'), 0);
  const bound = emitted[0].event; assert.equal(bound.type, 'bound'); if (bound.type !== 'bound') throw new Error(); assert.match(bound.binding.externalSubmissionID!, /^msg_[a-zA-Z0-9]+$/);
  release(); await execution;
  assert.deepEqual(emitted.map(event => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(emitted.at(-1)!.event.type, 'settled'); assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), 1);
  assert.deepEqual(h.calls.find(call => call.path === '/session')!.body!.permission, deny);
  const prompt = h.calls.find(call => call.path.endsWith('/prompt_async'))!.body!;
  assert.equal(prompt.messageID, bound.binding.externalSubmissionID); assert.deepEqual(prompt.tools, { '*': false });
  assert.deepEqual(prompt.parts, [{ type: 'text', text: h.request.input }]);
  assert.ok(h.calls.every(call => call.directory === h.connection!.directory && call.authorization === h.connection!.authorization));
  assert.ok(h.calls.findIndex(call => call.path === '/event') < h.calls.findIndex(call => call.path.endsWith('/prompt_async')));
});

test('failed binding persistence and a revoked connection never submit or subscribe', { timeout: 5000 }, async t => {
  for (const revoke of [false, true]) {
    const h = await fixture(t);
    await assert.rejects(h.adapter.executeTask(h.request, async event => { if (event.event.type === 'bound') { if (revoke) h.connection = undefined; else throw new Error('fixture save rejected'); } }, controller().signal));
    assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), 0); assert.equal(count(h.calls, '/event'), 0);
  }
});

test('no-tools capability, attachments, model and driver mismatch fail before any HTTP', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  assert.equal('execute' in h.adapter, false); await assert.rejects(h.adapter.replyPermission());
  assert.equal(h.adapter.capabilities.tools, false); assert.equal(h.adapter.taskCapabilities.permissionReply, false); assert.equal(h.adapter.taskCapabilities.enforcedToolScope, false);
  for (const mutate of [
    (r: TaskExecutionRequest) => { r.spec.tools = { kind: 'restricted', readRoots: [], writeRoots: [], commands: [] }; },
    (r: TaskExecutionRequest) => { r.spec.materials = [{ referenceID: 'fixture', contentDigest: 'c'.repeat(64) }]; },
    (r: TaskExecutionRequest) => { r.resolved.materials = [{ reference: { referenceID: 'fixture', contentDigest: 'c'.repeat(64) }, bytes: new Uint8Array() }]; },
    (r: TaskExecutionRequest) => { r.model = { ...model, model_id: 'other' }; },
    (r: TaskExecutionRequest) => { r.spec.driver.configDigest = 'other'; },
  ]) { const input = structuredClone(h.request); mutate(input); await assert.rejects(h.adapter.executeTask(input, async () => {}, controller().signal)); }
  assert.equal(h.calls.length, 0);
});

test('lost prompt acknowledgement is queried by the persisted native message ID and is never reposted', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'lost-receipt'); let binding!: ExternalExecutionBinding;
  await assert.rejects(h.adapter.executeTask(h.request, async event => { if (event.event.type === 'bound') binding = event.event.binding; }, controller().signal));
  const observation = await h.adapter.inspectExecution(h.lookup(binding)); assert.equal(observation.status, 'finished');
  if (observation.status === 'finished') assert.equal(observation.output, 'Fixture reply');
  await assert.rejects(h.adapter.executeTask(h.request, async () => {}, controller().signal));
  assert.equal(count(h.calls, '/session'), 1); assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), 1);
});

test('idle, forged deltas, duplicate and reordered notifications do not complete or duplicate canonical text', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'idle'); const emitted: TaskEventEnvelope[] = [];
  const execution = h.adapter.executeTask(h.request, async event => { emitted.push(event); }, controller().signal);
  await wait(() => emitted.some(event => event.event.type === 'text-delta'));
  assert.ok(!emitted.some(event => event.event.type === 'settled'));
  const packet = h.events('message.part.delta', { sessionID, messageID: assistantID, partID: 'prt_assistant', field: 'text', delta: 'forged duplicate text' }, 'evt_repeat');
  h.events(packet.type, packet.properties, packet.id);
  h.events('message.part.updated', { sessionID, part: (h.messages[1] as ReturnType<typeof h.assistant>).parts[0], time: 1 });
  h.events('session.idle', { sessionID }); h.finish(); await execution;
  assert.equal(emitted.filter(event => event.event.type === 'text-delta').map(event => event.event.type === 'text-delta' ? event.event.text : '').join(''), 'Fixture reply');
  assert.equal(emitted.filter(event => event.event.type === 'settled').length, 1);
});

test('cancellation requires an original completed MessageAbortedError, not true or idle', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'idle'); let binding!: ExternalExecutionBinding; const stop = controller();
  const execution = h.adapter.executeTask(h.request, async event => { if (event.event.type === 'bound') binding = event.event.binding; }, stop.signal).catch(() => undefined);
  await wait(() => count(h.calls, `/session/${sessionID}/prompt_async`) === 1);
  assert.deepEqual(await h.adapter.cancelExecution(h.lookup(binding)), { status: 'unknown' });
  h.aborted = true;
  assert.deepEqual(await h.adapter.cancelExecution(h.lookup(binding)), { status: 'confirmed' });
  stop.abort(); await execution;
});

test('changed generation and missing submission refuse query/cancel without HTTP or recreation', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'lost-receipt'); let binding!: ExternalExecutionBinding;
  await assert.rejects(h.adapter.executeTask(h.request, async event => { if (event.event.type === 'bound') binding = event.event.binding; }, controller().signal));
  const size = h.calls.length; h.connection = { ...h.connection!, connectionGeneration: 'replacement-generation' };
  assert.equal((await h.adapter.inspectExecution(h.lookup(binding))).status, 'unverifiable');
  assert.deepEqual(await h.adapter.cancelExecution(h.lookup(binding)), { status: 'unknown' });
  assert.equal(h.calls.length, size);
});

test('query needs original parent, a complete finish and unchanged fresh-session history', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'lost-receipt'); let binding!: ExternalExecutionBinding;
  await assert.rejects(h.adapter.executeTask(h.request, async event => { if (event.event.type === 'bound') binding = event.event.binding; }, controller().signal));
  const original = structuredClone(h.messages);
  for (const corrupt of [
    (value: unknown[]) => { (value[1] as ReturnType<typeof h.assistant>).info.parentID = 'msg_other'; },
    (value: unknown[]) => { delete ((value[1] as ReturnType<typeof h.assistant>).info as { finish?: unknown }).finish; },
    (value: unknown[]) => { (value[1] as ReturnType<typeof h.assistant>).info.time.completed = -1; },
    (value: unknown[]) => { value.push(h.user()); },
  ]) {
    const value = structuredClone(original); corrupt(value); h.messages = value;
    assert.equal((await h.adapter.inspectExecution(h.lookup(binding))).status, 'unverifiable');
  }
  h.messages = [h.user(), h.assistant('Still unfinished', false)]; h.status = 'idle';
  assert.equal((await h.adapter.inspectExecution(h.lookup(binding))).status, 'running');
  h.messages = [];
  assert.equal((await h.adapter.inspectExecution(h.lookup(binding))).status, 'unverifiable');
  assert.equal(count(h.calls, '/session'), 1); assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), 1);
});

test('unexpected permission or tool facts never finish, deny permission, and request original-session abort', { timeout: 5000 }, async t => {
  for (const scenario of ['permission', 'tool'] as const) {
    const h = await fixture(t, scenario); const emitted: TaskEventEnvelope[] = [];
    await assert.rejects(h.adapter.executeTask(h.request, async event => { emitted.push(event); }, controller().signal), (error: unknown) => error instanceof ExecutionError && error.code === 'tools-forbidden');
    assert.ok(!emitted.some(event => event.event.type === 'settled' && event.event.outcome === 'finished'));
    assert.equal(count(h.calls, `/session/${sessionID}/abort`), 1);
    if (scenario === 'permission') assert.deepEqual(h.calls.find(call => call.path === '/permission/per_fixture/reply')!.body, { reply: 'reject' });
  }
});

test('explicit original-message failures are redacted and are not accepted as finished', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'error'); const emitted: TaskEventEnvelope[] = [];
  await h.adapter.executeTask(h.request, async event => { emitted.push(event); }, controller().signal);
  const settled = emitted.at(-1)!.event; assert.equal(settled.type, 'settled'); if (settled.type === 'settled') assert.equal(settled.outcome, 'failed');
  assert.ok(!JSON.stringify(emitted).includes('secret-key')); assert.ok(!JSON.stringify(emitted).includes('private-response'));
});

test('unready subscription, disconnection, conflicting event ID and canonical regression leave no finished fact', { timeout: 5000 }, async t => {
  for (const scenario of ['no-ready', 'disconnect', 'conflict', 'regression'] as const) {
    const h = await fixture(t, scenario); const emitted: TaskEventEnvelope[] = [];
    const execution = h.adapter.executeTask(h.request, async event => { emitted.push(event); if (scenario === 'regression' && event.event.type === 'text-delta') h.messages = [h.user(), h.assistant('Changed text', true)]; }, controller().signal);
    await assert.rejects(execution); assert.ok(!emitted.some(event => event.event.type === 'settled' && event.event.outcome === 'finished'));
    assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), scenario === 'no-ready' ? 0 : 1);
  }
});

test('remote endpoints and redirects are refused without leaking authorization or response text', { timeout: 5000 }, async t => {
  const h = await fixture(t, 'redirect');
  await assert.rejects(h.adapter.executeTask(h.request, async () => {}, controller().signal), (error: unknown) => error instanceof ExecutionError && !error.message.includes('password'));
  assert.equal(count(h.calls, `/session/${sessionID}/prompt_async`), 0);
  const size = h.calls.length;
  for (const baseURL of ['https://example.invalid/', 'http://localhost:1234/', 'http://127.0.0.1:1234/path', 'http://user:password@127.0.0.1:1234/', 'http://127.0.0.1:1234/?secret=1']) {
    h.connection = { ...h.connection!, baseURL };
    await assert.rejects(h.adapter.executeTask({ ...h.request, clientRequestID: randomUUID() }, async () => {}, controller().signal));
  }
  assert.equal(h.calls.length, size);
});
