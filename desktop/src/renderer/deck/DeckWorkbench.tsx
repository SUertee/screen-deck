import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, ExternalLink, Minus, Plus, Square, X } from 'lucide-react';
import type { DesktopAPI, DesktopEvent } from '../../shared/desktop-api';
import type { AgentChatSourceInfo } from '../../shared/agent-chat';
import type { PlanWorkItem, PreviewPlan, SessionRecord } from '../../shared/types';
import { Brand, isBusy } from '../components';
import { AssignmentPicker } from './AssignmentPicker';
import { assignmentKey, assignmentLabel, assignItem, deckError, itemAssignment, mergePlans, planProgress, type DeckAssignment } from './deck-model';
import { TaskPlanningPanel } from '../tasks/TaskPlanningPanel';
import { TaskJevAdvice } from '../tasks/TaskJevAdvice';
import './deck.css';

interface EditDraft {
  key: string;
  planID: string;
  field: 'title' | 'item' | 'new-item';
  itemID?: string;
  baseVersion: number;
  value: string;
  assignment: DeckAssignment;
  saving: boolean;
  error: string;
  conflict?: boolean;
}
interface NewDraft { title: string; requestID: string; submitted?: boolean; saving: boolean; error: string }
type Page = 'tasks' | 'usage';
type DeckPresentation = Awaited<ReturnType<DesktopAPI['getDeckPresentation']>>;
const interactionQueues = new WeakMap<DesktopAPI, Promise<void>>();
/** A cleanup release must reach main before a subsequent mount's busy signal. */
function publishInteraction(api: DesktopAPI, busy: boolean): Promise<void> {
  const previous = interactionQueues.get(api) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => api.setDeckInteraction({ busy }));
  interactionQueues.set(api, next);
  return next;
}
const newItem = (title: string, assignment: DeckAssignment, id: string): PlanWorkItem => ({
  id, title, kind: 'implementation', expected_result: '', dependencies: [], status: 'planned', ...assignment,
});

function InlineField({ value, label, draft, onBegin, onChange, onSave, onCancel, onReload, onComposing, children }: {
  value: string; label: string; draft: EditDraft | null; onBegin(): void; onChange(value: string): void;
  onSave(): void; onCancel(): void; onReload(): void; onComposing(value: boolean): void; children?: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const read = useRef<HTMLSpanElement>(null);
  const previous = useRef<string | null>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (draft && previous.current !== draft.key) { input.current?.focus({ preventScroll: true }); input.current?.select(); }
    else if (!draft && previous.current && restoreFocus.current) read.current?.focus({ preventScroll: true });
    previous.current = draft?.key ?? null;
  }, [draft?.key]);
  return <span className={`deck-inline-slot ${draft ? 'is-editing' : ''}`}>
    {draft ? <>
      <input ref={input} className="deck-inline-input" data-inline-input aria-label={label} maxLength={draft.field === 'title' ? 600 : 200} value={draft.value} disabled={draft.saving} onChange={event => onChange(event.target.value)} onCompositionStart={() => onComposing(true)} onCompositionEnd={event => { onChange(event.currentTarget.value); onComposing(false); }} onBlur={event => {
        if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('.deck-inline-slot.is-editing,.deck-owner-picker,.deck-assignment-menu')) return;
        restoreFocus.current = false; onSave();
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); restoreFocus.current = true; onSave(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restoreFocus.current = true; onCancel(); }
      }} />
      {children}
      <button type="button" className="deck-inline-control" aria-label={`保存${label.replace(/^编辑/, '')}`} title="保存" disabled={draft.saving} onClick={() => { restoreFocus.current = true; onSave(); }}><Check size={11} /></button>
      <button type="button" className="deck-inline-control" aria-label={`取消${label.replace(/^编辑/, '')}`} title="取消" disabled={draft.saving} onClick={() => { restoreFocus.current = true; onCancel(); }}><X size={11} /></button>
      {draft.error && <span className="deck-inline-error" role="alert">{draft.error}{draft.conflict && <button type="button" onClick={onReload}>取消并重新编辑</button>}</span>}
    </> : <span ref={read} className="deck-inline-read" role="button" tabIndex={0} data-inline-read={label === '编辑任务名称' ? 'title' : 'subtask'} aria-label={`${value}，双击或按F2编辑`} title={`${value} · 双击编辑`} onDoubleClick={onBegin} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'F2' || event.key === 'Enter') { event.preventDefault(); onBegin(); }
    }}>{value}</span>}
  </span>;
}

