import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentChatReadySource, AgentSessionRecord } from '../../src/shared/agent-chat.js';
import type { SessionRecord } from '../../src/shared/types.js';
import type { TaskSessionRecord } from '../../src/shared/task-execution.js';
import type { AgentChatDriver, AgentChatExecutionEvent, AgentChatLookup, AgentChatRequest } from '../../src/core/agent-chat-driver.js';
import { AgentSessionHistoryStore, type AgentSessionHistoryStoring } from '../../src/core/agent-session-history-store.js';
import { AgentSessionLifecycle } from '../../src/core/agent-session-lifecycle.js';
import { validateAgentSession } from '../../src/core/agent-session-schema.js';
import { ExecutionError } from '../../src/core/execution-driver.js';
import { StorageError } from '../../src/core/private-storage.js';
import { SessionHistoryStore } from '../../src/core/session-history-store.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { TaskSessionHistoryStore } from '../../src/core/task-session-history-store.js';
import { FakeTaskExecutionDriver } from '../../src/core/fake-task-execution-driver.js';

const date = '2026-10-14T00:00:00.000Z';
const source = (): AgentChatReadySource => ({ agentID: 'opencode', name: 'OpenCode', state: 'ready', configDigest: 'a'.repeat(64), runtimeID: randomUUID(), connectionGeneration: randomUUID(), model: { provider_id: 'fixture', model_id: 'fixture-model' } });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
class MemoryStore implements AgentSessionHistoryStoring {
  readonly records = new Map<string, AgentSessionRecord>();
  readonly failures = new Set<number>();
  readonly uncertain = new Set<number>();
  saves = 0;
  beforeSave?: (record: AgentSessionRecord, number: number) => Promise<void>;
  async load(id: string) { return structuredClone(this.records.get(id)); }
  async list() { return { records: structuredClone([...this.records.values()]), diagnostics: [] }; }
  async save(record: AgentSessionRecord, revision?: number) {
    validateAgentSession(record);
    const number = ++this.saves;
    await this.beforeSave?.(structuredClone(record), number);
    if (this.failures.has(number)) throw new StorageError('write-failed', 'fixture save failed');
    const previous = this.records.get(record.conversation_id);
    if (revision !== previous?.revision) throw new StorageError('revision-changed', 'fixture CAS conflict');
    const saved = structuredClone(record);
    saved.revision += 1;
    this.records.set(saved.conversation_id, saved);
    if (this.uncertain.has(number)) throw new StorageError('write-uncertain', 'fixture replacement uncertain');
    return structuredClone(saved);
  }
}
type Body = (request: AgentChatRequest, emit: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal) => Promise<void>;
class AgentFixture implements AgentChatDriver {
  source: AgentChatReadySource | undefined = source();
  readonly requests: AgentChatRequest[] = [];
  readonly cancellations: AgentChatLookup[] = [];
  prompts = 0;
  sessions = 0;
  cancelStatus: 'confirmed' | 'unknown' = 'unknown';
  onCancel?: () => void;
  constructor(readonly body: Body = async (request, emit) => {
    await emit({ type: 'text-delta', text: `reply:${request.input}` });
    await emit({ type: 'settled', outcome: 'finished' });
  }) {}
  getSource() { return structuredClone(this.source); }
  async sendTurn(request: AgentChatRequest, emit: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal) {
    this.requests.push(structuredClone(request));
    if (!request.binding) {
      this.sessions += 1;
      await emit({ type: 'bound', binding: { runtimeID: this.source!.runtimeID, connectionGeneration: this.source!.connectionGeneration, externalSessionID: `fixture-session-${this.sessions}` } });
    }
    if (signal.aborted) throw new ExecutionError('cancelled', 'fixture stopped before prompt', false);
    this.prompts += 1;
    await emit({ type: 'submitted' });
    await this.body(request, emit, signal);
  }
  async cancelTurn(lookup: AgentChatLookup) {
    this.cancellations.push(structuredClone(lookup));
    this.onCancel?.();
    return { status: this.cancelStatus };
  }
}
function fixture(store = new MemoryStore(), driver = new AgentFixture()) {
  return { store, driver, lifecycle: new AgentSessionLifecycle(store, driver, () => new Date(date), 0) };
}
const create = (lifecycle: AgentSessionLifecycle) => lifecycle.create({ title: 'Agent fixture', agentID: 'opencode' });
const temp = async () => mkdtemp(join(await realpath(tmpdir()), 'screendeck-agent-chat-test-'));
function emptyRecord(): AgentSessionRecord {
  const id = randomUUID();
  return { kind: 'electron_agent_chat', schema_version: 1, conversation_id: id, source: { agentID: 'opencode', configDigest: 'a'.repeat(64) }, title: 'fixture', scope: { kind: 'local_chat', local_chat_id: id }, created_at: date, updated_at: date, revision: 0, turns: [], messages: [] };
}
function chatRecord(record: AgentSessionRecord): SessionRecord {
  const { kind: _kind, source: _source, binding: _binding, ...chat } = record;
  return chat;
}

