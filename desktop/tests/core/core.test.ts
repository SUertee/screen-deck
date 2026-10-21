import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { ApprovalService, ChatCompletionsAdapter, DecisionEngine, ExecutionError, SessionHistoryStore, SessionManager, StorageError, TaskOrchestrator, type ExecutionDriver, type ExecutionEvent, type ExecutionRequest, type SessionHistoryStoring } from '../../src/core/index.js';
import type { ModelSelection, PlanWorkItem, SessionRecord } from '../../src/shared/types.js';

const model: ModelSelection = { provider_id: 'test-provider', model_id: 'requested-model' };
function session(): SessionRecord {
  const id = randomUUID(); const date = '2026-10-10T08:00:00.000Z';
  return { schema_version: 1, conversation_id: id, title: 'Test', scope: { kind: 'local_chat', local_chat_id: id }, created_at: date, updated_at: date, revision: 0, turns: [], messages: [] };
}
async function temp(): Promise<string> { return mkdtemp(join(await realpath(tmpdir()), 'screendeck-core-test-')); }
class MemoryStore implements SessionHistoryStoring {
  records = new Map<string, SessionRecord>(); saves = 0; failures = new Set<number>();
  async list() { return { records: structuredClone([...this.records.values()]), diagnostics: [] }; }
  async load(id: string) { return structuredClone(this.records.get(id)); }
  async save(record: SessionRecord, expectedRevision?: number) {
    this.saves += 1;
    if (this.failures.has(this.saves)) throw new StorageError('write-failed', 'Test local write failed');
    const existing = this.records.get(record.conversation_id);
    assert.equal(expectedRevision, existing?.revision);
    const saved = structuredClone(record); saved.revision += 1;
    this.records.set(saved.conversation_id, saved); return structuredClone(saved);
  }
}
class FakeDriver implements ExecutionDriver {
  readonly capabilities = { chat: true, tools: false, remoteSessions: false, remoteAbort: false };
  calls: ExecutionRequest[] = [];
  constructor(private readonly body: (emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal) => Promise<void> = async emit => {
    await emit({ type: 'submitted' }); await emit({ type: 'observed-model', model: { ...model, model_id: 'actual-model' } });
    await emit({ type: 'text-delta', text: 'Hello ' }); await emit({ type: 'text-delta', text: 'world' }); await emit({ type: 'completed' });
  }) {}
  async execute(request: ExecutionRequest, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal) { this.calls.push(request); await this.body(emit, signal); }
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const reply = { model: 'actual-model', choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] };

test('session store preserves Swift v1 wire keys, assigns revisions, and keeps UTC creation bucket', async () => {
  const root = join(await temp(), 'sessions'); const store = new SessionHistoryStore(root);
  const saved = await store.save(session()); assert.equal(saved.revision, 1);
  saved.updated_at = '2026-10-11T11:00:00.000Z'; saved.title = 'Continued';
  const updated = await store.save(saved, 1); assert.equal(updated.revision, 2);
  const file = join(root, '2026', '10', '10', `${saved.conversation_id}.json`);
  const json = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(json.conversation_id, saved.conversation_id); assert.equal(json.schema_version, 1); assert.equal(json.sessionID, undefined); assert.equal(json.binding, undefined);
  assert.deepEqual((await store.list()).records, [updated]);
  await assert.rejects(store.save({ ...updated, created_at: '2026-10-11T08:00:00.000Z' }, 2), /创建时间/);
});

test('byte CAS rejects another writer even with unchanged revision', async () => {
  const root = join(await temp(), 'sessions'); const one = new SessionHistoryStore(root); const two = new SessionHistoryStore(root);
  const initial = await one.save(session()); const first = await one.load(initial.conversation_id); const second = await two.load(initial.conversation_id);
  assert.ok(first && second); second.title = 'From another window'; await two.save(second, 1);
  first.title = 'Stale'; await assert.rejects(one.save(first, 1), /修改|冲突/);
  assert.equal((await two.load(initial.conversation_id))?.title, 'From another window');
});

