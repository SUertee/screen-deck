import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installDesktopRoutes } from '../../src/main/desktop-routes.js';
import { ProviderSettingsStore } from '../../src/main/provider-settings.js';
import { ProviderModelsService } from '../../src/main/provider-models.js';
import { LocalState } from '../../src/main/local-state.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { SessionManager, TaskOrchestrator } from '../../src/core/index.js';
import type { ProjectWorkspaceReader } from '../../src/projects/index.js';
import type { DesktopEvent, ProviderModelsResult } from '../../src/shared/desktop-api.js';
const baseURL = 'https://models-fixture.invalid/v1', apiKey = 'synthetic-model-catalog-key';
async function harness(listModels: (input: { baseURL: string; credential: string }) => Promise<ProviderModelsResult> = async () => ({ kind: 'available', modelIDs: ['model-a', 'model-b'] })) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-model-routes-'));
  const settings = new ProviderSettingsStore(root); await settings.initialize();
  const local = new LocalState(join(root, 'local-state')), providerModels = new ProviderModelsService(settings, local, { listModels });
  const handlers = new Map<string, (input: unknown) => unknown>(), events: DesktopEvent[] = [];
  const host = { handle: (channel: string, handler: (input: unknown) => unknown) => handlers.set(channel, handler), broadcast: (event: DesktopEvent) => events.push(event) } as unknown as ElectronHost;
  installDesktopRoutes({ settings, providerModels, local, host, manager: {} as SessionManager, projects: {} as ProjectWorkspaceReader, plans: {} as TaskOrchestrator, diagnostics: [], previewRoot: root, withSettingsSnapshot: (_snapshot, operation) => operation() });
  return { root, settings, providerModels, events, invoke: async (channel: string, input?: unknown) => handlers.get(channel)!(input) };
}
test('explicit list check never saves draft keys or returns them over IPC', async () => {
  let requests = 0;
  const h = await harness(async input => { requests++; assert.deepEqual(input, { baseURL, credential: apiKey }); return { kind: 'available', modelIDs: ['model-a'] }; });
  const result = await h.invoke('list-provider-models', { baseURL, apiKey });
  assert.deepEqual(result, { kind: 'available', modelIDs: ['model-a'] }); assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal(h.settings.publicSettings().hasKey, false); await assert.rejects(readFile(join(h.root, 'credential.json')), { code: 'ENOENT' });
  assert.deepEqual(h.events, []); assert.equal(requests, 1);
});
test('validated settings default to persistence and cache survives restart without HTTP', async () => {
  let requests = 0; const h = await harness(async () => { requests++; return { kind: 'available', modelIDs: ['model-a', 'model-b'] }; });
  await h.invoke('list-provider-models', { baseURL, apiKey });
  assert.deepEqual(await h.invoke('save-settings', { baseURL, modelID: 'model-a', apiKey }), { baseURL, modelID: 'model-a', hasKey: true, credentialStorage: 'file' });
  assert.deepEqual(await h.invoke('get-provider-models'), { baseURL, modelIDs: ['model-a', 'model-b'] }); assert.equal(JSON.stringify(h.events).includes(apiKey), false); assert.equal(requests, 1);
  const restarted = new ProviderSettingsStore(h.root); await restarted.initialize();
  const models = new ProviderModelsService(restarted, new LocalState(join(h.root, 'local-state')), { listModels: async () => { throw new Error('Cached reads must not fetch.'); } });
  assert.deepEqual(await models.get(), { baseURL, modelIDs: ['model-a', 'model-b'] }); assert.equal(restarted.publicSettings().hasKey, true);
});
test('selecting cached models updates settings without requests or changing captured snapshots', async () => {
  let requests = 0; const h = await harness(async () => { requests++; return { kind: 'available', modelIDs: ['model-a', 'model-b'] }; });
  await h.invoke('list-provider-models', { baseURL, apiKey }); await h.invoke('save-settings', { baseURL, modelID: 'model-a', apiKey });
  const original = await h.settings.prepareRequest();
  assert.deepEqual(await h.invoke('select-provider-model', { modelID: 'model-b' }), { baseURL, modelID: 'model-b', hasKey: true, credentialStorage: 'file' });
  assert.equal(original.modelID, 'model-a'); assert.equal(original.credential, apiKey); assert.equal(requests, 1); assert.equal(h.events.at(-1)?.type, 'settings-updated');
  for (const input of [{ modelID: 'not-listed' }, { modelID: '' }, { modelID: 'model-a', unexpected: true }]) await assert.rejects(h.invoke('select-provider-model', input));
  assert.equal(h.settings.publicSettings().modelID, 'model-b');
});
test('list validates fields, key types and changed destinations before fetching', async () => {
  let requests = 0; const h = await harness(async () => { requests++; return { kind: 'available', modelIDs: [] }; });
  await h.invoke('save-settings', { baseURL, modelID: 'manual-model', apiKey });
  for (const input of [{ baseURL, apiKey, url: 'extra' }, { baseURL, apiKey: 123 }, { baseURL: 'http://invalid.example/v1', apiKey }, { baseURL: 'https://new-origin.invalid/v1' }]) await assert.rejects(h.invoke('list-provider-models', input));
  assert.equal(requests, 0); assert.equal((await h.settings.prepareRequest()).credential, apiKey);
});
test('failed list leaves the original connection and credential untouched', async () => {
  const h = await harness(async () => { throw new Error('Synthetic connection failure'); });
  await h.invoke('save-settings', { baseURL, modelID: 'manual-model', apiKey }); const before = await readFile(join(h.root, 'credential.json'));
  await assert.rejects(h.invoke('list-provider-models', { baseURL: 'https://another-fixture.invalid/v1', apiKey: 'replacement-synthetic-key' }));
  assert.deepEqual(await readFile(join(h.root, 'credential.json')), before); assert.equal(h.settings.publicSettings().baseURL, baseURL); assert.equal(h.events.length, 1);
});

test('save and select publish the latest settings when another window saves during cache update', async () => {
  for (const channel of ['save-settings', 'select-provider-model']) {
    const h = await harness();
    await h.invoke('list-provider-models', { baseURL, apiKey }); await h.invoke('save-settings', { baseURL, modelID: 'model-a', apiKey });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    h.providerModels.afterSave = async () => { entered(); await held; };
    const pending = h.invoke(channel, channel === 'save-settings' ? { baseURL, modelID: 'model-b' } : { modelID: 'model-b' });
    await started;
    const latest = await h.settings.save({ baseURL: 'https://new-window.invalid/v1', modelID: 'new-window-model', apiKey: 'synthetic-new-window-key' });
    release(); assert.deepEqual(await pending, latest);
    assert.deepEqual(h.events.at(-1), { type: 'settings-updated', settings: latest });
    assert.equal(JSON.stringify(h.events).includes('synthetic-new-window-key'), false);
  }
});