test('Agent creation is local; two turns reuse one native binding and only current input', async () => {
  const { lifecycle, driver } = fixture();
  const session = await create(lifecycle);
  assert.equal(driver.sessions, 0);
  assert.equal(driver.prompts, 0);
  const first = await lifecycle.send({ sessionID: session.conversation_id, text: 'first' });
  const second = await lifecycle.send({ sessionID: session.conversation_id, text: 'second' });
  assert.equal(first.status, 'accepted');
  assert.equal(second.session.turns.length, 2);
  assert.equal(driver.sessions, 1);
  assert.equal(driver.prompts, 2);
  assert.deepEqual(driver.requests.map(value => value.input), ['first', 'second']);
  assert.deepEqual(driver.requests[1].binding, first.session.binding);
  assert.equal(Object.hasOwn(driver.requests[1], 'messages'), false);
  assert.deepEqual(second.session.messages.map(value => value.text), ['first', 'reply:first', 'second', 'reply:second']);
});

test('Unready or changed source refuses creation/send without a prompt or replacement binding', async () => {
  const { lifecycle, driver } = fixture();
  const session = await create(lifecycle);
  driver.source = undefined;
  await assert.rejects(create(lifecycle), /尚未就绪/);
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'no' }), /尚未就绪/);
  driver.source = { ...source(), configDigest: 'b'.repeat(64) };
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'no' }), /配置已失效/);
  assert.equal(driver.prompts, 0);
  assert.equal((await lifecycle.load(session.conversation_id))?.turns.length, 0);
});

test('Concurrent duplicate sends reserve before awaiting and issue exactly one prompt', async () => {
  const entered = deferred(); const release = deferred();
  const driver = new AgentFixture(async (_request, emit) => { entered.resolve(); await release.promise; await emit({ type: 'settled', outcome: 'finished' }); });
  const { lifecycle } = fixture(undefined, driver);
  const session = await create(lifecycle);
  const first = lifecycle.send({ sessionID: session.conversation_id, text: 'once' });
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'once' }), /活动轮次/);
  await entered.promise;
  assert.equal(driver.prompts, 1);
  release.resolve();
  assert.equal((await first).session.turns.length, 1);
});

for (const number of [2, 3, 4]) {
  test(`Write failure ${number} before prompt never sends; retry only saves local facts`, async () => {
    const { lifecycle, store, driver } = fixture();
    const session = await create(lifecycle);
    store.failures.add(number);
    const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'only input' });
    assert.equal(result.status, 'notSubmitted');
    assert.equal(result.session.turns[0]?.state, 'failed');
    assert.equal(driver.prompts, 0);
    await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'blocked' }), /补存/);
    store.failures.clear();
    await lifecycle.retry(session.conversation_id);
    assert.equal(driver.prompts, 0);
    assert.equal((await store.load(session.conversation_id))?.turns[0]?.state, 'failed');
  });
}

test('Source change while submitting CAS is awaited prevents the first driver call', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  store.beforeSave = async (_record, number) => { if (number === 3) driver.source!.configDigest = 'b'.repeat(64); };
  const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'no submit' });
  assert.equal(result.status, 'notSubmitted');
  assert.equal(driver.requests.length, 0);
  assert.equal(result.session.turns[0]?.state, 'failed');
});

test('Stop during prepared save prevents any driver call', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  const entered = deferred(); const release = deferred();
  store.beforeSave = async (_record, number) => { if (number === 2) { entered.resolve(); await release.promise; } };
  const sending = lifecycle.send({ sessionID: session.conversation_id, text: 'no submit' });
  await entered.promise;
  const stopping = lifecycle.stop(session.conversation_id);
  release.resolve();
  const result = await sending;
  await stopping;
  assert.equal(result.status, 'notSubmitted');
  assert.equal(result.session.turns[0]?.state, 'cancelled');
  assert.equal(driver.requests.length, 0);
  assert.equal(driver.cancellations.length, 0);
});