test('store diagnoses duplicate identities and refuses renamed, unknown, or missing records', async () => {
  const root = join(await temp(), 'sessions'); const store = new SessionHistoryStore(root); const saved = await store.save(session());
  const file = join(root, '2026', '10', '10', `${saved.conversation_id}.json`);
  const duplicate = join(root, '2026', '10', '11'); await mkdir(duplicate);
  await writeFile(join(duplicate, `${saved.conversation_id}.json`), await readFile(file));
  const listing = await store.list(); assert.equal(listing.records.length, 0); assert.ok(listing.diagnostics.some(item => item.reason.includes('多个文件')));
  await assert.rejects(store.load(saved.conversation_id), /多个文件/);
  const isolated = join(await temp(), 'sessions'); const secondStore = new SessionHistoryStore(isolated); const other = await secondStore.save(session());
  const original = join(isolated, '2026', '10', '10', `${other.conversation_id}.json`);
  await rename(original, join(isolated, '2026', '10', '10', `${randomUUID()}.json`));
  await assert.rejects(secondStore.load(other.conversation_id), /不一致|移动/);
  await assert.rejects(secondStore.save(other, 1), /不一致|移动/);
});

test('store rejects symlink roots, old-layout directories and extra unversioned fields', async () => {
  const base = await temp(); await mkdir(join(base, 'target')); await symlink(join(base, 'target'), join(base, 'sessions'));
  await assert.rejects(new SessionHistoryStore(join(base, 'sessions')).list(), /符号链接/);
  const legacy = join(await temp(), 'sessions'); await mkdir(join(legacy, 'history'), { recursive: true });
  await assert.rejects(new SessionHistoryStore(legacy).list(), /迁移/);
  const store = new SessionHistoryStore(join(await temp(), 'sessions'));
  await assert.rejects(store.save({ ...session(), api_key: 'must-not-persist' } as SessionRecord), /字段无效/);
});

test('cooperating O_EXCL lock never overwrites or steals an existing lock', async () => {
  const base = await temp(); const root = join(base, 'sessions'); const lock = join(base, '.sessions.write.lock');
  await writeFile(lock, 'other-writer');
  await assert.rejects(new SessionHistoryStore(root).save(session()), /另一写入者/);
  assert.equal(await readFile(lock, 'utf8'), 'other-writer');
});

test('adapter emits JSON text and observed model without tools or credentials in payload', async () => {
  const events: ExecutionEvent[] = []; let calls = 0;
  const adapter = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1///', credential: async () => 'unit-test-secret', fetch: (async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/v1/chat/completions');
    calls += 1; const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'n', 'stream']); assert.equal(JSON.stringify(body).includes('unit-test-secret'), false);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer unit-test-secret'); return response(reply);
  }) as typeof fetch });
  await adapter.execute({ clientRequestID: randomUUID(), model, messages: [{ role: 'user', content: 'Hello' }] }, async event => { events.push(event); }, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(events.map(event => event.type), ['submitted', 'observed-model', 'text-delta', 'completed']);
  assert.equal((events[1] as Extract<ExecutionEvent, { type: 'observed-model' }>).model.model_id, 'actual-model');
});

test('adapter rejects tool_calls, sanitizes provider errors, and never retries', async () => {
  let calls = 0;
  const adapter = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => 'secret-token', fetch: (async () => {
    calls += 1; return response({ ...reply, choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'shell' } }] }, finish_reason: 'tool_calls' }] });
  }) as typeof fetch });
  await assert.rejects(adapter.execute({ clientRequestID: randomUUID(), model, messages: [] }, async () => {}, new AbortController().signal), error => error instanceof ExecutionError && error.code === 'tools-forbidden');
  assert.equal(calls, 1);
  const failing = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => 'secret-token', fetch: (async () => new Response('secret-token account@private.invalid', { status: 401 })) as typeof fetch });
  await assert.rejects(failing.execute({ clientRequestID: randomUUID(), model, messages: [] }, async () => {}, new AbortController().signal), error => error instanceof ExecutionError && error.message.includes('401') && !error.message.includes('secret-token'));
});

