import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import fileOperations from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ProviderSettingsStore, DEFAULT_PROVIDER, validateProvider, type CredentialCipher } from '../../src/main/provider-settings.js';
import { LocalState } from '../../src/main/local-state.js';
import { isTrustedURL, payload, textInput, uuidInput } from '../../src/main/ipc-validation.js';

async function temp(): Promise<string> { return mkdtemp(join(await realpath(tmpdir()), 'screendeck-main-test-')); }
interface FakeCipher extends CredentialCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
  availabilityChecks: number;
  encryptions: number;
  decryptions: number;
}
function fakeCipher(available = true): FakeCipher {
  return {
    availabilityChecks: 0, encryptions: 0, decryptions: 0,
    available() { this.availabilityChecks += 1; return available; },
    encrypt(value) { this.encryptions += 1; return Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)); },
    decrypt(value) { this.decryptions += 1; return Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)).toString('utf8'); },
  };
}
const secret = 'unit-test-only-secret';
const preferences = { baseURL: 'https://provider.example/v1', modelID: 'test-model' };
function cipherCounts(cipher: FakeCipher): number[] { return [cipher.availabilityChecks, cipher.encryptions, cipher.decryptions]; }
async function savedCredentialRoot(provider = preferences): Promise<string> {
  const root = await temp(); const writer = new ProviderSettingsStore(root, fakeCipher()); await writer.initialize();
  await writer.save({ ...provider, apiKey: secret, rememberKey: true }); return root;
}

test('provider public settings reveal presence and storage mode without a credential', async () => {
  const root = await temp(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  assert.deepEqual(store.publicSettings(), { ...DEFAULT_PROVIDER, hasKey: false, credentialStorage: 'none' });
  const saved = await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  assert.deepEqual(saved, { ...preferences, hasKey: true, credentialStorage: 'encrypted' });
  assert.equal(JSON.stringify(saved).includes(secret), false); assert.equal(JSON.stringify(store.publicSettings()).includes(secret), false);
  assert.equal((await readFile(join(root, 'provider.toml'), 'utf8')).includes(secret), false);
  assert.equal((await readFile(join(root, 'credential.bin'))).includes(Buffer.from(secret)), false);
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
  const restartCipher = fakeCipher(); const restarted = new ProviderSettingsStore(root, restartCipher); await restarted.initialize();
  assert.deepEqual(restarted.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'locked' });
  assert.equal(restarted.snapshot().credential, undefined); assert.deepEqual(cipherCounts(restartCipher), [0, 0, 0]);
  const loaded = await restarted.ensureCredential();
  assert.deepEqual(loaded, { ...preferences, hasKey: true, credentialStorage: 'encrypted' });
  assert.equal(JSON.stringify(loaded).includes(secret), false);
  assert.equal(restarted.snapshot().credential, secret); assert.equal(restarted.snapshot().baseURL, preferences.baseURL);
});

test('an endpoint or path change cannot silently inherit an old key', async () => {
  const store = new ProviderSettingsStore(await temp(), fakeCipher()); await store.initialize();
  await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  await store.save({ ...preferences, modelID: 'another-model', rememberKey: true }); assert.equal(store.snapshot().credential, secret);
  await store.save({ ...preferences, baseURL: 'https://provider.example/another-path', rememberKey: true });
  assert.equal(store.publicSettings().hasKey, false); assert.equal(store.snapshot().credential, undefined);
  await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  await store.save({ ...preferences, baseURL: 'https://another-provider.example/v1', rememberKey: true }); assert.equal(store.publicSettings().hasKey, false);
});

test('a captured submission snapshot remains bound to its original endpoint, model and key', async () => {
  const store = new ProviderSettingsStore(await temp(), fakeCipher()); await store.initialize();
  await store.save({ ...preferences, apiKey: secret, rememberKey: true }); const pending = store.snapshot();
  await store.save({ baseURL: 'https://another-provider.example/v1', modelID: 'another-model', apiKey: 'different-test-secret', rememberKey: true });
  assert.deepEqual(pending, { baseURL: preferences.baseURL, modelID: preferences.modelID, credential: secret });
  assert.notEqual(store.snapshot().baseURL, pending.baseURL); assert.notEqual(store.snapshot().credential, pending.credential);
});

