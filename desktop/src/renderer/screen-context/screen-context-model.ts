import type { TimelineFrame } from '../../shared/timeline';

/** Private UI adapter. A owns the canonical task reference and maps its opaque key. */
export interface ScreenContextTarget {
  key: string;
  title: string;
  sourceLabel: string;
  version: number;
  disabledReason?: string;
}
export interface ScreenClueSource {
  kind: 'screen-frame'; frameID: string; capturedAt: string;
  appName: string; bundleID: string; displayID: number; width: number; height: number;
}
export interface ScreenContextHandoff {
  schemaVersion: 1; confirmationID: string; draftID: string; draftRevision: number;
  target: { key: string; baseVersion: number };
  summary: string;
  clues: Array<{ source: ScreenClueSource; note: string; excerpt?: { kind: 'user-reviewed'; text: string } }>;
}
export interface ScreenContextReceipt { confirmationID: string; materialID: string; targetKey: string; savedVersion: number }
export interface ScreenContextBridge {
  targets: readonly ScreenContextTarget[];
  loading?: boolean; error?: string;
  refreshTargets?(): void;
  /** Host must resolve target/source IDs, compare version, save through A's single writer,
   * deduplicate confirmationID, then return a durable receipt. No capture or model calls. */
  confirm(input: ScreenContextHandoff): Promise<ScreenContextReceipt>;
}
export interface ScreenContextSourceAPI {
  timelineFrame(id: string): Promise<TimelineFrame>;
  timelineFrameText(id: string): Promise<string>;
}
export interface ScreenClue {
  id: string; source?: ScreenClueSource; note: string; excerpt: string;
  state: 'loading' | 'ready' | 'error' | 'unavailable'; error?: string;
  ocrState: 'idle' | 'loading' | 'ready' | 'error'; ocr?: string; ocrError?: string;
}
export interface ScreenContextDraft {
  id: string; revision: number; summary: string; clues: ScreenClue[];
  target?: ScreenContextTarget; confirmationID?: string; receipt?: ScreenContextReceipt;
}
export interface ScreenContextState extends ScreenContextDraft {
  phase: 'idle' | 'checking' | 'saving'; error: string;
}
export const CONTEXT_LIMITS = { clues: 32, summary: 12000, note: 1000, excerpt: 2000 } as const;
const message = (e: unknown) => e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : '读取未完成，请重试。';
const unavailable = (e: unknown) => e && typeof e === 'object' && 'code' in e && e.code === 'timeline-missing';
const sourceOf = (frame: TimelineFrame, expected: string): ScreenClueSource => {
  if (frame.id !== expected || !Number.isFinite(Date.parse(frame.timestamp)) || !Number.isSafeInteger(frame.displayID) || frame.displayID < 1 || !Number.isInteger(frame.width) || frame.width < 1 || !Number.isInteger(frame.height) || frame.height < 1 || typeof frame.appName !== 'string' || typeof frame.bundleID !== 'string') throw new Error('画面来源信息无效，请重新选择。');
  return { kind: 'screen-frame', frameID: frame.id, capturedAt: frame.timestamp, appName: frame.appName, bundleID: frame.bundleID, displayID: frame.displayID, width: frame.width, height: frame.height };
};
const validID = (id: string) => /^\d{13}-[0-9a-f-]{36}$/.test(id);
const validTarget = (t: ScreenContextTarget) => t.key.length > 0 && t.key.length <= 500 && t.title.trim().length > 0 && Number.isSafeInteger(t.version) && t.version >= 1 && !t.disabledReason;

