import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecordingStore } from '../../src/main/recording/recording-store.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: { after(fn: () => Promise<void>): void }, ageDays = 0) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screen-source-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RecordingStore(root); await store.initialize();
  const frame = await store.add({ appName: 'Synthetic', bundleID: 'fixture', width: 640, height: 360, displayID: 1, text: 'private OCR' }, Buffer.from([255, 216, 255, 217]), new Date(Date.now() - ageDays * 86400000));
  return { store, frame };
}
for (const kind of ['delete', 'clear', 'prune', 'settings-prune'] as const) test(`production store ${kind} waits until context persistence settles`, async t => {
  const { store, frame } = await fixture(t, kind === 'settings-prune' ? 2 : 0), entered = deferred(), committed = deferred(), order: string[] = [];
  const saving = store.withContextSources([frame.id], async () => {
    entered.resolve(); await committed.promise;
    assert.ok(store.getFrame(frame.id)); assert.ok(await readFile(path.join(store.root, frame.id + '.json')));
    assert.ok(await store.image(frame.id)); order.push('persisted'); return { materialID: 'saved-once' };
  });
  await entered.promise;
  let removed = false; store.onRemoved(() => { removed = true; order.push('removed'); });
  const deletion = kind === 'delete' ? store.delete(frame.id) : kind === 'clear' ? store.clear() : kind === 'prune' ? store.prune(new Date(Date.now() + 10 * 86400000)) : store.saveSettings({ ...store.settings, retentionDays: 1 });
  await new Promise<void>(r => setImmediate(r)); assert.equal(removed, false); assert.ok(store.getFrame(frame.id));
  committed.resolve(); assert.deepEqual(await saving, { materialID: 'saved-once' }); await deletion;
  assert.deepEqual(order, ['persisted', 'removed']); assert.equal(store.getFrame(frame.id), undefined);
});
test('deletion queued first rejects a later lease before persistence', async t => {
  const { store, frame } = await fixture(t); let writes = 0;
  const deletion = store.delete(frame.id), saving = store.withContextSources([frame.id], async () => { writes++; });
  await assert.rejects(saving, /删除或过期/); await deletion; assert.equal(writes, 0);
});
test('failed persistence releases the queue and invalid sources never persist', async t => {
  const { store, frame } = await fixture(t); const entered = deferred(), release = deferred();
  const saving = store.withContextSources([frame.id], async () => { entered.resolve(); await release.promise; throw new Error('CAS conflict'); });
  const rejected = assert.rejects(saving, /CAS conflict/); await entered.promise; const deletion = store.clear(); release.resolve(); await rejected; await deletion;
  let writes = 0; const persist = async () => { writes++; };
  for (const ids of [[], ['../bad'], [frame.id, frame.id], [frame.id]]) await assert.rejects(store.withContextSources(ids, persist));
  assert.equal(writes, 0);
});
test('concurrent leases and capture pruning use one queue and preserve results', async t => {
  const { store, frame } = await fixture(t); const entered = deferred(), release = deferred(), order: string[] = [];
  const first = store.withContextSources([frame.id], async () => { entered.resolve(); await release.promise; order.push('first'); return 1; });
  await entered.promise;
  const second = store.withContextSources([frame.id], async () => { assert.ok(store.getFrame(frame.id)); order.push('second'); return 2; });
  const adding = store.add({ ...frame, text: 'next' }, Buffer.from([255, 216, 255, 217]), new Date(Date.now() + 10 * 86400000));
  release.resolve(); assert.deepEqual(await Promise.all([first, second]), [1, 2]); await adding;
  assert.deepEqual(order, ['first', 'second']); assert.equal(store.getFrame(frame.id), undefined);
});