test('memory-only keys and forgetting credentials leave no recoverable key on restart', async () => {
  const root = await temp(); const store = new ProviderSettingsStore(root, fakeCipher(false)); await store.initialize();
  const saved = await store.save({ ...preferences, apiKey: secret, rememberKey: true }); assert.equal(saved.credentialStorage, 'memory');
  assert.equal((await readFile(join(root, 'credential.bin'))).length, 0);
  const cipher = fakeCipher(); const restarted = new ProviderSettingsStore(root, cipher); await restarted.initialize();
  assert.equal(restarted.publicSettings().hasKey, false); assert.equal(cipher.decryptions, 0); assert.deepEqual(restarted.diagnostics, []);
  await restarted.save({ ...preferences, apiKey: secret, rememberKey: true });
  await restarted.save({ ...preferences, forgetKey: true, rememberKey: true }); assert.equal(restarted.publicSettings().hasKey, false);
  const afterForget = new ProviderSettingsStore(root, fakeCipher()); await afterForget.initialize(); assert.equal(afterForget.publicSettings().hasKey, false); assert.deepEqual(afterForget.diagnostics, []);
});

test('encrypted keys are rejected after an interrupted endpoint update or unknown config version', async () => {
  const root = await temp(); const store = new ProviderSettingsStore(root, fakeCipher()); await store.initialize();
  await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  const altered = 'schema_version = 1\nbase_url = "https://another-provider.example/v1"\nmodel_id = "test-model"\n';
  await writeFile(join(root, 'provider.toml'), altered);
  const cipher = fakeCipher(); const keyBefore = await readFile(join(root, 'credential.bin'));
  const restarted = new ProviderSettingsStore(root, cipher); await restarted.initialize();
  assert.equal(restarted.publicSettings().credentialStorage, 'locked'); assert.equal(restarted.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [0, 0, 0]);
  await assert.rejects(restarted.ensureCredential(), /未能读取/); assert.equal(restarted.publicSettings().hasKey, false);
  assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.equal(await readFile(join(root, 'provider.toml'), 'utf8'), altered);
  const unsupported = 'schema_version = 99\nbase_url = "https://provider.example/v1"\nmodel_id = "test-model"\n'; await writeFile(join(root, 'provider.toml'), unsupported);
  const future = new ProviderSettingsStore(root, fakeCipher()); await future.initialize();
  assert.equal(future.publicSettings().hasKey, false); assert.ok(future.diagnostics.length); assert.equal(await readFile(join(root, 'provider.toml'), 'utf8'), unsupported);
  await assert.rejects(future.ensureCredential(), /有效配置无法关联/); assert.equal(future.snapshot().credential, undefined);
});

test('cipher failures never expose decrypted material in diagnostics or public settings', async () => {
  const root = await temp(); const store = new ProviderSettingsStore(root, fakeCipher()); await store.initialize(); await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  const cipher: CredentialCipher = { available: () => true, encrypt: value => Buffer.from(value), decrypt: () => { throw new Error(secret); } };
  const restarted = new ProviderSettingsStore(root, cipher); await restarted.initialize();
  await assert.rejects(restarted.ensureCredential(), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes(secret), false); assert.match(error.message, /未能读取/); return true;
  });
  assert.equal(restarted.publicSettings().credentialStorage, 'locked'); assert.equal(restarted.snapshot().credential, undefined);
  assert.equal(restarted.publicSettings().hasKey, false); assert.equal(JSON.stringify(restarted.diagnostics).includes(secret), false);
});

test('startup and public reads never probe availability, encrypt or decrypt a stored credential', async () => {
  const root = await savedCredentialRoot(); const keyBefore = await readFile(join(root, 'credential.bin')); const configBefore = await readFile(join(root, 'provider.toml'));
  const calls = [0, 0, 0];
  const cipher: CredentialCipher = {
    available() { calls[0]! += 1; throw new Error('startup must not probe system keychain'); },
    encrypt() { calls[1]! += 1; throw new Error('startup must not encrypt'); },
    decrypt() { calls[2]! += 1; throw new Error('startup must not decrypt'); },
  };
  const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  for (let count = 0; count < 3; count += 1) {
    assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'locked' });
    assert.equal(store.snapshot().credential, undefined);
  }
  await store.flush(); assert.deepEqual(calls, [0, 0, 0]); assert.deepEqual(store.diagnostics, []);
  assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
});

