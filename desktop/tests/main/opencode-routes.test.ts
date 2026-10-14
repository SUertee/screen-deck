import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOpenCodeRoutes } from '../../src/main/opencode-routes.js';
import { ProviderSettingsStore } from '../../src/main/provider-settings.js';
import type { OpenCodeRuntime } from '../../src/main/opencode-runtime.js';
import type { OpenCodeConnection } from '../../src/core/opencode-adapter.js';
import { OpenCodeRuntimeError } from '../../src/main/opencode-runtime.js';
import { StorageError } from '../../src/core/private-storage.js';
import type { OpenCodeBinaryCandidate, OpenCodeInstallation, DesktopEvent, OpenCodeStatus } from '../../src/shared/desktop-api.js';

async function harness(options: { stored?: boolean; decryptPause?: Promise<void> } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-runtime-routes-'));
  let decrypts = 0;
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => { decrypts++; await options.decryptPause; return bytes.toString(); } };
  const writer = new ProviderSettingsStore(root, cipher); await writer.initialize();
  if (options.stored) await writer.save({ baseURL: 'https://fixture.example/v1', modelID: 'fixture-model', apiKey: 'fixture-secret', rememberKey: true });
  const settings = options.stored ? new ProviderSettingsStore(root, cipher) : writer;
  if (options.stored) await settings.initialize();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: DesktopEvent[] = [];
  let connection: OpenCodeConnection | undefined;
  let starts = 0;
  let chosen: () => Promise<string | undefined> = async () => '/fixture/opencode';
  let input: Parameters<OpenCodeRuntime['start']>[0] | undefined;
  let failure = false; let versionFailure = false;
  let startPause: Promise<void> | undefined;
  const candidate: OpenCodeBinaryCandidate = { id: 'a'.repeat(64), path: '/fixture/opencode', source: 'standard' };
  let candidates = [candidate]; let preferredID: string | undefined; let chooserCalls = 0; let guideCalls = 0; let rememberFailure = false; let resolves = 0; let staleAfter: number | undefined;
  const remembered: string[] = [];
  const discovery = {
    discover: async (): Promise<OpenCodeInstallation> => ({ candidates: structuredClone(candidates), ...(preferredID ? { preferredID } : {}) }),
    choose: async (path: string): Promise<OpenCodeBinaryCandidate> => { const choice = { id: 'b'.repeat(64), path, source: 'manual' as const }; candidates = [choice, ...candidates.filter(value => value.path !== path)]; preferredID = choice.id; return choice; },
    resolve: async (id?: string): Promise<string> => {
      resolves++; if (staleAfter !== undefined && resolves > staleAfter) throw new StorageError('candidate-stale', '程序文件已变化，请重新检测。');
      const value = candidates.find(value => value.id === (id ?? preferredID ?? (candidates.length === 1 ? candidates[0].id : undefined)));
      if (!value) throw new StorageError('candidate-unavailable', '程序候选不可确认，请检测或明确选择。'); return value.path;
    },
    remember: async (path: string) => { if (rememberFailure) throw new Error('private-path-save-error'); remembered.push(path); },
  };
  const runtime: Pick<OpenCodeRuntime, 'start' | 'stop' | 'getConnection'> = {
    getConnection: () => connection,
    start: async value => {
      starts++; input = value;
      await startPause;
      if (versionFailure) throw new OpenCodeRuntimeError('runtime-version', 'synthetic-untrusted-runtime-text');
      if (failure) throw new Error(`Untrusted diagnostic: ${value.provider.credential}`);
      return connection = { baseURL: 'http://127.0.0.1:1234', authorization: 'private-auth', runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', directory: '/fixture/clean', version: '1.19.0', configDigest: 'a'.repeat(64), model: { provider_id: 'screendeck', model_id: value.provider.modelID } };
    },
    stop: async () => { connection = undefined; },
  };
  let runtimeGeneration: string | undefined;
  installOpenCodeRoutes({ onStarted: generation => { runtimeGeneration = generation; }, requiresRestart: () => runtimeGeneration !== settings.generation, host: { handle: (name, handler) => { handlers.set(name, handler); }, broadcast: event => { events.push(event); } }, settings, runtime, discovery, openInstallGuide: async () => { guideCalls++; }, chooseBinary: () => { chooserCalls++; return chosen(); } });
  const invoke = async (name: string, value?: unknown) => await handlers.get(name)!(value) as OpenCodeStatus;
  return { settings, invoke, events, remembered, resolves: () => resolves, failVersion: () => { versionFailure = true; }, candidates: (values: OpenCodeBinaryCandidate[], preferred?: string) => { candidates = values; preferredID = preferred; }, chooserCalls: () => chooserCalls, guideCalls: () => guideCalls, staleAfter: (count: number) => { staleAfter = count; }, failRemember: () => { rememberFailure = true; }, starts: () => starts, input: () => input, decrypts: () => decrypts, choose: (fn: typeof chosen) => { chosen = fn; }, pause: (value: Promise<void>) => { startPause = value; }, fail: () => { failure = true; } };
}