test('cancellation while credential is pending prevents HTTP submission', async () => {
  let release!: () => void; const credential = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const controller = new AbortController();
  const adapter = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => { await credential; return undefined; }, fetch: (async () => { calls += 1; return response(reply); }) as typeof fetch });
  const running = adapter.execute({ clientRequestID: randomUUID(), model, messages: [] }, async () => {}, controller.signal);
  controller.abort(); release();
  await assert.rejects(running, error => error instanceof ExecutionError && error.code === 'cancelled' && !error.attempted); assert.equal(calls, 0);
});

async function closeServer(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
test('local HTTP SSE handles split UTF-8, CRLF, model observation and completion', async () => {
  let body = '';
  const server = createServer(async (request, result) => {
    for await (const chunk of request) body += chunk.toString();
    result.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(`: heartbeat\r\n\r\ndata: ${JSON.stringify({ model: 'actual-model', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`);
    for (let index = 0; index < bytes.length; index += 7) result.write(bytes.subarray(index, index + 7)); result.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const events: ExecutionEvent[] = [];
    const adapter = new ChatCompletionsAdapter({ baseURL: `http://127.0.0.1:${address.port}/v1`, credential: async () => undefined });
    await adapter.execute({ clientRequestID: randomUUID(), model, messages: [{ role: 'user', content: '测试' }] }, async event => { events.push(event); }, new AbortController().signal);
    assert.equal((events.find(event => event.type === 'text-delta') as Extract<ExecutionEvent, { type: 'text-delta' }>).text, '你好');
    assert.equal(events.at(-1)?.type, 'completed'); assert.equal(JSON.parse(body).tools, undefined);
  } finally { await closeServer(server); }
});

test('local HTTP stalled response times out once with a sanitized error', async () => {
  let requests = 0;
  const server = createServer((_request, result) => { requests += 1; result.writeHead(200, { 'Content-Type': 'text/event-stream' }); result.write(': keepalive\n\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const adapter = new ChatCompletionsAdapter({ baseURL: `http://127.0.0.1:${address.port}/v1`, credential: async () => undefined, timeoutMs: 30 });
    await assert.rejects(adapter.execute({ clientRequestID: randomUUID(), model, messages: [] }, async () => {}, new AbortController().signal), error => error instanceof ExecutionError && error.code === 'timeout');
    assert.equal(requests, 1);
  } finally { await closeServer(server); }
});

test('manager persists before a single send, distinguishes models and throttles intermediate writes', async () => {
  const store = new MemoryStore(); const driver = new FakeDriver(async emit => {
    const record = [...store.records.values()][0]!; assert.equal(record.turns[0]?.state, 'submitting');
    await emit({ type: 'submitted' }); await emit({ type: 'observed-model', model: { ...model, model_id: 'actual-model' } });
    for (let index = 0; index < 30; index += 1) await emit({ type: 'text-delta', text: 'x' }); await emit({ type: 'completed' });
  });
  const manager = new SessionManager({ store, driver, persistIntervalMs: 100_000 }); const events: string[] = [];
  manager.subscribe(event => { events.push(event.type); }); const record = await manager.createSession('Chat');
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.status, 'accepted'); assert.equal(driver.calls.length, 1); assert.equal(result.session.turns[0]?.state, 'finished');
  assert.equal(result.session.turns[0]?.requested_model.model_id, 'requested-model'); assert.equal(result.session.turns[0]?.observed_model?.model_id, 'actual-model');
  assert.equal(result.session.messages[1]?.text, 'x'.repeat(30)); assert.equal(result.session.binding, undefined); assert.ok(store.saves <= 5); assert.ok(events.length >= 30);
});

test('prepared persistence failure prevents sending and retries only the local write', async () => {
  const store = new MemoryStore(); const driver = new FakeDriver(); const manager = new SessionManager({ store, driver });
  const record = await manager.createSession('Chat'); store.failures.add(2);
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.status, 'notSubmitted'); assert.equal(driver.calls.length, 0); assert.equal(result.session.turns[0]?.state, 'failed');
  await assert.rejects(manager.sendMessage({ sessionID: record.conversation_id, text: 'Again', model }), /未保存/);
  await manager.retryPendingWrites(record.conversation_id); assert.equal(driver.calls.length, 0); assert.equal((await store.load(record.conversation_id))?.turns[0]?.state, 'failed');
});

test('terminal save failure preserves completion and blocks sends until local write succeeds', async () => {
  const store = new MemoryStore(); const driver = new FakeDriver(async emit => { await emit({ type: 'submitted' }); await emit({ type: 'text-delta', text: 'Answer' }); await emit({ type: 'completed' }); });
  const manager = new SessionManager({ store, driver }); const record = await manager.createSession('Chat'); store.failures.add(5);
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.status, 'uncertain'); assert.equal(result.session.turns[0]?.state, 'finished'); assert.equal(result.session.messages[1]?.text, 'Answer');
  await manager.retryPendingWrites(record.conversation_id); assert.equal((await store.load(record.conversation_id))?.turns[0]?.state, 'finished'); assert.equal(driver.calls.length, 1);
});

test('a post-completion driver failure cannot revert a finished turn', async () => {
  const store = new MemoryStore(); const driver = new FakeDriver(async emit => { await emit({ type: 'submitted' }); await emit({ type: 'completed' }); throw new Error('private-key-that-must-not-persist'); });
  const manager = new SessionManager({ store, driver }); const record = await manager.createSession('Chat');
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.session.turns[0]?.state, 'finished'); assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('one active turn per session and stop only claims local cancellation', async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const store = new MemoryStore(); const driver = new FakeDriver(async (emit, signal) => { await emit({ type: 'submitted' }); started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw new ExecutionError('cancelled', 'local cancelled', true); });
  const manager = new SessionManager({ store, driver }); const record = await manager.createSession('Chat');
  const running = manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model }); await ready;
  await assert.rejects(manager.sendMessage({ sessionID: record.conversation_id, text: 'Again', model }), /活动轮次/);
  await manager.stopGeneration(record.conversation_id); const result = await running;
  assert.equal(result.session.turns[0]?.state, 'cancelled'); assert.match(result.session.turns[0]?.failure ?? '', /远端是否停止未知/);
});