for (const confirmed of [true, false]) {
  test(`Original prompt cancellation ${confirmed ? 'confirmed' : 'unconfirmed'} records ${confirmed ? 'cancelled' : 'unknown'}`, async () => {
    const entered = deferred(); const cancelled = deferred();
    const driver = new AgentFixture(async (_request, emit, signal) => {
      entered.resolve();
      if (confirmed) { await cancelled.promise; await emit({ type: 'settled', outcome: 'cancelled' }); }
      else await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ExecutionError('cancelled', 'fixture local abort', true)), { once: true }));
    });
    driver.cancelStatus = confirmed ? 'confirmed' : 'unknown';
    driver.onCancel = cancelled.resolve;
    const { lifecycle } = fixture(undefined, driver);
    const session = await create(lifecycle);
    const sending = lifecycle.send({ sessionID: session.conversation_id, text: 'slow' });
    await entered.promise;
    await lifecycle.stop(session.conversation_id);
    const result = await sending;
    assert.equal(result.session.turns[0]?.state, confirmed ? 'cancelled' : 'unknown');
    assert.equal(result.status, confirmed ? 'accepted' : 'uncertain');
    assert.equal(driver.cancellations[0]?.binding?.externalSessionID, result.session.binding?.externalSessionID);
    assert.equal(driver.prompts, 1);
    if (!confirmed) await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'again' }), /结果未知/);
  });
}

test('Attempted disconnect and forbidden events remain unknown without automatic replay', async () => {
  for (const body of [async () => { throw new ExecutionError('network', 'fixture disconnected', true); }, async (_request: AgentChatRequest, emit: (event: AgentChatExecutionEvent) => Promise<void>) => { await emit({ type: 'tool' } as unknown as AgentChatExecutionEvent); }]) {
    const { lifecycle, driver } = fixture(undefined, new AgentFixture(body));
    const session = await create(lifecycle);
    const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'once' });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.session.turns[0]?.state, 'unknown');
    await lifecycle.retry(session.conversation_id);
    await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'replay' }), /结果未知/);
    assert.equal(driver.prompts, 1);
  }
});

test('Terminal save failure preserves finished proof and retry never calls the driver', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  store.failures.add(6);
  const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'done' });
  assert.equal(result.status, 'accepted');
  assert.equal(result.session.turns[0]?.state, 'finished');
  assert.equal((await store.load(session.conversation_id))?.turns[0]?.state, 'streaming');
  store.failures.clear();
  await lifecycle.retry(session.conversation_id);
  assert.equal((await store.load(session.conversation_id))?.turns[0]?.state, 'finished');
  assert.equal(driver.prompts, 1);
});

test('Uncertain atomic replacement adopts only the exact next local revision', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  store.uncertain.add(6);
  await lifecycle.send({ sessionID: session.conversation_id, text: 'done' });
  const before = (await store.load(session.conversation_id))!.revision;
  await lifecycle.retry(session.conversation_id);
  assert.equal((await lifecycle.load(session.conversation_id))?.revision, before);
  assert.equal(driver.prompts, 1);
});

test('Restart turns active submission unknown; finished history stays readable but old generation cannot rebind', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  const finished = await lifecycle.send({ sessionID: session.conversation_id, text: 'done' });
  const interrupted = structuredClone(finished.session);
  interrupted.turns[0]!.state = 'submitting';
  store.records.set(session.conversation_id, interrupted);
  const restarted = new AgentSessionLifecycle(store, driver, () => new Date(date));
  assert.equal((await restarted.load(session.conversation_id))?.turns[0]?.state, 'unknown');
  await assert.rejects(restarted.send({ sessionID: session.conversation_id, text: 'no replay' }), /结果未知/);
  assert.equal(driver.prompts, 1);
  const another = fixture();
  const otherSession = await create(another.lifecycle);
  const otherFinished = await another.lifecycle.send({ sessionID: otherSession.conversation_id, text: 'done' });
  another.driver.source!.connectionGeneration = randomUUID();
  const nextApp = new AgentSessionLifecycle(another.store, another.driver);
  assert.deepEqual((await nextApp.load(otherSession.conversation_id))?.binding, otherFinished.session.binding);
  await assert.rejects(nextApp.send({ sessionID: otherSession.conversation_id, text: 'do not bind' }), /不会重新绑定/);
  assert.equal(another.driver.sessions, 1);
});

