import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderSettingsStore, type CredentialCipher } from '../../src/main/provider-settings.js';

const preferences = { baseURL: 'https://provider.example/v1', modelID: 'test-model' };
const secret = 'async-fixture-only-secret';
const encode = (value: string): Buffer => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a));
const decode = (value: Buffer): string => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)).toString('utf8');
const syncCipher: CredentialCipher = { available: () => true, encrypt: encode, decrypt: decode };
async function temp(): Promise<string> { return mkdtemp(join(await realpath(tmpdir()), 'screendeck-async-provider-test-')); }
async function savedRoot(): Promise<string> {
  const root = await temp(); const writer = new ProviderSettingsStore(root, syncCipher); await writer.initialize();
  await writer.save({ ...preferences, apiKey: secret, rememberKey: true }); return root;
}
function barrier(): { entered: Promise<void>; wait: () => Promise<void>; release: () => void } {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await held; } };
}

test('automatic asynchronous credential loads are idempotent and leave persisted bytes unchanged', async () => {
  const root = await savedRoot(); const keyBefore = await readFile(join(root, 'credential.bin')); const configBefore = await readFile(join(root, 'provider.toml'));
  const calls = [0, 0, 0]; const gate = barrier();
  const cipher: CredentialCipher = {
    async available() { calls[0]! += 1; return true; },
    async encrypt(value) { calls[1]! += 1; return encode(value); },
    async decrypt(value) { calls[2]! += 1; await gate.wait(); return decode(value); },
  };
  const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  assert.deepEqual(calls, [0, 0, 0]);
  const pending = Promise.all([store.prepareRequest(), store.ensureCredential(), store.prepareRequest()]);
  await gate.entered;
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'locked' });
  assert.equal(store.snapshot().credential, undefined);
  gate.release();
  const [first, publicSettings, repeated] = await pending; await store.ensureCredential();
  assert.deepEqual(first, { baseURL: preferences.baseURL, modelID: preferences.modelID, credential: secret });
  assert.equal(Object.isFrozen(first), true); assert.deepEqual(repeated, first);
  assert.deepEqual(publicSettings, { ...preferences, hasKey: true, credentialStorage: 'encrypted' });
  assert.equal(JSON.stringify(publicSettings).includes(secret), false); assert.deepEqual(calls, [1, 0, 1]);
  assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
});

test('a request freezes its loaded destination and credential before queued saves change them', async () => {
  const root = await savedRoot(); const gate = barrier(); const order: string[] = [];
  const cipher: CredentialCipher = { ...syncCipher, async decrypt(value) { await gate.wait(); return decode(value); } };
  const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  const replacement = { baseURL: 'https://another-provider.example/v1', modelID: 'another-model', apiKey: 'another-fixture-only-secret', rememberKey: false };
  const first = store.prepareRequest().then(snapshot => { order.push('first request'); return snapshot; });
  const saving = store.save(replacement).then(settings => { order.push('save'); return settings; });
  const second = store.prepareRequest().then(snapshot => { order.push('second request'); return snapshot; });
  await gate.entered;
  assert.equal(store.publicSettings().baseURL, preferences.baseURL); assert.equal(store.publicSettings().hasKey, false);
  gate.release();
  const [original, saved, next] = await Promise.all([first, saving, second]);
  assert.deepEqual(order, ['first request', 'save', 'second request']);
  assert.deepEqual(original, { baseURL: preferences.baseURL, modelID: preferences.modelID, credential: secret });
  assert.equal(Object.isFrozen(original), true); assert.equal(Reflect.set(original, 'baseURL', next.baseURL), false);
  assert.deepEqual(next, { baseURL: replacement.baseURL, modelID: replacement.modelID, credential: replacement.apiKey });
  assert.equal(saved.credentialStorage, 'memory'); assert.equal((await readFile(join(root, 'credential.bin'))).length, 0);
  assert.deepEqual(original, { baseURL: preferences.baseURL, modelID: preferences.modelID, credential: secret });
});

