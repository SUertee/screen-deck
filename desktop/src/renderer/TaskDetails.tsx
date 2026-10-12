import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, File, FileText, Plus, Trash2, X } from 'lucide-react';
import type { ArtifactPreview, ArtifactReferenceDTO, RunDTO, TaskDTO } from '../projects/types';
import type { DecisionRecommendation, ModelSelection, PlanWorkItem, PreviewPlan } from '../shared/types';
import { Empty, formatDate, Notice, TimelineRow } from './components';

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
  task: TaskDTO | null;
  projectName: string;
  runs: RunDTO[];
  references: ArtifactReferenceDTO[];
  plans: PreviewPlan[];
  model: ModelSelection | null;
  openReference?: ArtifactReferenceDTO | null;
  onClose: () => void;
  onPreview: (ref: ArtifactReferenceDTO) => Promise<ArtifactPreview>;
  onCreatePlan: (title: string, items: PlanWorkItem[]) => Promise<PreviewPlan>;
  onSavePlan: (plan: PreviewPlan) => Promise<PreviewPlan>;
  onRecommend: (plan: PreviewPlan) => Promise<Array<{ workItemID: string; recommendation: DecisionRecommendation }>>;
}

export function TaskDetails({ task, projectName, runs, references, plans, model, openReference, onClose, onPreview, onCreatePlan, onSavePlan, onRecommend }: DetailProps) {
  const [tab, setTab] = useState<'overview' | 'division' | 'timeline' | 'delivery'>('overview');
  const [containerTab, setContainerTab] = useState<'task' | 'file'>('task');
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [previewReference, setPreviewReference] = useState<ArtifactReferenceDTO | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const previewGeneration = useRef(0);
  useEffect(() => { previewGeneration.current++; setTab('overview'); setContainerTab('task'); setPreview(null); setPreviewReference(null); setPreviewError(''); setPreviewLoading(false); }, [task?.project_id, task?.task_id]);
  useEffect(() => {
    // Matches styles.css: compact panels lock chat; desktop columns remain interactive.
    const media = matchMedia('(max-width: 960px)');
    let lastFocus: HTMLElement | null = null;
    const update = () => {
      const center = document.getElementById('center-column');
      if (media.matches) {
        lastFocus = document.activeElement as HTMLElement;
        center?.setAttribute('inert', '');
        panel.current?.querySelector<HTMLElement>('button')?.focus();
      } else { center?.removeAttribute('inert'); }
    };
    update(); media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); document.getElementById('center-column')?.removeAttribute('inert'); lastFocus?.focus(); };
  }, []);
  const taskRuns = runs.filter(run => run.task_id === task?.task_id).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const taskRefs = references.filter(ref => ref.owner_kind === 'task' && ref.owner_id === task?.task_id);
  const runRefs = references.filter(ref => ref.owner_kind === 'run' && taskRuns.some(run => run.run_id === ref.owner_id));
  const previewRef = async (ref: ArtifactReferenceDTO) => {
    const generation = ++previewGeneration.current;
    setContainerTab('file'); setPreview(null); setPreviewReference(ref); setPreviewLoading(true); setPreviewError('');
    try { const loaded = await onPreview(ref); if (generation === previewGeneration.current) setPreview(loaded); } catch (error) { if (generation === previewGeneration.current) setPreviewError(error instanceof Error ? error.message : '文件预览失败，请重试。'); }
    finally { if (generation === previewGeneration.current) setPreviewLoading(false); }
  };
  const refLink = (ref: ArtifactReferenceDTO) => <button key={ref.reference_id} className="artifact-link" onClick={() => void previewRef(ref)}><FileText size={14} /><span>{ref.label}</span></button>;
  const compactRefs = (refs: ArtifactReferenceDTO[]) => <>{refs.slice(0, 2).map(refLink)}{refs.length > 2 && <details className="collapsed-materials"><summary>其余 {refs.length - 2} 项材料</summary>{refs.slice(2).map(refLink)}</details>}</>;
  useEffect(() => { if (openReference) void previewRef(openReference); }, [openReference?.reference_id]);

  return <><button className="detail-scrim" aria-label="关闭任务详情" onClick={onClose} /><aside className="detail-panel" ref={panel} aria-label="任务详情和文件预览" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) onClose(); }}>
    <div className="panel-tabs" role="tablist" aria-label="上下文面板"><button role="tab" aria-selected={containerTab === 'task'} className={`panel-tab ${containerTab === 'task' ? 'active' : ''}`} onClick={() => setContainerTab('task')}>任务详情</button>{(preview || previewLoading || previewError) && <button role="tab" aria-selected={containerTab === 'file'} className={`panel-tab ${containerTab === 'file' ? 'active' : ''}`} onClick={() => setContainerTab('file')}><File size={13} />文件预览</button>}<button className="icon-button" aria-label="关闭详情面板" onClick={onClose}><X size={16} /></button></div>
    {containerTab === 'file' ? <><div className="file-header"><FileText size={15} /><span>{preview?.label ?? previewReference?.label ?? '文件预览'}</span></div><div className="file-content">{previewLoading ? <div className="loading-lines" aria-label="正在读取文件"><div /><div /><div /></div> : previewError ? <Notice>{previewError}{previewReference && <button className="button small" onClick={() => void previewRef(previewReference)}>重新读取</button>}</Notice> : preview?.type === 'text' ? <pre>{preview.text}</pre> : preview?.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(preview.mime_type) ? <img alt={preview.label} src={`data:${preview.mime_type};base64,${preview.base64}`} /> : <Empty title="暂不支持这种文件预览">当前可预览纯文本和常见图片。</Empty>}</div></> : <>
      {task ? <><header className="detail-heading"><h1>{task.title}</h1><div className="detail-meta"><span>{projectName}</span><span>·</span><span>{taskStateLabel(task.status)}</span><span>· 只读历史</span></div></header><div className="detail-tabs" role="tablist" aria-label="任务内容">{([['overview', '概览'], ['division', '分工'], ['timeline', '时间线'], ['delivery', '交付']] as const).map(([id, label]) => <button key={id} className={`detail-tab ${tab === id ? 'active' : ''}`} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div><div className="detail-scroll">
        {tab === 'overview' && <><section className="detail-section"><h2>目标</h2><p className="goal">{task.goal || '原记录没有保存目标。'}</p>{compactRefs(taskRefs)}</section><section className="detail-section"><h2>过程</h2>{taskRuns[0] ? <><StoredSummary text={taskRuns[0].summary} empty="这一条执行没有保存摘要。" /><p className="quiet-text">最近记录 · 补录于 {formatDate(taskRuns[0].recorded_at)}</p>{compactRefs(references.filter(ref => ref.owner_kind === 'run' && ref.owner_id === taskRuns[0].run_id))}</> : <p>还没有可读取的执行记录。</p>}</section><section className="detail-section"><h2>决定</h2><p>原记录没有单独保存决定。</p></section><section className="detail-section"><h2>产物</h2>{runRefs.length ? <>{compactRefs(runRefs)}<p className="field-help">执行记录关联的材料，不代表已验收。</p></> : <p>执行记录中还没有关联材料。</p>}<button className="button small ghost" onClick={() => setTab('delivery')}>查看交付记录</button></section></>}
        <div hidden={tab !== 'division'}><PlanEditor key={`${task.project_id}:${task.task_id}`} task={task} plans={plans} model={model} onCreate={onCreatePlan} onSave={onSavePlan} onRecommend={onRecommend} /></div>
        {tab === 'timeline' && <>{taskRuns.length ? taskRuns.map(run => <TimelineRow key={run.run_id} title={run.status === 'completed' ? '执行已结束' : run.status === 'failed' ? '执行失败' : run.status === 'interrupted' ? '执行中断' : '历史运行记录'} date={run.started_at} state={<span className="task-status">只读</span>}><StoredSummary text={run.summary} /><details open={run.status === 'failed'}><summary>查看记录细节 <ChevronDown size={11} /></summary><p>Agent：{run.executor.agent || '未记录'}<br />模型：{run.executor.model || '未记录'}<br />结束时间：{formatDate(run.ended_at)}<br />补录时间：{formatDate(run.recorded_at)}</p><pre>{run.run_id}</pre></details>{compactRefs(references.filter(ref => ref.owner_kind === 'run' && ref.owner_id === run.run_id))}</TimelineRow>) : <Empty title="还没有执行时间线">这里仅显示项目中实际保存的记录。</Empty>}</>}
        {tab === 'delivery' && <><section className="detail-section"><h2>交付材料</h2>{runRefs.length ? runRefs.map(refLink) : <p>执行记录中没有关联交付材料。</p>}<p className="field-help">关联文件表示材料已记录，验证结果以原始记录为准。</p></section>{task.acceptance.length > 0 && <section className="detail-section"><h2>验证记录</h2>{task.acceptance.slice(0, 3).map(item => <p key={item.id}>{item.verification === 'verified' ? '✓ 已验证' : item.verification === 'failed' ? '验证失败' : '未检查'} · {item.description}</p>)}{task.acceptance.length > 3 && <details><summary className="quiet-text">其余 {task.acceptance.length - 3} 项</summary>{task.acceptance.slice(3).map(item => <p key={item.id}>{item.verification === 'verified' ? '已验证' : item.verification === 'failed' ? '验证失败' : '未检查'} · {item.description}</p>)}</details>}</section>}</>}
      </div></> : <Empty icon={<FileText size={24} />} title="选择一项任务">从左侧项目打开任务，查看目标、执行记录和交付材料。</Empty>}
    </>}
  </aside></>;
}

function PlanEditor({ task, plans, model, onCreate, onSave, onRecommend }: { task: TaskDTO; plans: PreviewPlan[]; model: ModelSelection | null; onCreate: DetailProps['onCreatePlan']; onSave: DetailProps['onSavePlan']; onRecommend: DetailProps['onRecommend'] }) {
  const cacheKey = `${task.project_id}:${task.task_id}`;
  const stored = planDraftMemory.get(cacheKey);
  const cached = stored?.plan && (stored.plan.scope?.project_id !== task.project_id || stored.plan.scope?.task_id !== task.task_id) ? { ...stored, plan: null, dirty: stored.items.length > 0, suggestions: [] } : stored;
  const onlyScopedPlan = !cached && plans.length === 1 && plans[0].scope?.project_id === task.project_id && plans[0].scope?.task_id === task.task_id ? plans[0] : null;
  const [plan, setPlan] = useState<PreviewPlan | null>(cached?.plan ?? onlyScopedPlan);
  const [items, setItems] = useState<PlanWorkItem[]>(cached?.items ?? onlyScopedPlan?.work_items ?? []);
  const [busy, setBusy] = useState(pendingPlans.has(cacheKey));
  const [notice, setNotice] = useState(cached?.notice ?? '');
  const [suggestions, setSuggestions] = useState<Array<{ workItemID: string; recommendation: DecisionRecommendation }>>(cached?.suggestions ?? []);
  const [dirty, setDirty] = useState(cached?.dirty ?? false);
  useEffect(() => { planDraftMemory.set(cacheKey, { plan, items, suggestions, dirty, notice }); }, [cacheKey, plan, items, suggestions, dirty, notice]);
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
  return <fieldset className="plain-fieldset" disabled={busy}><p className="quiet-text">原任务记录没有分工步骤。这里可独立保存下一步预览计划，保存后由你决定如何推进。</p>{plans.length > 0 && <div className="field"><label htmlFor="existing-plan">打开已保存的预览计划</label><select id="existing-plan" value={plan?.id ?? ''} onChange={event => { const selected = plans.find(item => item.id === event.target.value) ?? null; if (dirty) { setNotice('当前输入尚未保存，请先保存；新计划可在保存后切换。'); return; } setPlan(selected); setItems(selected?.work_items ?? []); setSuggestions([]); }}><option value="">新计划</option>{plans.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>}
    <div className="plan-toolbar"><button className="button small" onClick={addItem}><Plus size={13} />添加工作项</button><button className="button small ghost" disabled={busy || !valid || !plan || dirty} onClick={() => void recommend()}>规则建议</button></div>
    <div className="plan-form">{items.map((item, index) => <div className="plan-item" key={item.id}><div className="plan-item-head"><input aria-label={`工作项 ${index + 1} 内容`} placeholder="要完成什么？" value={item.title} onChange={event => update(item.id, { title: event.target.value })} /><button className="icon-button" aria-label={`删除工作项 ${index + 1}`} onClick={() => { setItems(current => current.filter(value => value.id !== item.id).map(value => ({ ...value, dependencies: value.dependencies.filter(id => id !== item.id) }))); setDirty(true); setSuggestions([]); setNotice(''); }}><Trash2 size={14} /></button></div><div className="plan-item-options"><select aria-label={`工作项 ${index + 1} 类型`} value={item.kind} onChange={event => { const kind = event.target.value as PlanWorkItem['kind']; update(item.id, { kind, ...(kind !== 'discussion' && item.assignee === 'chat' ? { assignee: 'unassigned', model: undefined } : {}) }); }}><option value="discussion">讨论</option><option value="implementation">实施</option><option value="validation">验证</option></select><select aria-label={`工作项 ${index + 1} 分工`} value={item.assignee} onChange={event => { const assignee = event.target.value as PlanWorkItem['assignee']; update(item.id, { assignee, model: assignee === 'chat' ? model ?? undefined : undefined }); }}><option value="unassigned">待分工</option><option value="human">由我处理</option><option value="chat" disabled={item.kind !== 'discussion' || !model}>指定模型讨论</option></select></div><div className="field" style={{ marginTop: 9 }}><input aria-label={`工作项 ${index + 1} 预期结果`} placeholder="预期得到什么结果？" value={item.expected_result} onChange={event => update(item.id, { expected_result: event.target.value })} /></div>{items.length > 1 && <div className="field" style={{ marginTop: 9 }}><label>依赖</label>{items.filter(value => value.id !== item.id).map(dependency => <label className="dependency-choice" key={dependency.id}><input type="checkbox" checked={item.dependencies.includes(dependency.id)} onChange={event => update(item.id, { dependencies: event.target.checked ? [...item.dependencies, dependency.id] : item.dependencies.filter(id => id !== dependency.id) })} />{dependency.title || '尚未填写的工作项'}</label>)}</div>}{item.assignee === 'chat' && item.model && <p className="field-help">指定模型：{item.model.model_id} · 保存后不会发起请求</p>}{suggestions.find(value => value.workItemID === item.id) && <div className="plan-suggestion">建议：{suggestions.find(value => value.workItemID === item.id)!.recommendation.candidate === 'human' ? '由你处理' : '模型讨论'}<br />{suggestions.find(value => value.workItemID === item.id)!.recommendation.reasons.join('；')}<br />建议仅供判断，不会改动手动分工。</div>}</div>)}</div>
    {items.length > 0 && <><div className="plan-toolbar"><button className="button primary small" disabled={busy || !valid} onClick={() => void save()}>{busy ? '处理中…' : '保存计划'}</button>{dirty && <span className="field-help">尚未保存</span>}{plan && !dirty && <span className="field-help"><Check size={12} /> v{plan.version}</span>}</div>{!valid && <p className="field-help">填写工作内容和预期结果后可保存。</p>}</>}{notice && <div className="saved-status" role="status">{notice}</div>}
  </fieldset>;
}
