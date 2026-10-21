import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import fileOperations from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderSettingsStore } from '../../src/main/provider-settings.js';

const preferences = { baseURL: 'https://provider.example/v1', modelID: 'test-model' };
const secret = 'async-fixture-only-secret';
async function temp(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), 'screendeck-async-provider-test-'));
}
async function savedRoot(): Promise<string> {
  const root = await temp();
  const writer = new ProviderSettingsStore(root);
  await writer.initialize();
  await writer.save({ ...preferences, apiKey: secret, rememberKey: true });
  return root;
}
function barrier(): { entered: Promise<void>; wait: () => Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await held; } };
}
function assertSanitized(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(secret), false);
  return true;
}

test('concurrent request preparation is idempotent and does not rewrite loaded plaintext credentials', async () => {
  const root = await savedRoot();
  const keyBefore = await readFile(join(root, 'credential.json'));
  const configBefore = await readFile(join(root, 'provider.toml'));
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: true, credentialStorage: 'file' });
  const requests = await Promise.all([store.prepareRequest(), store.prepareRequest(), store.prepareRequest()]);
  await store.flush();
  for (const request of requests) {
    assert.deepEqual(request, { ...preferences, credential: secret });
    assert.equal(Object.isFrozen(request), true);
  }
  assert.equal(JSON.stringify(store.publicSettings()).includes(secret), false);
  assert.deepEqual(await readFile(join(root, 'credential.json')), keyBefore);
  assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
});

test('asynchronous request validation reserves the original snapshot before queued saves', async () => {
  const root = await savedRoot();
  const gate = barrier();
  const order: string[] = [];
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const replacement = {
    baseURL: 'https://another-provider.example/v1', modelID: 'another-model',
    apiKey: 'another-fixture-only-secret', rememberKey: false,
  };
  const first = store.prepareRequest(() => gate.wait()).then(snapshot => { order.push('first request'); return snapshot; });
  const saving = store.save(replacement).then(settings => { order.push('save'); return settings; });
  const second = store.prepareRequest().then(snapshot => { order.push('second request'); return snapshot; });
  await gate.entered;
  assert.deepEqual(order, []);
  assert.equal(store.publicSettings().baseURL, preferences.baseURL);
  assert.equal(store.publicSettings().credentialStorage, 'file');
  gate.release();
  const [original, saved, next] = await Promise.all([first, saving, second]);
  assert.deepEqual(order, ['first request', 'save', 'second request']);
  assert.deepEqual(original, { ...preferences, credential: secret });
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Reflect.set(original, 'baseURL', next.baseURL), false);
  assert.deepEqual(next, { baseURL: replacement.baseURL, modelID: replacement.modelID, credential: replacement.apiKey });
  assert.equal(saved.credentialStorage, 'memory');
  assert.equal(JSON.parse(await readFile(join(root, 'credential.json'), 'utf8')), null);
  assert.deepEqual(original, { ...preferences, credential: secret });
});

test('external edits during request validation reject stale preparation and later saves without adopting edited bytes', async () => {
  for (const file of ['provider.toml', 'credential.json']) {
    const root = await savedRoot();
    const gate = barrier();
    const store = new ProviderSettingsStore(root);
    await store.initialize();
    const otherFile = file === 'provider.toml' ? 'credential.json' : 'provider.toml';
    const otherBefore = await readFile(join(root, otherFile));
    const pending = store.prepareRequest(() => gate.wait());
    await gate.entered;
    const external = Buffer.from(file === 'provider.toml'
      ? 'schema_version = 1\nbase_url = "https://external.example/v1"\nmodel_id = "external-model"\n'
      : JSON.stringify({ schema_version: 1, base_url: preferences.baseURL, api_key: 'external-fixture-key' }));
    await writeFile(join(root, file), external);
    gate.release();
    await assert.rejects(pending, { code: 'settings-conflict' });
    await assert.rejects(store.prepareRequest(), { code: 'settings-conflict' });
    await assert.rejects(store.save({ ...preferences, apiKey: 'replacement-fixture-key', rememberKey: true }), { code: 'settings-conflict' });
    assert.equal(store.snapshot().credential, undefined);
    assert.deepEqual(await readFile(join(root, file)), external);
    assert.deepEqual(await readFile(join(root, otherFile)), otherBefore);
  }
});

test('failed caller validation does not write credentials or poison the queued settings save', async () => {
  const root = await savedRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const keyBefore = await readFile(join(root, 'credential.json'));
  const gate = barrier();
  const first = store.prepareRequest(async () => { await gate.wait(); throw new Error('fixture request cancelled'); });
  const rejection = assert.rejects(first, /fixture request cancelled/);
  const saving = store.save({ ...preferences, modelID: 'next-model', rememberKey: true });
  await gate.entered;
  assert.deepEqual(await readFile(join(root, 'credential.json')), keyBefore);
  gate.release();
  await rejection;
  assert.equal((await saving).modelID, 'next-model');
  assert.deepEqual(await store.prepareRequest(), { ...preferences, modelID: 'next-model', credential: secret });
});

