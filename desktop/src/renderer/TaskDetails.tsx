import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, File, FileText, Plus, Trash2, X } from 'lucide-react';
import type { ArtifactPreview, ArtifactReferenceDTO, RunDTO, TaskDTO } from '../projects/types';
import type { DecisionRecommendation, ModelSelection, PlanWorkItem, PreviewPlan } from '../shared/types';
import { Empty, formatDate, Notice, TimelineRow } from './components';
import type { TaskSessionRecord } from '../shared/task-execution';
import './task-panel.css';

const taskStates: Record<string, string> = { draft: '草稿', ready: '待开始', running: '记录为运行中', awaiting_approval: '记录为待审批', verifying: '记录为验证中', awaiting_review: '记录为待验收', completed: '已完成', failed: '失败', cancelled: '已取消' };
export const taskStateLabel = (value: string) => taskStates[value] ?? '状态未知';
interface PlanDraftMemory { plan: PreviewPlan | null; items: PlanWorkItem[]; suggestions: Array<{ workItemID: string; recommendation: DecisionRecommendation }>; dirty: boolean; notice?: string }
/** Uncommitted plan input survives navigation in this renderer. Only explicit saves are durable. */
const planDraftMemory = new Map<string, PlanDraftMemory>();
const pendingPlans = new Map<string, symbol>();
const planListeners = new Map<string, Set<() => void>>();
const finishPlanOperation = (key: string, token: symbol) => {
  if (pendingPlans.get(key) !== token) return;
  pendingPlans.delete(key);
  planListeners.get(key)?.forEach(listener => listener());
};

export function StoredSummary({ text, empty = '没有保存摘要。' }: { text: string; empty?: string }) {
  const characters = Array.from(text);
  return <><p className="record-summary">{characters.length ? characters.slice(0, 220).join('') : empty}{characters.length > 220 && '…'}</p>{characters.length > 220 && <details className="summary-expand"><summary>查看全文</summary><p className="record-summary">{text}</p></details>}</>;
}

interface DetailProps {
  open: boolean;
  task: TaskDTO | null;
  runs: RunDTO[];
  references: ArtifactReferenceDTO[];
  plans: PreviewPlan[];
  model: ModelSelection | null;
  openReference?: ArtifactReferenceDTO | null;
  filePreviewOnly?: boolean;
  onFilesChange?: (hasFiles: boolean) => void;
  onClose: () => void;
  onPreview: (ref: ArtifactReferenceDTO) => Promise<ArtifactPreview>;
  onCreatePlan: (title: string, items: PlanWorkItem[]) => Promise<PreviewPlan>;
  onSavePlan: (plan: PreviewPlan) => Promise<PreviewPlan>;
  onRecommend: (plan: PreviewPlan) => Promise<Array<{ workItemID: string; recommendation: DecisionRecommendation }>>;
  onDiscussWorkItem?: (plan: PreviewPlan, workItemID: string) => void;
  onRequestWorkItem?: (plan: PreviewPlan, workItemID: string) => void;
  executionPending?: boolean;
  taskSessions?: TaskSessionRecord[];
  onOpenTaskHistory?: (record: TaskSessionRecord) => void;
}

