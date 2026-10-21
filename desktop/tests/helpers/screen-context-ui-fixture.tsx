import React, { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { Modal } from '../../src/renderer/components';
import { ScreenContextDraftPanel } from '../../src/renderer/screen-context/ScreenContextDraft';
import { ScreenContextController, type ScreenContextBridge, type ScreenContextHandoff, type ScreenContextReceipt } from '../../src/renderer/screen-context/screen-context-model';
import type { TimelineFrame } from '../../src/shared/timeline';
import '../../src/renderer/styles.css';
const frames: TimelineFrame[] = [
  { id: '1792551600000-11111111-1111-4111-8111-111111111111', timestamp: '2026-10-21T03:00:00Z', appName: 'Browser · 合成画面', bundleID: 'fixture.browser', displayID: 1, width: 960, height: 600, bytes: 4, snippet: 'UNSELECTED_SNIPPET' },
  { id: '1792551660000-22222222-2222-4222-8222-222222222222', timestamp: '2026-10-21T03:01:00Z', appName: 'Terminal · 合成画面', bundleID: 'fixture.terminal', displayID: 2, width: 960, height: 600, bytes: 4, snippet: 'UNSELECTED_SNIPPET' },
];
const removed = new Set<string>(); let failRead = false, holdRead = false; const reads: Array<() => void> = [];
let mode: 'success' | 'fail' | 'lost-receipt' | 'hold' = 'success', releaseSave: (() => void) | undefined;
const saved = new Map<string, ScreenContextReceipt>(), attempts: ScreenContextHandoff[] = [];
let writes = 0, ocrReads = 0;
const controller = new ScreenContextController({ timelineFrame: async id => {
  if (holdRead) await new Promise<void>(resolve => reads.push(resolve));
  if (removed.has(id)) throw { code: 'timeline-missing', message: '合成来源已删除。' };
  if (failRead) throw new Error('合成来源暂不可读');
  return structuredClone(frames.find(f => f.id === id)!);
}, timelineFrameText: async () => { ocrReads++; return '可引用的错误信息\nPRIVATE_UNSELECTED_OCR\n第三行合成资料'; } });
let forceRender = () => {};
let version = 2, connected = true, targetError = '';
const targets = () => [
  { key: 'local-plan:fixture-a', title: '修复页面报错', sourceLabel: '本地任务 · A', version },
  { key: 'project-task:fixture-b', title: '修复页面报错', sourceLabel: '项目任务 · B', version: 7 },
];
const bridge = (): ScreenContextBridge => ({ targets: targets(), error: targetError, confirm: async h => {
  attempts.push(structuredClone(h)); if (mode === 'hold') await new Promise<void>(resolve => { releaseSave = resolve; });
  if (mode === 'fail') throw new Error('合成任务保存失败');
  if (h.target.key === targets()[0].key && h.target.baseVersion !== version) throw new Error('合成任务版本冲突');
  if (h.clues.some(c => removed.has(c.source.frameID))) throw new Error('来源在保存前已失效');
  if (saved.has(h.confirmationID)) return saved.get(h.confirmationID)!;
  writes++; const receipt = { confirmationID: h.confirmationID, materialID: 'fixture-material-' + writes, targetKey: h.target.key, savedVersion: h.target.baseVersion + 1 }; saved.set(h.confirmationID, receipt);
  if (mode === 'lost-receipt') throw new Error('合成回执丢失'); return receipt;
} });
const control = {
  ids: frames.map(f => f.id),
  stats: () => ({ writes, attempts, ocrReads, draft: controller.draft() }),
  mode: (value: typeof mode) => { mode = value; },
  version: () => { version++; forceRender(); },
  targetsError: (text: string) => { targetError = text; forceRender(); },
  connect: (value: boolean) => { connected = value; forceRender(); },
  expire: (id: string) => { removed.add(id); controller.invalidate(id); },
  readFailure: (value: boolean) => { failRead = value; },
  holdReads: () => { holdRead = true; },
  releaseReads: () => { holdRead = false; reads.splice(0).forEach(resolve => resolve()); },
  releaseSave: () => { releaseSave?.(); },
  reset: () => { controller.newDraft(); removed.clear(); failRead = false; mode = 'success'; targetError = ''; connected = true; forceRender(); },
};
(globalThis as unknown as { __screenContextFixture: typeof control }).__screenContextFixture = control;
function Fixture() {
  const [open, setOpen] = useState(false), [, render] = useState(0);
  forceRender = () => render(v => v + 1);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const close = () => { if (controller.getSnapshot().phase === 'saving') return; controller.cancelCheck(); setOpen(false); };
  return <><main id="app-shell" style={{ padding: 36, maxWidth: 1100, margin: 'auto' }}><p>ScreenDeck / 隔离合成数据</p><h1>从屏幕线索整理任务上下文</h1><p>这份夹具仅验证草稿和宿主保存契约，不连接采集、模型或任务数据库。</p><div style={{ display: 'flex', gap: 16, marginTop: 24 }}><button className="button" onClick={() => void Promise.all(frames.map(f => controller.add(f.id)))}>选择两条合成线索</button><button className="button" onClick={() => setOpen(true)}>打开上下文草稿</button></div><p>已选 {state.clues.length} 条线索</p></main>{open && createPortal(<Modal title="整理任务上下文" className="sc-draft-modal" onClose={close}><ScreenContextDraftPanel controller={controller} bridge={connected ? bridge() : undefined} onClose={close} /></Modal>, document.body)}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
