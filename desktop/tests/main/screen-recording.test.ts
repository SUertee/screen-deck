import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readdir, writeFile, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { RecordingStore, defaultRecordingSettings } from '../../src/main/recording/recording-store.js';
import { RecordingService, type ScreenCaptureBackend, type CapturedScreen } from '../../src/main/recording/recording-service.js';
import { installRecordingRoutes } from '../../src/main/recording/recording-routes.js';
const frame = { appName: 'Editor', bundleID: 'test.editor', text: '屏幕记录 local keyword', displayID: 1, width: 640, height: 360 };
const jpeg = Buffer.from([255,216,255,217]);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-recording-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RecordingStore(root); await store.initialize(); return { root, store };
}
const defer = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const backend = (capture: ScreenCaptureBackend['capture']): ScreenCaptureBackend => ({ supported: true, permission: async () => true, displays: async () => [], capture });
const realTimeout = globalThis.setTimeout;
const waitForIO = () => new Promise<void>(resolve => realTimeout(resolve, 5));
async function settled(predicate: () => boolean) { for (let i=0; i<200; i++) { if (predicate()) return; await waitForIO(); } assert.fail('async state did not settle'); }

test('screen history survives restart, supports local date, app, text and pagination, and owner-only image reads', async t => {
  const { root, store } = await fixture(t);
  for (let i=0; i<52; i++) await store.add({ ...frame, appName: i === 0 ? 'Browser' : 'Editor', text: i === 0 ? '唯一内容' : frame.text }, jpeg, new Date(Date.now()-i*1000));
  const reopened = new RecordingStore(root); await reopened.initialize();
  assert.equal(reopened.search({}).total, 52); assert.equal(reopened.search({ offset: 50 }).frames.length, 2);
  assert.equal(reopened.search({ query: '唯一' }).total, 1); assert.equal(reopened.search({ app: 'Browser' }).total, 1);
  const record = reopened.search({}).frames[0];
  const date = new Date(record.timestamp); const day = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  assert.equal(reopened.search({ day }).total, 52);
  assert.equal(await reopened.image(record.id), `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.equal((await stat(path.join(store.root, record.id+'.jpg'))).mode & 0o777, 0o600);
  await assert.rejects(reopened.image('../../private'));
  assert.throws(() => reopened.search({ offset: -1 })); assert.throws(() => reopened.search({ day: 'yesterday' }));
});

test('retention and capacity prune oldest first, persist settings, and reclaim interrupted image writes', async t => {
  const { root, store } = await fixture(t); const now = new Date();
  const recent = await store.add(frame, jpeg, now);
  await store.add(frame, jpeg, new Date(now.getTime()-2*86400000));
  await store.saveSettings({ ...defaultRecordingSettings, retentionDays: 1, maxStorageMB: 32 });
  assert.equal(store.stats().frameCount, 1);
  const orphan = `${now.getTime()}-00000000-0000-0000-0000-000000000000.jpg`;
  await writeFile(path.join(store.root, orphan), jpeg);
  const reopened = new RecordingStore(root); await reopened.initialize();
  assert.equal(reopened.settings.retentionDays, 1); assert.ok(!(await readdir(store.root)).includes(orphan));
  // Five 7 MiB images exceed the configured 32 MiB quota.
  for (let i=0; i<5; i++) await reopened.add(frame, Buffer.alloc(7*1024*1024), new Date(now.getTime()+i+1));
  assert.ok(reopened.stats().storageBytes <= 32*1024*1024); assert.equal(reopened.search({}).total, 4);
  await assert.rejects(reopened.image(recent.id));
});

test('corrupt index is retained and symlink images cannot expose outside files', async t => {
  const { root, store } = await fixture(t); const record = await store.add(frame, jpeg);
  const image = path.join(store.root, record.id+'.jpg'); await rm(image); await symlink(path.join(root, 'secret'), image); await writeFile(path.join(root, 'secret'), 'secret');
  await assert.rejects(store.image(record.id));
  await writeFile(path.join(store.root, record.id+'.json'), '{broken');
  await assert.rejects(new RecordingStore(root).initialize());
  assert.ok((await readdir(store.root)).includes(record.id+'.json'));
});

test('stop during capture discards pending pixels; restart remains explicitly stopped', async t => {
  const { root, store } = await fixture(t); const gate = defer<CapturedScreen>(); let calls = 0;
  const service = new RecordingService(store, backend(async () => { calls++; return gate.promise; }));
  assert.equal(service.status().state, 'stopped'); assert.equal(calls, 0);
  await service.start(); assert.equal(calls, 1);
  const stop = service.stop(); gate.resolve({ frame, jpeg }); await stop;
  assert.equal(service.status().state, 'stopped'); assert.equal(store.stats().frameCount, 0);
  const reopened = new RecordingStore(root); await reopened.initialize(); const next = new RecordingService(reopened, backend(async () => ({ frame, jpeg })));
  assert.equal(next.status().state, 'stopped');
});

test('lock or suspend invalidates a pending capture and cannot automatically resume', async t => {
  const { store } = await fixture(t); const gate = defer<CapturedScreen>();
  const service = new RecordingService(store, backend(async () => gate.promise)); await service.start();
  service.pause(); gate.resolve({ frame, jpeg }); await setImmediate();
  assert.equal(service.status().state, 'paused'); assert.equal(store.stats().frameCount, 0); await service.shutdown();
});

test('pause while permission prompt is pending does not start capture afterwards', async t => {
  const { store } = await fixture(t); const permission = defer<boolean>(); let calls = 0;
  const b = backend(async () => { calls++; return { frame, jpeg }; }); b.permission = () => permission.promise;
  const service = new RecordingService(store, b); const start = service.start(); await setImmediate(); service.pause(); permission.resolve(true); await start;
  assert.equal(service.status().state, 'stopped'); assert.equal(calls, 0); await service.shutdown();
});

test('permission denied, unavailable backend and disk errors never claim active capture', async t => {
  const { store } = await fixture(t); const b = backend(async () => { throw new Error('native failure'); });
  b.permission = async () => false; const service = new RecordingService(store,b);
  assert.equal((await service.start()).state, 'error'); assert.equal(service.status().needsPermission, true); assert.equal(store.stats().frameCount, 0);
  b.permission = async () => true; await service.start(); assert.equal(service.status().needsPermission, false); await settled(() => service.status().state === 'error');
  b.capture = async () => ({ frame, jpeg }); store.add = async () => { throw new Error('disk full'); };
  await service.start(); await settled(() => service.status().state === 'error');
  b.supported = false; await assert.rejects(service.start()); await service.shutdown();
});

test('excluded applications skip samples and clear stops and removes images and OCR', async t => {
  const { store } = await fixture(t); const service = new RecordingService(store, backend(async () => undefined));
  await service.start(); await setImmediate(); assert.equal(store.stats().frameCount,0); assert.equal(service.status().state, 'recording');
  await service.stop(); await store.add(frame,jpeg); await service.clear();
  assert.equal(service.status().state,'stopped'); assert.equal(store.search({query:'keyword'}).total,0);
  assert.deepEqual((await readdir(store.root)).filter(f => /\.(jpg|json)$/.test(f)),[]);
});

test('recording IPC rejects arbitrary paths, invalid payloads and out-of-range settings', async t => {
  const { store } = await fixture(t); const service = new RecordingService(store, backend(async () => undefined));
  const handlers = new Map<string, (input: unknown) => unknown>();
  installRecordingRoutes({ handle: (name, fn) => { handlers.set(name, fn); } }, service, async () => {});
  assert.throws(() => handlers.get('screen-status')!({ root: '/elsewhere' }));
  await assert.rejects(Promise.resolve().then(() => handlers.get('screen-image')!('/etc/passwd')));
  await assert.rejects(service.saveSettings({ ...defaultRecordingSettings, intervalSeconds: 1 }));
  await assert.rejects(service.saveSettings({ ...defaultRecordingSettings, excludedApps: [''] }));
  assert.throws(() => handlers.get('screen-search')!({ root: '/' }));
  await service.shutdown();
});

test('unchanged screenshots are deduplicated while visual or application changes are kept', async t => {
  const { store } = await fixture(t); await store.saveSettings({ ...defaultRecordingSettings, intervalSeconds: 5 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = { frame, jpeg };
  const service = new RecordingService(store,backend(async () => current));
  t.after(() => service.shutdown());
  await service.start();
  await settled(() => store.stats().frameCount === 1); for(let i=0;i<10;i++) await waitForIO();
  t.mock.timers.tick(5000); await settled(() => service.status().message.includes('静止画面')); for(let i=0;i<10;i++) await waitForIO();
  assert.equal(store.stats().frameCount,1);
  current = { frame: { ...frame, appName: 'Browser' }, jpeg };
  t.mock.timers.tick(5000); await settled(() => store.stats().frameCount === 2);
});