type TaskTab = 'overview' | 'division' | 'timeline' | 'delivery';
interface OpenFile { reference: ArtifactReferenceDTO; preview: ArtifactPreview | null; loading: boolean; error: string }
const initialPlanDraft = (task: TaskDTO | null, plans: PreviewPlan[]): PlanDraftMemory => {
  const cached = task ? planDraftMemory.get(`${task.project_id}:${task.task_id}`) : undefined;
  if (cached) return cached;
  const plan = plans.filter(value => value.scope?.project_id === task?.project_id && value.scope?.task_id === task?.task_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  return { plan, items: plan?.work_items ?? [], suggestions: [], dirty: false };
};

export function TaskDetails({ open, task, runs, references, plans, model, openReference, filePreviewOnly = false, onFilesChange, onClose, onPreview, onCreatePlan, onSavePlan, onRecommend, onDiscussWorkItem, onRequestWorkItem, executionPending, taskSessions = [], onOpenTaskHistory }: DetailProps) {
  const [tab, setTab] = useState<TaskTab>('overview');
  const [taskContentOpen, setTaskContentOpen] = useState(!!task || taskSessions.length > 0);
  const [containerTab, setContainerTab] = useState(task || taskSessions.length ? 'task' : '');
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [standaloneFile, setStandaloneFile] = useState<OpenFile | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planDraft, setPlanDraft] = useState(() => initialPlanDraft(task, plans));
  const [compact, setCompact] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const fileRequests = useRef(new Map<string, number>());
  const nextFileRequest = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; fileRequests.current.clear(); }; }, []);
  // App changes the component key only for a different chat context. Hiding the
  // panel on another page, or receiving a refreshed task, does not reset tabs.
  useEffect(() => { onFilesChange?.(files.length > 0); }, [files.length, onFilesChange]);
  useEffect(() => {
    if (open && !filePreviewOnly && !taskContentOpen && !files.length && (task || taskSessions.length)) {
      setTaskContentOpen(true); setContainerTab('task');
    }
  }, [open]); // Only the user's open gesture may restore initially unloaded recovery content.

  useEffect(() => {
    const media = matchMedia('(max-width: 960px)');
    let previousFocus: HTMLElement | null = null;
    let trapping = false;
    const background = Array.from(document.querySelectorAll<HTMLElement>('#app-shell > .brand-header, #app-shell > .sidebar, #app-shell > .topbar, #center-column'));
    const previousInert = new Map<HTMLElement, string | null>();
    const modalOwnsFocus = () => document.getElementById('app-shell')?.hasAttribute('inert') ?? false;
    const restoreBackground = () => {
      previousInert.forEach((value, node) => { if (value === null) node.removeAttribute('inert'); else node.setAttribute('inert', value); });
      previousInert.clear();
    };
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter(node => !node.closest('[hidden]') && node.getClientRects().length > 0);
    const focusFirst = () => { if (!modalOwnsFocus()) (focusable()[0] ?? panel.current)?.focus(); };
    const update = () => {
      setCompact(media.matches);
      if (open && media.matches) {
        if (!trapping) {
          previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; trapping = true;
          background.forEach(node => { previousInert.set(node, node.getAttribute('inert')); node.setAttribute('inert', ''); });
          focusFirst();
        }
      } else if (trapping) {
        trapping = false; restoreBackground();
        if (!modalOwnsFocus() && previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (!trapping || modalOwnsFocus() || event.key !== 'Tab') return;
      const controls = focusable(); const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); panel.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const onFocus = (event: FocusEvent) => { if (trapping && !modalOwnsFocus() && event.target instanceof Node && !panel.current?.contains(event.target)) focusFirst(); };
    update(); media.addEventListener('change', update); document.addEventListener('keydown', onKey); document.addEventListener('focusin', onFocus);
    return () => {
      media.removeEventListener('change', update); document.removeEventListener('keydown', onKey); document.removeEventListener('focusin', onFocus);
      restoreBackground();
      if (trapping && !modalOwnsFocus() && previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
    };
  }, [open]);

  const taskRuns = runs.filter(run => run.task_id === task?.task_id).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const taskRefs = references.filter(ref => ref.owner_kind === 'task' && ref.owner_id === task?.task_id);
  const runRefs = references.filter(ref => ref.owner_kind === 'run' && taskRuns.some(run => run.run_id === ref.owner_id));
  const trials = (task ? taskSessions.filter(record => record.scope.project_id === task.project_id && record.scope.task_id === task.task_id) : [...taskSessions]).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const externalTrials = trials.some(record => record.turns.some(turn => turn.execution.spec.driver.mode === 'external'));
  const previewRef = async (reference: ArtifactReferenceDTO, standalone = false) => {
    const id = reference.reference_id; const request = ++nextFileRequest.current;
    const requestKey = `${standalone ? 'preview' : 'context'}:${id}`;
    fileRequests.current.set(requestKey, request);
    const next: OpenFile = { reference, preview: null, loading: true, error: '' };
    if (standalone) setStandaloneFile(next);
    else { setContainerTab(id); setFiles(current => current.some(file => file.reference.reference_id === id) ? current.map(file => file.reference.reference_id === id ? next : file) : [...current, next]); }
    try {
      const preview = await onPreview(reference);
      if (alive.current && fileRequests.current.get(requestKey) === request) {
        if (standalone) setStandaloneFile(current => current?.reference.reference_id === id ? { ...current, preview, loading: false } : current);
        else setFiles(current => current.map(file => file.reference.reference_id === id ? { ...file, preview, loading: false } : file));
      }
    } catch (error) {
      if (alive.current && fileRequests.current.get(requestKey) === request) {
        const message = error instanceof Error ? error.message : '文件无法读取，请重新读取。';
        if (standalone) setStandaloneFile(current => current?.reference.reference_id === id ? { ...current, loading: false, error: message } : current);
        else setFiles(current => current.map(file => file.reference.reference_id === id ? { ...file, loading: false, error: message } : file));
      }
    }
  };
  useEffect(() => { if (openReference) void previewRef(openReference, filePreviewOnly); }, [openReference, filePreviewOnly]);
  const focusRemainingContent = () => {
    if (!panel.current?.contains(document.activeElement)) return;
    requestAnimationFrame(() => {
      if (!alive.current || panel.current?.hidden || panel.current?.contains(document.activeElement)) return;
      const target = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary') ?? []).find(node => !node.closest('[hidden]') && node.getClientRects().length > 0);
      (target ?? panel.current)?.focus();
    });
  };
  const closeFile = (id: string) => {
    if (!taskContentOpen && files.length === 1) { onClose(); return; }
    focusRemainingContent();
    fileRequests.current.delete(`context:${id}`);
    const remaining = files.filter(file => file.reference.reference_id !== id); setFiles(remaining);
    if (containerTab === id) setContainerTab(taskContentOpen ? 'task' : remaining.at(-1)?.reference.reference_id ?? '');
  };
  const closeTaskContent = () => { if (!files.length) { onClose(); return; } focusRemainingContent(); setTaskContentOpen(false); if (containerTab === 'task') setContainerTab(files.at(-1)?.reference.reference_id ?? ''); };
  const showTask = () => { setTaskContentOpen(true); setContainerTab('task'); };
  const moveTo = (next: TaskTab) => { setTab(next); showTask(); };
  const refLink = (ref: ArtifactReferenceDTO) => <button key={ref.reference_id} className="task-material" onClick={() => void previewRef(ref)}><FileText size={14} /><span>{ref.label}</span></button>;
  const compactRefs = (refs: ArtifactReferenceDTO[]) => <div className="task-materials">{refs.slice(0, 2).map(refLink)}{refs.length > 2 && <details className="collapsed-materials"><summary>其余 {refs.length - 2} 项材料</summary>{refs.slice(2).map(refLink)}</details>}</div>;
  const stepLink = (label: string, next: TaskTab) => <button className="task-section-link" onClick={() => moveTo(next)}>{label}<ArrowRight size={13} /></button>;
  const visibleFiles = filePreviewOnly ? standaloneFile ? [standaloneFile] : [] : files;
  const renderFile = (file: OpenFile, standalone = false) => <div className="task-panel-body" key={`${standalone ? 'preview' : 'context'}:${file.reference.reference_id}`} hidden={standalone ? !filePreviewOnly : filePreviewOnly || containerTab !== file.reference.reference_id}><div className="file-header"><FileText size={15} /><span>{file.reference.label}</span></div><div className="file-content">{file.loading ? <div className="loading-lines" aria-label="正在读取文件"><div /><div /><div /></div> : file.error ? <Notice>{file.error}<button className="button small" onClick={() => void previewRef(file.reference, standalone)}>重新读取</button></Notice> : file.preview?.type === 'text' ? <pre>{file.preview.text}</pre> : file.preview?.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(file.preview.mime_type) ? <img alt={file.preview.label} src={`data:${file.preview.mime_type};base64,${file.preview.base64}`} /> : <Empty title="暂不支持这种文件预览">当前可预览纯文本和常见图片。</Empty>}</div></div>;

  return <>
    <button className="detail-scrim task-panel-scrim" hidden={!open} aria-label="关闭任务详情" onClick={onClose} />
    <aside id="task-context-panel" className={`detail-panel task-panel${filePreviewOnly ? ' file-preview-panel' : ''}`} ref={panel} hidden={!open} aria-label={filePreviewOnly ? '项目文件预览' : '任务详情和文件预览'} role={compact && open ? 'dialog' : undefined} aria-modal={compact && open ? true : undefined} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); } }}>
      <div className="panel-tabs task-content-tabs" role="tablist" aria-label="上下文面板">
        {!filePreviewOnly && taskContentOpen && <div className="task-content-tab"><button role="tab" aria-selected={containerTab === 'task'} className={`panel-tab ${containerTab === 'task' ? 'active' : ''}`} onClick={showTask}><FileText size={14} />任务详情</button><button className="icon-button task-content-close" aria-label="关闭任务详情内容" onClick={closeTaskContent}><X size={13} /></button></div>}
        {visibleFiles.map(file => <div className="task-content-tab" key={file.reference.reference_id}><button role="tab" aria-selected={filePreviewOnly || containerTab === file.reference.reference_id} className={`panel-tab ${filePreviewOnly || containerTab === file.reference.reference_id ? 'active' : ''}`} onClick={() => { if (!filePreviewOnly) setContainerTab(file.reference.reference_id); }} title={file.reference.label}><File size={14} /><span>{file.reference.label}</span></button><button className="icon-button task-content-close" aria-label={`关闭文件预览：${file.reference.label}`} onClick={() => filePreviewOnly ? onClose() : closeFile(file.reference.reference_id)}><X size={13} /></button></div>)}
        {!filePreviewOnly && !taskContentOpen && (task || trials.length > 0) && <button className="icon-button task-reopen-content" aria-label="打开任务详情内容" onClick={showTask}><Plus size={15} /></button>}
      </div>
      <div className="task-panel-body" hidden={filePreviewOnly || !taskContentOpen || containerTab !== 'task'}>
        {task ? <>
          <header className="detail-heading"><h1>{task.title}</h1><div className="detail-meta"><span>{taskStateLabel(task.status)}</span><span>更新于 {formatDate(task.updated_at)}</span></div></header>
          <div className="detail-tabs" role="tablist" aria-label="任务内容">{([['overview', '概览'], ['division', '分工'], ['timeline', '时间线'], ['delivery', '交付']] as const).map(([id, label]) => <button key={id} className={`detail-tab ${tab === id ? 'active' : ''}`} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
          <div className="detail-scroll">
            <div hidden={tab !== 'overview'}>
              <section className="detail-section task-overview-section"><h2>目标</h2><p className="goal">{task.goal || '原记录没有保存目标。'}</p>{compactRefs(taskRefs)}</section>
              <section className="detail-section task-overview-section"><h2>过程</h2>{taskRuns[0] ? <><StoredSummary text={taskRuns[0].summary} empty="最近一次执行没有保存摘要。" /><p className="quiet-text">最近记录 · 补录于 {formatDate(taskRuns[0].recorded_at)}</p>{compactRefs(references.filter(ref => ref.owner_kind === 'run' && ref.owner_id === taskRuns[0].run_id))}</> : <p>还没有保存的执行记录。</p>}{stepLink('查看时间线', 'timeline')}</section>
              <section className="detail-section task-overview-section"><h2>决定</h2><p>原任务没有单独保存决定。</p>{planDraft.plan && <p className="task-plan-note">已保存预览计划 v{planDraft.plan.version} · {planDraft.plan.work_items.length} 个工作项。保存计划不会开始执行。</p>}{stepLink('查看分工', 'division')}</section>
              <section className="detail-section task-overview-section"><h2>产物</h2>{runRefs.length ? <>{compactRefs(runRefs)}<p className="field-help">原执行记录关联的材料，不代表已验收。</p></> : <p>尚无关联的交付材料。</p>}{stepLink('查看交付', 'delivery')}</section>
            </div>
            <div hidden={tab !== 'division'}>
              <div className="task-section-heading"><div><h2>工作项</h2><p className="field-help">独立预览计划{planDraft.plan ? ` · v${planDraft.plan.version}` : ''}{planDraft.dirty ? ' · 尚未保存' : ''}</p></div><button className="button small ghost task-edit-plan" aria-expanded={editingPlan} onClick={() => setEditingPlan(value => !value)}>{editingPlan ? '收起编辑' : '编辑计划'}</button></div>
              <div className="task-work-items" data-testid="task-work-items" hidden={editingPlan}>{planDraft.items.length ? planDraft.items.map((item, index) => <article className="task-work-item" key={item.id}><span className="task-work-number">{index + 1}</span><div><h3>{item.title || '尚未填写的工作项'}</h3><p>{item.expected_result || '尚未填写预期结果'}</p><div className="task-work-meta"><span>{item.assignee === 'human' ? '由你处理' : item.assignee === 'chat' ? '模型讨论' : '待分工'}</span>{item.dependencies.length > 0 && <span>{item.dependencies.length} 项依赖</span>}</div>{planDraft.plan && onDiscussWorkItem && <button className="task-section-link" disabled={planDraft.dirty || pendingPlans.has(`${task.project_id}:${task.task_id}`) || !planDraft.plan.work_items.some(saved => saved.id === item.id)} onClick={() => onDiscussWorkItem(planDraft.plan!, item.id)}>讨论这一步<ArrowRight size={13} /></button>}{planDraft.plan && onRequestWorkItem && item.kind === 'discussion' && item.assignee === 'unassigned' && <button className="task-section-link" disabled={executionPending || planDraft.dirty || pendingPlans.has(`${task.project_id}:${task.task_id}`) || !planDraft.plan.work_items.some(saved => saved.id === item.id)} onClick={() => onRequestWorkItem(planDraft.plan!, item.id)}>{executionPending ? '正在准备…' : '用 OpenCode 讨论'}<ArrowRight size={13} /></button>}</div></article>) : <p className="quiet-text">还没有预览工作项。可编辑计划，记录下一步。</p>}</div>
              <div hidden={!editingPlan} className="task-plan-editor"><PlanEditor key={`${task.project_id}:${task.task_id}`} task={task} plans={plans} model={model} onCreate={onCreatePlan} onSave={onSavePlan} onRecommend={onRecommend} onDraftChange={setPlanDraft} /></div>
              <p className="field-help task-plan-boundary">讨论这一步只准备聊天输入；不调用模型或启动执行。计划编辑不回写原任务。</p>
            </div>
            <div hidden={tab !== 'timeline'}>
              {taskRuns.length ? taskRuns.map(run => <TimelineRow key={run.run_id} title={run.status === 'completed' ? '执行已结束' : run.status === 'failed' ? '执行失败' : run.status === 'interrupted' ? '执行中断' : '历史运行记录'} date={run.started_at} state={<span className="task-status">只读</span>}><StoredSummary text={run.summary} /><details open={run.status === 'failed'}><summary>查看记录细节 <ChevronDown size={11} /></summary><p>Agent：{run.executor.agent || '未记录'}<br />模型：{run.executor.model || '未记录'}<br />结束时间：{formatDate(run.ended_at)}<br />补录时间：{formatDate(run.recorded_at)}</p><pre>{run.run_id}</pre></details>{compactRefs(references.filter(ref => ref.owner_kind === 'run' && ref.owner_id === run.run_id))}</TimelineRow>) : <p className="quiet-text">原任务没有保存的执行时间线。</p>}
              {trials.length > 0 && <section className="detail-section task-trial-history" data-testid="task-trial-history"><h2>{externalTrials ? '执行记录' : '预览试运行记录'}</h2><p className="field-help">{externalTrials ? '按来源查看执行事实；文本结束不代表工具执行或原任务完成。' : '仅保留之前的模拟事实，不代表真实工具执行或原任务进度。'}</p>{trials.map(record => <div className="task-trial-row" key={record.conversation_id}><div><strong>{record.title}</strong><time>{formatDate(record.updated_at)}</time></div>{onOpenTaskHistory && <button className="button small ghost" aria-label={`查看试运行记录：${record.title}`} onClick={() => onOpenTaskHistory(record)}>查看记录<ArrowRight size={13} /></button>}</div>)}</section>}
            </div>
            <div hidden={tab !== 'delivery'}><section className="detail-section"><h2>交付材料</h2>{runRefs.length ? <div className="task-materials">{runRefs.map(refLink)}</div> : <p>执行记录中没有关联交付材料。</p>}<p className="field-help">文件被关联不等于验收通过，以下仅展示原始记录。</p></section>{task.acceptance.length > 0 && <section className="detail-section"><h2>验证记录</h2>{task.acceptance.slice(0, 3).map(item => <p key={item.id}>{item.verification === 'verified' ? '✓ 已验证' : item.verification === 'failed' ? '验证失败' : '未检查'} · {item.description}</p>)}{task.acceptance.length > 3 && <details><summary className="quiet-text">其余 {task.acceptance.length - 3} 项</summary>{task.acceptance.slice(3).map(item => <p key={item.id}>{item.verification === 'verified' ? '已验证' : item.verification === 'failed' ? '验证失败' : '未检查'} · {item.description}</p>)}</details>}</section>}</div>
          </div>
        </> : <div className="detail-scroll task-recovery-scroll">{!trials.length && <Empty icon={<FileText size={24} />} title="选择一项任务">从左侧选择任务，在这里查看目标、分工与记录。</Empty>}{trials.length > 0 && <section className="detail-section task-trial-history" data-testid="task-trial-history"><h2>{externalTrials ? '已保存的执行记录' : '已保存的试运行记录'}</h2><p className="field-help">原任务暂不可读，仍可查看已保存的执行事实。</p>{trials.map(record => <div className="task-trial-row" key={record.conversation_id}><div><strong>{record.title}</strong><p className="task-recovery-scope">任务：{record.scope.task_id}<br />项目：{record.scope.project_id}</p><time>{formatDate(record.updated_at)}</time></div>{onOpenTaskHistory && <button className="button small ghost" aria-label={`查看试运行记录：${record.title}`} onClick={() => onOpenTaskHistory(record)}>查看记录<ArrowRight size={13} /></button>}</div>)}</section>}</div>}
      </div>
      {files.map(file => renderFile(file))}
      {standaloneFile && renderFile(standaloneFile, true)}
    </aside>
  </>;
}

function PlanEditor({ task, plans, model, onCreate, onSave, onRecommend, onDraftChange }: { task: TaskDTO; plans: PreviewPlan[]; model: ModelSelection | null; onCreate: DetailProps['onCreatePlan']; onSave: DetailProps['onSavePlan']; onRecommend: DetailProps['onRecommend']; onDraftChange: (draft: PlanDraftMemory) => void }) {
  const cacheKey = `${task.project_id}:${task.task_id}`;
  const stored = planDraftMemory.get(cacheKey);
  const cached = stored?.plan && (stored.plan.scope?.project_id !== task.project_id || stored.plan.scope?.task_id !== task.task_id) ? { ...stored, plan: null, dirty: stored.items.length > 0, suggestions: [] } : stored;
  const onlyScopedPlan = !cached ? plans.filter(value => value.scope?.project_id === task.project_id && value.scope?.task_id === task.task_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null : null;
  const [plan, setPlan] = useState<PreviewPlan | null>(cached?.plan ?? onlyScopedPlan);
  const [items, setItems] = useState<PlanWorkItem[]>(cached?.items ?? onlyScopedPlan?.work_items ?? []);
  const [busy, setBusy] = useState(pendingPlans.has(cacheKey));
  const [notice, setNotice] = useState(cached?.notice ?? '');
  const [suggestions, setSuggestions] = useState<Array<{ workItemID: string; recommendation: DecisionRecommendation }>>(cached?.suggestions ?? []);
  const [dirty, setDirty] = useState(cached?.dirty ?? false);
  useEffect(() => { const draft = { plan, items, suggestions, dirty, notice }; planDraftMemory.set(cacheKey, draft); onDraftChange(draft); }, [cacheKey, plan, items, suggestions, dirty, notice, onDraftChange]);
  useEffect(() => {
    const listener = () => { const current = planDraftMemory.get(cacheKey); setBusy(pendingPlans.has(cacheKey)); if (current) { setPlan(current.plan); setItems(current.items); setSuggestions(current.suggestions); setDirty(current.dirty); setNotice(current.notice ?? ''); } };
    const listeners = planListeners.get(cacheKey) ?? new Set<() => void>(); listeners.add(listener); planListeners.set(cacheKey, listeners);
    listener();
    return () => { listeners.delete(listener); if (!listeners.size) planListeners.delete(cacheKey); };
  }, [cacheKey]);
  const update = (id: string, change: Partial<PlanWorkItem>) => { setItems(current => current.map(item => item.id === id ? { ...item, ...change } : item)); setDirty(true); setSuggestions([]); setNotice(''); };
  const addItem = () => { setItems(current => [...current, { id: crypto.randomUUID(), title: '', kind: 'discussion', assignee: 'unassigned', expected_result: '', dependencies: [], status: 'planned' }]); setDirty(true); setSuggestions([]); setNotice(''); };
  const valid = items.length > 0 && items.every(item => item.title.trim() && item.expected_result.trim() && (item.assignee !== 'chat' || (item.kind === 'discussion' && item.model)));
  const save = async () => {
    if (busy || pendingPlans.has(cacheKey)) return;
    if (!valid) { setNotice('请填写每项工作的内容与预期结果；聊天分工需要指定模型。'); return; }
    const token = Symbol(); pendingPlans.set(cacheKey, token); setBusy(true); setNotice('');
    try { const saved = plan ? await onSave({ ...plan, work_items: items }) : await onCreate(`${task.title} · 分工`, items); planDraftMemory.set(cacheKey, { plan: saved, items: saved.work_items, suggestions: [], dirty: false, notice: `已保存预览计划 · ${formatDate(saved.updated_at)}。工作项尚未执行。` }); }
    catch (error) { const current = planDraftMemory.get(cacheKey); if (current) planDraftMemory.set(cacheKey, { ...current, notice: error instanceof Error ? error.message : '保存失败，输入已保留，可重试。' }); }
    finally { finishPlanOperation(cacheKey, token); }
  };
  const recommend = async () => {
    if (busy || pendingPlans.has(cacheKey)) return;
    if (!valid || !plan || dirty) { setNotice('保存当前计划后，可以查看规则建议。'); return; }
    const token = Symbol(); pendingPlans.set(cacheKey, token); setBusy(true); setNotice('');
    try { const recommendations = await onRecommend(plan); const current = planDraftMemory.get(cacheKey); if (current) planDraftMemory.set(cacheKey, { ...current, suggestions: recommendations, notice: '' }); }
    catch (error) { const current = planDraftMemory.get(cacheKey); if (current) planDraftMemory.set(cacheKey, { ...current, notice: error instanceof Error ? error.message : '无法获取建议。' }); }
    finally { finishPlanOperation(cacheKey, token); }
  };
  return <fieldset className="plain-fieldset" disabled={busy} aria-busy={busy}><p className="quiet-text">原任务记录没有分工步骤。这里可独立保存下一步预览计划，保存后由你决定如何推进。</p>{plans.length > 0 && <div className="field"><label htmlFor="existing-plan">打开已保存的预览计划</label><select id="existing-plan" value={plan?.id ?? ''} onChange={event => { const selected = plans.find(item => item.id === event.target.value) ?? null; if (dirty) { setNotice('当前输入尚未保存，请先保存；新计划可在保存后切换。'); return; } setPlan(selected); setItems(selected?.work_items ?? []); setSuggestions([]); }}><option value="">新计划</option>{plans.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>}
    <div className="plan-toolbar"><button className="button small" onClick={addItem}><Plus size={13} />添加工作项</button><button className="button small ghost" disabled={busy || !valid || !plan || dirty} onClick={() => void recommend()}>规则建议</button></div>
    <div className="plan-form">{items.map((item, index) => <div className="plan-item" key={item.id}><div className="plan-item-head"><input aria-label={`工作项 ${index + 1} 内容`} placeholder="要完成什么？" value={item.title} onChange={event => update(item.id, { title: event.target.value })} /><button className="icon-button" aria-label={`删除工作项 ${index + 1}`} onClick={() => { setItems(current => current.filter(value => value.id !== item.id).map(value => ({ ...value, dependencies: value.dependencies.filter(id => id !== item.id) }))); setDirty(true); setSuggestions([]); setNotice(''); }}><Trash2 size={14} /></button></div><div className="plan-item-options"><select aria-label={`工作项 ${index + 1} 类型`} value={item.kind} onChange={event => { const kind = event.target.value as PlanWorkItem['kind']; update(item.id, { kind, ...(kind !== 'discussion' && item.assignee === 'chat' ? { assignee: 'unassigned', model: undefined } : {}) }); }}><option value="discussion">讨论</option><option value="implementation">实施</option><option value="validation">验证</option></select><select aria-label={`工作项 ${index + 1} 分工`} value={item.assignee} onChange={event => { const assignee = event.target.value as PlanWorkItem['assignee']; update(item.id, { assignee, model: assignee === 'chat' ? model ?? undefined : undefined }); }}><option value="unassigned">待分工</option><option value="human">由我处理</option><option value="chat" disabled={item.kind !== 'discussion' || !model}>指定模型讨论</option></select></div><div className="field" style={{ marginTop: 9 }}><input aria-label={`工作项 ${index + 1} 预期结果`} placeholder="预期得到什么结果？" value={item.expected_result} onChange={event => update(item.id, { expected_result: event.target.value })} /></div>{items.length > 1 && <div className="field" style={{ marginTop: 9 }}><label>依赖</label>{items.filter(value => value.id !== item.id).map(dependency => <label className="dependency-choice" key={dependency.id}><input type="checkbox" checked={item.dependencies.includes(dependency.id)} onChange={event => update(item.id, { dependencies: event.target.checked ? [...item.dependencies, dependency.id] : item.dependencies.filter(id => id !== dependency.id) })} />{dependency.title || '尚未填写的工作项'}</label>)}</div>}{item.assignee === 'chat' && item.model && <p className="field-help">指定模型：{item.model.model_id} · 保存后不会发起请求</p>}{suggestions.find(value => value.workItemID === item.id) && <div className="plan-suggestion">建议：{suggestions.find(value => value.workItemID === item.id)!.recommendation.candidate === 'human' ? '由你处理' : '模型讨论'}<br />{suggestions.find(value => value.workItemID === item.id)!.recommendation.reasons.join('；')}<br />建议仅供判断，不会改动手动分工。</div>}</div>)}</div>

    {items.length > 0 && <><div className="plan-toolbar"><button className="button primary small" disabled={busy || !valid} onClick={() => void save()}>{busy ? '处理中…' : '保存计划'}</button>{dirty && <span className="field-help">尚未保存</span>}{plan && !dirty && <span className="field-help"><Check size={12} /> v{plan.version}</span>}</div>{!valid && <p className="field-help">填写工作内容和预期结果后可保存。</p>}</>}{notice && <div className="saved-status" role="status">{notice}</div>}
  </fieldset>;
}
