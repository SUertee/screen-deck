import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import fileOperations from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ProviderSettingsStore, DEFAULT_PROVIDER, validateProvider } from '../../src/main/provider-settings.js';
import { LocalState } from '../../src/main/local-state.js';
import { isTrustedURL, payload, textInput, uuidInput } from '../../src/main/ipc-validation.js';

async function temp(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), 'screendeck-main-test-'));
}
const secret = 'unit-test-only-secret';
const preferences = { baseURL: 'https://provider.example/v1', modelID: 'test-model' };
async function savedCredentialRoot(provider = preferences): Promise<string> {
  const root = await temp();
  const writer = new ProviderSettingsStore(root);
  await writer.initialize();
  await writer.save({ ...provider, apiKey: secret, rememberKey: true });
  return root;
}
function assertNoSecret(value: unknown): void {
  assert.equal(JSON.stringify(value).includes(secret), false);
}

test('remembered credentials are plaintext owner-only files but never appear in public settings', async () => {
  const root = await temp();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  assert.deepEqual(store.publicSettings(), { ...DEFAULT_PROVIDER, hasKey: false, credentialStorage: 'none' });
  const saved = await store.save({ ...preferences, apiKey: secret, rememberKey: true });
  assert.deepEqual(saved, { ...preferences, hasKey: true, credentialStorage: 'file' });
  assertNoSecret(saved);
  assertNoSecret(store.publicSettings());
  assertNoSecret(store.diagnostics);
  assert.equal((await readFile(join(root, 'provider.toml'), 'utf8')).includes(secret), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'credential.json'), 'utf8')), {
    schema_version: 1, base_url: preferences.baseURL, api_key: secret,
  });
  assert.equal((await lstat(join(root, 'credential.json'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(root, 'provider.toml'))).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp') || name.endsWith('.lock') || name === 'credential.bin'), false);
  const keyBefore = await readFile(join(root, 'credential.json'));
  const configBefore = await readFile(join(root, 'provider.toml'));
  const restarted = new ProviderSettingsStore(root);
  await restarted.initialize();
  assert.deepEqual(restarted.publicSettings(), saved);
  assert.equal((await restarted.prepareRequest()).credential, secret);
  assertNoSecret(restarted.publicSettings());
  assert.deepEqual(await readFile(join(root, 'credential.json')), keyBefore);
  assert.deepEqual(await readFile(join(root, 'provider.toml')), configBefore);
});

test('model-only edits retain a key while endpoint and path changes cannot inherit it', async () => {
  const root = await savedCredentialRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  await store.save({ baseURL: 'https://PROVIDER.example/v1///', modelID: 'another-model', rememberKey: true });
  assert.equal((await store.prepareRequest()).credential, secret);
  assert.equal(store.publicSettings().credentialStorage, 'file');
  for (const baseURL of ['https://provider.example/another-path', 'https://another-provider.example/v1']) {
    await store.save({ ...preferences, apiKey: secret, rememberKey: true });
    await store.save({ ...preferences, baseURL, rememberKey: true });
    assert.equal(store.publicSettings().hasKey, false);
    assert.equal(store.snapshot().credential, undefined);
    assert.equal(JSON.parse(await readFile(join(root, 'credential.json'), 'utf8')), null);
    await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
  }
});

test('a captured submission snapshot stays frozen at its original endpoint, model and key', async () => {
  const store = new ProviderSettingsStore(await savedCredentialRoot());
  await store.initialize();
  const original = await store.prepareRequest();
  await store.save({ baseURL: 'https://another-provider.example/v1', modelID: 'another-model', apiKey: 'different-test-secret', rememberKey: true });
  assert.deepEqual(original, { ...preferences, credential: secret });
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Reflect.set(original, 'credential', 'changed'), false);
  assert.notEqual(store.snapshot().baseURL, original.baseURL);
  assert.notEqual(store.snapshot().credential, original.credential);
});

