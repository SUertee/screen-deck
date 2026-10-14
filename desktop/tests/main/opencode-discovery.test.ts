import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenCodeDiscovery } from '../../src/main/opencode-discovery.js';
import { LocalState } from '../../src/main/local-state.js';
import { StorageError } from '../../src/core/private-storage.js';

const key = 'opencode-binary';
class MemoryLocal {
  record: unknown = undefined;
  reads = 0;
  writes = 0;
  failRead = false;
  failWrite = false;
  async read<T>(name: string, fallback: T): Promise<T> {
    assert.equal(name, key);
    this.reads += 1;
    if (this.failRead) throw new Error('fixture-only-private-error');
    return structuredClone(this.record === undefined ? fallback : this.record) as T;
  }
  async write(name: string, value: unknown): Promise<void> {
    assert.equal(name, key);
    this.writes += 1;
    if (this.failWrite) throw new Error('fixture-only-private-error');
    this.record = structuredClone(value);
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'screendeck-opencode-discovery-test-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const local = new MemoryLocal();
  const build = (searchPath = '', standardDirectories: string[] = []) => new OpenCodeDiscovery(local, { home, searchPath, standardDirectories });
  // The shell marker proves discovery never executes even an executable candidate.
  const binary = async (directory: string, name = 'opencode') => {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    await writeFile(file, `#!/bin/sh\nprintf executed > '${root}/executed-marker'\nexit 90\n`, { mode: 0o700 });
    return file;
  };
  const noExecution = async () => {
    await assert.rejects(lstat(path.join(root, 'executed-marker')), { code: 'ENOENT' });
  };
  return { root, home, local, build, binary, noExecution };
}
const remembered = (binaryPath: string) => ({ schema_version: 1, kind: 'opencode_binary_location', binaryPath });

test('metadata-only discovery finds an executable in absolute PATH and returns a stable opaque ID', async () => {
  const h = await fixture();
  const file = await h.binary(path.join(h.root, 'path-bin'));
  const discovery = h.build(path.dirname(file));
  const found = await discovery.discover();
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0]?.source, 'path');
  assert.equal(found.candidates[0]?.path, await realpath(file));
  assert.match(found.candidates[0]!.id, /^[a-f0-9]{64}$/);
  assert.equal(found.preferredID, found.candidates[0]?.id);
  assert.deepEqual(await discovery.discover(), found);
  assert.equal(await discovery.resolve(found.preferredID), await realpath(file));
  assert.equal(await discovery.resolve(), await realpath(file));
  assert.equal(h.local.writes, 0);
  await h.noExecution();
});

test('explicit finite standard directories supplement PATH without recursively finding other files', async () => {
  const h = await fixture();
  const standard = path.join(h.home, '.opencode', 'bin');
  const file = await h.binary(standard);
  await h.binary(path.join(standard, 'nested'));
  await h.binary(path.join(h.root, 'elsewhere'));
  const discovery = h.build('', [standard]);
  const found = await discovery.discover();
  assert.deepEqual(found.candidates.map(value => ({ path: value.path, source: value.source })), [{ path: await realpath(file), source: 'standard' }]);
  await h.noExecution();
});

test('empty, relative, control-character PATH entries never scan the current working directory', async () => {
  const h = await fixture();
  const valid = path.join(h.root, 'valid');
  const file = await h.binary(valid);
  const discovery = h.build(['', '.', './node_modules/.bin', 'relative', `${valid}\n`, valid, ''].join(path.delimiter));
  assert.deepEqual((await discovery.discover()).candidates.map(value => value.path), [await realpath(file)]);
  assert.deepEqual(await h.build([ '', '.', './node_modules/.bin' ].join(path.delimiter)).discover(), { candidates: [] });
  await h.noExecution();
});

test('remembered location wins on a fresh instance; stale remembered path falls through without rewriting it', async () => {
  const h = await fixture();
  const old = await h.binary(path.join(h.root, 'remembered'));
  const other = await h.binary(path.join(h.root, 'path-bin'));
  h.local.record = remembered(old);
  const discovery = h.build(path.dirname(other));
  const found = await discovery.discover();
  assert.deepEqual(found.candidates.map(value => value.source), ['remembered', 'path']);
  assert.equal(found.preferredID, found.candidates[0]?.id);
  assert.equal(await discovery.resolve(), old);
  const original = structuredClone(h.local.record);
  await unlink(old);
  const fallback = await discovery.discover();
  assert.equal(fallback.candidates.length, 1);
  assert.equal(fallback.candidates[0]?.path, other);
  assert.equal(fallback.preferredID, fallback.candidates[0]?.id);
  assert.deepEqual(h.local.record, original);
  assert.equal(h.local.writes, 0);
});