/** The compact window is a second view of saved plans; it never owns an execution runtime. */
export function DeckWorkbench({ api }: { api: DesktopAPI }) {
  const query = useRef(new URLSearchParams(location.search));
  const [plans, setPlans] = useState<PreviewPlan[]>([]);
  const plansRef = useRef<PreviewPlan[]>([]);
  const [sources, setSources] = useState<AgentChatSourceInfo[]>([]);
  const sourceGeneration = useRef(0);
  const [selectedID, setSelectedID] = useState<string | null>(query.current.get('planID'));
  const [sessionID, setSessionID] = useState<string | null>(query.current.get('sessionID'));
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [planningID, setPlanningID] = useState<string | null>(null);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [planningBusy, setPlanningBusy] = useState(false), [jevBusy, setJevBusy] = useState(false);
  const planningOpenRef = useRef(false); planningOpenRef.current = planningOpen;
  const [page, setPage] = useState<Page>('tasks');
  const [floatingCollapsed, setFloatingCollapsed] = useState(false);
  const [presentation, setPresentation] = useState<DeckPresentation>({ mode: 'floating', state: 'expanded', notchWidth: 0, notchHeight: 0, revision: -1 });
  const [presentationReady, setPresentationReady] = useState(false);
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const presentationRevision = useRef(-1);
  const isNotch = presentation.mode === 'notch';
  const collapsed = isNotch ? presentation.state !== 'expanded' : floatingCollapsed;
  const [resizing, setResizing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [newDraft, setNewDraft] = useState<NewDraft | null>(null);
  const newDraftRef = useRef<NewDraft | null>(null);
  newDraftRef.current = newDraft;
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const editRef = useRef<EditDraft | null>(null);
  const editSavePromise = useRef<Promise<boolean> | null>(null);
  editRef.current = edit;
  const [recent, setRecent] = useState<DeckAssignment[]>([]);
  const [pendingPlans, setPendingPlans] = useState(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const [completedOpen, setCompletedOpen] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const composing = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const updateComposing = (value: boolean) => { composing.current = value; setIsComposing(value); };
  const alive = useRef(true);
  const queuedPlan = useRef<string | null>(null);
  const contextRevision = useRef(-1);
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !isNotch) return;
    const measure = () => {
      const width = node.clientWidth, height = node.clientHeight;
      if (!width || !height) return;
      node.style.setProperty('--deck-shell-scale-x', String(Math.min(1, presentation.notchWidth / width)));
      node.style.setProperty('--deck-shell-scale-y', String(Math.min(1, presentation.notchHeight / height)));
      node.style.setProperty('--deck-peek-scale-y', String(Math.min(1, (presentation.notchHeight + 26) / height)));
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [isNotch, presentation.notchWidth, presentation.notchHeight]);

  const list = useRef<HTMLDivElement>(null);
  const pager = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const taskTab = useRef<HTMLButtonElement>(null);
  const usageTab = useRef<HTMLButtonElement>(null);
  const selectedSessionID = useRef(sessionID);
  selectedSessionID.current = sessionID;

  const acceptPlans = useCallback((incoming: PreviewPlan[]) => {
    const next = mergePlans(plansRef.current, incoming); plansRef.current = next; setPlans(next);
    const draft = editRef.current;
    if (draft && !draft.saving && incoming.some(plan => plan.id === draft.planID && plan.version > draft.baseVersion)) setEdit(current => current?.key === draft.key ? { ...current, conflict: true, error: '任务已在其他窗口更新，输入已保留。请取消后重新核对。' } : current);
  }, []);
  const refreshSources = useCallback(async () => {
    const generation = ++sourceGeneration.current;
    try { const next = await api.getAgentSources(); if (alive.current && generation === sourceGeneration.current) setSources(next); }
    catch { if (alive.current && generation === sourceGeneration.current) setNotice('Agent 目录暂时无法读取，已有分工保留，可以稍后重试。'); }
  }, [api]);
  const bootstrap = useCallback(async () => {
    setLoading(true); setLoadFailed(false);
    try { const result = await api.bootstrap(); if (alive.current) acceptPlans(result.plans); }
    catch (error) { if (alive.current) { setLoadFailed(true); setNotice(deckError(error)); } }
    finally { if (alive.current) setLoading(false); }
  }, [api, acceptPlans]);
  const acceptPresentation = useCallback((next: DeckPresentation) => {
    if (next.revision <= presentationRevision.current) return;
    presentationRevision.current = next.revision;
    presentationRef.current = next;
    setPresentation(next);
    setPresentationReady(true);
    if (next.mode === 'floating') setFloatingCollapsed(next.state === 'collapsed');
  }, []);
  const interactionBusy = Boolean(edit || newDraft || isComposing || menuOpen || pendingPlans.size || planningOpen);
  useEffect(() => {
    void publishInteraction(api, interactionBusy).catch(() => {});
  }, [api, interactionBusy]);
  useEffect(() => () => { void publishInteraction(api, false).catch(() => {}); }, [api]);

  useEffect(() => {
    alive.current = true; void bootstrap(); void refreshSources();
    const applyContext = (context: { revision: number; sessionID?: string; planID?: string }) => {
      if (context.revision <= contextRevision.current) return;
      contextRevision.current = context.revision;
      if (context.revision === 0 && !context.sessionID && !context.planID) return;
      if (presentationRef.current.mode === 'floating') setFloatingCollapsed(false);
      setSessionID(context.sessionID ?? null);
      if (context.planID) {
        if (editRef.current || newDraftRef.current || pendingRef.current.size || planningOpenRef.current) { queuedPlan.current = context.planID; setNotice('当前输入已保留，保存或取消后会打开所选任务。'); }
        else { queuedPlan.current = null; setSelectedID(context.planID); setPage('tasks'); }
      } else queuedPlan.current = null;
    };
    const unsubscribe = api.subscribe((event: DesktopEvent) => {
      if (event.type === 'plan-updated') acceptPlans([event.plan]);
      else if (event.type === 'agent-sources-updated' || event.type === 'settings-updated') void refreshSources();
      else if (event.type === 'session-updated' && event.session.conversation_id === selectedSessionID.current) setSession(previous => previous && previous.revision > event.session.revision ? previous : event.session);
      else if (event.type === 'deck-context-updated') applyContext(event);
      else if (event.type === 'deck-presentation-updated') acceptPresentation(event.presentation);
      else if (event.type === 'diagnostic' && (!event.sessionID || event.sessionID === selectedSessionID.current)) setNotice(event.message);
    });
    let active = true;
    void api.getDeckContext().then(context => { if (active) applyContext(context); }).catch(() => {});
    void api.getDeckPresentation().then(snapshot => { if (active) acceptPresentation(snapshot); }).catch(() => {});
    return () => { active = false; alive.current = false; unsubscribe(); };
  }, [api, acceptPlans, bootstrap, refreshSources, acceptPresentation]);
  useEffect(() => {
    if (edit || newDraft || pendingPlans.size || planningOpen || !queuedPlan.current) return;
    setSelectedID(queuedPlan.current); queuedPlan.current = null; setPage('tasks');
  }, [edit, newDraft, pendingPlans, planningOpen]);
  useEffect(() => {
    let active = true; setSession(null); setStopRequested(false);
    if (sessionID) void api.loadSession(sessionID).then(record => { if (active && record) setSession(previous => previous && previous.revision > record.revision ? previous : record); }).catch(error => { if (active) setNotice(deckError(error)); });
    return () => { active = false; };
  }, [api, sessionID]);
  useEffect(() => { if (!isBusy(session?.turns.at(-1)?.state)) setStopRequested(false); }, [session]);
  useLayoutEffect(() => { if (newDraft) { composerInput.current?.focus({ preventScroll: true }); if (list.current) list.current.scrollTop = 0; } }, [Boolean(newDraft)]);

  const remember = (value: DeckAssignment) => {
    if (value.assignee !== 'agent') return;
    setRecent(current => [value, ...current.filter(option => assignmentKey(option) !== assignmentKey(value))].slice(0, 3));
  };
  const mutatePlan = async (id: string, update: (plan: PreviewPlan) => PreviewPlan, expectedVersion?: number): Promise<PreviewPlan> => {
    const current = plansRef.current.find(plan => plan.id === id);
    if (!current) throw new Error('任务暂时无法读取，输入已保留。');
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('任务已在其他窗口更新，输入已保留。请取消后重新核对。');
    if (pendingRef.current.has(id)) throw new Error('上一次修改正在保存，请稍后重试。');
    pendingRef.current.add(id); setPendingPlans(new Set(pendingRef.current));
    try {
      const next = update(structuredClone(current));
      const saved = await api.savePlan({ plan: { ...next, schema_version: next.schema_version === 3 ? 3 : 2 }, expectedVersion: expectedVersion ?? current.version });
      if (alive.current) acceptPlans([saved]);
      return saved;
    } finally { pendingRef.current.delete(id); if (alive.current) setPendingPlans(new Set(pendingRef.current)); }
  };
  const cancelEdit = () => { if (!editRef.current?.saving && !composing.current) setEdit(null); };
  const performEditSave = async (): Promise<boolean> => {
    const draft = editRef.current;
    if (!draft) return true;
    if (draft.saving || composing.current) return false;
    if (draft.field === 'new-item' && draft.value === '' && draft.assignment.assignee === 'unassigned') { editRef.current = null; setEdit(null); return true; }
    const title = draft.value.trim();
    if (!title) { setEdit(current => current?.key === draft.key ? { ...current, error: '名称不能为空，输入已保留。' } : current); return false; }
    editRef.current = { ...draft, saving: true, error: '' };
    setEdit(editRef.current);
    try {
      await mutatePlan(draft.planID, current => {
        if (draft.field === 'title') return { ...current, title };
        if (draft.field === 'new-item') {
          if (current.work_items.length >= 12) throw new Error('已达到12个子任务，输入已保留。');
          if (current.work_items.some(item => item.id === draft.itemID)) return current;
          return { ...current, work_items: [...current.work_items, newItem(title, draft.assignment, draft.itemID!)] };
        }
        if (!current.work_items.some(item => item.id === draft.itemID)) throw new Error('原子任务已变更，输入已保留，请重新检查。');
        return { ...current, work_items: current.work_items.map(item => item.id === draft.itemID ? { ...item, title } : item) };
      }, draft.baseVersion);
      if (alive.current) { if (draft.field === 'new-item') remember(draft.assignment); editRef.current = null; setEdit(current => current?.key === draft.key ? null : current); }
      return true;
    } catch (error) {
      if (alive.current) { const message = deckError(error); const failed = { ...draft, saving: false, error: message, conflict: plansRef.current.find(plan => plan.id === draft.planID)?.version !== draft.baseVersion || /版本|冲突|其他窗口/.test(message) }; editRef.current = failed; setEdit(current => current?.key === draft.key ? failed : current); }
      return false;
    }
  };
  const saveEdit = (): Promise<boolean> => {
    if (editSavePromise.current) return editSavePromise.current;
    const promise = performEditSave(); editSavePromise.current = promise;
    void promise.finally(() => { if (editSavePromise.current === promise) editSavePromise.current = null; });
    return promise;
  };
  const reloadEdit = () => {
    const draft = editRef.current, plan = draft && plansRef.current.find(current => current.id === draft.planID);
    if (!draft || !plan || draft.saving) return;
    const item = plan.work_items.find(current => current.id === draft.itemID);
    setEdit({ ...draft, key: crypto.randomUUID(), baseVersion: plan.version, value: draft.field === 'title' ? plan.title : item?.title ?? '', error: '', conflict: false, assignment: item ? itemAssignment(item) : { assignee: 'unassigned' } });
  };
  const beginEdit = async (plan: PreviewPlan, field: EditDraft['field'], item?: PlanWorkItem) => {
    if (editRef.current && !await saveEdit()) return;
    if (field === 'new-item' && plan.work_items.length >= 12) { setNotice('最多保留12个子任务，可以继续编辑已有内容。'); return; }
    const latest = plansRef.current.find(current => current.id === plan.id) ?? plan;
    const latestItem = item && latest.work_items.find(current => current.id === item.id);
    setEdit({ key: crypto.randomUUID(), planID: plan.id, baseVersion: latest.version, field, itemID: field === 'new-item' ? crypto.randomUUID() : item?.id, value: field === 'title' ? latest.title : latestItem?.title ?? '', assignment: latestItem ? itemAssignment(latestItem) : { assignee: 'unassigned' }, saving: false, error: '' });
  };
  const choosePlan = async (id: string | null) => {
    if (editRef.current && !await saveEdit()) return;
    if (pendingRef.current.size || newDraftRef.current?.saving) { setNotice('修改正在保存，完成后可以切换任务。'); return; }
    setSelectedID(id);
  };
  const createPlan = async () => {
    if (!newDraft || newDraft.saving || composing.current) return;
    const title = newDraft.title.trim();
    if (!title) { setNewDraft(current => current && { ...current, error: '先写下一个主任务。' }); return; }
    setNewDraft(current => current && { ...current, submitted: true, saving: true, error: '' });
    try {
      const plan = await api.createTaskDraft({ requestID: newDraft.requestID, goal: title });
      if (!alive.current) return;
      acceptPlans([plan]); setNewDraft(null); setSelectedID(plan.id);
      setPlanningID(plan.id); setPlanningOpen(true);
    } catch (error) { if (alive.current) setNewDraft(current => current && { ...current, saving: false, error: deckError(error) }); }
  };
  const toggleCollapsed = async () => {
    if (resizing || composing.current || planningBusy || jevBusy) return;
    setResizing(true);
    try { await api.setDeckCollapsed(isNotch ? true : !floatingCollapsed); if (alive.current && presentationRef.current.mode === 'floating') setFloatingCollapsed(!floatingCollapsed); }
    catch (error) { if (alive.current) setNotice(deckError(error)); }
    finally { if (alive.current) setResizing(false); }
  };
  const changePage = (next: Page, focus = false) => {
    if (collapsed || composing.current || menuOpen || editRef.current || newDraft || planningOpen) return;
    const moveFocus = root.current?.querySelector(`[data-deck-page="${page}"]`)?.contains(document.activeElement);
    setPage(next);
    if (focus || moveFocus) (next === 'tasks' ? taskTab : usageTab).current?.focus({ preventScroll: true });
  };
  const pageState = useRef({ page, collapsed, menuOpen, hasDraft: Boolean(edit || newDraft || planningOpen) });
  pageState.current = { page, collapsed, menuOpen, hasDraft: Boolean(edit || newDraft || planningOpen) };
  const pageChange = useRef(changePage); pageChange.current = changePage;
  const [drag, setDrag] = useState(0);
  const gesture = useRef<{ id: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null } | null>(null);
  const suppressClick = useRef(0);
  useEffect(() => {
    const node = pager.current; if (!node) return;
    let amount = 0, used = false, timer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      if (pageState.current.collapsed || pageState.current.menuOpen || pageState.current.hasDraft || composing.current || event.ctrlKey || (event.target as HTMLElement).closest('input,textarea,select,.deck-owner-picker')) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.25) return;
      event.preventDefault(); clearTimeout(timer); timer = setTimeout(() => { amount = 0; used = false; }, 220);
      if (used) return;
      amount += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      if (Math.abs(amount) > 42) { used = true; pageChange.current(amount > 0 ? 'usage' : 'tasks'); }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); clearTimeout(timer); };
  }, []);

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, cancel = false) => {
    const current = gesture.current; if (!current || current.id !== event.pointerId) return;
    if (current.axis === 'x') {
      suppressClick.current = performance.now() + 400;
      if (!cancel && Math.abs(current.dx) > Math.max(46, event.currentTarget.clientWidth * .17)) changePage(current.dx < 0 ? 'usage' : 'tasks');
    }
    gesture.current = null; setDrag(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const updateEdit = (value: string) => setEdit(current => current ? { ...current, value, error: '' } : current);
  const inline = (plan: PreviewPlan, field: 'title' | 'item', item?: PlanWorkItem) => <InlineField value={field === 'title' ? plan.title : item!.title} label={field === 'title' ? '编辑任务名称' : '编辑子任务名称'} draft={edit?.planID === plan.id && edit.field === field && edit.itemID === item?.id ? edit : null} onBegin={() => void beginEdit(plan, field, item)} onChange={updateEdit} onSave={() => void saveEdit()} onCancel={cancelEdit} onReload={reloadEdit} onComposing={updateComposing} />;
  const planRow = (plan: PreviewPlan) => {
    const progress = planProgress(plan), expanded = selectedID === plan.id, pending = pendingPlans.has(plan.id);
    const newItemDraft = edit?.planID === plan.id && edit.field === 'new-item' ? edit : null;
    const metadata = <p className="deck-row-meta"><span>{progress.completed ? '已完成' : progress.done ? '进行中' : '待开始'}</span>{progress.total > 0 && <><span className="deck-mini-progress" role="progressbar" aria-label={`${plan.title}的子任务进度`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><span style={{ width: `${progress.done / progress.total * 100}%` }} /></span><span className="deck-count">{progress.done}/{progress.total}</span></>}</p>;
    return <article key={plan.id} className={`deck-task-entry ${expanded ? 'is-expanded' : ''}`} data-plan-id={plan.id}>
      {expanded ? <div className="deck-task-row deck-expanded-row"><div className="deck-task-row-copy"><h2>{inline(plan, 'title')}</h2>{metadata}</div><button type="button" className="deck-collapse-task" aria-label={`收起任务：${plan.title}`} aria-expanded="true" aria-controls={`deck-plan-${plan.id}`} title="收起任务" onClick={() => void choosePlan(null)}><ChevronDown size={13} /></button></div>
        : <button type="button" className="deck-task-row" aria-label={`展开任务：${plan.title}`} aria-expanded="false" aria-controls={`deck-plan-${plan.id}`} title={plan.title} onClick={() => void choosePlan(plan.id)}><div className="deck-task-row-copy"><h2>{plan.title}</h2>{metadata}</div><span className="deck-row-arrow"><ChevronRight size={13} /></span></button>}
      {expanded && <div className="deck-task-expansion" id={`deck-plan-${plan.id}`} role="region" aria-label={`${plan.title}的子任务`}>
        <div className="deck-subtask-heading"><h3>子任务</h3><span>分工</span></div>
        {plan.work_items.map(item => <div className={`deck-subtask-row ${item.status === 'completed' ? 'is-done' : ''}`} key={item.id} data-item-id={item.id}>
          <input type="checkbox" aria-label={`完成子任务：${item.title}`} checked={item.status === 'completed'} disabled={pending && !(edit?.planID === plan.id && edit.saving)} onChange={event => {
            const completed = event.target.checked;
            void (async () => { if (!await saveEdit()) return; await mutatePlan(plan.id, current => ({ ...current, work_items: current.work_items.map(value => value.id === item.id ? { ...value, status: completed ? 'completed' : 'planned' } : value) })); })().catch(error => setNotice(deckError(error)));
          }} />
          <div className="deck-subtask-name">{inline(plan, 'item', item)}</div>
          <AssignmentPicker value={itemAssignment(item)} sources={sources} recent={recent} collapsed={collapsed} disabled={pending} label={`分工：${item.title}`} onOpenChange={setMenuOpen} onCommit={async value => {
            if (!await saveEdit()) throw new Error('请先保存或取消当前输入，再修改分工。');
            await mutatePlan(plan.id, current => {
              if (!current.work_items.some(existing => existing.id === item.id)) throw new Error('子任务已变更，请重新检查。');
              return { ...current, work_items: current.work_items.map(existing => existing.id === item.id ? assignItem(existing, value) : existing) };
            }); remember(value);
          }} />
        </div>)}
        <div className="deck-add-item">
          {newItemDraft ? <InlineField value="" label="新子任务名称" draft={newItemDraft} onBegin={() => {}} onChange={updateEdit} onSave={() => void saveEdit()} onCancel={cancelEdit} onReload={reloadEdit} onComposing={updateComposing}>
            <AssignmentPicker value={newItemDraft.assignment} sources={sources} recent={recent} collapsed={collapsed} disabled={newItemDraft.saving} label="新子任务分工" onOpenChange={setMenuOpen} onCommit={async value => { setEdit(current => current?.key === newItemDraft.key ? { ...current, assignment: value } : current); }} />
          </InlineField> : <button type="button" className="deck-add-subtask" disabled={pending || plan.work_items.length >= 12} onClick={() => void beginEdit(plan, 'new-item')}><Plus size={11} />添加子任务</button>}
        </div>
        <button type="button" className="deck-plan-action" disabled={pending || Boolean(edit)} onClick={() => { setPlanningID(plan.id); setPlanningOpen(true); }}>规划与分工<ChevronRight size={12}/></button>
      </div>}
    </article>;
  };
  const openPlans = plans.filter(plan => !planProgress(plan).completed || selectedID === plan.id);
  const completePlans = plans.filter(plan => planProgress(plan).completed && selectedID !== plan.id);
  const planningPlan = plans.find(plan => plan.id === planningID);
  const selectedPlan = plans.find(plan => plan.id === selectedID);
  const foldedPlan = selectedPlan ?? openPlans[0] ?? completePlans[0];
  const stopVisible = Boolean(sessionID && session && isBusy(session.turns.at(-1)?.state));

  return <section ref={root} className={`deck-workbench ${collapsed ? 'is-collapsed' : ''} ${!presentationReady ? 'is-presentation-pending' : ''} ${isNotch ? 'is-notch' : 'is-floating'} presentation-${presentation.state} ${navigator.platform.toLowerCase().includes('mac') ? 'is-mac' : ''}`} data-presentation-mode={presentation.mode} data-presentation-state={isNotch ? presentation.state : collapsed ? 'collapsed' : 'expanded'} aria-label="ScreenDeck 浮窗工作台" style={{ '--deck-notch-width': `${presentation.notchWidth}px`, '--deck-notch-height': `${presentation.notchHeight}px` } as React.CSSProperties}>
    <div className="deck-notch-surface" hidden={!isNotch} aria-hidden="true" />
    <div className="deck-notch-cap" hidden={!isNotch} aria-hidden="true" />
    <div className="deck-notch-peek" hidden={!isNotch || presentation.state !== 'peeked'} aria-hidden="true"><span>任务工作台</span></div>
    <div className="deck-content-shell" hidden={!presentationReady} aria-hidden={isNotch && collapsed || undefined} inert={!presentationReady || isNotch && collapsed}>
    <header className="deck-window-bar"><Brand /><div className="deck-window-controls"><button type="button" className="deck-icon-button" aria-label={collapsed ? '展开浮窗' : '收起浮窗'} title={collapsed ? '展开浮窗' : '收起浮窗'} disabled={resizing} onClick={() => void toggleCollapsed()}>{collapsed ? <ChevronDown size={14} /> : <Minus size={14} />}</button><button type="button" className="deck-icon-button" aria-label="打开工作台" title="打开工作台" onClick={() => void api.showWorkbench(selectedID ?? undefined).catch(error => setNotice(deckError(error)))}><ExternalLink size={14} /></button></div></header>
    <div ref={pager} className="deck-pager" hidden={!isNotch && collapsed} onClickCapture={event => { if (performance.now() < suppressClick.current) { suppressClick.current = 0; event.preventDefault(); event.stopPropagation(); } }} onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || composing.current || menuOpen || edit || newDraft || planningOpen || (event.target as HTMLElement).closest('input,textarea,select,.deck-owner-picker') || window.getSelection()?.toString()) return;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, axis: null };
    }} onPointerMove={event => {
      const current = gesture.current; if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      if (!current.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) { if (Math.abs(dx) > Math.abs(dy) * 1.25) current.axis = 'x'; else if (Math.abs(dy) > Math.abs(dx) * 1.25) current.axis = 'y'; }
      if (current.axis !== 'x') return;
      event.preventDefault(); if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
      current.dx = dx; const edge = page === 'tasks' && dx > 0 || page === 'usage' && dx < 0; setDrag(Math.max(-event.currentTarget.clientWidth * .85, Math.min(event.currentTarget.clientWidth * .85, dx * (edge ? .2 : 1))));
    }} onPointerUp={event => finishPointer(event)} onPointerCancel={event => finishPointer(event, true)} onLostPointerCapture={event => { if (event.target === event.currentTarget && gesture.current?.id === event.pointerId) { gesture.current = null; setDrag(0); } }}>
      <div className={`deck-pager-track ${drag ? 'is-dragging' : ''}`} style={{ transform: `translateX(calc(${page === 'usage' ? -100 : 0}% + ${drag}px))` }}>
        <section className="deck-page" data-deck-page="tasks" id="deck-tasks-panel" role="tabpanel" aria-labelledby="deck-tasks-tab" aria-hidden={page !== 'tasks'} inert={page !== 'tasks'}>
          <div className="deck-page-heading" hidden={planningOpen}><h1>任务</h1><span>{plans.filter(plan => !planProgress(plan).completed).length} 项待完成</span></div>
          <div ref={list} hidden={planningOpen} className="deck-body-scroll" data-testid="deck-task-list" aria-busy={loading}>
            {newDraft && <article className="deck-task-composer"><div className="deck-composer-heading"><h2>新增任务</h2><button type="button" className="deck-composer-close" aria-label="取消新增任务" disabled={newDraft.saving || newDraft.submitted} onClick={() => { if (!composing.current) { setNewDraft(null); newButton.current?.focus(); } }}><X size={12} /></button></div><form onSubmit={event => { event.preventDefault(); void createPlan(); }}><input ref={composerInput} aria-label="主任务" maxLength={4000} autoComplete="off" placeholder="接下来想完成什么？" value={newDraft.title} disabled={newDraft.saving || newDraft.submitted} aria-invalid={Boolean(newDraft.error)} onChange={event => setNewDraft(current => current && { ...current, title: event.target.value, error: '' })} onCompositionStart={() => updateComposing(true)} onCompositionEnd={event => { updateComposing(false); const value = event.currentTarget.value; setNewDraft(current => current && { ...current, title: value }); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) { if (event.key === 'Enter') event.preventDefault(); return; }
              if (event.key === 'Escape' && !newDraft.saving && !newDraft.submitted) { event.preventDefault(); setNewDraft(null); newButton.current?.focus(); }
            }} />{newDraft.error && <p className="deck-inline-error" role="alert">{newDraft.error}</p>}<div className="deck-composer-actions"><button type="submit" disabled={newDraft.saving}>{newDraft.saving ? '正在创建…' : newDraft.submitted ? '核对原任务' : '创建任务'}</button></div></form></article>}
            {loading && !plans.length ? <p className="deck-empty" role="status">正在读取任务…</p> : !plans.length && !newDraft ? <div className="deck-empty"><p>还没有任务</p><small>记下接下来要做的事。</small></div> : null}
            {openPlans.map(planRow)}
            {completePlans.length > 0 && <details className="deck-completed-tasks" open={completedOpen} onToggle={event => setCompletedOpen(event.currentTarget.open)}><summary>已完成 · {completePlans.length}</summary>{completePlans.map(planRow)}</details>}
          </div>
          {planningPlan && <div className="deck-planning-view" hidden={!planningOpen}>
            <header className="deck-planning-heading"><button type="button" aria-label="返回浮窗任务" disabled={planningBusy || jevBusy} onClick={() => setPlanningOpen(false)}><ArrowLeft size={13}/>任务</button><strong title={planningPlan.title}>{planningPlan.title}</strong></header>
            <div className="deck-body-scroll deck-planning-scroll">
              <TaskPlanningPanel key={planningPlan.id} api={api} plan={planningPlan} disabled={jevBusy} onBusyChange={setPlanningBusy} onSaved={plan => acceptPlans([plan])} onOpenNative={() => void api.showWorkbench(planningPlan.id).catch(error => setNotice(deckError(error)))}/>
              <TaskJevAdvice key={'jev-'+planningPlan.id} api={api} plan={planningPlan} disabled={planningBusy} onBusyChange={setJevBusy}/>
            </div>
          </div>}
          <footer className="deck-task-footer" hidden={planningOpen}><button ref={newButton} type="button" className="deck-new-task" aria-label="新增任务" disabled={Boolean(newDraft?.saving)} onClick={async () => { if (composing.current || editRef.current && !await saveEdit()) return; setNewDraft(current => current ?? { title: '', requestID: crypto.randomUUID(), saving: false, error: '' }); }}><Plus size={12} />新增任务</button>{stopVisible && <button type="button" className="deck-resident-stop" aria-label={`停止聊天：${session!.title}`} title={`停止聊天：${session!.title}`} disabled={stopRequested} onClick={async () => {
            if (!sessionID || stopRequested) return; const target = sessionID; setStopRequested(true);
            try { await api.stopGeneration(target); const updated = await api.loadSession(target); if (selectedSessionID.current === target && updated) setSession(previous => previous && previous.revision > updated.revision ? previous : updated); }
            catch (error) { if (selectedSessionID.current === target) { setStopRequested(false); setNotice(deckError(error)); } }
          }}><Square size={11} />{stopRequested ? '请求停止中…' : '停止聊天'}</button>}</footer>
        </section>
        <section className="deck-page" data-deck-page="usage" id="deck-usage-panel" role="tabpanel" aria-labelledby="deck-usage-tab" aria-hidden={page !== 'usage'} inert={page !== 'usage'}>
          <div className="deck-body-scroll deck-usage"><h1>Agent 用量</h1><div className="deck-usage-summary"><div><span>已报告的模型消耗</span><small>ScreenDeck 内调用</small></div><strong>未报告</strong></div>
            <div className="deck-usage-row"><span>模型聊天<small>{session?.turns.at(-1)?.observed_model?.model_id ?? session?.turns.at(-1)?.requested_model.model_id ?? '尚无模型记录'}</small></span><span>未报告</span></div>
            {sources.map(source => <div className="deck-usage-row" key={source.agentID}><span>{source.name}<small>{source.state === 'ready' ? source.model.model_id : '未连接 · 跟随设置'}</small></span><span>未报告</span></div>)}
            <p className="deck-usage-note">调用尚未提供可累计的用量报告，未报告不按 0 计算。上下文占用和账户剩余额度暂不可获取。</p>
          </div>
        </section>
      </div>
    </div>
    <nav className="deck-page-switch" role="tablist" aria-label="切换浮窗页面" hidden={!isNotch && collapsed} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); changePage(event.key === 'Home' ? 'tasks' : event.key === 'End' ? 'usage' : page === 'tasks' ? 'usage' : 'tasks', true);
    }}><button ref={taskTab} type="button" role="tab" id="deck-tasks-tab" aria-controls="deck-tasks-panel" aria-selected={page === 'tasks'} tabIndex={page === 'tasks' ? 0 : -1} onClick={() => changePage('tasks', true)}><span />任务</button><button ref={usageTab} type="button" role="tab" id="deck-usage-tab" aria-controls="deck-usage-panel" aria-selected={page === 'usage'} tabIndex={page === 'usage' ? 0 : -1} onClick={() => changePage('usage', true)}><span />用量</button></nav>
    {!isNotch && collapsed && <div className="deck-folded-content"><div><p>{foldedPlan?.title ?? session?.title ?? '手头还没有任务'}</p><small>{foldedPlan ? (() => { const p = planProgress(foldedPlan); return p.total ? `${p.done}/${p.total} 项已完成` : '待开始'; })() : '展开查看任务工作台'}</small></div>{foldedPlan && planProgress(foldedPlan).total > 0 && <span className="deck-folded-progress"><span style={{ width: `${planProgress(foldedPlan).done / planProgress(foldedPlan).total * 100}%` }} /></span>}</div>}
    {notice && !collapsed && <div className="deck-notice" role="alert"><span>{notice}</span>{loadFailed && <button type="button" onClick={() => void bootstrap()}>重试</button>}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={11} /></button></div>}
    </div>
  </section>;
}