test('memory-only replacement clears persisted credentials and cannot survive restart', async () => {
  const root = await savedCredentialRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const replacement = 'replacement-fixture-only-key';
  const saved = await store.save({ ...preferences, apiKey: replacement, rememberKey: false });
  assert.deepEqual(saved, { ...preferences, hasKey: true, credentialStorage: 'memory' });
  assert.equal((await store.prepareRequest()).credential, replacement);
  assert.equal(JSON.parse(await readFile(join(root, 'credential.json'), 'utf8')), null);
  assert.equal((await readFile(join(root, 'credential.json'), 'utf8')).includes(replacement), false);
  const restarted = new ProviderSettingsStore(root);
  await restarted.initialize();
  assert.equal(restarted.publicSettings().hasKey, false);
  assert.equal(restarted.publicSettings().credentialStorage, 'none');
  assert.deepEqual(restarted.diagnostics, []);
  await assert.rejects(restarted.prepareRequest(), { code: 'credential-missing' });
});

test('forgetting a key clears both active and remembered credentials even when a key is submitted', async () => {
  const root = await savedCredentialRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  await store.save({ ...preferences, apiKey: 'ignored-fixture-key', forgetKey: true, rememberKey: true });
  assert.deepEqual(store.publicSettings(), { ...preferences, hasKey: false, credentialStorage: 'none' });
  assert.equal(JSON.parse(await readFile(join(root, 'credential.json'), 'utf8')), null);
  await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
  const restarted = new ProviderSettingsStore(root);
  await restarted.initialize();
  assert.equal(restarted.snapshot().credential, undefined);
  assert.deepEqual(restarted.diagnostics, []);
});

test('a saved key cannot bind through missing, malformed or unsupported configuration defaults', async () => {
  const configs = [
    undefined,
    'not valid [toml',
    `schema_version = 99\nbase_url = "${DEFAULT_PROVIDER.baseURL}"\nmodel_id = "${DEFAULT_PROVIDER.modelID}"\n`,
  ];
  for (const configuration of configs) {
    const root = await savedCredentialRoot(DEFAULT_PROVIDER);
    const originalKey = await readFile(join(root, 'credential.json'));
    if (configuration === undefined) await unlink(join(root, 'provider.toml'));
    else await writeFile(join(root, 'provider.toml'), configuration);
    const store = new ProviderSettingsStore(root);
    await store.initialize();
    assert.deepEqual(store.publicSettings(), { ...DEFAULT_PROVIDER, hasKey: false, credentialStorage: 'none' });
    await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
    assert.ok(store.diagnostics.length);
    assertNoSecret(store.diagnostics);
    assert.deepEqual(await readFile(join(root, 'credential.json')), originalKey);
    if (configuration !== undefined) assert.equal(await readFile(join(root, 'provider.toml'), 'utf8'), configuration);
  }
});

test('credential JSON requires an exact versioned record bound to the validated endpoint', async () => {
  const records = [
    `{"api_key":"${secret}"`,
    '[]',
    'false',
    JSON.stringify({ schema_version: 1, base_url: preferences.baseURL, api_key: '' }),
    JSON.stringify({ schema_version: 1, base_url: preferences.baseURL, api_key: `bad\n${secret}` }),
    JSON.stringify({ schema_version: 99, base_url: preferences.baseURL, api_key: secret }),
    JSON.stringify({ schema_version: 1, base_url: 'https://another-provider.example/v1', api_key: secret }),
    JSON.stringify({ schema_version: 1, base_url: preferences.baseURL, api_key: secret, extra: true }),
    JSON.stringify({ schema_version: 1, base_url: preferences.baseURL, api_key: 42 }),
  ];
  for (const record of records) {
    const root = await savedCredentialRoot();
    await writeFile(join(root, 'credential.json'), record);
    const store = new ProviderSettingsStore(root);
    await store.initialize();
    assert.equal(store.publicSettings().credentialStorage, 'none');
    assert.equal(store.snapshot().credential, undefined);
    await assert.rejects(store.prepareRequest(), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      return (error as { code?: string }).code === 'credential-missing';
    });
    assert.ok(store.diagnostics.length);
    assertNoSecret(store.diagnostics);
    assert.equal(await readFile(join(root, 'credential.json'), 'utf8'), record);
    await store.save({ ...preferences, apiKey: secret, rememberKey: true });
    assert.equal((await store.prepareRequest()).credential, secret);
    assert.deepEqual(store.diagnostics, []);
  }
});