test('locked same-endpoint model edits preserve ciphertext byte-for-byte without cipher calls', async () => {
  const root = await savedCredentialRoot(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  const before = await readFile(join(root, 'credential.bin'));
  const saved = await store.save({ baseURL: 'https://PROVIDER.example/v1///', modelID: 'new-model', rememberKey: true });
  assert.deepEqual(saved, { ...preferences, modelID: 'new-model', hasKey: false, credentialStorage: 'locked' });
  assert.equal(store.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [0, 0, 0]);
  assert.deepEqual(await readFile(join(root, 'credential.bin')), before);
  const loaded = await store.ensureCredential(); assert.equal(loaded.modelID, 'new-model'); assert.equal(loaded.hasKey, true);
  assert.equal(store.snapshot().credential, secret); assert.deepEqual(cipherCounts(cipher), [1, 0, 1]);
});

test('locked destination changes, forgetting and disabling persistence never revive the previous key', async () => {
  const cases = [
    { ...preferences, baseURL: 'https://another-provider.example/v1', rememberKey: true },
    { ...preferences, baseURL: 'https://provider.example/another-path', rememberKey: true },
    { ...preferences, forgetKey: true, rememberKey: true },
    { ...preferences, rememberKey: false },
  ];
  for (const input of cases) {
    const root = await savedCredentialRoot(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    const result = await store.save(input); assert.equal(result.hasKey, false); assert.equal(result.credentialStorage, 'none');
    assert.equal((await readFile(join(root, 'credential.bin'))).length, 0); await assert.rejects(store.ensureCredential());
    await store.save({ ...preferences, rememberKey: true }); await assert.rejects(store.ensureCredential());
    assert.equal(store.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [0, 0, 0]);
    const restartedCipher = fakeCipher(); const restarted = new ProviderSettingsStore(root, restartedCipher); await restarted.initialize();
    await assert.rejects(restarted.ensureCredential()); assert.equal(restarted.publicSettings().credentialStorage, 'none'); assert.deepEqual(cipherCounts(restartedCipher), [0, 0, 0]);
  }
});

test('missing, malformed and unsupported configuration cannot bind locked ciphertext through default fallback', async () => {
  const configs = [undefined, 'not valid [toml', 'schema_version = 99\nbase_url = "' + DEFAULT_PROVIDER.baseURL + '"\nmodel_id = "' + DEFAULT_PROVIDER.modelID + '"\n'];
  for (const configuration of configs) {
    const root = await savedCredentialRoot(DEFAULT_PROVIDER); const keyBefore = await readFile(join(root, 'credential.bin'));
    if (configuration === undefined) await unlink(join(root, 'provider.toml')); else await writeFile(join(root, 'provider.toml'), configuration);
    const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    assert.deepEqual(store.publicSettings(), { ...DEFAULT_PROVIDER, hasKey: false, credentialStorage: 'locked' });
    await assert.rejects(store.ensureCredential(), /有效配置无法关联/); assert.deepEqual(cipherCounts(cipher), [0, 0, 0]);
    assert.equal(store.snapshot().credential, undefined); assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore);
    if (configuration !== undefined) assert.equal(await readFile(join(root, 'provider.toml'), 'utf8'), configuration);
  }
});

test('unavailable or throwing cipher credential loads remain locked with sanitized errors and unchanged files', async () => {
  for (const failure of ['unavailable', 'availability-throw', 'decrypt-throw']) {
    const root = await savedCredentialRoot(); const keyBefore = await readFile(join(root, 'credential.bin')); const configBefore = await readFile(join(root, 'provider.toml'));
    const cipher = fakeCipher(failure !== 'unavailable');
    if (failure === 'availability-throw') cipher.available = function () { this.availabilityChecks += 1; throw new Error(secret); };
    if (failure === 'decrypt-throw') cipher.decrypt = function () { this.decryptions += 1; throw new Error(secret); };
    const store = new ProviderSettingsStore(root, cipher); await store.initialize(); assert.deepEqual(cipherCounts(cipher), [0, 0, 0]);
    await assert.rejects(store.ensureCredential(), error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(secret), false); assert.match(error.message, /未能读取/); return true; });
    assert.equal(store.publicSettings().credentialStorage, 'locked'); assert.equal(store.publicSettings().hasKey, false); assert.equal(store.snapshot().credential, undefined);
    assert.equal(JSON.stringify(store.diagnostics).includes(secret), false);
    assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
  }
});