test('Restart closes an unsubmitted prepared turn locally without claiming cancellation proof', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  store.failures.add(2);
  const prepared = await lifecycle.send({ sessionID: session.conversation_id, text: 'prepared' });
  const interrupted = structuredClone(prepared.session);
  interrupted.turns[0]!.state = 'prepared';
  interrupted.revision = 2;
  store.records.set(session.conversation_id, interrupted);
  const nextApp = new AgentSessionLifecycle(store, driver);
  assert.equal((await nextApp.load(session.conversation_id))?.turns[0]?.state, 'failed');
  assert.equal(driver.prompts, 0);
});

test('Shutdown requires remote cancellation proof and otherwise preserves unknown', async () => {
  const entered = deferred();
  const driver = new AgentFixture(async (_request, _emit, signal) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ExecutionError('cancelled', 'fixture local stop', true)), { once: true }));
  });
  const { lifecycle } = fixture(undefined, driver);
  const session = await create(lifecycle);
  const sending = lifecycle.send({ sessionID: session.conversation_id, text: 'slow' });
  await entered.promise;
  await lifecycle.shutdown();
  assert.equal((await sending).session.turns[0]?.state, 'unknown');
  await assert.rejects(create(lifecycle), /已关闭/);
});

test('Agent storage is a separate strict flat format and cannot mutate source, binding, or input', async () => {
  const root = await temp();
  const store = new AgentSessionHistoryStore(root);
  const driver = new AgentFixture();
  const lifecycle = new AgentSessionLifecycle(store, driver, () => new Date(date), 0);
  const session = await create(lifecycle);
  const finished = (await lifecycle.send({ sessionID: session.conversation_id, text: 'frozen' })).session;
  const file = join(root, 'agent-sessions-v1', `${session.conversation_id}.json`);
  const bytes = await readFile(file);
  assert.deepEqual(await readdir(root), ['agent-sessions-v1']);
  assert.equal(JSON.parse(bytes.toString()).kind, 'electron_agent_chat');
  for (const mutate of [(value: AgentSessionRecord) => { value.source.configDigest = 'b'.repeat(64); }, (value: AgentSessionRecord) => { value.binding!.externalSessionID = 'replacement'; }, (value: AgentSessionRecord) => { value.messages[0]!.text = 'changed'; }, (value: AgentSessionRecord) => { value.turns[0]!.state = 'unknown'; }]) {
    const changed = structuredClone(finished);
    mutate(changed);
    await assert.rejects(store.save(changed, changed.revision), /不可/);
    assert.deepEqual(await readFile(file), bytes);
  }
  await assert.rejects(store.save({ ...emptyRecord(), apiKey: 'synthetic-do-not-store' } as AgentSessionRecord), /字段无效/);
  await assert.rejects(store.save(chatRecord(emptyRecord()) as AgentSessionRecord), /字段无效/);
});

test('Agent storage detects same revision byte edits, exclusive locks, unknown entries and symlinks', async () => {
  const root = await temp();
  const store = new AgentSessionHistoryStore(root);
  const record = await store.save(emptyRecord());
  const file = join(store.root, `${record.conversation_id}.json`);
  await writeFile(file, JSON.stringify({ ...record, title: 'external writer' }));
  await assert.rejects(store.save({ ...record, title: 'stale' }, record.revision), /修改|冲突/);
  await writeFile(join(root, '.agent-sessions-v1.write.lock'), 'fixture-other-owner');
  await assert.rejects(store.save(emptyRecord()), /另一写入者/);
  assert.equal(await readFile(join(root, '.agent-sessions-v1.write.lock'), 'utf8'), 'fixture-other-owner');
  const unknown = await temp();
  await mkdir(join(unknown, 'agent-sessions-v1'));
  await writeFile(join(unknown, 'agent-sessions-v1', 'unknown.txt'), 'fixture');
  await assert.rejects(new AgentSessionHistoryStore(unknown).list(), /未知条目/);
  const linked = await temp();
  await mkdir(join(linked, 'target'));
  await symlink(join(linked, 'target'), join(linked, 'agent-sessions-v1'));
  await assert.rejects(new AgentSessionHistoryStore(linked).list(), /符号链接/);
});

