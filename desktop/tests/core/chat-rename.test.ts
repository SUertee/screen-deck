import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentChatReadySource, AgentSessionRecord } from '../../src/shared/agent-chat.js';
import type { HistoryDiagnostic, SessionRecord } from '../../src/shared/types.js';
import type { AgentChatDriver } from '../../src/core/sessions/agent-chat-driver.js';
import { AgentSessionHistoryStore } from '../../src/core/sessions/agent-session-history-store.js';
import { ExecutionError, type ExecutionDriver } from '../../src/core/sessions/execution-driver.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { StorageError } from '../../src/core/storage/private-storage.js';

type ChatRecord = SessionRecord | AgentSessionRecord;
interface TestStore<T extends ChatRecord> {
  load(id: string, options?: { observeRecord?: (record: T) => boolean }): Promise<T | undefined>;
  list(options?: { observeRecord?: (id: string) => boolean }): Promise<{ records: T[]; diagnostics: HistoryDiagnostic[] }>;
  save(record: T, expectedRevision?: number): Promise<T>;
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
interface Controls {
  failure?: 'before' | 'after';
  beforeSave?: () => Promise<void>;
  afterLoad?: () => Promise<void>;
  afterList?: () => void;
}
function intercept<T extends ChatRecord>(store: TestStore<T>, controls: Controls): TestStore<T> {
  return {
    load: async (id, options) => { const record = await store.load(id, options); await controls.afterLoad?.(); return record; },
    list: async options => { const listing = await store.list(options); controls.afterList?.(); return listing; },
    save: async (record, revision) => {
      await controls.beforeSave?.();
      if (controls.failure === 'before') throw new StorageError('write-failed', 'fixture write failed');
      const saved = await store.save(record, revision);
      if (controls.failure === 'after') throw new StorageError('write-uncertain', 'fixture replacement uncertain');
      return saved;
    },
  };
}

async function fixture(t: TestContext, kind: 'model' | 'agent') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-chat-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = { provider_id: 'fixture', model_id: 'fixture-model' };
  let now = '2026-10-18T01:00:00.000Z';
  let source: AgentChatReadySource | undefined = { agentID: 'opencode', name: 'OpenCode', state: 'ready', configDigest: 'a'.repeat(64), runtimeID: randomUUID(), connectionGeneration: randomUUID(), model };
  const calls = { execute: 0, source: 0 };
  let mode: 'finished' | 'unknown' | 'hold' = 'finished';
  const entered = deferred();
  const release = deferred();
  const driver: ExecutionDriver = {
    capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false },
    async execute(_request, emit) {
      calls.execute += 1;
      await emit({ type: 'submitted' });
      if (mode === 'unknown') throw new ExecutionError('network', 'fixture disconnect', true);
      if (mode === 'hold') { entered.resolve(); await release.promise; }
      await emit({ type: 'text-delta', text: 'fixture reply' });
      await emit({ type: 'completed' });
    },
  };
  const agent: AgentChatDriver = {
    getSource() { calls.source += 1; return structuredClone(source); },
    async sendTurn(request, emit) {
      calls.execute += 1;
      if (!request.binding) await emit({ type: 'bound', binding: { runtimeID: source!.runtimeID, connectionGeneration: source!.connectionGeneration, externalSessionID: 'fixture-native-session' } });
      await emit({ type: 'submitted' });
      if (mode === 'unknown') throw new ExecutionError('network', 'fixture disconnect', true);
      if (mode === 'hold') { entered.resolve(); await release.promise; }
      await emit({ type: 'text-delta', text: 'fixture reply' });
      await emit({ type: 'settled', outcome: 'finished' });
    },
    async cancelTurn() { return { status: 'unknown' }; },
  };
  const controls: Controls = {};
  const chatStore = new SessionHistoryStore(join(root, 'sessions'));
  const agentStore = new AgentSessionHistoryStore(root);
  const manager = new SessionManager({ store: kind === 'model' ? intercept(chatStore, controls) : chatStore, driver, agent: { store: kind === 'agent' ? intercept(agentStore, controls) : agentStore, driver: agent }, now: () => new Date(now), persistIntervalMs: 100_000 });
  const initial = kind === 'model' ? await manager.createSession('Original') : await manager.createAgentSession({ title: 'Original', agentID: 'opencode' });
  const id = initial.conversation_id;
  const filename = kind === 'model' ? join(root, 'sessions', ...initial.created_at.slice(0, 10).split('-'), `${id}.json`) : join(root, 'agent-sessions-v1', `${id}.json`);
  const load = () => kind === 'model' ? manager.loadSession(id) : manager.loadAgentSession(id);
  const list = () => kind === 'model' ? manager.listSessions() : manager.listAgentSessions();
  const rename = (title: string, expectedRevision: number) => kind === 'model' ? manager.renameSession({ sessionID: id, title, expectedRevision }) : manager.renameAgentSession({ sessionID: id, title, expectedRevision });
  const send = () => kind === 'model' ? manager.sendMessage({ sessionID: id, text: 'fixture input', model }) : manager.sendAgentMessage({ sessionID: id, text: 'fixture input' });
  const retry = () => kind === 'model' ? manager.retryPendingWrites(id) : manager.retryAgentPendingWrites(id);
  const busy = () => kind === 'model' ? manager.isSessionBusy(id) : manager.isAgentSessionBusy(id);
  return { manager, controls, initial, filename, calls, entered, release, load, list, rename, send, retry, busy, advance: () => { now = '2026-10-18T02:00:00.000Z'; }, unavailable: () => { source = undefined; }, mode: (next: typeof mode) => { mode = next; } };
}