test('credential load rejects malformed, mismatched and extra-field encrypted envelopes without changing files', async () => {
  const envelopes = ['not json', 'null', '[]', JSON.stringify({ baseURL: preferences.baseURL, key: '' }), JSON.stringify({ baseURL: preferences.baseURL, key: 'bad\nkey' }), JSON.stringify({ baseURL: 'https://another-provider.example/v1', key: secret }), JSON.stringify({ baseURL: preferences.baseURL, key: secret, extra: true })];
  for (const envelope of envelopes) {
    const root = await savedCredentialRoot(); const bytes = fakeCipher().encrypt(envelope); await writeFile(join(root, 'credential.bin'), bytes);
    const store = new ProviderSettingsStore(root, fakeCipher()); await store.initialize(); await assert.rejects(store.ensureCredential(), /未能读取/);
    assert.equal(store.publicSettings().credentialStorage, 'locked'); assert.equal(store.snapshot().credential, undefined); assert.deepEqual(await readFile(join(root, 'credential.bin')), bytes);
  }
});

test('credential load rejects external config or credential edits during decryption and never adopts the changed CAS baseline', async () => {
  for (const fileName of ['provider.toml', 'credential.bin']) {
    const root = await savedCredentialRoot(); const cipher = fakeCipher(); const decrypt = cipher.decrypt;
    const external = fileName === 'provider.toml' ? Buffer.from('schema_version = 1\nbase_url = "https://external.example/v1"\nmodel_id = "external-model"\n') : fakeCipher().encrypt(JSON.stringify({ baseURL: preferences.baseURL, key: 'external-fixture-key' }));
    cipher.decrypt = function (bytes) { const plaintext = decrypt.call(this, bytes); writeFileSync(join(root, fileName), external); return plaintext; };
    const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    await assert.rejects(store.ensureCredential(), /外部修改/); assert.equal(store.publicSettings().credentialStorage, 'locked'); assert.equal(store.snapshot().credential, undefined);
    assert.deepEqual(await readFile(join(root, fileName)), external); assert.deepEqual(cipherCounts(cipher), [1, 0, 1]);
    await assert.rejects(store.ensureCredential(), /外部修改/); await assert.rejects(store.save({ ...preferences, modelID: 'local-model', rememberKey: true }), /外部修改/);
    assert.deepEqual(cipherCounts(cipher), [1, 0, 1]); assert.deepEqual(await readFile(join(root, fileName)), external);
  }
});

test('concurrent repeated credential loads are idempotent and do not rewrite preferences or credentials', async () => {
  const root = await savedCredentialRoot(); const keyBefore = await readFile(join(root, 'credential.bin')); const configBefore = await readFile(join(root, 'provider.toml'));
  const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  const results = await Promise.all([store.ensureCredential(), store.ensureCredential(), store.ensureCredential()]); await store.flush();
  for (const result of results) { assert.deepEqual(result, { ...preferences, hasKey: true, credentialStorage: 'encrypted' }); assert.equal(JSON.stringify(result).includes(secret), false); }
  await store.ensureCredential(); assert.deepEqual(cipherCounts(cipher), [1, 0, 1]);
  assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
});

test('credential load and destination saves run in caller order without reviving cleared ciphertext', async () => {
  const newPreferences = { baseURL: 'https://another-provider.example/v1', modelID: 'new-model', rememberKey: true };
  for (const loadFirst of [true, false]) {
    const root = await savedCredentialRoot(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
    const results = await Promise.allSettled(loadFirst ? [store.ensureCredential(), store.save(newPreferences)] : [store.save(newPreferences), store.ensureCredential()]);
    assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, loadFirst ? 'fulfilled' : 'rejected');
    await store.flush(); assert.equal(store.snapshot().baseURL, newPreferences.baseURL); assert.equal(store.snapshot().credential, undefined);
    assert.equal(store.publicSettings().credentialStorage, 'none'); assert.equal((await readFile(join(root, 'credential.bin'))).length, 0);
    await store.save({ ...preferences, rememberKey: true }); await assert.rejects(store.ensureCredential()); assert.deepEqual(cipherCounts(cipher), loadFirst ? [1, 0, 1] : [0, 0, 0]);
  }
});