test('runtime status and cancelled chooser never read credentials or start a process', async () => {
  const h = await harness();
  await h.settings.save({ baseURL: 'https://fixture.example/v1', modelID: 'fixture-model', apiKey: 'fixture-secret', rememberKey: true });
  h.choose(async () => undefined);
  assert.deepEqual(await h.invoke('opencode-status'), { state: 'stopped' });
  assert.equal(await h.invoke('choose-opencode-binary'), undefined);
  assert.equal(h.starts(), 0); assert.equal(h.decrypts(), 0);
  for (const input of [{ binaryPath: '/untrusted' }, { baseURL: 'http://remote' }, {}, null, []]) await assert.rejects(h.invoke('start-opencode', input), { code: 'ipc-input' });
});

test('explicit start freezes a provider privately; status contains no URL, path, auth or credential', async () => {
  const h = await harness();
  await h.settings.save({ baseURL: 'https://fixture.example/v1', modelID: 'fixture-model', apiKey: 'fixture-secret', rememberKey: false });
  const status = await h.invoke('start-opencode');
  assert.deepEqual(status, { state: 'ready', version: '1.19.0', model: { provider_id: 'screendeck', model_id: 'fixture-model' }, requiresRestart: false });
  assert.deepEqual(h.input()?.provider, { baseURL: 'https://fixture.example/v1', modelID: 'fixture-model', credential: 'fixture-secret' });
  assert.equal(h.starts(), 1);
  await h.settings.save({ baseURL: 'https://new.example/v1', modelID: 'new-model', apiKey: 'new-fixture-secret', rememberKey: false });
  assert.deepEqual(await h.invoke('start-opencode'), { ...status, requiresRestart: true });
  assert.equal(h.starts(), 1, 'saving settings must not retarget an existing runtime');
  assert.equal(h.input()?.provider.modelID, 'fixture-model');
  assert.doesNotMatch(JSON.stringify(status), /secret|private-auth|fixture\/|https?:/);
  assert.deepEqual(await h.invoke('stop-opencode'), { state: 'stopped' });
});

test('missing credentials and concurrent control cannot dispatch a duplicate start', async () => {
  const h = await harness();
  await assert.rejects(h.invoke('start-opencode'), { code: 'credential-missing' });
  assert.equal(h.starts(), 0);
  await h.settings.save({ baseURL: 'https://fixture.example/v1', modelID: 'fixture-model', apiKey: 'fixture-secret', rememberKey: false });
  let release!: () => void;
  h.pause(new Promise(resolve => { release = resolve; }));
  const first = h.invoke('start-opencode');
  await assert.rejects(h.invoke('start-opencode'), { code: 'runtime-busy' });
  await assert.rejects(h.invoke('stop-opencode'), { code: 'runtime-busy' });
  release(); await first;
  assert.equal(h.starts(), 1);
});

test('untrusted startup errors are replaced by a fixed diagnostic without the credential', async () => {
  const h = await harness();
  await h.settings.save({ baseURL: 'https://fixture.example/v1', modelID: 'fixture-model', apiKey: 'fixture-secret', rememberKey: false });
  h.fail();
  await assert.rejects(h.invoke('start-opencode'), error => error instanceof Error && !error.message.includes('fixture-secret') && /未能连接/.test(error.message));
  assert.deepEqual(await h.invoke('opencode-status'), { state: 'stopped' });
});

test('settings saved during startup invalidate new submissions without retargeting the private snapshot', async () => {
  const h = await harness();
  await h.settings.save({ baseURL: 'https://fixture.example/v1', modelID: 'original-model', apiKey: 'original-fixture-secret', rememberKey: false });
  let release!: () => void;
  h.pause(new Promise(resolve => { release = resolve; }));
  const pending = h.invoke('start-opencode');
  while (!h.starts()) await new Promise(resolve => setTimeout(resolve, 1));
  await h.settings.save({ baseURL: 'https://new.example/v1', modelID: 'new-model', apiKey: 'new-fixture-secret', rememberKey: false });
  release();
  const status = await pending;
  assert.deepEqual(status, { state: 'ready', version: '1.19.0', model: { provider_id: 'screendeck', model_id: 'original-model' }, requiresRestart: true });
  assert.deepEqual(h.input()?.provider, { baseURL: 'https://fixture.example/v1', modelID: 'original-model', credential: 'original-fixture-secret' });
  assert.equal(h.starts(), 1);
});


