import React, { useRef, useState, useSyncExternalStore } from 'react';
import { ScreenContextController, CONTEXT_LIMITS, type ScreenContextBridge, type ScreenClue } from './screen-context-model';
import './screen-context.css';
const time = (value: string) => new Date(value).toLocaleString();
function OCRPreview({ clue, controller, disabled }: { clue: ScreenClue; controller: ScreenContextController; disabled: boolean }) {
  const [selection, setSelection] = useState(''), [error, setError] = useState('');
  const text = useRef<HTMLTextAreaElement>(null);
  return <div className="sc-ocr">
    {clue.ocrState !== 'ready' ? <button type="button" className="text-button" disabled={disabled || clue.state !== 'ready' || clue.ocrState === 'loading'} onClick={() => void controller.readOCR(clue.id)}>{clue.ocrState === 'loading' ? '正在读取识别文字…' : clue.ocrState === 'error' ? '重试识别文字' : '查看识别文字'}</button> : <>
      <label>来源识别文字（仅供核对，尚未加入材料）<textarea ref={text} aria-label={`来源识别文字 ${clue.id}`} rows={4} readOnly value={clue.ocr ?? ''} onSelect={() => { const el = text.current; if (el) setSelection(el.value.slice(el.selectionStart, el.selectionEnd)); }} /></label>
      {!clue.ocr && <p>此画面没有识别到文字，可手动填写备注。</p>}
      <button type="button" className="text-button" disabled={disabled || !selection.trim()} onClick={() => { const next = [clue.excerpt, selection.trim()].filter(Boolean).join('\n'); if (next.length > CONTEXT_LIMITS.excerpt) { setError(`每条线索最多引用 ${CONTEXT_LIMITS.excerpt} 字，请缩小选择。`); return; } controller.setExcerpt(clue.id, next); setSelection(''); setError(''); }}>将选中文字加入引用</button>
    </>}
    {(clue.ocrError || error) && <p role="alert">{clue.ocrError || error}</p>}
  </div>;
}
/** Controlled by a memory-only controller; task integration is a host-owned optional adapter. */
export function ScreenContextDraftPanel({ controller, bridge, onClose, onOpenSource }: {
  controller: ScreenContextController;
  bridge?: ScreenContextBridge;
  onClose(): void;
  onOpenSource?(frameID: string): void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const busy = state.phase !== 'idle', frozen = busy || !!state.receipt;
  const targetMatches = state.target ? bridge?.targets.filter(t => t.key === state.target!.key) ?? [] : [];
  const targetChanged = !!state.target && (targetMatches.length !== 1 || targetMatches[0].version !== state.target.version || !!targetMatches[0].disabledReason);
  const blocked = !bridge || busy || !!state.receipt || !!bridge.loading || !!bridge.error || !state.target || targetChanged || !state.summary.trim() || !state.clues.length || state.clues.some(c => c.state !== 'ready');
  return <section className="screen-context-draft" aria-label="屏幕线索上下文草稿" aria-busy={busy}>
    <p className="sc-intro">核对选中的画面，移除无关线索，再用自己的话整理背景。识别文字仅供参考，只有明确加入的引用才进入材料。</p>
    {state.receipt ? <div className="sc-saved" role="status">已保存到「{state.target?.title}」的任务材料 · v{state.receipt.savedVersion}。未启动采集或发送给模型。</div> : !bridge ? <p className="sc-status" role="status">任务上下文保存尚未接入，当前仅为本窗口草稿；关闭后仍可继续编辑，退出应用不保留。</p> : bridge.loading ? <p role="status">正在读取可关联任务…</p> : bridge.error ? <p role="alert">任务读取失败：{bridge.error}{bridge.refreshTargets && <button type="button" className="text-button" disabled={busy} onClick={bridge.refreshTargets}>重试任务列表</button>}</p> : !bridge.targets.length ? <p role="status">暂无可关联的任务，请先在任务页创建任务。{bridge.refreshTargets && <button type="button" className="text-button" disabled={busy} onClick={bridge.refreshTargets}>刷新任务列表</button>}</p> : null}
    <label className="sc-summary">上下文摘要<span>用户核对内容，不作为执行指令或完成证明</span><textarea aria-label="上下文摘要" rows={4} maxLength={CONTEXT_LIMITS.summary} placeholder="例如：这个页面提交后出现报错；以下两条线索分别记录了页面表现和终端信息。" value={state.summary} disabled={frozen} onChange={e => controller.setSummary(e.target.value)} /><small>{state.summary.length} / {CONTEXT_LIMITS.summary}</small></label>
    <label className="sc-target">关联到任务<select aria-label="关联到任务" value={state.target?.key ?? ''} disabled={frozen || !bridge || bridge.loading || !!bridge.error} onChange={e => controller.selectTarget(bridge?.targets.find(t => t.key === e.target.value))}>
      <option value="">请选择任务，不自动选择</option>
      {state.target && !bridge?.targets.some(t => t.key === state.target!.key) && <option value={state.target.key} disabled>{state.target.title}（来源已不可用）</option>}
      {bridge?.targets.map(t => <option key={t.key} value={t.key} disabled={!!t.disabledReason}>{t.title} · {t.sourceLabel} · v{t.version}{t.disabledReason ? ` · ${t.disabledReason}` : ''}</option>)}
    </select></label>
    {targetChanged && !state.receipt && <p role="alert">所选任务已变化或不可用。请重新选择以核对当前版本。{bridge?.targets.some(t => t.key === state.target?.key) && <button type="button" className="text-button" disabled={busy} onClick={() => controller.selectTarget(undefined)}>重新选择任务</button>}</p>}
    {state.target && <p className="sc-target-note">确认对象：{state.target.title} · {state.target.sourceLabel} · 基础版本 v{state.target.version}</p>}
    <div className="sc-source-heading"><h3>所选线索</h3><span>{state.clues.length} / {CONTEXT_LIMITS.clues}</span></div>
    {!state.clues.length && <p className="sc-empty">尚未选择屏幕线索。关闭草稿后，可从屏幕记录列表勾选画面，或从画面详情加入。</p>}
    <div className="sc-clues">{state.clues.map((clue, index) => <article className="sc-clue" key={clue.id} data-state={clue.state}>
      <header><div><strong>{index + 1}. {clue.source?.appName ?? '屏幕线索'}</strong>{clue.source && <p>{time(clue.source.capturedAt)} · 显示器 {clue.source.displayID} · {clue.source.width}×{clue.source.height}</p>}</div><button type="button" className="text-button" aria-label={`移除线索 ${clue.id}`} disabled={frozen} onClick={() => controller.remove(clue.id)}>移除</button></header>
      <details className="sc-origin"><summary>查看来源标识</summary><code>{clue.id}</code>{clue.source?.bundleID && <p>{clue.source.bundleID}</p>}</details>
      {clue.state === 'loading' ? <p role="status">正在读取来源…</p> : clue.state !== 'ready' ? <div className="sc-source-error" role="alert"><p>{clue.error || '来源暂不可用。'}</p>{clue.state === 'error' && <button type="button" className="text-button" disabled={frozen} onClick={() => void controller.readSource(clue.id)}>重试来源</button>}</div> : <>
        {onOpenSource && <button type="button" className="text-button" disabled={frozen} onClick={() => onOpenSource(clue.id)}>回看原画面</button>}
        <label>线索备注<textarea aria-label={`线索备注 ${clue.id}`} rows={2} maxLength={CONTEXT_LIMITS.note} value={clue.note} disabled={frozen} placeholder="这条线索说明了什么？" onChange={e => controller.setNote(clue.id, e.target.value)} /></label>
        <OCRPreview clue={clue} controller={controller} disabled={frozen} />
        <label>选定引用文字（可修改，可留空）<textarea aria-label={`选定引用文字 ${clue.id}`} rows={2} maxLength={CONTEXT_LIMITS.excerpt} value={clue.excerpt} disabled={frozen} placeholder="默认不引用全部 OCR；可选择部分文字加入或手动填写。" onChange={e => controller.setExcerpt(clue.id, e.target.value)} /></label>
      </>}
    </article>)}</div>
    {state.error && <p className="sc-error" role="alert">{state.error}</p>}
    <footer className="sc-footer"><p>确认仅保存到所选任务的材料；不开始采集、不发给模型、不授权工具，也不标记任务完成。</p><div className="sc-actions">
      <button type="button" className="button primary" disabled={blocked} onClick={() => { if (bridge) void controller.confirm(bridge); }}>{state.phase === 'checking' ? '正在核对来源…' : state.phase === 'saving' ? '正在保存…' : state.receipt ? '已关联并保存' : state.confirmationID && state.error ? '重试确认关联' : '确认关联并保存'}</button>
      {state.phase === 'checking' && <button type="button" className="button ghost" onClick={() => controller.cancelCheck()}>取消检查</button>}
      <button type="button" className="button ghost" disabled={state.phase === 'saving'} onClick={() => { controller.cancelCheck(); onClose(); }}>{state.receipt ? '关闭' : '关闭，保留草稿'}</button>
      {state.receipt && <button type="button" className="text-button" onClick={() => controller.newDraft()}>新建上下文草稿</button>}
    </div></footer>
  </section>;
}