test('external edits while async availability or decryption waits reject the load without changing its CAS baseline', async () => {
  for (const phase of ['availability', 'decryption']) for (const file of ['provider.toml', 'credential.bin']) {
    const root = await savedRoot(); const gate = barrier(); const calls = [0, 0];
    const cipher: CredentialCipher = {
      async available() { calls[0]! += 1; if (phase === 'availability') await gate.wait(); return true; },
      encrypt: encode,
      async decrypt(value) { calls[1]! += 1; if (phase === 'decryption') await gate.wait(); return decode(value); },
    };
    const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    const pending = store.prepareRequest(); await gate.entered;
    const external = file === 'provider.toml' ? Buffer.from('schema_version = 1\nbase_url = "https://external.example/v1"\nmodel_id = "external-model"\n') : encode(JSON.stringify({ baseURL: preferences.baseURL, key: 'external-fixture-secret' }));
    await writeFile(join(root, file), external); gate.release();
    await assert.rejects(pending, { code: 'settings-conflict' });
    assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'locked' }); assert.equal(store.snapshot().credential, undefined);
    const expectedCalls = phase === 'availability' ? [1, 0] : [1, 1]; assert.deepEqual(calls, expectedCalls);
    await assert.rejects(store.prepareRequest(), { code: 'settings-conflict' });
    await assert.rejects(store.save({ ...preferences, modelID: 'local-model', rememberKey: true }), { code: 'settings-conflict' });
    assert.deepEqual(calls, expectedCalls); assert.deepEqual(await readFile(join(root, file)), external);
  }
});

test('saving awaits async availability and encryption before committing settings or allowing a request', async () => {
  const root = await temp(); const availability = barrier(); const encryption = barrier();
  const cipher: CredentialCipher = {
    async available() { await availability.wait(); return true; },
    async encrypt(value) { await encryption.wait(); return encode(value); },
    async decrypt(value) { return decode(value); },
  };
  const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  let saved = false; let prepared = false;
  const saving = store.save({ ...preferences, apiKey: secret, rememberKey: true }).then(value => { saved = true; return value; });
  const request = store.prepareRequest().then(value => { prepared = true; return value; });
  await availability.entered; assert.equal(saved, false); assert.equal(prepared, false); assert.equal(store.publicSettings().hasKey, false);
  await assert.rejects(readFile(join(root, 'credential.bin')), { code: 'ENOENT' }); availability.release();
  await encryption.entered; assert.equal(saved, false); assert.equal(prepared, false); assert.equal(store.publicSettings().hasKey, false);
  await assert.rejects(readFile(join(root, 'provider.toml')), { code: 'ENOENT' }); encryption.release();
  assert.equal((await saving).credentialStorage, 'encrypted'); assert.equal((await request).credential, secret);
  assert.equal(saved, true); assert.equal(prepared, true); assert.equal((await readFile(join(root, 'credential.bin'))).includes(Buffer.from(secret)), false);
  const restarted = new ProviderSettingsStore(root, syncCipher); await restarted.initialize(); assert.equal((await restarted.prepareRequest()).credential, secret);
});

test('external edits during async encryption prevent both file replacements and retain the external bytes', async () => {
  for (const phase of ['availability', 'encryption']) for (const file of ['provider.toml', 'credential.bin']) {
    const root = await savedRoot(); const gate = barrier();
    const cipher: CredentialCipher = {
      async available() { if (phase === 'availability') await gate.wait(); return true; },
      async encrypt(value) { if (phase === 'encryption') await gate.wait(); return encode(value); },
      decrypt: decode,
    };
    const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    const original = await readFile(join(root, file === 'provider.toml' ? 'credential.bin' : 'provider.toml'));
    const pending = store.save({ ...preferences, apiKey: 'replacement-fixture-secret', rememberKey: true }); await gate.entered;
    const external = Buffer.from(file === 'provider.toml' ? 'external configuration fixture' : 'external ciphertext fixture');
    await writeFile(join(root, file), external); gate.release(); await assert.rejects(pending, { code: 'settings-conflict' });
    assert.deepEqual(await readFile(join(root, file)), external);
    assert.deepEqual(await readFile(join(root, file === 'provider.toml' ? 'credential.bin' : 'provider.toml')), original);
    assert.equal(store.snapshot().credential, undefined); await assert.rejects(store.prepareRequest(), { code: 'settings-conflict' });
  }
});

test('async cipher rejection messages never expose secrets or overwrite persisted data', async () => {
  for (const phase of ['availability', 'encryption', 'decryption']) {
    const root = await savedRoot(); const keyBefore = await readFile(join(root, 'credential.bin')); const configBefore = await readFile(join(root, 'provider.toml'));
    const cipher: CredentialCipher = {
      async available() { if (phase === 'availability') throw new Error(secret); return true; },
      async encrypt(value) { if (phase === 'encryption') throw new Error(secret); return encode(value); },
      async decrypt(value) { if (phase === 'decryption') throw new Error(secret); return decode(value); },
    };
    const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    const operation = phase === 'decryption' ? store.prepareRequest() : store.save({ ...preferences, apiKey: secret, rememberKey: true });
    await assert.rejects(operation, error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(secret), false); return true; });
    assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'locked' }); assert.equal(store.snapshot().credential, undefined);
    assert.equal(JSON.stringify(store.diagnostics).includes(secret), false);
    assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
  }
});