test('restart marks prepared failed, submitted unknown, and never replays a request', async () => {
  const store = new MemoryStore(); const record = session(); const now = record.created_at;
  for (const state of ['prepared', 'streaming'] as const) record.turns.push({ turn_id: randomUUID(), client_request_id: randomUUID(), requested_model: model, state, created_at: now, updated_at: now, draft_revision: 0 });
  await store.save(record); const driver = new FakeDriver(); const manager = new SessionManager({ store, driver });
  const recovered = await manager.loadSession(record.conversation_id);
  assert.deepEqual(recovered?.turns.map(turn => turn.state), ['failed', 'unknown']); assert.equal(driver.calls.length, 0);
  await assert.rejects(manager.sendMessage({ sessionID: record.conversation_id, text: 'Again', model }), /未知/);
  await manager.shutdown(); await assert.rejects(manager.createSession('After shutdown'), /关闭/);
});

function workItem(kind: PlanWorkItem['kind'] = 'discussion'): PlanWorkItem {
  return { id: randomUUID(), title: 'Review the idea', kind, assignee: 'unassigned', expected_result: 'A short decision note', dependencies: [], status: 'planned' };
}
test('plans save editable human/model assignment, conflict on version, reject cycles, and only recommend', async () => {
  const root = await temp(); const tasks = new TaskOrchestrator(root); const item = workItem();
  const created = await tasks.createPlan('New goal', [item]); const changed = structuredClone(created);
  changed.work_items[0]!.assignee = 'chat'; changed.work_items[0]!.model = model;
  const saved = await tasks.savePlan(changed, 1); assert.equal(saved.version, 2); assert.equal((await tasks.loadPlan(saved.id))?.work_items[0]?.model?.model_id, model.model_id);
  await assert.rejects(tasks.savePlan(changed, 1), /冲突/);
  const recommendations = await tasks.recommendations(saved); assert.equal(recommendations[0]?.recommendation.candidate, 'chat'); assert.equal(recommendations[0]?.recommendation.advisory, true);
  assert.ok(recommendations[0]?.recommendation.reasons.some(reason => reason.includes('预算未确认')));
  const cycle = workItem(); cycle.dependencies = [cycle.id]; await assert.rejects(tasks.createPlan('Cyclic', [cycle]), /循环/);
  const dirs = await readdir(root); assert.ok(dirs.includes('preview-plans')); assert.equal(dirs.includes('tasks'), false); assert.equal(dirs.includes('runs'), false);
});