test('legacy ciphertext is only detected and is never opened, migrated, deleted or overwritten', async () => {
  const root = await temp();
  const legacyPath = join(root, 'credential.bin');
  const legacyBytes = Buffer.from('legacy-fixture-ciphertext');
  await writeFile(legacyPath, legacyBytes);
  const originalOpen = fileOperations.open;
  let legacyReads = 0;
  fileOperations.open = async (...args: Parameters<typeof fileOperations.open>) => {
    if (args[0] === legacyPath) { legacyReads += 1; throw new Error('legacy files must not be opened'); }
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  const store = new ProviderSettingsStore(root);
  try {
    await store.initialize();
    assert.equal(store.publicSettings().hasKey, false);
    assert.ok(store.diagnostics.some(message => message.includes('旧版')));
    await assert.rejects(store.prepareRequest(), { code: 'credential-missing' });
    await store.save({ ...preferences, apiKey: secret, rememberKey: true });
    assert.equal(legacyReads, 0);
    assert.deepEqual(store.diagnostics, []);
  } finally {
    fileOperations.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(legacyPath), legacyBytes);
  const restarted = new ProviderSettingsStore(root);
  await restarted.initialize();
  assert.equal(restarted.publicSettings().credentialStorage, 'file');
  assert.deepEqual(restarted.diagnostics, []);
  assert.deepEqual(await readFile(legacyPath), legacyBytes);
});

test('legacy symlinks are not followed and explicit empty modern records do not revive old keys', async () => {
  for (const modern of [undefined, '', 'null\n']) {
    const root = await temp();
    const target = join(await temp(), 'legacy-fixture-only');
    await writeFile(target, 'legacy-target-must-stay-unchanged');
    await symlink(target, join(root, 'credential.bin'));
    if (modern !== undefined) await writeFile(join(root, 'credential.json'), modern);
    const store = new ProviderSettingsStore(root);
    await store.initialize();
    assert.equal(store.publicSettings().hasKey, false);
    assert.equal(store.diagnostics.length, modern === undefined ? 1 : 0);
    assert.equal(await readFile(target, 'utf8'), 'legacy-target-must-stay-unchanged');
    assert.equal((await lstat(join(root, 'credential.bin'))).isSymbolicLink(), true);
  }
});

test('credential and configuration symlinks fail closed without reading their targets', async () => {
  for (const name of ['credential.json', 'provider.toml']) {
    const root = await temp();
    const target = join(await temp(), 'fixture-only');
    await writeFile(target, secret);
    await symlink(target, join(root, name));
    const store = new ProviderSettingsStore(root);
    await assert.rejects(store.initialize(), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      return (error as { code?: string }).code === 'unsafe-file';
    });
    assert.equal(store.publicSettings().hasKey, false);
    assert.equal(await readFile(target, 'utf8'), secret);
  }
});

test('invalid and oversized keys fail without replacing either persisted file or exposing input', async () => {
  const root = await savedCredentialRoot();
  const store = new ProviderSettingsStore(root);
  await store.initialize();
  const originalKey = await readFile(join(root, 'credential.json'));
  const originalConfig = await readFile(join(root, 'provider.toml'));
  for (const apiKey of [' ', `line\n${secret}`, `null\0${secret}`, 'x'.repeat(8193), '"'.repeat(8192)]) {
    await assert.rejects(store.save({ ...preferences, apiKey, rememberKey: true }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      assert.ok(['settings-invalid', 'too-large'].includes((error as { code?: string }).code ?? ''));
      return true;
    });
    assert.deepEqual(await readFile(join(root, 'credential.json')), originalKey);
    assert.deepEqual(await readFile(join(root, 'provider.toml')), originalConfig);
  }
  assert.equal((await store.prepareRequest()).credential, secret);
});

test('provider validation rejects credentials, queries, fragments and non-HTTPS destinations', () => {
  for (const baseURL of ['http://provider.example/v1', 'https://user:pass@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#fragment', 'file:///private/secret', 'not-a-url']) assert.throws(() => validateProvider(baseURL, 'model'));
  for (const invalid of ['', 'line\nbreak', 'x'.repeat(201), null]) assert.throws(() => validateProvider(preferences.baseURL, invalid));
  assert.deepEqual(validateProvider('https://PROVIDER.example/v1///', ' model '), { ...preferences, modelID: 'model' });
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
