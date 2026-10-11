import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installDesktopRoutes } from '../../src/main/desktop-routes.js';
import { ProviderSettingsStore, type CredentialCipher, type ProviderRequestSnapshot } from '../../src/main/provider-settings.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { SessionManager, TaskOrchestrator } from '../../src/core/index.js';
import type { ProjectWorkspaceReader } from '../../src/projects/index.js';
import type { LocalState } from '../../src/main/local-state.js';
import type { DesktopEvent } from '../../src/shared/desktop-api.js';

const sessionID = '019a0000-0000-7000-8000-000000000001';
const preferences = { baseURL: 'https://fixture.example/v1', modelID: 'fixture-model' };
const secret = 'fixture-only-key';
const cipher = (): CredentialCipher => ({ available: () => true, encrypt: value => Buffer.from(value.split('').reverse().join('')), decrypt: value => value.toString().split('').reverse().join('') });

async function harness(options: { stored?: boolean; cipher?: CredentialCipher; exists?: boolean; beforeSessionLoad?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-credential-routes-'));
  const writer = new ProviderSettingsStore(root, cipher()); await writer.initialize();
  if (options.stored !== false) await writer.save({ ...preferences, apiKey: secret, rememberKey: true });
  const settings = new ProviderSettingsStore(root, options.cipher ?? cipher()); await settings.initialize();
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
  return { settings, handlers, events, requests, snapshots, stops: () => stops, invoke: async (name: string, input?: unknown) => handlers.get(name)!(input) };
}

test('send IPC automatically loads a stored credential and captures one private call snapshot', async () => {
  const h = await harness(); assert.equal(h.settings.publicSettings().hasKey, false);
  await h.invoke('send-message', { sessionID, text: 'fixture prompt' });
  assert.deepEqual(h.requests, [{ sessionID, text: 'fixture prompt', model: { provider_id: 'chat-completions', model_id: preferences.modelID } }]);
  assert.deepEqual(h.snapshots, [{ endpoint: `${preferences.baseURL}/chat/completions`, modelID: preferences.modelID, credential: secret }]);
  assert.equal(Object.isFrozen(h.snapshots[0]), true);
  assert.equal(h.settings.publicSettings().hasKey, true);
  assert.equal(h.events.length, 1); assert.equal(JSON.stringify(h.events).includes(secret), false);
  assert.equal(h.handlers.has('unlock-credentials'), false);
});

test('missing or denied credentials never submit messages and OS error details stay private', async () => {
  for (const options of [{ stored: false }, { cipher: { ...cipher(), decrypt: async () => { throw new Error(secret); } } }]) {
    const h = await harness(options);
    await assert.rejects(h.invoke('send-message', { sessionID, text: 'fixture prompt' }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(secret), false); return true;
    });
    assert.equal(h.requests.length, 0); assert.equal(h.snapshots.length, 0); assert.equal(h.events.length, 0);
    assert.equal(h.settings.publicSettings().hasKey, false);
  }
});

test('invalid or missing session targets are rejected before credential access', async () => {
  let decryptions = 0;
  const h = await harness({ exists: false, cipher: { ...cipher(), decrypt: value => { decryptions++; return cipher().decrypt(value); } } });
  for (const input of [{ sessionID, text: 'fixture prompt' }, { sessionID, text: '   ' }, { sessionID: 'invalid', text: 'fixture prompt' }, { sessionID, text: 'fixture prompt', unexpected: true }]) await assert.rejects(h.invoke('send-message', input));
  assert.equal(decryptions, 0); assert.equal(h.requests.length, 0);
});

test('duplicate sends are rejected while waiting for system credential access', async () => {
  let release!: () => void; let began!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
  const h = await harness({ cipher: { ...cipher(), decrypt: async value => { began(); await barrier; return cipher().decrypt(value); } } });
  const pending = h.invoke('send-message', { sessionID, text: 'first prompt' }); await started;
  await assert.rejects(h.invoke('send-message', { sessionID, text: 'duplicate prompt' }), /重复发送/);
  release(); await pending; assert.equal(h.requests.length, 1);
});

test('stop during credential preparation prevents later model submission without erasing draft data', async () => {
  let release!: () => void; let began!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
  const h = await harness({ cipher: { ...cipher(), decrypt: async value => { began(); await barrier; return cipher().decrypt(value); } } });
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
  assert.equal(h.snapshots[0]?.endpoint, `${preferences.baseURL}/chat/completions`);
  assert.equal(h.snapshots[0]?.modelID, preferences.modelID); assert.equal(h.snapshots[0]?.credential, secret);
  assert.equal(h.settings.publicSettings().baseURL, 'https://replacement.example/v1');
});