test('rule decision falls back to human for tool work, high risk and missing budget', async () => {
  const engine = new DecisionEngine();
  for (const context of [
    { planVersion: 1, workItem: workItem('implementation'), risk: 'low' as const, budgetAvailable: true, capabilities: ['stateless-chat'] },
    { planVersion: 1, workItem: workItem(), risk: 'high' as const, budgetAvailable: true, capabilities: ['stateless-chat'] },
    { planVersion: 1, workItem: workItem(), risk: 'low' as const, budgetAvailable: false, capabilities: ['stateless-chat'] },
  ]) assert.equal((await engine.recommend(context)).candidate, 'human');
});

test('approval persists an explicit human decision and invalidates changed scope/version or expiry', async () => {
  const service = new ApprovalService(await temp());
  const context = { action: 'discuss', parameters: { prompt: 'Review idea' }, workspace: '/temporary/example', planID: randomUUID(), planVersion: 1 };
  const approved = await service.recordDecision({ context, decision: 'approved', decidedBy: 'human', expiresAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(await service.isApproved(approved.id, context), true);
  assert.equal(await service.isApproved(approved.id, { ...context, planVersion: 2 }), false);
  assert.equal(await service.isApproved(approved.id, { ...context, parameters: { prompt: 'Another prompt' } }), false);
  assert.equal(await service.isApproved(approved.id, context, new Date('2100-01-01')), false);
  const rejected = await service.recordDecision({ context, decision: 'rejected', decidedBy: 'human' }); assert.equal(await service.isApproved(rejected.id, context), false);
  await assert.rejects(service.recordDecision({ context: { ...context, parameters: { api_key: 'secret' } }, decision: 'approved', decidedBy: 'human' }), /凭据/);
});

test('adapter rejects SSE tool events and incomplete streams after preserving partial text', async () => {
  for (const [payload, code] of [
    [{ model: 'actual-model', choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }] }, 'tools-forbidden'],
    [{ model: 'actual-model', choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }] }, 'incomplete'],
  ] as const) {
    const events: ExecutionEvent[] = [];
    const adapter = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => undefined, fetch: (async () => new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch });
    await assert.rejects(adapter.execute({ clientRequestID: randomUUID(), model, messages: [] }, async event => { events.push(event); }, new AbortController().signal), error => error instanceof ExecutionError && error.code === code);
    assert.equal(events.some(event => event.type === 'completed'), false);
  }
});

test('incomplete response stays unknown and cannot silently replay on another send', async () => {
  const store = new MemoryStore(); const driver = new FakeDriver(async emit => { await emit({ type: 'submitted' }); await emit({ type: 'text-delta', text: 'Partial' }); throw new ExecutionError('incomplete', 'Reply outcome unknown', true); });
  const manager = new SessionManager({ store, driver }); const record = await manager.createSession('Chat');
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.session.turns[0]?.state, 'unknown'); assert.equal(result.session.messages[1]?.text, 'Partial');
  await assert.rejects(manager.sendMessage({ sessionID: record.conversation_id, text: 'Retry', model }), /未知/); assert.equal(driver.calls.length, 1);
});

