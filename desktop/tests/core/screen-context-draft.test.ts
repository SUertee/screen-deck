import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ScreenContextController, CONTEXT_LIMITS, type ScreenContextBridge, type ScreenContextHandoff, type ScreenContextReceipt, type ScreenContextSourceAPI } from '../../src/renderer/screen-context/screen-context-model.js';
import type { TimelineFrame } from '../../src/shared/timeline.js';
const makeFrame = (at = '2026-10-21T03:00:00.000Z'): TimelineFrame => ({ id: `${Date.parse(at)}-${randomUUID()}`, timestamp: at, appName: 'Fixture Editor', bundleID: 'fixture.editor', displayID: 1, width: 960, height: 600, bytes: 4, snippet: 'UNSELECTED_SNIPPET' });
const target = { key: 'host-owned:local-plan:fixture-a', title: '同名任务', sourceLabel: '本地任务', version: 4 };
const defer = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const frames = [makeFrame(), makeFrame('2026-10-21T03:01:00.000Z')];
  let ocrCalls = 0, frameCalls = 0; const writes: ScreenContextHandoff[] = [];
  const api: ScreenContextSourceAPI = { timelineFrame: async id => { frameCalls++; const f = frames.find(f => f.id === id); if (!f) throw { code: 'timeline-missing', message: '画面已删除或过期。' }; return structuredClone(f); }, timelineFrameText: async () => { ocrCalls++; return '可选文字\nPRIVATE_UNSELECTED_OCR'; } };
  const controller = new ScreenContextController(api, undefined, randomUUID);
  const receipt = (h: ScreenContextHandoff): ScreenContextReceipt => ({ confirmationID: h.confirmationID, materialID: 'host-material-1', targetKey: h.target.key, savedVersion: h.target.baseVersion + 1 });
  const bridge: ScreenContextBridge = { targets: [target, { ...target, key: 'host-owned:project-task:fixture-b', sourceLabel: '项目任务' }], confirm: async h => { writes.push(h); return receipt(h); } };
  const ready = async () => { await controller.add(frames[0].id); controller.setSummary('用户核对的背景'); controller.selectTarget(target); };
  return { frames, controller, api, bridge, writes, receipt, ready, get ocrCalls() { return ocrCalls; }, get frameCalls() { return frameCalls; } };
}
test('multiple explicit clues preserve stable sources, deduplicate and never read OCR or save on selection', async () => {
  const f = fixture(); await Promise.all([f.controller.add(f.frames[0].id), f.controller.add(f.frames[1].id), f.controller.add(f.frames[0].id)]);
  assert.equal(f.controller.getSnapshot().clues.length, 2); assert.equal(f.ocrCalls, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.controller.getSnapshot().target, undefined); assert.equal(f.controller.getSnapshot().summary, '');
  const source = f.controller.getSnapshot().clues[0].source!; assert.equal(source.frameID, f.frames[0].id); assert.equal(source.capturedAt, f.frames[0].timestamp); assert.equal(source.displayID, 1);
  assert.ok(!JSON.stringify(f.controller.draft()).includes('UNSELECTED_SNIPPET'));
  f.controller.setNote(f.frames[0].id, '这是页面表现'); f.controller.remove(f.frames[1].id); assert.equal(f.controller.getSnapshot().clues[0].note, '这是页面表现'); assert.equal(f.writes.length, 0);
});
test('confirmation hands off only user summary, notes and explicit excerpt, with exact task version and source refs', async () => {
  const f = fixture(); await f.ready(); await f.controller.add(f.frames[1].id); await f.controller.readOCR(f.frames[0].id);
  f.controller.setNote(f.frames[0].id, '已核对'); f.controller.setExcerpt(f.frames[0].id, '可选文字');
  await f.controller.confirm(f.bridge); const saved = f.writes[0]; assert.equal(f.writes.length, 1);
  assert.deepEqual(saved.target, { key: target.key, baseVersion: 4 }); assert.equal(saved.summary, '用户核对的背景'); assert.equal(saved.clues.length, 2); assert.deepEqual(saved.clues[0].excerpt, { kind: 'user-reviewed', text: '可选文字' });
  assert.equal(saved.clues[1].excerpt, undefined); assert.ok(!JSON.stringify(saved).includes('PRIVATE_UNSELECTED_OCR')); assert.ok(!JSON.stringify(saved).includes('UNSELECTED_SNIPPET'));
  assert.equal(f.controller.getSnapshot().receipt?.materialID, 'host-material-1');
  f.controller.setSummary('不能覆盖已确认内容'); await f.controller.confirm(f.bridge); assert.equal(f.writes.length, 1); assert.equal(f.controller.getSnapshot().summary, '用户核对的背景');
});
test('empty, missing summary, unselected target and stale or ambiguous targets never save', async () => {
  const f = fixture(); await f.controller.confirm(f.bridge); await f.controller.add(f.frames[0].id); await f.controller.confirm(f.bridge);
  f.controller.setSummary('背景'); await f.controller.confirm(f.bridge); assert.equal(f.writes.length, 0);
  f.controller.selectTarget(target); await f.controller.confirm({ ...f.bridge, targets: [{ ...target, version: 5 }] }); assert.equal(f.writes.length, 0);
  await f.controller.confirm({ ...f.bridge, targets: [target, { ...target }] }); assert.equal(f.writes.length, 0);
  await f.controller.confirm({ ...f.bridge, error: '任务读取失败' }); await f.controller.confirm({ ...f.bridge, targets: [{ ...target, disabledReason: '只读' }] }); assert.equal(f.writes.length, 0);
  assert.equal(f.controller.getSnapshot().summary, '背景');
});
test('same confirmation ID is reused after failed or lost acknowledgement; duplicate clicks cannot create duplicate writes', async () => {
  const f = fixture(); await f.ready(); const wait = defer<ScreenContextReceipt>(); let calls = 0; let first!: ScreenContextHandoff;
  const bridge = { ...f.bridge, confirm: async (h: ScreenContextHandoff) => { calls++; first = h; return wait.promise; } };
  const firstRun = f.controller.confirm(bridge); await Promise.resolve(); await Promise.resolve(); await f.controller.confirm(bridge); assert.equal(calls, 1);
  wait.resolve({ ...f.receipt(first), confirmationID: 'wrong-receipt' }); await firstRun; assert.ok(f.controller.getSnapshot().error); assert.equal(f.controller.getSnapshot().receipt, undefined);
  const id = f.controller.getSnapshot().confirmationID; await f.controller.confirm(f.bridge); assert.equal(f.writes[0].confirmationID, id); assert.equal(f.controller.getSnapshot().receipt?.confirmationID, id);
});
test('host error preserves edits; an intentional edit changes the confirmation identity', async () => {
  const f = fixture(); await f.ready(); f.controller.setNote(f.frames[0].id, '备注');
  await f.controller.confirm({ ...f.bridge, confirm: async () => { throw new Error('版本冲突'); } }); const prior = f.controller.getSnapshot().confirmationID;
  assert.match(f.controller.getSnapshot().error, /版本冲突/); assert.equal(f.controller.getSnapshot().clues[0].note, '备注');
  f.controller.setSummary('重新核对的背景'); await f.controller.confirm(f.bridge); assert.notEqual(f.writes[0].confirmationID, prior); assert.equal(f.writes[0].summary, '重新核对的背景');
});
test('cancelled source checking keeps input and late callback never invokes host', async () => {
  const f = fixture(); await f.ready(); const wait = defer<TimelineFrame>(); f.api.timelineFrame = async () => wait.promise;
  const saving = f.controller.confirm(f.bridge); assert.equal(f.controller.getSnapshot().phase, 'checking'); f.controller.cancelCheck();
  wait.resolve(f.frames[0]); await saving; assert.equal(f.controller.getSnapshot().phase, 'idle'); assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().summary, '用户核对的背景');
});
test('source expiration scrubs OCR/excerpt, preserves user summary and blocks confirmation until removed', async () => {
  const f = fixture(); await f.ready(); await f.controller.readOCR(f.frames[0].id); f.controller.setExcerpt(f.frames[0].id, '可选文字');
  f.controller.invalidate(f.frames[0].id); assert.equal(f.controller.getSnapshot().clues[0].state, 'unavailable'); assert.equal(f.controller.getSnapshot().clues[0].ocr, undefined); assert.equal(f.controller.getSnapshot().clues[0].excerpt, '');
  await f.controller.confirm(f.bridge); assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().summary, '用户核对的背景');
  f.controller.remove(f.frames[0].id); await f.controller.add(f.frames[1].id); await f.controller.confirm(f.bridge); assert.equal(f.writes[0].clues[0].source.frameID, f.frames[1].id);
});
test('deletion while validation is pending invalidates the whole attempt', async () => {
  const f = fixture(); await f.ready(); const wait = defer<TimelineFrame>(); f.api.timelineFrame = async () => wait.promise;
  const saving = f.controller.confirm(f.bridge); f.controller.invalidate(f.frames[0].id); wait.resolve(f.frames[0]); await saving;
  assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().clues[0].state, 'unavailable');
});
test('source failure and metadata drift are explicit; retry never clears note or summary', async () => {
  const f = fixture(); await f.ready(); const original = f.api.timelineFrame; f.controller.setNote(f.frames[0].id, '备注保留'); f.api.timelineFrame = async () => { throw new Error('读取失败'); };
  await f.controller.confirm(f.bridge); assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().clues[0].state, 'error'); assert.equal(f.controller.getSnapshot().clues[0].note, '备注保留');
  f.api.timelineFrame = async id => ({ ...await original(id), displayID: 2 }); await f.controller.readSource(f.frames[0].id); f.api.timelineFrame = original;
  await f.controller.confirm(f.bridge); assert.equal(f.writes.length, 0); assert.match(f.controller.getSnapshot().clues[0].error!, /来源信息已变化/);
});
test('late source load cannot resurrect a removed clue or mutate a newly created draft', async () => {
  const f = fixture(); const old = defer<TimelineFrame>(); f.api.timelineFrame = async () => old.promise;
  const loading = f.controller.add(f.frames[0].id); f.controller.remove(f.frames[0].id); f.controller.newDraft();
  f.api.timelineFrame = async () => ({ ...f.frames[0], appName: 'New source' }); await f.controller.add(f.frames[0].id); old.resolve(f.frames[0]); await loading;
  assert.equal(f.controller.getSnapshot().clues.length, 1); assert.equal(f.controller.getSnapshot().clues[0].source?.appName, 'New source');
});
test('selection and text bounds prevent unbounded handoff; reading OCR does not include it automatically', async () => {
  const f = fixture(); await f.controller.add('not-a-frame'); assert.equal(f.controller.getSnapshot().clues.length, 0);
  for (let i = 0; i < CONTEXT_LIMITS.clues + 1; i++) { const frame = makeFrame(); f.frames.push(frame); await f.controller.add(frame.id); }
  assert.equal(f.controller.getSnapshot().clues.length, CONTEXT_LIMITS.clues); f.controller.setSummary('x'.repeat(CONTEXT_LIMITS.summary + 1)); assert.equal(f.controller.getSnapshot().summary, '');
  await f.controller.readOCR(f.controller.getSnapshot().clues[0].id); assert.equal(f.controller.getSnapshot().clues[0].excerpt, ''); assert.ok(!JSON.stringify(f.controller.draft()).includes('PRIVATE_UNSELECTED_OCR'));
});
test('memory roundtrip keeps edited draft and receipt but never cached raw OCR', async () => {
  const f = fixture(); await f.ready(); await f.controller.readOCR(f.frames[0].id); f.controller.setNote(f.frames[0].id, '用户笔记');
  const next = new ScreenContextController(f.api, f.controller.draft(), randomUUID); assert.equal(next.getSnapshot().clues[0].ocr, undefined); assert.equal(next.getSnapshot().clues[0].note, '用户笔记'); assert.equal(next.getSnapshot().target?.key, target.key);
});
