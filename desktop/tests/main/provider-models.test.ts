import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProviderModelsService } from '../../src/main/provider-models.js';
import { ProviderSettingsStore } from '../../src/main/provider-settings.js';
import { LocalState } from '../../src/main/local-state.js';
import type { ProviderModelCatalog, ProviderModelsResult } from '../../src/shared/desktop-api.js';

const provider = { baseURL: 'https://models-fixture.invalid/v1', modelID: 'original-model' };
const key = 'provider-model-catalog-synthetic-secret';
const alternate = { baseURL: 'https://other-models-fixture.invalid/v1', apiKey: 'alternate-catalog-synthetic-secret' };
const cacheName = createHash('sha256').update('provider-models').digest('hex') + '.json';
function gate() {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { started, release, async wait() { entered(); await held; } };
}
async function fixture(t: TestContext, query?: (input: { baseURL: string; credential: string }) => Promise<ProviderModelsResult>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-provider-models-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = new ProviderSettingsStore(root); await settings.initialize();
  await settings.save({ ...provider, apiKey: key, rememberKey: true });
  const local = new LocalState(join(root, 'local'));
  const calls: Array<{ baseURL: string; credential: string }> = [];
  const service = new ProviderModelsService(settings, local, { listModels: async input => {
    calls.push({ ...input }); return query ? query(input) : { kind: 'available', modelIDs: ['model-a', 'model-b'] };
  } });
  const seed = async (catalog: ProviderModelCatalog) => { await local.read('provider-models', undefined); await local.write('provider-models', catalog); };
  const save = async (input: Parameters<ProviderSettingsStore['save']>[0]) => {
    const previous = settings.snapshot(), generation = settings.generation;
    const result = await settings.save(input, generation);
    await service.afterSave(previous, settings.snapshot(), generation);
    return result;
  };
  return { root, settings, local, calls, service, seed, save, cacheFile: join(root, 'local', cacheName) };
}

test('get reads cloned URL-bound saved suggestions without HTTP or changing either provider file', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['model-a'] });
  const paths = ['provider.toml', 'credential.json'].map(name => join(h.root, name));
  const before = await Promise.all(paths.map(file => readFile(file)));
  const catalog = await h.service.get();
  assert.deepEqual(catalog, { baseURL: provider.baseURL, modelIDs: ['model-a'] });
  catalog.modelIDs.push('caller-mutation');
  assert.deepEqual((await h.service.get()).modelIDs, ['model-a']);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(file))), before);
  await h.seed({ baseURL: alternate.baseURL, modelIDs: ['other-model'] });
  assert.deepEqual(await h.service.get(), { baseURL: provider.baseURL, modelIDs: [] });
  assert.equal(h.calls.length, 0);
});

test('a draft query does not save settings or cache, and only its matching saved connection promotes the list', async t => {
  const h = await fixture(t);
  const original = h.settings.snapshot();
  const before = await readFile(join(h.root, 'credential.json'));
  const result = await h.service.list(alternate);
  assert.deepEqual(result, { kind: 'available', modelIDs: ['model-a', 'model-b'] });
  assert.deepEqual(h.calls, [{ baseURL: alternate.baseURL, credential: alternate.apiKey }]);
  assert.deepEqual(h.settings.snapshot(), original);
  assert.deepEqual(await readFile(join(h.root, 'credential.json')), before);
  await assert.rejects(readFile(h.cacheFile), { code: 'ENOENT' });
  if (result.kind === 'available') result.modelIDs[0] = 'caller-mutation';
  await h.save({ ...alternate, modelID: 'model-a', rememberKey: true });
  const cached = { baseURL: alternate.baseURL, modelIDs: ['model-a', 'model-b'] };
  assert.deepEqual(await h.service.get(), cached);
  const persisted = await readFile(h.cacheFile, 'utf8');
  assert.deepEqual(JSON.parse(persisted), cached);
  assert.equal(persisted.includes(key) || persisted.includes(alternate.apiKey), false);
  const restarted = new ProviderSettingsStore(h.root); await restarted.initialize();
  const restored = new ProviderModelsService(restarted, new LocalState(join(h.root, 'local')), { listModels: async () => assert.fail('Cache reads cannot make a request.') });
  assert.deepEqual(await restored.get(), cached);
});