test('shutdown during a prepared write prevents later submission', async () => {
  const store = new MemoryStore(); const save = store.save.bind(store); let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  store.save = async (record, expectedRevision) => { if (record.turns[0]?.state === 'prepared') { started(); await gate; } return save(record, expectedRevision); };
  const driver = new FakeDriver(); const manager = new SessionManager({ store, driver }); const record = await manager.createSession('Chat');
  const sending = manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model }); await ready;
  const stopping = manager.shutdown(); release(); await stopping;
  const result = await sending; assert.equal(driver.calls.length, 0); assert.equal(result.status, 'notSubmitted'); assert.equal(result.session.turns[0]?.state, 'cancelled');
});

test('retry adopts an exact terminal record when a write succeeded before reporting uncertainty', async () => {
  const store = new MemoryStore(); const save = store.save.bind(store); let uncertain = true;
  store.save = async (record, expectedRevision) => {
    const saved = await save(record, expectedRevision);
    if (record.turns[0]?.state === 'finished' && uncertain) { uncertain = false; throw new StorageError('write-uncertain', 'Written, directory sync uncertain'); }
    return saved;
  };
  // Use a real CAS-like error when retry encounters the already persisted next revision.
  const guarded = store.save.bind(store);
  store.save = async (record, expectedRevision) => {
    if (store.records.get(record.conversation_id)?.revision !== expectedRevision) throw new StorageError('revision-changed', 'Already changed');
    return guarded(record, expectedRevision);
  };
  // Initial creation has no existing revision and therefore passes the guard.
  const manager = new SessionManager({ store, driver: new FakeDriver() }); const record = await manager.createSession('Chat');
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.status, 'uncertain'); assert.equal(result.session.turns[0]?.state, 'finished');
  await manager.retryPendingWrites(record.conversation_id);
  assert.equal((await manager.loadSession(record.conversation_id))?.revision, store.records.get(record.conversation_id)?.revision);
});

test('full stateless chat roundtrip persists actual text and leaves no secret or external session binding', async () => {
  const root = join(await temp(), 'sessions'); const store = new SessionHistoryStore(root);
  const driver = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => 'secret-unit-fixture', fetch: (async () => response(reply)) as typeof fetch });
  const manager = new SessionManager({ store, driver }); const created = await manager.createSession('Real local history');
  await manager.sendMessage({ sessionID: created.conversation_id, text: 'Hello', model }); await manager.shutdown();
  const loaded = await new SessionHistoryStore(root).load(created.conversation_id); assert.equal(loaded?.messages[1]?.text, 'Hello'); assert.equal(loaded?.turns[0]?.state, 'finished'); assert.equal(loaded?.binding, undefined);
  const file = join(root, ...created.created_at.slice(0, 10).split('-'), `${created.conversation_id}.json`);
  const raw = await readFile(file, 'utf8'); assert.equal(raw.includes('secret-unit-fixture'), false); assert.equal(raw.includes('Authorization'), false);
});

test('HTTP rejection is never reported as an accepted chat turn', async () => {
  const store = new MemoryStore();
  const driver = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => undefined, fetch: (async () => new Response('private error', { status: 401 })) as typeof fetch });
  const manager = new SessionManager({ store, driver }); const record = await manager.createSession('Chat');
  const result = await manager.sendMessage({ sessionID: record.conversation_id, text: 'Hello', model });
  assert.equal(result.status, 'uncertain'); assert.equal(result.session.turns[0]?.state, 'failed'); assert.equal(result.session.turns[0]?.failure?.includes('private error'), false);
});