test('Cross-format chat/task conflicts refuse Agent reads and preserve all original bytes', async () => {
  for (const format of ['chat', 'task']) {
    const root = await temp();
    const record = emptyRecord();
    const store = new AgentSessionHistoryStore(root);
    const agent = await store.save(record);
    const agentFile = join(store.root, `${record.conversation_id}.json`);
    const agentBytes = await readFile(agentFile);
    if (format === 'chat') {
      const chat = new SessionHistoryStore(join(root, 'sessions'));
      await chat.save(chatRecord(record));
    } else {
      const { source: _source, binding: _binding, ...base } = record;
      const task: TaskSessionRecord = { ...base, kind: 'electron_task_session', schema_version: 2, scope: { kind: 'project', project_id: `project-${randomUUID()}`, task_id: 'task-001' }, turns: [], messages: [] };
      await new TaskSessionHistoryStore(root).save(task);
    }
    await assert.rejects(store.load(agent.conversation_id), /不同格式/);
    assert.equal((await store.list()).records.length, 0);
    await assert.rejects(store.save({ ...agent, title: 'must not write' }, agent.revision), /不同格式/);
    assert.deepEqual(await readFile(agentFile), agentBytes);
    const manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'sessions')), driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, async execute() { throw new Error('must not send'); } }, agent: { store, driver: new AgentFixture() }, task: { store: new TaskSessionHistoryStore(root), driver: new FakeTaskExecutionDriver() } });
    if (format === 'chat') await assert.rejects(manager.loadSession(record.conversation_id), /不同格式/);
    else {
      const listing = await manager.listTaskSessions();
      assert.equal(listing.records.length, 0);
      assert.ok(listing.diagnostics.length);
      await assert.rejects(manager.loadTaskSession({ format: 'task-v2', sessionID: record.conversation_id }), /不同格式/);
    }
    await manager.shutdown();
  }
});

test('Facade routes Agent events and keeps old ordinary chat JSON unchanged', async () => {
  const root = await temp();
  const chatStore = new SessionHistoryStore(join(root, 'sessions'));
  const chat = await chatStore.save(chatRecord(emptyRecord()));
  const original = await readFile(join(root, 'sessions', '2026', '10', '14', `${chat.conversation_id}.json`));
  const driver = new AgentFixture();
  const manager = new SessionManager({ store: chatStore, driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, async execute() {} }, agent: { store: new AgentSessionHistoryStore(root), driver } });
  const events: string[] = [];
  const unsubscribe = manager.subscribeAgent(event => { events.push(event.type); });
  const agent = await manager.createAgentSession({ title: 'separate', agentID: 'opencode' });
  await manager.sendAgentMessage({ sessionID: agent.conversation_id, text: 'only current' });
  assert.equal((await manager.listAgentSessions()).records.length, 1);
  assert.equal((await manager.listSessions()).records.length, 1);
  assert.ok(events.includes('agent-session-updated'));
  assert.deepEqual(await readFile(join(root, 'sessions', '2026', '10', '14', `${chat.conversation_id}.json`)), original);
  unsubscribe();
  await manager.shutdown();
});

test('Input byte limit and slash commands fail before preparing local or external facts', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'x'.repeat(256 * 1024 + 1) }), /容量上限/);
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: '  /login' }), /不支持原生命令/);
  assert.equal(store.saves, 1);
  assert.equal(driver.requests.length, 0);
  assert.equal((await lifecycle.send({ sessionID: session.conversation_id, text: 'x'.repeat(256 * 1024) })).status, 'accepted');
  assert.equal(driver.prompts, 1);
});

test('Settings become unavailable after submission without invalidating original finished facts', async () => {
  const driver = new AgentFixture(async (_request, emit) => {
    driver.source = undefined;
    await emit({ type: 'text-delta', text: 'original reply' });
    await emit({ type: 'settled', outcome: 'finished' });
  });
  const { lifecycle } = fixture(undefined, driver);
  const session = await create(lifecycle);
  const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'original input' });
  assert.equal(result.session.turns[0]?.state, 'finished');
  assert.equal(result.session.messages[1]?.text, 'original reply');
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'next' }), /尚未就绪/);
  assert.equal(driver.prompts, 1);
});