test('unsupported endpoints and rejected or secret-bearing results do not replace saved suggestions', async t => {
  let response: ProviderModelsResult | Error = { kind: 'unsupported' };
  const h = await fixture(t, async () => { if (response instanceof Error) throw response; return response; });
  const cached = { baseURL: provider.baseURL, modelIDs: ['saved-model'] };
  await h.seed(cached);
  assert.deepEqual(await h.service.list({ baseURL: provider.baseURL }), { kind: 'unsupported' });
  response = new Error(`untrusted error containing ${key}`);
  await assert.rejects(h.service.list({ baseURL: provider.baseURL }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes(key), false); return true;
  });
  response = { kind: 'available', modelIDs: [key] };
  await assert.rejects(h.service.list({ baseURL: provider.baseURL }), /返回格式无效/);
  response = { kind: 'available', modelIDs: [' model-a '] };
  await assert.rejects(h.service.list({ baseURL: provider.baseURL }), /返回格式无效/);
  assert.deepEqual(await h.service.get(), cached);
  assert.equal((await readFile(h.cacheFile, 'utf8')).includes(key), false);
});

test('configuration changes during a query reject its late response and prevent promotion', async t => {
  const held = gate();
  const h = await fixture(t, async () => { await held.wait(); return { kind: 'available', modelIDs: ['stale-model'] }; });
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['saved-model'] });
  const pending = h.service.list({ baseURL: provider.baseURL });
  const rejected = assert.rejects(pending, { code: 'provider-models-stale' });
  await held.started;
  await h.save({ ...alternate, modelID: 'alternate-model', rememberKey: true });
  held.release(); await rejected;
  assert.deepEqual(await h.service.get(), { baseURL: alternate.baseURL, modelIDs: [] });
});

test('an earlier query cannot overwrite the result of a later explicit query', async t => {
  const held = gate(); let requests = 0;
  const h = await fixture(t, async () => {
    requests++;
    if (requests === 1) { await held.wait(); return { kind: 'available', modelIDs: ['older-model'] }; }
    return { kind: 'available', modelIDs: ['newer-model'] };
  });
  const earlier = h.service.list({ baseURL: provider.baseURL });
  const rejected = assert.rejects(earlier, { code: 'provider-models-stale' });
  await held.started;
  assert.deepEqual(await h.service.list({ baseURL: provider.baseURL }), { kind: 'available', modelIDs: ['newer-model'] });
  held.release(); await rejected;
  await h.save({ ...provider, rememberKey: true });
  assert.deepEqual((await h.service.get()).modelIDs, ['newer-model']);
});

test('a changed key invalidates old suggestions and a pending list from an earlier generation cannot be reused', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['saved-model'] });
  await h.service.list({ baseURL: provider.baseURL });
  await h.save({ ...provider, apiKey: alternate.apiKey, rememberKey: true });
  assert.deepEqual((await h.service.get()).modelIDs, []);
  await h.service.list({ baseURL: provider.baseURL });
  await h.settings.save({ ...provider, apiKey: key, rememberKey: true });
  await h.settings.save({ ...provider, apiKey: alternate.apiKey, rememberKey: true });
  await h.save({ ...provider, modelID: 'edited-model', rememberKey: true });
  assert.deepEqual((await h.service.get()).modelIDs, [], 'Identical restored destination/key cannot reuse a query from an older settings generation.');
});