for (const kind of ['model', 'agent'] as const) {
  test(`${kind}: canonical rename changes only title, aggregate time and revision; same title is a no-op`, async t => {
    const h = await fixture(t, kind);
    const completed = (await h.send()).session;
    const calls = structuredClone(h.calls);
    h.advance();
    const renamed = await h.rename('  New title  ', completed.revision);
    assert.deepEqual(renamed, { ...completed, title: 'New title', updated_at: '2026-10-18T02:00:00.000Z', revision: completed.revision + 1 });
    const bytes = await readFile(h.filename);
    assert.deepEqual(await h.rename('New title', renamed.revision), renamed);
    assert.deepEqual(await readFile(h.filename), bytes);
    assert.deepEqual(h.calls, calls);
    assert.equal(h.busy(), false);
    assert.deepEqual((await h.list()).records[0], renamed);
  });

  test(`${kind}: unknown and original binding remain frozen even when Agent readiness is unavailable`, async t => {
    const h = await fixture(t, kind);
    h.mode('unknown');
    const unknown = (await h.send()).session;
    assert.equal(unknown.turns[0]!.state, 'unknown');
    h.unavailable();
    const calls = structuredClone(h.calls);
    h.advance();
    const renamed = await h.rename('Keep this evidence', unknown.revision);
    assert.deepEqual(renamed.turns, unknown.turns);
    assert.deepEqual(renamed.messages, unknown.messages);
    assert.deepEqual(renamed.binding, unknown.binding);
    assert.deepEqual(h.calls, calls);
    await assert.rejects(h.send(), /未知/);
    assert.equal(h.calls.execute, calls.execute);
  });

  test(`${kind}: invalid title/revision and stale revision never write or leave a busy reservation`, async t => {
    const h = await fixture(t, kind);
    const bytes = await readFile(h.filename);
    for (const title of ['', '  ', 'a\0b', '界'.repeat(201)]) await assert.rejects(h.rename(title, h.initial.revision), /标题/);
    for (const revision of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(h.rename('No', revision), /修订/);
    await assert.rejects(h.rename('No', h.initial.revision + 1), /变化/);
    assert.deepEqual(await readFile(h.filename), bytes);
    assert.equal(h.busy(), false);
    assert.equal(h.calls.execute, 0);
  });

  test(`${kind}: metadata reservation rejects send/retry/rename while list and load await the saved title`, async t => {
    const h = await fixture(t, kind);
    const entered = deferred(); const release = deferred();
    h.controls.beforeSave = async () => { entered.resolve(); await release.promise; };
    const renaming = h.rename('Reserved', h.initial.revision);
    await entered.promise;
    assert.equal(h.busy(), true);
    await assert.rejects(h.send(), /修改标题/);
    await assert.rejects(h.retry(), /标题修改/);
    await assert.rejects(h.rename('Overtake', h.initial.revision), /正在读取或修改/);
    const loading = h.load(); const listing = h.list();
    let loaded = false; void loading.then(() => { loaded = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(loaded, false);
    release.resolve();
    const renamed = await renaming;
    assert.deepEqual(await loading, renamed);
    assert.deepEqual((await listing).records[0], renamed);
    assert.equal(h.calls.execute, 0);
    assert.equal(h.busy(), false);
  });

  test(`${kind}: active turns and in-flight reads reject rename without editing execution facts`, async t => {
    const h = await fixture(t, kind);
    h.mode('hold');
    const sending = h.send();
    await h.entered.promise;
    await assert.rejects(h.rename('During send', h.initial.revision), /轮次/);
    h.release.resolve(); await sending;
    const entered = deferred(); const release = deferred();
    h.controls.afterLoad = async () => { entered.resolve(); await release.promise; };
    const loading = h.load();
    await entered.promise;
    assert.equal(h.busy(), true);
    await assert.rejects(h.rename('During load', h.initial.revision), /正在读取或修改/);
    release.resolve(); await loading;
    assert.equal(h.busy(), false);
  });

  for (const failure of ['before', 'after'] as const) {
    test(`${kind}: ${failure}-replacement save failure blocks changes and retry only repairs the exact local rename`, async t => {
      const h = await fixture(t, kind);
      h.controls.failure = failure;
      await assert.rejects(h.rename('Pending title', h.initial.revision), /fixture/);
      assert.equal(h.busy(), true);
      assert.equal(JSON.parse(await readFile(h.filename, 'utf8')).title, failure === 'before' ? 'Original' : 'Pending title');
      await assert.rejects(h.send(), /未保存|补存/);
      await assert.rejects(h.rename('Overwrite pending', h.initial.revision), /补存/);
      h.controls.failure = undefined;
      await h.retry();
      const saved = await h.load();
      assert.equal(saved!.title, 'Pending title');
      assert.equal(saved!.revision, h.initial.revision + 1);
      assert.equal(h.calls.execute, 0);
      assert.equal(h.busy(), false);
    });
  }

  test(`${kind}: listing during metadata CAS cannot adopt another writer's same-revision bytes`, async t => {
    const h = await fixture(t, kind);
    const entered = deferred(); const release = deferred(); const listed = deferred();
    h.controls.beforeSave = async () => { entered.resolve(); await release.promise; };
    h.controls.afterList = listed.resolve;
    const renaming = h.rename('Local rename', h.initial.revision);
    await entered.promise;
    const external = JSON.parse(await readFile(h.filename, 'utf8'));
    external.title = 'External same revision';
    const bytes = Buffer.from(JSON.stringify(external));
    await writeFile(h.filename, bytes);
    const listing = h.list();
    await listed.promise;
    release.resolve();
    await assert.rejects(renaming, /修改|冲突/);
    await listing;
    h.controls.beforeSave = undefined;
    await assert.rejects(h.retry(), /修改|冲突/);
    assert.deepEqual(await readFile(h.filename), bytes);
    assert.equal(h.calls.execute, 0);
    assert.equal(h.busy(), true);
  });
}