/** Memory-only draft/controller; never writes task storage, starts capture or invokes a model. */
export class ScreenContextController {
  private state: ScreenContextState;
  private listeners = new Set<() => void>();
  private requests = new Map<string, number>();
  private generation = 0;
  private requestSerial = 0;
  constructor(private api: ScreenContextSourceAPI, initial?: ScreenContextDraft, private uuid = () => crypto.randomUUID()) {
    this.state = initial ? { ...structuredClone(initial), clues: initial.clues.map(c => ({ ...c, ocr: undefined, ocrState: 'idle', ocrError: undefined, state: c.state === 'loading' ? 'error' : c.state, error: c.state === 'loading' ? '来源尚未读完，请重试。' : c.error })), phase: 'idle', error: '' } : { id: uuid(), revision: 1, summary: '', clues: [], phase: 'idle', error: '' };
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  draft(): ScreenContextDraft {
    const { phase: _phase, error: _error, ...draft } = this.state;
    return { ...draft, clues: draft.clues.map(({ ocr: _ocr, ocrError: _ocrError, ...clue }) => ({ ...clue, ocrState: 'idle' })) };
  }
  private publish(patch: Partial<ScreenContextState>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  private editable() { return this.state.phase === 'idle' && !this.state.receipt; }
  private edit(patch: Partial<ScreenContextState>) { if (this.editable()) this.publish({ ...patch, revision: this.state.revision + 1, confirmationID: undefined, error: '' }); }
  setSummary(summary: string) { if (summary.length <= CONTEXT_LIMITS.summary) this.edit({ summary }); }
  setNote(id: string, note: string) { if (note.length <= CONTEXT_LIMITS.note) this.edit({ clues: this.state.clues.map(c => c.id === id ? { ...c, note } : c) }); }
  setExcerpt(id: string, excerpt: string) { if (excerpt.length <= CONTEXT_LIMITS.excerpt) this.edit({ clues: this.state.clues.map(c => c.id === id && c.state === 'ready' ? { ...c, excerpt } : c) }); }
  selectTarget(target?: ScreenContextTarget) { if (target && !validTarget(target)) return; this.edit({ target: target ? { ...target } : undefined }); }
  remove(id: string) { if (!this.editable()) return; this.requests.set(id, ++this.requestSerial); this.edit({ clues: this.state.clues.filter(c => c.id !== id) }); }
  async add(id: string) {
    if (!this.editable() || this.state.clues.some(c => c.id === id)) return;
    if (!validID(id)) { this.publish({ error: '画面标识无效。' }); return; }
    if (this.state.clues.length >= CONTEXT_LIMITS.clues) { this.publish({ error: `每份草稿最多选择 ${CONTEXT_LIMITS.clues} 条线索。` }); return; }
    this.edit({ clues: [...this.state.clues, { id, note: '', excerpt: '', state: 'loading', ocrState: 'idle' }] });
    await this.readSource(id);
  }
  async readSource(id: string) {
    if (!this.editable() || !this.state.clues.some(c => c.id === id)) return;
    const token = ++this.requestSerial; this.requests.set(id, token);
    this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, state: 'loading', error: undefined } : c) });
    try {
      const source = sourceOf(await this.api.timelineFrame(id), id);
      if (this.requests.get(id) !== token || !this.editable()) return;
      this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, source, state: 'ready', error: undefined } : c) });
    } catch (e) {
      if (this.requests.get(id) !== token || !this.editable()) return;
      this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, state: unavailable(e) ? 'unavailable' : 'error', error: message(e) } : c) });
    }
  }
  async readOCR(id: string) {
    const clue = this.state.clues.find(c => c.id === id);
    if (!this.editable() || !clue || clue.state !== 'ready' || clue.ocrState === 'loading' || clue.ocrState === 'ready') return;
    const token = this.requests.get(id);
    this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, ocrState: 'loading', ocrError: undefined } : c) });
    try {
      const text = await this.api.timelineFrameText(id);
      if (token !== this.requests.get(id) || !this.editable()) return;
      if (typeof text !== 'string' || text.length > 24000) throw new Error('识别文字格式无效。');
      this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, ocrState: 'ready', ocr: text } : c) });
    } catch (e) {
      if (token !== this.requests.get(id) || !this.editable()) return;
      if (unavailable(e)) { this.invalidate(id); return; }
      this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, ocrState: 'error', ocrError: message(e) } : c) });
    }
  }
  invalidate(id: string) {
    if (!this.state.clues.some(c => c.id === id)) return;
    this.requests.set(id, ++this.requestSerial);
    if (this.state.phase === 'checking') { this.generation++; }
    this.publish({ clues: this.state.clues.map(c => c.id === id ? { ...c, state: 'unavailable', error: '来源已删除或过期，请移除这条线索。', ocr: undefined, ocrState: 'idle', excerpt: '' } : c), ...(this.state.phase === 'checking' ? { phase: 'idle' as const, error: '来源已失效，尚未保存。' } : {}) });
  }
  cancelCheck() { if (this.state.phase === 'checking') { this.generation++; this.publish({ phase: 'idle', error: '已取消检查，草稿保留，尚未保存。' }); } }
  newDraft() { if (this.state.phase !== 'idle') return; this.generation++; this.requests.clear(); this.publish({ id: this.uuid(), revision: 1, clues: [], summary: '', target: undefined, confirmationID: undefined, receipt: undefined, error: '' }); }
  async confirm(bridge: ScreenContextBridge): Promise<void> {
    if (!this.editable()) return;
    const current = this.state, target = current.target;
    if (!target || !validTarget(target) || !current.summary.trim() || !current.clues.length || current.clues.some(c => c.state !== 'ready' || !c.source)) { this.publish({ error: '请填写摘要、选择明确任务，并移除或重试不可用线索。' }); return; }
    const matches = bridge.targets.filter(t => t.key === target.key);
    if (bridge.loading || bridge.error || matches.length !== 1 || !validTarget(matches[0]) || matches[0].version !== target.version) { this.publish({ error: '任务已变化或暂不可用，请刷新并重新选择任务。' }); return; }
    const generation = ++this.generation;
    const confirmationID = current.confirmationID ?? this.uuid();
    this.publish({ phase: 'checking', error: '', confirmationID });
    const checks = await Promise.all(current.clues.map(async clue => {
      try { const source = sourceOf(await this.api.timelineFrame(clue.id), clue.id); if (JSON.stringify(source) !== JSON.stringify(clue.source)) throw new Error('来源信息已变化，请重新核对。'); return { clue, source }; }
      catch (error) { return { clue, error }; }
    }));
    if (generation !== this.generation) return;
    const failed = checks.filter(c => 'error' in c);
    if (failed.length) {
      this.publish({ phase: 'idle', error: '部分来源无法核对，草稿未保存。请重试或移除对应线索。', clues: this.state.clues.map(c => { const failure = failed.find(f => f.clue.id === c.id); return failure ? { ...c, state: unavailable(failure.error) ? 'unavailable' : 'error', error: message(failure.error), ocr: undefined, ocrState: 'idle' } : c; }) }); return;
    }
    const handoff: ScreenContextHandoff = { schemaVersion: 1, confirmationID, draftID: current.id, draftRevision: current.revision, target: { key: target.key, baseVersion: target.version }, summary: current.summary.trim(), clues: checks.map(c => ({ source: c.source!, note: c.clue.note.trim(), ...(c.clue.excerpt.trim() ? { excerpt: { kind: 'user-reviewed' as const, text: c.clue.excerpt.trim() } } : {}) })) };
    this.publish({ phase: 'saving' });
    try {
      const receipt = await bridge.confirm(structuredClone(handoff));
      if (!receipt || receipt.confirmationID !== confirmationID || receipt.targetKey !== target.key || typeof receipt.materialID !== 'string' || !receipt.materialID || !Number.isSafeInteger(receipt.savedVersion) || receipt.savedVersion <= target.version) throw new Error('未收到有效保存回执。请核对任务记录；重试将使用同一确认标识。');
      this.publish({ phase: 'idle', receipt: { ...receipt }, error: '' });
    } catch (e) { this.publish({ phase: 'idle', error: `${message(e)} 草稿保留；再次确认会沿用同一确认标识。` }); }
  }
}
