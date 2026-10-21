import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installDesktopRoutes } from '../../src/main/desktop-routes.js';
import { ProviderSettingsStore, type ProviderRequestSnapshot } from '../../src/main/provider-settings.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { SessionManager, TaskOrchestrator } from '../../src/core/index.js';
import type { ProjectWorkspaceReader } from '../../src/projects/index.js';
import type { LocalState } from '../../src/main/local-state.js';
import type { DesktopEvent } from '../../src/shared/desktop-api.js';

const sessionID = '019a0000-0000-7000-8000-000000000001';
const preferences = { baseURL: 'https://fixture.example/v1', modelID: 'fixture-model' };
const secret = 'fixture-only-key';
async function harness(options: { stored?: boolean; exists?: boolean; beforeSessionLoad?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-credential-routes-'));
  const writer = new ProviderSettingsStore(root); await writer.initialize();
  if (options.stored !== false) await writer.save({ ...preferences, apiKey: secret, rememberKey: true });
  const settings = new ProviderSettingsStore(root); await settings.initialize();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: DesktopEvent[] = []; const requests: unknown[] = []; const snapshots: ProviderRequestSnapshot[] = [];
  let stops = 0;
  const manager = {
    loadSession: async () => { await options.beforeSessionLoad?.(); return options.exists === false ? undefined : { conversation_id: sessionID }; },
    sendMessage: async (request: unknown) => { requests.push(request); return { status: 'accepted' }; },
    stopGeneration: async () => { stops++; },
  } as unknown as SessionManager;
  const host = { handle: (name: string, operation: (input: unknown) => unknown) => handlers.set(name, operation), broadcast: (event: DesktopEvent) => events.push(event) } as unknown as ElectronHost;
  installDesktopRoutes({ settings, manager, host, projects: {} as ProjectWorkspaceReader, plans: {} as TaskOrchestrator, local: {} as LocalState, diagnostics: [], previewRoot: root, withSettingsSnapshot: (snapshot, operation) => { snapshots.push(snapshot); return operation(); } });
  return { root, settings, handlers, events, requests, snapshots, stops: () => stops, invoke: async (name: string, input?: unknown) => handlers.get(name)!(input) };
}

test('send IPC uses the startup-loaded file credential and captures one private call snapshot', async () => {
  const h = await harness();
  assert.deepEqual(await h.invoke('get-settings'), { ...preferences, hasKey: true, credentialStorage: 'file' });
  const before = await Promise.all(['provider.toml', 'credential.json'].map(name => readFile(join(h.root, name))));
  await h.invoke('send-message', { sessionID, text: 'fixture prompt' });
  assert.deepEqual(h.requests, [{ sessionID, text: 'fixture prompt', model: { provider_id: 'chat-completions', model_id: preferences.modelID } }]);
  assert.deepEqual(h.snapshots, [{ baseURL: preferences.baseURL, modelID: preferences.modelID, credential: secret }]);
  assert.equal(Object.isFrozen(h.snapshots[0]), true);
  assert.equal(h.settings.publicSettings().hasKey, true);
  assert.equal(h.events.length, 1); assert.equal(JSON.stringify(h.events).includes(secret), false);
  assert.equal(JSON.stringify(await h.invoke('get-settings')).includes(secret), false);
  assert.deepEqual(await Promise.all(['provider.toml', 'credential.json'].map(name => readFile(join(h.root, name)))), before);
  assert.equal(h.handlers.has('unlock-credentials'), false);
});

test('missing credentials never submit a message or expose a private snapshot', async () => {
  const h = await harness({ stored: false });
  await assert.rejects(h.invoke('send-message', { sessionID, text: 'fixture prompt' }), { code: 'credential-missing' });
  assert.equal(h.requests.length, 0); assert.equal(h.snapshots.length, 0); assert.equal(h.events.length, 0);
  assert.equal(h.settings.publicSettings().hasKey, false);
});

test('invalid or missing session targets cannot capture a call snapshot or submit', async () => {
  const h = await harness({ exists: false });
  for (const input of [{ sessionID, text: 'fixture prompt' }, { sessionID, text: '   ' }, { sessionID: 'invalid', text: 'fixture prompt' }, { sessionID, text: 'fixture prompt', unexpected: true }]) await assert.rejects(h.invoke('send-message', input));
  assert.equal(h.snapshots.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.events.length, 0);
});

test('duplicate sends are rejected while session validation is preparing the request', async () => {
  let release!: () => void; let began!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
  const h = await harness({ beforeSessionLoad: async () => { began(); await barrier; } });
  const pending = h.invoke('send-message', { sessionID, text: 'first prompt' }); await started;
  await assert.rejects(h.invoke('send-message', { sessionID, text: 'duplicate prompt' }), /重复发送/);
  release(); await pending; assert.equal(h.requests.length, 1);
});

test('stop during session validation prevents model submission and permits an explicit retry', async () => {
  let release!: () => void; let began!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
  const h = await harness({ beforeSessionLoad: async () => { began(); await barrier; } });
  const pending = h.invoke('send-message', { sessionID, text: 'unsent prompt' }); await started;
  await h.invoke('stop-generation', sessionID); release(); await assert.rejects(pending, /尚未发送/);
  assert.equal(h.requests.length, 0); assert.equal(h.stops(), 1);
  await h.invoke('send-message', { sessionID, text: 'deliberate retry' }); assert.equal(h.requests.length, 1);
});

test('a later settings save cannot retarget Send while its session validation is pending', async () => {
  let release!: () => void; let began!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
  const h = await harness({ beforeSessionLoad: async () => { began(); await barrier; } });
  const sending = h.invoke('send-message', { sessionID, text: 'original destination' }); await started;
  let saved = false;
  const saving = h.invoke('save-settings', { baseURL: 'https://replacement.example/v1', modelID: 'replacement-model', apiKey: 'replacement-fixture-key', rememberKey: false }).then(() => { saved = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(saved, false);
  release(); await Promise.all([sending, saving]);
  assert.equal(h.snapshots[0]?.baseURL, preferences.baseURL);
  assert.equal(h.snapshots[0]?.modelID, preferences.modelID); assert.equal(h.snapshots[0]?.credential, secret);
  assert.equal(h.settings.publicSettings().baseURL, 'https://replacement.example/v1');
});

test('external edits during preparation reject submission without adopting or overwriting the changed files', async () => {
  for (const name of ['provider.toml', 'credential.json']) {
    let release!: () => void; let began!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
    const h = await harness({ beforeSessionLoad: async () => { began(); await barrier; } });
    const pending = h.invoke('send-message', { sessionID, text: 'must not send after an external edit' });
    await started;
    const external = `external ${name} fixture`;
    await writeFile(join(h.root, name), external);
    release();
    await assert.rejects(pending, error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(secret), false);
      return 'code' in error && error.code === 'settings-conflict';
    });
    await assert.rejects(h.invoke('send-message', { sessionID, text: 'must not silently retry' }), { code: 'settings-conflict' });
    assert.equal(await readFile(join(h.root, name), 'utf8'), external);
    assert.equal(h.requests.length, 0); assert.equal(h.snapshots.length, 0); assert.equal(h.events.length, 0);
  }
});