test('model selection accepts only saved suggestions or the current model and never queries the provider', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['model-a'] });
  const before = await readFile(join(h.root, 'provider.toml'));
  await assert.rejects(h.service.select('not-in-catalog'), { code: 'provider-models-selection' });
  assert.deepEqual(await readFile(join(h.root, 'provider.toml')), before);
  assert.deepEqual(await h.service.select('model-a'), { ...provider, modelID: 'model-a', hasKey: true, credentialStorage: 'file' });
  assert.deepEqual((await h.service.get()).modelIDs, ['model-a']);
  await h.seed({ baseURL: provider.baseURL, modelIDs: [] });
  assert.equal((await h.service.select('model-a')).modelID, 'model-a');
  assert.equal(h.calls.length, 0);
});

test('a queued connection change cannot be silently reverted by selecting from the previous catalog', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['model-a'] });
  const held = gate();
  const blocker = h.settings.prepareRequest(() => held.wait()); await held.started;
  const changing = h.settings.save({ ...alternate, modelID: 'alternate-model', rememberKey: true });
  const selecting = h.service.select('model-a');
  const rejected = assert.rejects(selecting, { code: 'settings-changed' });
  await new Promise(resolve => setImmediate(resolve));
  held.release(); await blocker; await changing; await rejected;
  assert.equal(h.settings.publicSettings().baseURL, alternate.baseURL);
  assert.equal(h.settings.publicSettings().modelID, 'alternate-model');
});

test('get rejects a stale read if settings change while the local cache is being read', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['model-a'] });
  const originalRead = h.local.read.bind(h.local), held = gate();
  h.local.read = async <T>(name: string, fallback: T): Promise<T> => { const value = await originalRead(name, fallback); await held.wait(); return value; };
  const pending = h.service.get(); const rejected = assert.rejects(pending, { code: 'provider-models-stale' });
  await held.started;
  await h.settings.save({ ...provider, modelID: 'changed-model', rememberKey: true });
  held.release(); await rejected;
  h.local.read = originalRead;
  assert.equal(h.calls.length, 0);
});

test('cache write failure does not fail a saved connection or revive its old list', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['old-model'] });
  const oldBytes = await readFile(h.cacheFile);
  await h.service.list({ baseURL: provider.baseURL, apiKey: alternate.apiKey });
  const originalWrite = h.local.write.bind(h.local);
  h.local.write = async () => { throw new Error(`private filesystem error ${alternate.apiKey}`); };
  const saved = await h.save({ ...provider, apiKey: alternate.apiKey, rememberKey: true });
  assert.equal(saved.hasKey, true); assert.equal(saved.credentialStorage, 'file');
  assert.deepEqual((await h.service.get()).modelIDs, []);
  assert.equal(h.service.diagnostics.length, 1);
  assert.equal(JSON.stringify(h.service.diagnostics).includes(alternate.apiKey), false);
  assert.deepEqual(await readFile(h.cacheFile), oldBytes);
  h.local.write = originalWrite;
  await h.save({ ...provider, modelID: 'edited-model', rememberKey: true });
  assert.deepEqual(JSON.parse(await readFile(h.cacheFile, 'utf8')), { baseURL: provider.baseURL, modelIDs: [] });
  assert.deepEqual(h.service.diagnostics, []);
});

test('malformed cached records return static errors without leaking their body or writing a replacement', async t => {
  const h = await fixture(t);
  await h.seed({ baseURL: provider.baseURL, modelIDs: ['model-a'] });
  for (const invalid of ['{bad', JSON.stringify({ baseURL: provider.baseURL, modelIDs: [key] }), JSON.stringify({ baseURL: provider.baseURL, modelIDs: ['model-a'], apiKey: key })]) {
    await writeFile(h.cacheFile, invalid);
    await assert.rejects(h.service.get(), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(key), false);
      return 'code' in error && error.code === 'provider-models-cache';
    });
    assert.equal(await readFile(h.cacheFile, 'utf8'), invalid);
  }
  assert.equal(h.calls.length, 0);
  await h.service.list({ baseURL: provider.baseURL });
  await h.save({ ...provider, rememberKey: true });
  assert.deepEqual((await h.service.get()).modelIDs, ['model-a', 'model-b']);
  assert.equal((await readFile(h.cacheFile, 'utf8')).includes(key), false);
});
