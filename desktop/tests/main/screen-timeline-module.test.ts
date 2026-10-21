import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installScreenTimelineModule } from '../../src/main/screen-timeline-module.js';
import { LocalState } from '../../src/main/local-state.js';
import type { DesktopEvent } from '../../src/shared/desktop-api.js';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-screen-module-')); t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map<string, (input: unknown) => unknown>(), events: DesktopEvent[] = [], diagnostics: string[] = [];
  let permissions = 0, captures = 0;
  const options = { previewRoot: root, nativeBinary: '/unused-test-helper',
    host: { handle: (key: string, fn: (input: unknown) => unknown) => { handlers.set(key, fn); }, broadcast: (e: DesktopEvent) => { events.push(e); } },
    manager: { listSessions: async () => ({ records: [], diagnostics: [] }), listAgentSessions: async () => ({ records: [], diagnostics: [] }), listTaskSessions: async () => ({ records: [], diagnostics: [] }) },
    projects: { list: () => [] }, projectRegistry: { refresh: async () => { throw new Error('No project refresh expected'); } },
    local: new LocalState(path.join(root, 'local-state')), diagnostics,
    openPermissions: async () => { permissions++; },
    backend: { supported: false, permission: async () => { permissions++; return false; }, capture: async () => { captures++; return undefined; }, displays: async () => [] },
  };
  return { root, handlers, events, diagnostics, options, counts: () => ({ permissions, captures }) };
}
test('module assembly installs narrow routes without permissions, capture or model calls and resolves canonical frame refs', async t => {
  const f = await fixture(t), module = await installScreenTimelineModule(f.options);
  assert.ok(f.handlers.has('screen-status')); assert.ok(f.handlers.has('timeline-query')); assert.deepEqual(f.counts(), { permissions: 0, captures: 0 });
  assert.equal(module.recording?.status().state, 'stopped');
  const frame = await module.recording!.store.add({ appName: 'Fixture', bundleID: 'fixture.app', displayID: 1, width: 640, height: 360, text: 'NOT_A_DEFAULT_MATERIAL' }, Buffer.from([255, 216, 255, 217]), new Date('2026-10-21T03:00:00Z'));
  const source = module.resolveContextSource(frame.id); assert.equal(source.frameID, frame.id); assert.equal(source.capturedAt, '2026-10-21T03:00:00.000Z'); assert.ok(!('text' in source)); assert.ok(!('snippet' in source)); assert.ok(!JSON.stringify(source).includes('NOT_A_DEFAULT_MATERIAL'));
  assert.equal((await module.timeline.query({ day: '2026-10-21', timeZone: 'Asia/Shanghai' })).total, 0);
  await module.recording!.delete(frame.id); assert.throws(() => module.resolveContextSource(frame.id), /删除或过期/); assert.ok(f.events.some(e => e.type === 'screen-frame-removed' && e.frameID === frame.id));
  module.pause(); await module.shutdown(); assert.deepEqual(f.counts(), { permissions: 0, captures: 0 });
});
test('broken recording source remains untouched and timeline still works with a clear diagnostic', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'screen-recordings'); await mkdir(directory); const file = path.join(directory, 'settings.json'); await writeFile(file, '{broken');
  const module = await installScreenTimelineModule(f.options); assert.equal(module.recording, undefined); assert.ok(!f.handlers.has('screen-start')); assert.ok(f.handlers.has('timeline-query'));
  assert.ok(f.diagnostics.some(d => d.includes('屏幕记录暂不可用'))); const timeline = await module.timeline.query({ day: '2026-10-21', timeZone: 'Asia/Shanghai' }); assert.ok(timeline.diagnostics.some(d => d.includes('屏幕来源暂不可用')));
  assert.equal(await readFile(file, 'utf8'), '{broken'); module.pause(); await module.shutdown(); assert.deepEqual(f.counts(), { permissions: 0, captures: 0 });
});