test('manual selection is transient; only explicit success remembrance writes the strict non-secret record', async () => {
  const h = await fixture();
  const first = await h.binary(path.join(h.root, 'first'));
  const second = await h.binary(path.join(h.root, 'second'));
  h.local.record = remembered(first);
  const discovery = h.build();
  const selected = await discovery.choose(second);
  assert.equal(selected.source, 'manual');
  assert.equal(h.local.writes, 0);
  const found = await discovery.discover();
  assert.equal(found.preferredID, selected.id);
  assert.equal(await discovery.resolve(), second);
  await discovery.remember(second);
  assert.equal(h.local.writes, 1);
  assert.deepEqual(h.local.record, remembered(second));
  assert.deepEqual(Object.keys(h.local.record as object).sort(), ['binaryPath', 'kind', 'schema_version']);
  const fresh = await h.build().discover();
  assert.equal(fresh.candidates[0]?.source, 'remembered');
  assert.equal(fresh.candidates[0]?.path, second);
  await h.noExecution();
});

test('symlink aliases deduplicate into one canonical ordinary executable for strict Runtime handoff', async () => {
  const h = await fixture();
  const target = await h.binary(path.join(h.root, 'native'));
  const one = path.join(h.root, 'one'); const two = path.join(h.root, 'two');
  await mkdir(one); await mkdir(two);
  await symlink(target, path.join(one, 'opencode'));
  await symlink(target, path.join(two, 'opencode'));
  const discovery = h.build([one, two, path.dirname(target)].join(path.delimiter), [one]);
  const found = await discovery.discover();
  assert.equal(found.candidates.length, 1);
  const resolved = await discovery.resolve(found.candidates[0]!.id);
  assert.equal(resolved, await realpath(target));
  assert.equal((await lstat(resolved)).isSymbolicLink(), false);
  const chosen = await discovery.choose(path.join(two, 'opencode'));
  assert.equal(chosen.id, found.candidates[0]?.id);
  await h.noExecution();
});

test('multiple candidates require an explicit ID or confirmed preference; IDs cannot supply arbitrary paths', async () => {
  const h = await fixture();
  const first = await h.binary(path.join(h.root, 'first'));
  const second = await h.binary(path.join(h.root, 'second'));
  const discovery = h.build([path.dirname(first), path.dirname(second)].join(path.delimiter));
  const found = await discovery.discover();
  assert.equal(found.candidates.length, 2);
  assert.equal(found.preferredID, undefined);
  await assert.rejects(discovery.resolve(), error => error instanceof StorageError && error.code === 'discovery-ambiguous');
  assert.equal(await discovery.resolve(found.candidates[1]!.id), second);
  for (const id of ['../binary', first, 'x'.repeat(64), 'f'.repeat(64), '', undefined]) {
    await assert.rejects(discovery.resolve(id));
  }
  assert.equal(h.local.writes, 0);
  await h.noExecution();
});

test('missing candidate remains stopped metadata and resolution gives an actionable manual fallback', async () => {
  const h = await fixture();
  const discovery = h.build(path.join(h.root, 'absent'));
  assert.deepEqual(await discovery.discover(), { candidates: [] });
  await assert.rejects(discovery.resolve(), /未找到.*手动选择/);
  await assert.rejects(discovery.choose(path.join(h.root, 'absent', 'opencode')), /不是可用/);
  assert.equal(h.local.writes, 0);
  await h.noExecution();
});

test('changed symlink targets cannot retarget an already selected renderer ID', async () => {
  const h = await fixture();
  const first = await h.binary(path.join(h.root, 'first'));
  const second = await h.binary(path.join(h.root, 'second'));
  const alias = path.join(h.root, 'selected-opencode');
  await symlink(first, alias);
  const discovery = h.build();
  const chosen = await discovery.choose(alias);
  assert.equal(await discovery.resolve(chosen.id), first);
  await unlink(alias); await symlink(second, alias);
  await assert.rejects(discovery.resolve(chosen.id), error => error instanceof StorageError && error.code === 'discovery-changed');
  assert.deepEqual(await discovery.discover(), { candidates: [] });
  const selectedAgain = await discovery.choose(alias);
  assert.notEqual(selectedAgain.id, chosen.id);
  assert.equal(await discovery.resolve(selectedAgain.id), second);
  await h.noExecution();
});

test('replacement at the same canonical pathname invalidates the old ID', async () => {
  const h = await fixture();
  const file = await h.binary(path.join(h.root, 'bin'));
  const discovery = h.build(path.dirname(file));
  const found = await discovery.discover();
  const replacement = await h.binary(path.join(h.root, 'replacement'));
  await rename(replacement, file);
  await assert.rejects(discovery.resolve(found.candidates[0]!.id), error => error instanceof StorageError && error.code === 'discovery-changed');
  const fresh = await discovery.discover();
  assert.notEqual(fresh.candidates[0]?.id, found.candidates[0]?.id);
  await h.noExecution();
});

