import { AgentChatRegistry } from '../../src/core/agents/agent-chat-registry.js';
import { TEXT_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatPreferencesStore } from '../../src/main/chat-preferences.js';
import { LocalState } from '../../src/main/local-state.js';
import { installDesktopRoutes } from '../../src/main/desktop-routes.js';
import { ProviderSettingsStore } from '../../src/main/provider-settings.js';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { AgentSessionHistoryStore } from '../../src/core/sessions/agent-session-history-store.js';
import { TaskSessionHistoryStore } from '../../src/core/sessions/task-session-history-store.js';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import { StorageError } from '../../src/core/storage/private-storage.js';
import { TaskDriverFixture } from '../helpers/task-driver-fixture.js';
import type { AgentChatDriver } from '../../src/core/sessions/agent-chat-driver.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { ProjectWorkspaceReader } from '../../src/projects/index.js';
import type { BootstrapResult, DesktopEvent } from '../../src/shared/desktop-api.js';
import type { ChatPreferences } from '../../src/shared/chat-management.js';

const temporary = () => realpath(tmpdir()).then(root => mkdtemp(join(root, 'screendeck-chat-management-')));
const preferencePath = (root: string) => join(root, createHash('sha256').update('chat-preferences').digest('hex') + '.json');
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

async function fixture() {
  const root = await temporary(), local = new LocalState(join(root, 'local'));
  const calls = { model: 0, agent: 0, cancel: 0 };
  const runtimeID = randomUUID(), connectionGeneration = randomUUID();
  const agentDriver: AgentChatDriver = {
    descriptor: { agentID: 'fixture', name: 'Fixture', protocol: 'native', capabilities: TEXT_AGENT_CAPABILITIES },
    getSource: () => ({ state: 'ready', protocol: 'native', capabilities: TEXT_AGENT_CAPABILITIES, name: 'Fixture', agentID: 'fixture', configDigest: 'a'.repeat(64), runtimeID, connectionGeneration, model: { provider_id: 'fixture', model_id: 'fixture' } }),
    sendTurn: async () => { calls.agent++; assert.fail('Management must not send an Agent prompt.'); },
    cancelTurn: async () => { calls.cancel++; return { status: 'unknown' }; },
  };
  const modelStore = new SessionHistoryStore(join(root, 'sessions')), agentStore = new AgentSessionHistoryStore(root);
  const manager = new SessionManager({ store: modelStore, driver: { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { calls.model++; assert.fail('Management must not call a model.'); } }, agent: { store: agentStore, drivers: new AgentChatRegistry([{ driver: agentDriver }]) }, task: { store: new TaskSessionHistoryStore(root), driver: new TaskDriverFixture() } });
  const ordinary = await manager.createSession('Original model title'), agent = await manager.createAgentSession({ title: 'Original Agent title', agentID: 'fixture' });
  const settings = new ProviderSettingsStore(root);
  await settings.initialize();
  const handlers = new Map<string, (input: unknown) => unknown>(), events: DesktopEvent[] = [], clipboard: string[] = [];
  manager.subscribe(event => events.push(event)); manager.subscribeAgent(event => events.push(event));
  const host = { handle: (name: string, operation: (input: unknown) => unknown) => handlers.set(name, operation), broadcast: (event: DesktopEvent) => events.push(event), writeClipboardText: (text: string) => { clipboard.push(text); } } as unknown as ElectronHost;
  const projects = { list: () => [], get: () => undefined } as unknown as ProjectWorkspaceReader;
  installDesktopRoutes({ settings, manager, host, projects, plans: new TaskOrchestrator(root), local, diagnostics: [], previewRoot: root, withSettingsSnapshot: (_snapshot, operation) => operation() });
  const modelFile = (await readdir(modelStore.root, { recursive: true })).find(name => name.endsWith(`${ordinary.conversation_id}.json`))!;
  const files = [join(modelStore.root, modelFile), join(agentStore.root, `${agent.conversation_id}.json`)];
  return { root, local, manager, settings, ordinary, agent, events, calls, clipboard, files, invoke: <T = unknown>(name: string, input?: unknown) => Promise.resolve().then(() => handlers.get(name)!(input)) as Promise<T>, close: async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('preference patches serialize, preserve source identity, omit false flags and survive restart', async t => {
  const root = await temporary(); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChatPreferencesStore(new LocalState(root)), id = randomUUID();
  assert.deepEqual(await store.load(), { revision: 0, entries: {} });
  const results = await Promise.all([store.setArchived({ source: 'model', sessionID: id }, true, () => {}), store.setPinned({ source: 'model', sessionID: id }, true, () => {}), store.setPinned({ source: 'agent', sessionID: id }, true, () => {})]);
  assert.deepEqual(results.map(value => value.revision), [1, 2, 3]);
  const expected = { revision: 3, entries: { [`model:${id}`]: { archived: true, pinned: true }, [`agent:${id}`]: { pinned: true } } };
  assert.deepEqual(await new ChatPreferencesStore(new LocalState(root)).load(), expected);
  results[2]!.entries[`model:${id}`]!.archived = undefined;
  assert.deepEqual(await store.load(), expected, 'Returned snapshots cannot mutate the owner.');
  await store.setArchived({ source: 'model', sessionID: id }, false, () => {});
  const next = await store.setPinned({ source: 'model', sessionID: id }, false, () => {});
  assert.equal(next.entries[`model:${id}`], undefined);
  assert.deepEqual(await store.setPinned({ source: 'model', sessionID: id }, false, () => {}), next);
});

test('malformed preferences, failed writes and external CAS changes never overwrite the original', async t => {
  const root = await temporary(); t.after(() => rm(root, { recursive: true, force: true }));
  const local = new LocalState(root), store = new ChatPreferencesStore(local), ref = { source: 'model' as const, sessionID: randomUUID() };
  await store.setPinned(ref, true, () => {});
  const file = preferencePath(root), before = await readFile(file), write = local.write.bind(local);
  local.write = async () => { throw new StorageError('write-failed', 'Synthetic failure.'); };
  await assert.rejects(store.setArchived(ref, true, () => {}), /Synthetic/);
  assert.deepEqual(await readFile(file), before);
  const external = JSON.stringify({ schema_version: 1, kind: 'chat_preferences', revision: 9, entries: { [`model:${ref.sessionID}`]: { archived: true } } });
  local.write = async (name, value) => { await writeFile(file, external); return write(name, value); };
  await assert.rejects(store.setArchived(ref, true, () => {}));
  assert.equal(await readFile(file, 'utf8'), external);
  local.write = write;
  for (const invalid of ['{bad', JSON.stringify({ schema_version: 2, kind: 'chat_preferences', revision: 1, entries: {} }), JSON.stringify({ schema_version: 1, kind: 'chat_preferences', revision: 1, entries: { [`model:${ref.sessionID}`]: { archived: false } } })]) {
    await writeFile(file, invalid);
    await assert.rejects(store.load()); await assert.rejects(store.setPinned(ref, true, () => {}));
    assert.equal(await readFile(file, 'utf8'), invalid);
  }
});

test('archive, restore and pin broadcast saved preferences without changing either history or sending', async t => {
  const h = await fixture(); t.after(h.close);
  const before = await Promise.all(h.files.map(file => readFile(file)));
  const model = { source: 'model', sessionID: h.ordinary.conversation_id }, agent = { source: 'agent', sessionID: h.agent.conversation_id };
  await Promise.all([h.invoke('set-chat-archived', { ...model, archived: true }), h.invoke('set-chat-pinned', { ...agent, pinned: true })]);
  const restored = await h.invoke<ChatPreferences>('set-chat-archived', { ...model, archived: false });
  assert.deepEqual(restored, { revision: 3, entries: { [`agent:${h.agent.conversation_id}`]: { pinned: true } } });
  const bootstrap = await h.invoke<BootstrapResult>('bootstrap'); assert.deepEqual(bootstrap.chatPreferences, restored);
  assert.deepEqual(await Promise.all(h.files.map(file => readFile(file))), before);
  assert.deepEqual(h.events.filter(event => event.type === 'chat-preferences-updated').map(event => event.preferences.revision), [1, 2, 3]);
  assert.deepEqual(h.calls, { model: 0, agent: 0, cancel: 0 });
});

test('fixed preference inputs reject unknown fields, invalid types, missing chats and task-v2 targets', async t => {
  const h = await fixture(); t.after(h.close);
  const ref = { source: 'model', sessionID: h.ordinary.conversation_id };
  const task = await h.manager.createTaskSession({ title: 'Read-only task fixture', projectID: `project-${randomUUID()}`, taskID: 'task-001' });
  for (const input of [{ ...ref, archived: true, path: '/outside' }, { ...ref, archived: 'true' }, { ...ref, source: 'task', archived: true }, { ...ref, sessionID: '../outside', archived: true }, { ...ref, sessionID: randomUUID(), archived: true }, { ...ref, sessionID: task.conversation_id, archived: true }]) await assert.rejects(h.invoke('set-chat-archived', input));
  await assert.rejects(h.invoke('set-chat-pinned', { ...ref, pinned: 1 }));
  assert.deepEqual((await h.invoke<BootstrapResult>('bootstrap')).chatPreferences, { revision: 0, entries: {} });
  assert.equal(h.events.length, 0);
});

test('archive checks busy state after loading history and again inside the serialized preference read', async t => {
  const h = await fixture(); t.after(h.close);
  const ref = { source: 'model', sessionID: h.ordinary.conversation_id };
  const originalBusy = h.manager.isSessionBusy.bind(h.manager); let busy = false;
  h.manager.isSessionBusy = id => busy || originalBusy(id);
  const load = h.manager.loadSession.bind(h.manager), loaded = gate(), releaseLoad = gate();
  h.manager.loadSession = async id => { const value = await load(id); loaded.release(); await releaseLoad.promise; return value; };
  const loading = h.invoke('set-chat-archived', { ...ref, archived: true }); await loaded.promise; busy = true; releaseLoad.release();
  await assert.rejects(loading, /不能归档/); h.manager.loadSession = load;
  busy = false;
  const read = h.local.read.bind(h.local), reading = gate(), releaseRead = gate();
  h.local.read = async <T>(name: string, fallback: T): Promise<T> => { const value = await read(name, fallback); if (name === 'chat-preferences') { reading.release(); await releaseRead.promise; } return value; };
  const updating = h.invoke('set-chat-archived', { ...ref, archived: true }); await reading.promise; busy = true; releaseRead.release();
  await assert.rejects(updating, /不能归档/); h.local.read = read;
  await h.invoke('set-chat-pinned', { ...ref, pinned: true });
  const agentBusy = h.manager.isAgentSessionBusy.bind(h.manager); h.manager.isAgentSessionBusy = () => true;
  await assert.rejects(h.invoke('set-chat-archived', { source: 'agent', sessionID: h.agent.conversation_id, archived: true }), /不能归档/);
  h.manager.isAgentSessionBusy = agentBusy;
  assert.equal(h.events.filter(event => event.type === 'chat-preferences-updated').length, 1);
});

test('ordinary credential preparation blocks archive and rename before any dispatch', async t => {
  const h = await fixture(); t.after(h.close);
  await h.settings.save({ baseURL: 'https://fixture.invalid/v1', modelID: 'fixture', apiKey: 'synthetic-memory-key', rememberKey: false });
  const load = h.manager.loadSession.bind(h.manager), entered = gate(), release = gate();
  h.manager.loadSession = async id => { entered.release(); await release.promise; return load(id); };
  const sending = h.invoke('send-message', { sessionID: h.ordinary.conversation_id, text: 'Synthetic input, cancelled before dispatch.' });
  await entered.promise;
  await assert.rejects(h.invoke('set-chat-archived', { source: 'model', sessionID: h.ordinary.conversation_id, archived: true }), /不能归档/);
  await assert.rejects(h.invoke('rename-session', { sessionID: h.ordinary.conversation_id, title: 'Must not rename', expectedRevision: h.ordinary.revision }), /准备请求/);
  await h.invoke('stop-generation', h.ordinary.conversation_id); release.release(); await assert.rejects(sending, /尚未发送/);
  assert.deepEqual(h.calls, { model: 0, agent: 0, cancel: 0 });
});

test('rename IPC uses the source writer and one original update event, with strict revisions and titles', async t => {
  const h = await fixture(); t.after(h.close);
  for (const [channel, record, type] of [['rename-session', h.ordinary, 'session-updated'], ['rename-agent-session', h.agent, 'agent-session-updated']] as const) {
    const input = { sessionID: record.conversation_id, title: '  Renamed locally  ', expectedRevision: record.revision };
    const renamed = await h.invoke<{ title: string; revision: number }>(channel, input);
    assert.equal(renamed.title, 'Renamed locally'); assert.equal(renamed.revision, record.revision + 1);
    assert.equal(h.events.filter(event => event.type === type).length, 1);
    await assert.rejects(h.invoke(channel, input));
    for (const extra of [{ title: ' ' }, { title: '字'.repeat(201) }, { expectedRevision: 1.5 }, { arbitrary: true }]) await assert.rejects(h.invoke(channel, { ...input, expectedRevision: renamed.revision, ...extra }));
  }
  assert.deepEqual(h.calls, { model: 0, agent: 0, cancel: 0 });
});

test('corrupt preferences do not hide history in bootstrap and copy is bounded exact write-only text', async t => {
  const h = await fixture(); t.after(h.close);
  await h.invoke('set-chat-pinned', { source: 'model', sessionID: h.ordinary.conversation_id, pinned: true });
  const file = preferencePath(join(h.root, 'local')); await writeFile(file, '{broken');
  const data = await h.invoke<BootstrapResult>('bootstrap');
  assert.equal(data.sessions.length, 1); assert.equal(data.agentSessions?.length, 1); assert.equal(data.chatPreferences, undefined);
  assert.ok(data.diagnostics.some(message => message.includes('聊天整理')));
  const events = h.events.length; await assert.rejects(h.invoke('set-chat-pinned', { source: 'model', sessionID: h.ordinary.conversation_id, pinned: false }));
  assert.equal(await readFile(file, 'utf8'), '{broken'); assert.equal(h.events.length, events);
  const text = '  const x = "<tag>";\n\treturn x;\n'; await h.invoke('copy-text', text);
  assert.deepEqual(h.clipboard, [text]);
  for (const invalid of [{ text }, 'x'.repeat(1024 * 1024 + 1), 'nul\0text']) await assert.rejects(h.invoke('copy-text', invalid));
  assert.deepEqual(h.clipboard, [text]); assert.deepEqual(h.calls, { model: 0, agent: 0, cancel: 0 });
});