test('listing during a turn cannot refresh its byte-CAS baseline and erase another writer', async () => {
  const root = join(await temp(), 'sessions'); const store = new SessionHistoryStore(root);
  let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const driver = new FakeDriver(async emit => { await emit({ type: 'submitted' }); started(); await gate; await emit({ type: 'text-delta', text: 'Answer' }); await emit({ type: 'completed' }); });
  const manager = new SessionManager({ store, driver }); const created = await manager.createSession('Original');
  const running = manager.sendMessage({ sessionID: created.conversation_id, text: 'Hello', model }); await ready;
  const file = join(root, ...created.created_at.slice(0, 10).split('-'), `${created.conversation_id}.json`);
  const external = JSON.parse(await readFile(file, 'utf8')); external.title = 'External change, same revision'; await writeFile(file, JSON.stringify(external));
  await manager.listSessions(); release(); const result = await running;
  assert.equal(result.status, 'uncertain'); assert.equal(JSON.parse(await readFile(file, 'utf8')).title, external.title);
});

test('repeated pending-write reconciliation never adopts unrelated external bytes', async () => {
  const root = join(await temp(), 'sessions'); const store = new SessionHistoryStore(root);
  let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const driver = new FakeDriver(async emit => { await emit({ type: 'submitted' }); started(); await gate; await emit({ type: 'text-delta', text: 'Answer' }); });
  const manager = new SessionManager({ store, driver }); const created = await manager.createSession('Original');
  const running = manager.sendMessage({ sessionID: created.conversation_id, text: 'Hello', model }); await ready;
  const file = join(root, ...created.created_at.slice(0, 10).split('-'), `${created.conversation_id}.json`);
  const external = JSON.parse(await readFile(file, 'utf8')); external.title = 'External pending conflict'; await writeFile(file, JSON.stringify(external));
  release(); await running;
  await assert.rejects(manager.retryPendingWrites(created.conversation_id), /修改|冲突/);
  await assert.rejects(manager.retryPendingWrites(created.conversation_id), /修改|冲突/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).title, external.title); assert.equal(driver.calls.length, 1);
});

test('a delayed listing cannot pair a new observation with old send data or roll back newer cache', async () => {
  const root = join(await temp(), 'sessions'); const store = new SessionHistoryStore(root);
  let observed!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { observed = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const list = store.list.bind(store);
  store.list = async options => { const result = await list(options); observed(); await gate; return result; };
  const manager = new SessionManager({ store, driver: new FakeDriver() }); const created = await manager.createSession('Original');
  const file = join(root, ...created.created_at.slice(0, 10).split('-'), `${created.conversation_id}.json`);
  const external = JSON.parse(await readFile(file, 'utf8')); external.title = 'Changed before send'; await writeFile(file, JSON.stringify(external));
  const listing = manager.listSessions(); await ready;
  const result = await manager.sendMessage({ sessionID: created.conversation_id, text: 'Hello', model }); release();
  const listed = await listing;
  assert.equal(result.session.title, external.title); assert.equal(JSON.parse(await readFile(file, 'utf8')).title, external.title);
  assert.equal(listed.records[0]?.turns[0]?.state, 'finished'); assert.equal(listed.records[0]?.revision, result.session.revision);
});

test('SSE DONE without a legal finish reason never completes a turn', async () => {
  for (const body of ['data: [DONE]\n\n', `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`]) {
    const events: ExecutionEvent[] = [];
    const adapter = new ChatCompletionsAdapter({ baseURL: 'https://example.invalid/v1', credential: async () => undefined, fetch: (async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch });
    await assert.rejects(adapter.execute({ clientRequestID: randomUUID(), model, messages: [] }, async event => { events.push(event); }, new AbortController().signal), error => error instanceof ExecutionError && error.code === 'incomplete');
    assert.equal(events.some(event => event.type === 'completed'), false);
  }
});

test('a FIFO disguised as session JSON is diagnosed without blocking the scanner', { skip: process.platform === 'win32' }, async () => {
  const root = join(await temp(), 'sessions'); const bucket = join(root, '2026', '10', '10'); await mkdir(bucket, { recursive: true });
  const id = randomUUID(); const file = join(bucket, `${id}.json`);
  const made = spawnSync('mkfifo', [file]); assert.equal(made.status, 0);
  const listing = await new SessionHistoryStore(root).list(); assert.equal(listing.records.length, 0); assert.match(listing.diagnostics[0]?.reason ?? '', /普通文件/);
});