test('a queued memory-only replacement never loads or restores the previous persisted key', async () => {
  const root = await savedCredentialRoot(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  const replacement = 'replacement-fixture-only-key';
  const results = await Promise.all([store.save({ ...preferences, apiKey: replacement, rememberKey: false }), store.ensureCredential()]);
  for (const result of results) { assert.equal(result.credentialStorage, 'memory'); assert.equal(result.hasKey, true); assert.equal(JSON.stringify(result).includes(replacement), false); }
  assert.equal(store.snapshot().credential, replacement); assert.equal((await readFile(join(root, 'credential.bin'))).length, 0); assert.deepEqual(cipherCounts(cipher), [0, 0, 0]);
  const restarted = new ProviderSettingsStore(root, fakeCipher()); await restarted.initialize(); await assert.rejects(restarted.ensureCredential()); assert.equal(restarted.snapshot().credential, undefined);
});

test('configuration rename failure after credential replacement invalidates credential loading in this process', async () => {
  const root = await savedCredentialRoot(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  const originalConfig = await readFile(join(root, 'provider.toml')); const originalKey = await readFile(join(root, 'credential.bin'));
  const originalRename = fileOperations.rename;
  // The serial node:test process owns this temporary fault hook; always restore it.
  fileOperations.rename = async (from, to) => { if (to === join(root, 'provider.toml')) throw new Error('fixture config rename failure'); return originalRename(from, to); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.save({ ...preferences, modelID: 'attempted-model', apiKey: 'new-fixed-fixture-key', rememberKey: true }), { code: 'settings-write' });
  } finally { fileOperations.rename = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'none' });
  assert.equal(store.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [1, 1, 0]);
  await assert.rejects(store.ensureCredential(), /有效配置无法关联/); await assert.rejects(store.ensureCredential(), /有效配置无法关联/); await store.flush();
  assert.equal(store.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [1, 1, 0]);
  // Each file is atomic, but the pair is not a transaction: the new ciphertext can remain.
  assert.deepEqual(await readFile(join(root, 'provider.toml')), originalConfig); assert.notDeepEqual(await readFile(join(root, 'credential.bin')), originalKey);
});

test('settings lock release failure after both replacements invalidates credential loading in this process', async () => {
  const root = await savedCredentialRoot(); const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher); await store.initialize();
  const originalConfig = await readFile(join(root, 'provider.toml')); const originalKey = await readFile(join(root, 'credential.bin'));
  const originalUnlink = fileOperations.unlink;
  fileOperations.unlink = async file => { if (file === join(root, 'settings.lock')) throw new Error('fixture lock release failure'); return originalUnlink(file); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.save({ ...preferences, modelID: 'attempted-model', apiKey: 'new-fixed-fixture-key', rememberKey: true }), { code: 'lock-cleanup' });
  } finally { fileOperations.unlink = originalUnlink; syncBuiltinESMExports(); }
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'none' });
  assert.equal(store.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [1, 1, 0]);
  await assert.rejects(store.ensureCredential(), /有效配置无法关联/); await assert.rejects(store.ensureCredential(), /有效配置无法关联/); await store.flush();
  assert.equal(store.snapshot().credential, undefined); assert.deepEqual(cipherCounts(cipher), [1, 1, 0]);
  assert.notDeepEqual(await readFile(join(root, 'provider.toml')), originalConfig); assert.notDeepEqual(await readFile(join(root, 'credential.bin')), originalKey);
  assert.equal((await readdir(root)).includes('settings.lock'), true);
});

test('provider validation rejects credentials, queries, fragments and non-HTTPS destinations', () => {
  for (const baseURL of ['http://provider.example/v1', 'https://user:pass@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#fragment', 'file:///private/secret', 'not-a-url']) assert.throws(() => validateProvider(baseURL, 'model'));
  for (const invalid of ['', 'line\nbreak', 'x'.repeat(201), null]) assert.throws(() => validateProvider(preferences.baseURL, invalid));
  assert.deepEqual(validateProvider('https://PROVIDER.example/v1///', ' model '), { ...preferences, modelID: 'model' });
});

test('symlinked credential files fail closed before cipher decryption', async () => {
  const root = await temp(); const target = join(await temp(), 'not-a-real-secret'); await writeFile(target, 'fixture'); await symlink(target, join(root, 'credential.bin'));
  const cipher = fakeCipher(); const store = new ProviderSettingsStore(root, cipher);
  await assert.rejects(store.initialize(), /安全读取/); assert.equal(cipher.decryptions, 0); assert.equal(store.publicSettings().hasKey, false);
});

test('local drafts use fixed hashed paths, survive restart, and reject malformed or oversized data', async () => {
  const root = await temp(); const state = new LocalState(root); const name = 'draft:../../outside';
  assert.deepEqual(await state.read(name, { text: '' }), { text: '' }); await state.write(name, { text: 'Local draft' }); await state.flush();
  const files = await readdir(root); const expected = `${createHash('sha256').update(name).digest('hex')}.json`;
  assert.deepEqual(files, [expected]); assert.deepEqual(await new LocalState(root).read(name, { text: '' }), { text: 'Local draft' });
  await assert.rejects(state.write('too-large', { text: 'x'.repeat(300 * 1024) }), /容量/);
  await writeFile(join(root, expected), '{bad json'); await assert.rejects(state.read(name, { text: '' }), /原记录未覆盖/); assert.equal(await readFile(join(root, expected), 'utf8'), '{bad json');
});