test('directories, non-executable files, broken links and control-character choices are excluded', async () => {
  const h = await fixture();
  const nonExecutable = await h.binary(path.join(h.root, 'not-executable'));
  await chmod(nonExecutable, 0o600);
  const directory = path.join(h.root, 'directory');
  await mkdir(path.join(directory, 'opencode'), { recursive: true });
  const broken = path.join(h.root, 'broken'); await mkdir(broken);
  await symlink(path.join(h.root, 'missing-target'), path.join(broken, 'opencode'));
  const discovery = h.build([path.dirname(nonExecutable), directory, broken].join(path.delimiter));
  assert.deepEqual(await discovery.discover(), { candidates: [] });
  for (const file of [nonExecutable, path.join(directory, 'opencode'), 'relative/opencode', `${h.root}/bad\nname`, `${h.root}/bad\0name`]) await assert.rejects(discovery.choose(file));
  await h.noExecution();
});

test('future, malformed, extra-field and unsafe remembered records are rejected without overwriting them', async () => {
  const h = await fixture();
  const file = await h.binary(path.join(h.root, 'binary'));
  const discovery = h.build(path.dirname(file));
  for (const record of [null, [], 'path', {}, { ...remembered(file), schema_version: 2 }, { ...remembered(file), kind: 'other' }, { ...remembered(file), credential: 'fixture-only-must-not-store' }, remembered('relative'), remembered(`${h.root}/x/../binary/opencode`), remembered(`${h.root}/bad\nname`)]) {
    h.local.record = structuredClone(record);
    await assert.rejects(discovery.discover(), error => error instanceof StorageError && error.code === 'discovery-state' && !error.message.includes('fixture-only'));
    await assert.rejects(discovery.remember(file), /未覆盖原记录/);
    assert.deepEqual(h.local.record, record);
    assert.equal(h.local.writes, 0);
  }
});

test('private LocalState symlinks and malformed on-disk record bytes fail closed and remain untouched', async () => {
  const h = await fixture();
  const file = await h.binary(path.join(h.root, 'binary'));
  const stateRoot = path.join(h.root, 'local-state');
  const local = new LocalState(stateRoot);
  await local.read(key, undefined);
  await local.write(key, { ...remembered(file), privateUnknown: 'fixture-only-private' });
  const stateFile = path.join(stateRoot, `${createHash('sha256').update(key).digest('hex')}.json`);
  const original = await readFile(stateFile);
  const discovery = new OpenCodeDiscovery(local, { home: h.home, searchPath: '', standardDirectories: [] });
  await assert.rejects(discovery.discover(), /未覆盖原记录/);
  await assert.rejects(discovery.remember(file), /未覆盖原记录/);
  assert.deepEqual(await readFile(stateFile), original);
  const symlinkRoot = path.join(h.root, 'linked-state');
  await symlink(stateRoot, symlinkRoot);
  const linked = new OpenCodeDiscovery(new LocalState(symlinkRoot), { home: h.home, searchPath: '', standardDirectories: [] });
  await assert.rejects(linked.discover(), error => error instanceof StorageError && error.code === 'discovery-state');
  await h.noExecution();
});

test('private state errors are sanitized; remember failure does not consume the current manual candidate', async () => {
  const h = await fixture();
  const file = await h.binary(path.join(h.root, 'binary'));
  const discovery = h.build();
  const chosen = await discovery.choose(file);
  h.local.failRead = true;
  await assert.rejects(discovery.resolve(chosen.id), error => error instanceof StorageError && !error.message.includes('fixture-only-private'));
  h.local.failRead = false;
  h.local.failWrite = true;
  await assert.rejects(discovery.remember(file), error => error instanceof StorageError && error.code === 'discovery-save' && !error.message.includes('fixture-only-private'));
  assert.equal(await discovery.resolve(chosen.id), file);
  assert.equal(h.local.record, undefined);
  await h.noExecution();
});

test('search bounds reject oversized lists instead of silently using an incomplete discovery', async () => {
  const h = await fixture();
  const base = { home: h.home, standardDirectories: [] };
  assert.throws(() => new OpenCodeDiscovery(h.local, { ...base, searchPath: 'x'.repeat(64 * 1024 + 1) }), /超过上限/);
  assert.throws(() => new OpenCodeDiscovery(h.local, { ...base, searchPath: Array.from({ length: 129 }, (_, index) => `${h.root}/bin-${index}`).join(path.delimiter) }), /位置过多/);
  assert.throws(() => new OpenCodeDiscovery(h.local, { home: 'relative', searchPath: '', standardDirectories: [] }), /位置无效/);
  assert.throws(() => new OpenCodeDiscovery(h.local, { home: h.home, searchPath: '', standardDirectories: [`${h.root}/bad\nname`] }), /位置无效/);
  assert.equal(h.local.reads, 0);
  assert.equal(h.local.writes, 0);
  await h.noExecution();
});