test('Confirmed cancellation stores the original terminal proof and a later explicit turn keeps its binding', async () => {
  const entered = deferred(); const cancelProof = deferred();
  const driver = new AgentFixture(async (_request, emit) => {
    if (driver.prompts === 1) {
      entered.resolve();
      await cancelProof.promise;
      await emit({ type: 'text-delta', text: 'original partial reply' });
      await emit({ type: 'settled', outcome: 'cancelled' });
    } else await emit({ type: 'settled', outcome: 'finished' });
  });
  driver.cancelStatus = 'confirmed';
  driver.onCancel = cancelProof.resolve;
  const { lifecycle } = fixture(undefined, driver);
  const session = await create(lifecycle);
  const sending = lifecycle.send({ sessionID: session.conversation_id, text: 'first' });
  await entered.promise;
  await lifecycle.stop(session.conversation_id);
  const cancelled = await sending;
  assert.equal(cancelled.session.turns[0]?.state, 'cancelled');
  assert.equal(cancelled.session.messages[1]?.text, 'original partial reply');
  const next = await lifecycle.send({ sessionID: session.conversation_id, text: 'next explicit input' });
  assert.deepEqual(next.session.binding, cancelled.session.binding);
  assert.equal(driver.sessions, 1);
  assert.equal(driver.prompts, 2);
  assert.equal(next.session.turns[1]?.state, 'finished');
});

test('Changing runtime during binding save refuses prompt and retains the original immutable binding', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  const originalRuntime = driver.source!.runtimeID;
  store.beforeSave = async (_record, number) => { if (number === 4) driver.source!.runtimeID = randomUUID(); };
  const result = await lifecycle.send({ sessionID: session.conversation_id, text: 'not submitted' });
  assert.equal(result.status, 'notSubmitted');
  assert.equal(result.session.turns[0]?.state, 'failed');
  assert.equal(result.session.binding?.runtimeID, originalRuntime);
  assert.equal(driver.prompts, 0);
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'replacement' }), /不会重新绑定/);
});

test('Pending retry refuses another writer with the same next revision but different facts', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  store.uncertain.add(6);
  await lifecycle.send({ sessionID: session.conversation_id, text: 'done' });
  store.records.get(session.conversation_id)!.title = 'different writer';
  await assert.rejects(lifecycle.retry(session.conversation_id), /CAS conflict/);
  assert.equal((await store.load(session.conversation_id))?.title, 'different writer');
  await assert.rejects(lifecycle.send({ sessionID: session.conversation_id, text: 'replay' }), /补存/);
  assert.equal(driver.prompts, 1);
});

test('Agent directory capacity and mismatched declared identities fail closed', async () => {
  const root = await temp();
  const store = new AgentSessionHistoryStore(root);
  await mkdir(store.root);
  await Promise.all(Array.from({ length: 1000 }, async () => {
    const id = randomUUID();
    await writeFile(join(store.root, `${id}.json`), JSON.stringify({ conversation_id: id }));
  }));
  await assert.rejects(store.save(emptyRecord()), /数量达到上限/);
  const other = await temp();
  const mismatched = new AgentSessionHistoryStore(other);
  await mkdir(mismatched.root);
  const record = emptyRecord();
  await writeFile(join(mismatched.root, `${randomUUID()}.json`), JSON.stringify(record));
  await assert.rejects(mismatched.load(record.conversation_id), /身份不一致/);
  await assert.rejects(mismatched.save(record), /身份不一致/);
});

test('Concurrent list/load recovery shares one local write and does not create a pending conflict', async () => {
  const { lifecycle, store, driver } = fixture();
  const session = await create(lifecycle);
  const finished = (await lifecycle.send({ sessionID: session.conversation_id, text: 'done' })).session;
  finished.turns[0]!.state = 'submitting';
  store.records.set(session.conversation_id, finished);
  const entered = deferred(); const release = deferred();
  const before = store.saves;
  store.beforeSave = async () => { entered.resolve(); await release.promise; };
  const nextApp = new AgentSessionLifecycle(store, driver);
  const listing = nextApp.list();
  const loading = nextApp.load(session.conversation_id);
  await entered.promise;
  release.resolve();
  assert.equal((await listing).records[0]?.turns[0]?.state, 'unknown');
  assert.equal((await loading)?.turns[0]?.state, 'unknown');
  assert.equal(store.saves, before + 1);
  await nextApp.retry(session.conversation_id);
  assert.equal(store.saves, before + 1);
  assert.equal(driver.prompts, 1);
});