test('IPC validators bound text in bytes and reject unknown payload fields and unsafe IDs', () => {
  assert.deepEqual(payload({ text: 'ok' }, ['text']), { text: 'ok' });
  for (const value of [null, [], { text: 'ok', extra: true }, 'string']) assert.throws(() => payload(value, ['text']));
  assert.equal(textInput('你好', 6), '你好'); assert.throws(() => textInput('你好', 5)); assert.throws(() => textInput('a\0b'));
  assert.equal(uuidInput('abcdef00-0000-0000-0000-000000000000'), 'abcdef00-0000-0000-0000-000000000000');
  for (const value of ['../../data', 'ABCDEF00-0000-0000-0000-000000000000', 'missing', null]) assert.throws(() => uuidInput(value));
});

test('only the packaged top-level workbench origin is a trusted IPC URL', () => {
  assert.equal(isTrustedURL('screendeck-app://workbench/index.html'), true);
  assert.equal(isTrustedURL('screendeck-app://workbench/index.html?deck=1&sessionID=abcdef00-0000-0000-0000-000000000000'), true);
  for (const value of ['https://workbench/index.html', 'file:///index.html', 'screendeck-app://external/index.html', 'screendeck-app://workbench/assets/main.js', 'screendeck-app://user:pass@workbench/index.html', 'screendeck-app://workbench:123/index.html', 'javascript:alert(1)']) assert.equal(isTrustedURL(value), false);
});

test('conflicting public preferences preserve both config and encrypted credential originals', async () => {
  const root = await temp(); const store = new ProviderSettingsStore(root, fakeCipher()); await store.initialize(); await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  const keyBefore = await readFile(join(root, 'credential.bin'));
  const external = 'schema_version = 1\nbase_url = "https://external.example/v1"\nmodel_id = "externally-edited-model"\n'; await writeFile(join(root, 'provider.toml'), external);
  await assert.rejects(store.save({ ...preferences, apiKey: 'new-fixture-key', rememberKey: true }));
  assert.equal(await readFile(join(root, 'provider.toml'), 'utf8'), external); assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore);
});

test('local draft CAS rejects an external edit after an observed read', async () => {
  const root = await temp(); const state = new LocalState(root); await state.write('draft:one', { text: 'Original' });
  await state.read('draft:one', { text: '' });
  const file = join(root, `${createHash('sha256').update('draft:one').digest('hex')}.json`); const external = JSON.stringify({ text: 'External edit' }); await writeFile(file, external);
  await assert.rejects(state.write('draft:one', { text: 'Stale UI text' }), /修改|覆盖/); assert.equal(await readFile(file, 'utf8'), external);
});

test('local drafts enforce total capacity and count before creating another record', async () => {
  const root = await temp(); const maximumRecord = Buffer.from(JSON.stringify({ text: 'x'.repeat(250 * 1024) }));
  for (let index = 0; index < 8; index += 1) await writeFile(join(root, `${createHash('sha256').update(`existing-${index}`).digest('hex')}.json`), maximumRecord);
  await assert.rejects(new LocalState(root).write('new-draft', { text: 'y'.repeat(64 * 1024) }), /总容量/);
  assert.equal((await readdir(root)).filter(name => name.endsWith('.json')).length, 8);
  const countRoot = await temp();
  await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(join(countRoot, `${createHash('sha256').update(`existing-${index}`).digest('hex')}.json`), '{}')));
  await assert.rejects(new LocalState(countRoot).write('another-draft', { text: 'New' }), /份数/);
  assert.equal((await readdir(countRoot)).filter(name => name.endsWith('.json')).length, 1000);
});

test('oversized encrypted credentials fail before replacing either settings file', async () => {
  const root = await temp(); const store = new ProviderSettingsStore(root, fakeCipher()); await store.initialize(); await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  const keyBefore = await readFile(join(root, 'credential.bin')); const configBefore = await readFile(join(root, 'provider.toml'));
  await assert.rejects(store.save({ ...preferences, apiKey: '"'.repeat(8192), rememberKey: true }), /容量/);
  assert.deepEqual(await readFile(join(root, 'credential.bin')), keyBefore); assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
});