test('a settings save publishes no new snapshot until both file replacements complete', async () => {
  const root = await savedRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const keyBefore = await readFile(join(root, 'credential.json'));
  const gate = barrier();
  const originalRename = fileOperations.rename;
  fileOperations.rename = async (from, to) => {
    if (to === join(root, 'credential.json')) await gate.wait();
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  let saved = false;
  let prepared = false;
  try {
    const saving = store.save({ ...preferences, modelID: 'next-model', apiKey: 'replacement-fixture-key', rememberKey: true }).then(value => { saved = true; return value; });
    const request = store.prepareRequest().then(value => { prepared = true; return value; });
    await gate.entered;
    assert.equal(saved, false);
    assert.equal(prepared, false);
    assert.deepEqual(store.snapshot(), { ...preferences, credential: secret });
    assert.deepEqual(await readFile(join(root, 'credential.json')), keyBefore);
    gate.release();
    assert.equal((await saving).credentialStorage, 'file');
    assert.deepEqual(await request, { ...preferences, modelID: 'next-model', credential: 'replacement-fixture-key' });
  } finally {
    gate.release();
    fileOperations.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('two stores cannot overwrite the credential and preferences observed by the other writer', async () => {
  const root = await savedRoot();
  const first = new ProviderSettingsStore(root);
  const stale = new ProviderSettingsStore(root);
  await first.initialize();
  await stale.initialize();
  await first.save({ ...preferences, modelID: 'first-model', apiKey: 'first-fixture-key', rememberKey: true });
  const key = await readFile(join(root, 'credential.json'));
  const config = await readFile(join(root, 'provider.toml'));
  await assert.rejects(stale.prepareRequest(), { code: 'settings-conflict' });
  await assert.rejects(stale.save({ ...preferences, modelID: 'stale-model', apiKey: secret, rememberKey: true }), { code: 'settings-conflict' });
  assert.equal(stale.publicSettings().hasKey, false);
  assert.deepEqual(await readFile(join(root, 'credential.json')), key);
  assert.deepEqual(await readFile(join(root, 'provider.toml')), config);
  assert.equal((await first.prepareRequest()).modelID, 'first-model');
});

test('configuration replacement failure closes the current connection and a mismatched restart stays disabled', async () => {
  const root = await savedRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const configBefore = await readFile(join(root, 'provider.toml'));
  const keyBefore = await readFile(join(root, 'credential.json'));
  const previousGeneration = store.generation;
  const replacement = { baseURL: 'https://another-provider.example/v1', modelID: 'attempted-model', apiKey: 'new-fixed-fixture-key', rememberKey: true };
  const originalRename = fileOperations.rename;
  fileOperations.rename = async (from, to) => {
    if (to === join(root, 'provider.toml')) throw new Error(secret);
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.save(replacement), error => {
      assertSanitized(error);
      return (error as { code?: string }).code === 'settings-write';
    });
  } finally {
    fileOperations.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'none' });
  assert.notEqual(store.generation, previousGeneration);
  await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
  assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
  assert.notDeepEqual(await readFile(join(root, 'credential.json')), keyBefore);
  // The individual files are atomic; replacing both is not one transaction.
  const restarted = new ProviderSettingsStore(root);
  await restarted.initialize();
  assert.equal(restarted.publicSettings().hasKey, false);
  assert.ok(restarted.diagnostics.length);
  await assert.rejects(restarted.prepareRequest(), { code: 'credential-missing' });
  await store.save(replacement);
  assert.equal((await store.prepareRequest()).credential, replacement.apiKey);
});

test('credential replacement failure preserves both originals and does not silently fall back to memory', async () => {
  const root = await savedRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const configBefore = await readFile(join(root, 'provider.toml'));
  const keyBefore = await readFile(join(root, 'credential.json'));
  const originalRename = fileOperations.rename;
  fileOperations.rename = async (from, to) => {
    if (to === join(root, 'credential.json')) throw new Error(secret);
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.save({ ...preferences, apiKey: 'replacement-fixture-key', rememberKey: true }), error => {
      assertSanitized(error);
      return (error as { code?: string }).code === 'write-failed';
    });
  } finally {
    fileOperations.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(store.publicSettings().hasKey, false);
  assert.equal(store.publicSettings().credentialStorage, 'none');
  await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
  assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
  assert.deepEqual(await readFile(join(root, 'credential.json')), keyBefore);
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('lock release failure after both replacements leaves no usable in-process credential', async () => {
  const root = await savedRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const originalUnlink = fileOperations.unlink;
  fileOperations.unlink = async file => {
    if (file === join(root, 'settings.lock')) throw new Error(secret);
    return originalUnlink(file);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.save({ ...preferences, modelID: 'next-model', apiKey: 'replacement-fixture-key', rememberKey: true }), error => {
      assertSanitized(error);
      return (error as { code?: string }).code === 'lock-cleanup';
    });
  } finally {
    fileOperations.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'none' });
  await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
  assert.equal((await readdir(root)).includes('settings.lock'), true);
  assert.equal(JSON.parse(await readFile(join(root, 'credential.json'), 'utf8')).api_key, 'replacement-fixture-key');
  assert.equal((await readFile(join(root, 'provider.toml'), 'utf8')).includes('next-model'), true);
  await unlink(join(root, 'settings.lock'));
});

test('a credential symlink introduced while validating a request cannot be followed or overwritten', async () => {
  const root = await savedRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const gate = barrier();
  const pending = store.prepareRequest(() => gate.wait());
  await gate.entered;
  const target = join(await temp(), 'fixture-only-target');
  await writeFile(target, 'unrelated-fixture-data');
  await unlink(join(root, 'credential.json'));
  await symlink(target, join(root, 'credential.json'));
  gate.release();
  await assert.rejects(pending, { code: 'unsafe-file' });
  await assert.rejects(store.save({ ...preferences, apiKey: secret, rememberKey: true }), { code: 'unsafe-file' });
  assert.equal(await readFile(target, 'utf8'), 'unrelated-fixture-data');
  assert.equal(store.publicSettings().hasKey, false);
});