test('installation metadata, manual selection and install guide do not decrypt or connect', async () => {
  const h = await harness({ stored: true });
  await h.invoke('opencode-installation');
  const chosen = await h.invoke('choose-opencode-binary') as unknown as OpenCodeBinaryCandidate;
  assert.equal(chosen.source, 'manual');
  await h.invoke('opencode-install-guide');
  assert.equal(h.guideCalls(), 1); assert.equal(h.chooserCalls(), 1);
  assert.equal(h.decrypts(), 0); assert.equal(h.starts(), 0); assert.equal(h.remembered.length, 0);
  for (const name of ['opencode-installation', 'choose-opencode-binary', 'opencode-install-guide']) {
    await assert.rejects(h.invoke(name, { url: 'https://forged.example', path: '/arbitrary/program' }), { code: 'ipc-input' });
  }
});

test('missing, ambiguous and forged candidates fail before credential access without opening a chooser', async () => {
  const h = await harness({ stored: true });
  h.candidates([]); await assert.rejects(h.invoke('start-opencode'));
  h.candidates([{ id: 'a'.repeat(64), path: '/fixture/a', source: 'path' }, { id: 'b'.repeat(64), path: '/fixture/b', source: 'standard' }]);
  await assert.rejects(h.invoke('start-opencode'));
  await assert.rejects(h.invoke('start-opencode', { candidateID: 'c'.repeat(64) }));
  assert.equal(h.decrypts(), 0); assert.equal(h.starts(), 0); assert.equal(h.chooserCalls(), 0);
  await h.invoke('start-opencode', { candidateID: 'b'.repeat(64) });
  assert.equal(h.input()?.binaryPath, '/fixture/b'); assert.deepEqual(h.remembered, ['/fixture/b']);
});

test('one discovered candidate connects without chooser and is remembered only after success', async () => {
  const h = await harness({ stored: true });
  await h.invoke('start-opencode');
  assert.equal(h.starts(), 1); assert.equal(h.chooserCalls(), 0); assert.equal(h.decrypts(), 1);
  assert.deepEqual(h.remembered, ['/fixture/opencode']);
  const failed = await harness({ stored: true }); failed.fail();
  await assert.rejects(failed.invoke('start-opencode')); assert.deepEqual(failed.remembered, []);
});

test('program replaced while awaiting credential access cannot connect or be remembered', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ stored: true, decryptPause: wait }); h.staleAfter(1);
  const pending = h.invoke('start-opencode');
  while (!h.decrypts()) await new Promise(resolve => setImmediate(resolve));
  release(); await assert.rejects(pending, { code: 'candidate-stale' });
  assert.equal(h.starts(), 0); assert.deepEqual(h.remembered, []);
});

test('failed path persistence preserves the verified ready connection and generation', async () => {
  const h = await harness({ stored: true }); h.failRemember();
  const result = await h.invoke('start-opencode'); assert.equal(result.state, 'ready');
  assert.equal(result.state === 'ready' && result.requiresRestart, false);
  assert.equal(h.starts(), 1); assert.deepEqual(h.remembered, []);
  assert.ok(h.events.some(event => event.type === 'diagnostic' && event.message.includes('已连接')));
  assert.doesNotMatch(JSON.stringify(h.events), /fixture-secret|private-path-save-error/);
});


test('an ambiguous or empty initial discovery cannot resolve a new implicit choice while preparing', async () => {
  const h = await harness({ stored: true }); h.candidates([]);
  await assert.rejects(h.invoke('start-opencode'), { code: 'discovery-missing' });
  assert.equal(h.resolves(), 0); assert.equal(h.decrypts(), 0);
  h.candidates([{ id: 'a'.repeat(64), path: '/fixture/a', source: 'path' }, { id: 'b'.repeat(64), path: '/fixture/b', source: 'path' }]);
  await assert.rejects(h.invoke('start-opencode'), { code: 'discovery-ambiguous' });
  assert.equal(h.resolves(), 0); assert.equal(h.decrypts(), 0);
});

test('incompatible Runtime versions expose the supported version through the trusted storage error envelope', async () => {
  const h = await harness({ stored: true }); h.failVersion();
  await assert.rejects(h.invoke('start-opencode'), error => error instanceof StorageError && error.code === 'runtime-version' && /1\.19\.0/.test(error.message) && !error.message.includes('synthetic-untrusted-runtime-text'));
  assert.deepEqual(h.remembered, []); assert.equal(h.chooserCalls(), 0);
});
