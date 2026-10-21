import { ChatTaskOrigin } from '../task-chat/ChatTaskOrigin';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, FileText, Plus, RefreshCw, Search, Trash2, X, Columns3, List, LoaderCircle } from 'lucide-react';
import type { PlanWorkItem, PreviewPlan, TaskContent, TaskReference } from '../../shared/types';
import type { AgentChatSourceInfo } from '../../shared/agent-chat';
import type { ProjectWorkspaceResult } from '../../projects/types';
import { taskStateLabel } from '../TaskDetails';
import { planProgress } from '../deck/deck-model';
import type { DesktopAPI } from '../../shared/desktop-api';
import { taskBoardStatus, taskColumns, type TaskBoardStatus, type TaskColumn } from './task-board-model';
import { useTaskBoard } from './use-task-board';
import './tasks.css';

export const taskKey = (ref: TaskReference) => ref.kind === 'local' ? `local:${ref.planID}` : `project:${ref.projectID}:${ref.taskID}`;
export const taskContent = (plan: PreviewPlan): TaskContent => structuredClone(plan.task ?? { goal: '', completion_conditions: [], materials: [], chat_refs: [] });
type Draft = { plan: PreviewPlan; dirty: boolean; pending: boolean; error: string };
export type TaskDraftMemory = Map<string, Draft>;
const message = (error: unknown) => (error instanceof Error ? error.message : '保存失败，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
interface DetailProps {
  projects?: ProjectWorkspaceResult[];
  plan: PreviewPlan; memory: TaskDraftMemory; agents: AgentChatSourceInfo[];
  onSave(plan: PreviewPlan): Promise<PreviewPlan>; onDeck(plan: PreviewPlan): Promise<void>;
  onOpenScreen?(frameID: string): void;
  renderExtra?(plan: PreviewPlan, disabled: boolean): React.ReactNode;
  renderPlanAction?(plan:PreviewPlan,disabled:boolean):React.ReactNode;
  onDiscuss(plan: PreviewPlan, workItemID?: string): void;
}
/** Shared content, separate draft memories supplied by the page and the chat sidebar. */
export function TaskDetailContent({ plan, memory, agents, onSave, onDeck, onDiscuss, renderExtra, renderPlanAction, onOpenScreen, projects = [] }: DetailProps) {
  const [draft, setDraft] = useState<Draft>(() => memory.get(plan.id) ?? { plan: structuredClone(plan), dirty: false, pending: false, error: '' });
  const [editing,setEditing]=useState(()=>memory.get(plan.id)?.dirty??false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const commit = (next: Draft) => { memory.set(plan.id, next); if (alive.current) setDraft(next); };
  useEffect(() => {
    const cached = memory.get(plan.id);
    if (cached && cached !== draft) { setDraft(cached); return; }
    if (plan.version > draft.plan.version && !draft.dirty && !draft.pending) commit({ plan: structuredClone(plan), dirty: false, pending: false, error: '' });
  }, [plan, memory]);
  const update = (next: PreviewPlan) => commit({ plan: { ...next, schema_version: 3, task: taskContent(next) }, dirty: true, pending: false, error: '' });
  const content = taskContent(draft.plan);
  const updateContent = (patch: Partial<TaskContent>) => update({ ...draft.plan, task: { ...content, ...patch } });
  const itemChange = (id: string, patch: Partial<PlanWorkItem>) => update({ ...draft.plan, work_items: draft.plan.work_items.map(item => item.id === id ? { ...item, ...patch } : item) });
  const conflict = plan.version > draft.plan.version;
  const run = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { commit({ ...draft, error: message(error) }); } };
  return <div className="task-detail-content" data-plan-detail={plan.id}>
    <div className="task-detail-toolbar"><span>本地任务 · v{draft.plan.version}</span><div><button className="button small ghost" onClick={() => void run(() => onDeck(plan))}>在 Deck 查看<ArrowUpRight size={13} /></button><button className="button small" disabled={draft.dirty || draft.pending} onClick={() => onDiscuss(plan)}>讨论任务</button></div></div>
    <section className="task-summary" aria-label="主任务摘要"><div className="task-summary-heading"><h2>{draft.plan.title}</h2><button type="button" className="text-button" aria-expanded={editing} onClick={()=>setEditing(value=>!value)}>{editing?'收起编辑':'编辑任务与步骤'}</button></div>
      {content.goal && content.goal!==draft.plan.title && <p className="task-summary-goal">{content.goal.length>180?content.goal.slice(0,180)+'…':content.goal}</p>}
      {content.goal.length>180 && <details><summary>查看完整目标</summary><p>{content.goal}</p></details>}
      <p className="task-summary-meta">{content.project_id?projects.find(p=>p.project?.project_id===content.project_id)?.project?.name??'原项目':'独立任务'} · {content.completion_conditions.length} 项条件 · {content.materials.length} 份材料{draft.dirty?' · 有未保存修改':''}</p>
      {content.completion_conditions.length>0&&<details><summary>完成条件</summary>{content.completion_conditions.map((condition,index)=><p key={index}>{condition}</p>)}</details>}
      {content.materials.length>0&&<details><summary>材料摘要</summary>{content.materials.map(material=><p key={material.id}><strong>{material.title}</strong> · {material.source.label}<br/>{material.summary}</p>)}</details>}
    </section>
    <section className="task-steps-summary" aria-label="子任务步骤"><header><h3>步骤 <span>{draft.plan.work_items.length}</span></h3>{renderPlanAction?.(plan,draft.dirty||draft.pending)}</header>
      {!draft.plan.work_items.length ? <p className="quiet-text">主任务已保存，暂无步骤。可以先继续讨论目标。</p> : <ol className="task-steps-list">{draft.plan.work_items.map((item,index)=>{
        const agent=agents.find(agent=>agent.agentID===item.agentID);
        const executor=item.assignee==='human'?'由我处理':item.assignee==='agent'?agent?.name??item.agentID:item.assignee==='chat'?'直接模型':'待分工';
        const model=item.model?.model_id??(agent?.state==='ready'?agent.model.model_id:item.assignee==='agent'?'跟随连接':'未指定');
        return <li key={item.id} data-step-id={item.id}><span className="task-step-number">{index+1}</span><div><div className="task-step-summary-heading"><strong>{item.title||'待命名步骤'}</strong><span>{item.status==='completed'?'人工已完成':'待推进'}</span></div><p>{executor} · 模型：{model}</p><p>依赖：{item.dependencies.length?item.dependencies.map(id=>draft.plan.work_items.find(work=>work.id===id)?.title||'原步骤待核对').join('、'):'无'}</p></div></li>;
      })}</ol>}
    </section>
    <ChatTaskOrigin plan={plan} />
    {conflict && <div className="task-conflict" role="status">其他窗口已保存新版本，当前草稿已保留。<button className="text-button" disabled={draft.pending} onClick={() => commit({ plan: structuredClone(plan), dirty: false, pending: false, error: '' })}>放弃草稿并加载最新</button></div>}
    <div className="task-editor" hidden={!editing}><fieldset className="plain-fieldset" disabled={draft.pending}>
      <label className="task-field">任务名称<input aria-label="任务名称" value={draft.plan.title} maxLength={200} onChange={event => update({ ...draft.plan, title: event.target.value })} /></label>
      <label className="task-field">所属项目<select aria-label="任务所属项目" value={content.project_id??''} onChange={event=>{const {project_id:_old,...rest}=content;update({...draft.plan,task:{...rest,...(event.target.value?{project_id:event.target.value}:{})}});}}><option value="">独立任务</option>{content.project_id&&!projects.some(p=>p.project?.project_id===content.project_id)&&<option value={content.project_id}>原项目 · 尚未读取</option>}{projects.flatMap(p=>p.project?[<option value={p.project.project_id} key={p.project.project_id}>{p.project.name}</option>]:[])}</select></label>
      <label className="task-field">目标<textarea aria-label="任务目标" rows={3} value={content.goal} onChange={event => updateContent({ goal: event.target.value })} placeholder="这项任务要解决什么？" /></label>
      <label className="task-field">完成条件<textarea aria-label="完成条件" rows={3} value={content.completion_conditions.join('\n')} placeholder="每行一项可核对的结果" onChange={event => updateContent({ completion_conditions: event.target.value.split('\n') })} /></label>
      <section className="task-content-section"><header><h2>工作项 <span>{draft.plan.work_items.length}</span></h2><button className="icon-button" aria-label="添加工作项" onClick={() => update({ ...draft.plan, work_items: [...draft.plan.work_items, { id: crypto.randomUUID(), title: '', kind: 'implementation', assignee: 'unassigned', expected_result: '', dependencies: [], status: 'planned' }] })}><Plus size={15} /></button></header>
        {!draft.plan.work_items.length && <p className="quiet-text">把目标拆成可以分别推进的步骤。</p>}
        {draft.plan.work_items.map((item, index) => <div className="task-step-editor" key={item.id}>
          <div className="task-step-heading"><label className="task-progress-choice"><input type="checkbox" aria-label={`人工完成工作项 ${index + 1}`} checked={item.status === 'completed'} onChange={event => itemChange(item.id, { status: event.target.checked ? 'completed' : 'planned' })} /><input aria-label={`工作项 ${index + 1} 名称`} value={item.title} placeholder="这一步做什么？" onChange={event => itemChange(item.id, { title: event.target.value })} /></label><button className="icon-button" aria-label={`删除工作项 ${index + 1}`} onClick={() => update({ ...draft.plan, work_items: draft.plan.work_items.filter(v => v.id !== item.id).map(v => ({ ...v, dependencies: v.dependencies.filter(id => id !== item.id) })) })}><Trash2 size={14} /></button></div>
          <input aria-label={`工作项 ${index + 1} 预期结果`} value={item.expected_result} placeholder="预期结果" onChange={event => itemChange(item.id, { expected_result: event.target.value })} />
          <div className="task-step-options"><select aria-label={`工作项 ${index + 1} 类型`} value={item.kind} onChange={event => { const kind = event.target.value as PlanWorkItem['kind']; const next = { ...item, kind }; if (kind !== 'discussion' && next.assignee === 'chat') { next.assignee = 'unassigned'; delete next.model; } update({ ...draft.plan, work_items: draft.plan.work_items.map(v => v.id === item.id ? next : v) }); }}><option value="discussion">讨论</option><option value="implementation">实施</option><option value="validation">验证</option></select><select aria-label={`工作项 ${index + 1} 执行者`} value={item.assignee === 'agent' ? `agent:${item.agentID}` : item.assignee} onChange={event => { const selection = event.target.value; const { agentID: _agent, model: _model, ...rest } = item; const next: PlanWorkItem = selection.startsWith('agent:') ? { ...rest, assignee: 'agent', agentID: selection.slice(6) } : { ...rest, assignee: selection as 'human' | 'unassigned' }; update({ ...draft.plan, work_items: draft.plan.work_items.map(v => v.id === item.id ? next : v) }); }}><option value="unassigned">待分工</option><option value="human">由我处理</option>{item.assignee === 'chat' && <option value="chat">模型讨论 · {item.model?.model_id}</option>}{item.agentID && !agents.some(a => a.agentID === item.agentID) && <option value={`agent:${item.agentID}`}>{item.agentID}</option>}{agents.map(agent => <option value={`agent:${agent.agentID}`} key={agent.agentID}>{agent.name}</option>)}</select><button className="text-button" disabled={draft.dirty} onClick={() => onDiscuss(plan, item.id)}>讨论这一步</button></div>
          {draft.plan.work_items.length > 1 && <details className="task-dependencies"><summary>依赖 · {item.dependencies.length}</summary>{draft.plan.work_items.filter(v => v.id !== item.id).map(other => <label key={other.id}><input type="checkbox" checked={item.dependencies.includes(other.id)} onChange={event => itemChange(item.id, { dependencies: event.target.checked ? [...item.dependencies, other.id] : item.dependencies.filter(id => id !== other.id) })} />{other.title || '未命名步骤'}</label>)}</details>}
        </div>)}
      </section>
      <section className="task-content-section"><header><h2>材料 <span>{content.materials.length}</span></h2><button className="icon-button" aria-label="添加材料摘要" onClick={() => updateContent({ materials: [...content.materials, { id: crypto.randomUUID(), title: '材料摘要', summary: '', source: { kind: 'note', reference: `note:${crypto.randomUUID()}`, label: '手动整理' } }] })}><Plus size={15} /></button></header>
        {content.materials.map((material, index) => <div className="task-material-editor" key={material.id}><div><input aria-label={`材料 ${index + 1} 名称`} value={material.title} onChange={event => updateContent({ materials: content.materials.map(v => v.id === material.id ? { ...v, title: event.target.value } : v) })} /><button className="icon-button" aria-label={`移除材料 ${index + 1}`} onClick={() => updateContent({ materials: content.materials.filter(v => v.id !== material.id) })}><X size={14} /></button></div><span>{material.source.label}</span>{material.screen_clues?.length ? <details className="task-material-sources"><summary>原始来源 · {material.screen_clues.length} 条</summary>{material.screen_clues.map(clue => <div key={clue.source.frameID}><span>{clue.source.appName} · {new Date(clue.source.capturedAt).toLocaleString()}</span>{onOpenScreen && <button className="text-button" onClick={() => onOpenScreen(clue.source.frameID)}>查看画面</button>}</div>)}</details> : null}<textarea aria-label={`材料 ${index + 1} 摘要`} value={material.summary} rows={2} onChange={event => updateContent({ materials: content.materials.map(v => v.id === material.id ? { ...v, summary: event.target.value } : v) })} placeholder="只记录与任务相关的内容" /></div>)}
      </section>
    </fieldset>
    {draft.error && <p className="task-save-error" role="alert">{draft.error}</p>}
    <footer className="task-save-bar">{draft.dirty && <button className="text-button" disabled={draft.pending} onClick={() => commit({plan:structuredClone(plan),dirty:false,pending:false,error:''})}>放弃修改</button>}<span role="status">{draft.pending ? '正在保存…' : draft.dirty ? '尚未保存' : <><Check size={12} />已保存</>}</span><button className="button primary small" disabled={draft.pending || !draft.dirty || conflict || !draft.plan.title.trim()} onClick={() => { const clean = { ...draft.plan, task: { ...content, completion_conditions: content.completion_conditions.map(v => v.trim()).filter(Boolean) } }; void saveClean(clean); }}>保存修改</button></footer>
    </div>
    {renderExtra?.(plan, draft.dirty || draft.pending)}
    <p className="task-progress-note">步骤状态记录人工进度，Agent 结果仍需另行验收。</p>
  </div>;
  async function saveClean(clean: PreviewPlan) {
    if (memory.get(plan.id)?.pending || draft.pending || conflict) return;
    const pending = { ...draft, plan: clean, pending: true, error: '' }; commit(pending);
    try { const saved = await onSave(clean); commit({ plan: saved, dirty: false, pending: false, error: '' }); setEditing(false); }
    catch (error) { commit({ ...pending, pending: false, error: message(error) }); }
  }
}
interface WorkspaceProps {
  api: DesktopAPI; active: boolean;
  plans: PreviewPlan[]; projects: ProjectWorkspaceResult[]; projectID?: string; onRefresh?(): Promise<void>; selection?: TaskReference; agents: AgentChatSourceInfo[];
  onOpenScreen?(frameID: string): void;
  renderExtra?(plan: PreviewPlan, disabled: boolean): React.ReactNode;
  renderPlanAction?(plan:PreviewPlan,disabled:boolean):React.ReactNode;
  memory: TaskDraftMemory; onSelect(ref: TaskReference): void; onCreate(): Promise<void>;
  onSave(plan: PreviewPlan): Promise<PreviewPlan>; onDeck(plan: PreviewPlan): Promise<void>; onDiscuss(plan: PreviewPlan, workItemID?: string): void;
}
interface TaskCardEntry {
  key: string; reference: TaskReference; title: string; summary: string; meta: string;
  status: TaskBoardStatus; planID?: string; manualProgress?: string;
}
export function TaskWorkspace(props: WorkspaceProps) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<'all' | TaskColumn>('all');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [creating, setCreating] = useState(false), [error, setError] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null), detailHeading = useRef<HTMLHeadingElement>(null);
  const local = props.plans.filter(plan => !plan.scope && (!props.projectID || plan.task?.project_id === props.projectID));
  const { snapshots, retry } = useTaskBoard(props.api, local, props.active);
  const listedProjects = props.projects.filter(project => !props.projectID || project.project?.project_id === props.projectID);
  const selection = props.selection;
  const selectedKey = selection ? taskKey(selection) : '';
  useEffect(() => { if (selectedKey) setDetailOpen(true); }, [selectedKey]);
  useEffect(() => { if (detailOpen && props.active) detailHeading.current?.focus(); }, [detailOpen, selectedKey, props.active]);
  const selectedPlan = selection?.kind === 'local' ? props.plans.find(p => !p.scope && p.id === selection.planID) : undefined;
  const selectedProject = selection?.kind === 'project' && (!props.projectID || selection.projectID === props.projectID) ? props.projects.find(p => p.project?.project_id === selection.projectID) : undefined;
  const selectedTask = selectedProject?.tasks.find(t => selection?.kind === 'project' && t.task_id === selection.taskID);
  const showingDetail = detailOpen && !!(selectedPlan || selectedTask);
  const closeDetail = () => { setDetailOpen(false); requestAnimationFrame(() => container.current?.querySelector<HTMLButtonElement>(`[data-task-key="${CSS.escape(selectedKey)}"]`)?.focus()); };
  const create = async () => { if (creating) return; setCreating(true); setError(''); try { await props.onCreate(); setDetailOpen(true); } catch (e) { setError(message(e)); } finally { setCreating(false); } };
  const select = (ref: TaskReference) => { props.onSelect(ref); setDetailOpen(true); };
  const entries: TaskCardEntry[] = local.map(plan => {
    const progress = planProgress(plan);
    return { key: taskKey({ kind: 'local', planID: plan.id }), reference: { kind: 'local', planID: plan.id }, planID: plan.id, title: plan.title,
      summary: plan.task?.goal || '尚未填写目标', meta: `${props.projects.find(p=>p.project?.project_id===plan.task?.project_id)?.project?.name ?? '独立任务'} · ${plan.work_items.length} 个工作项 · ${plan.task?.materials.length ?? 0} 份材料`,
      manualProgress: progress.total ? `${progress.done} / ${progress.total} 项人工进度` : '待拆分工作项', status: taskBoardStatus(plan, snapshots[plan.id]) };
  });
  for (const project of listedProjects) for (const task of project.tasks) {
    const reference: TaskReference = { kind: 'project', projectID: task.project_id, taskID: task.task_id };
    entries.push({ key: taskKey(reference), reference, title: task.title, summary: task.goal,
      meta: `${project.project?.name ?? '项目'} · 历史只读`, status: { column: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'attention' : 'pending', label: `历史 · ${taskStateLabel(task.status)}`, next: '查看保存的项目记录' } });
  }
  const visible = entries.filter(entry => (filter === 'all' || entry.status.column === filter) && `${entry.title} ${entry.summary}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const waiting = entries.filter(entry => entry.status.column === 'attention').length;
  const hasReadError = Object.values(snapshots).some(snapshot => snapshot.state === 'error');
  const card = (entry: TaskCardEntry) => <button className="task-overview-row" data-plan-id={entry.planID} data-task-key={entry.key} data-state={entry.status.column} aria-pressed={showingDetail && selectedKey === entry.key} key={entry.key} onClick={() => select(entry.reference)}>
    <div className="task-card-heading"><strong>{entry.title}</strong><span className="task-card-status">{entry.status.label}</span></div>
    <p className="task-card-summary">{entry.summary}</p>
    <span className="task-card-next">{entry.status.column === 'running' ? <LoaderCircle size={12} className="task-running-icon" /> : entry.status.column === 'completed' ? <Check size={12} /> : <ArrowUpRight size={12} />}{entry.status.next}</span>
    <div className="task-card-meta"><span>{entry.meta}</span>{entry.manualProgress && <span>{entry.manualProgress}</span>}</div>
  </button>;
  return <div ref={container} className={`task-workspace${showingDetail ? ' showing-task' : ''}`} onKeyDown={event => { if (event.key === 'Escape' && showingDetail && !event.defaultPrevented) { event.stopPropagation(); closeDetail(); } }}>
    <div className="task-overview"><header className="task-page-heading"><div><h1>任务</h1><span>{waiting ? `${waiting} 项需要你处理` : `${entries.length} 项任务`}</span></div><div className="task-page-actions">{props.projectID && props.onRefresh && <button className="icon-button" aria-label="刷新项目任务" onClick={() => { void props.onRefresh!().catch(e => setError(message(e))); }}><RefreshCw size={14} /></button>}<button className="button primary small" disabled={creating} onClick={() => void create()}><Plus size={14} />{creating ? '创建中…' : '新建任务'}</button></div></header>
      <div className="task-overview-controls"><label className="task-search"><Search size={15} /><input aria-label="搜索任务" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索任务" /></label><div className="task-view-switch" aria-label="任务视图"><button aria-pressed={view === 'board'} onClick={() => setView('board')}><Columns3 size={14} />看板</button><button aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} />列表</button></div></div>
      <div className="task-filter" aria-label="任务筛选">{([{id:'all',label:'全部'},...taskColumns] as const).map(({id,label}) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
      {error && <p className="task-save-error" role="alert">{error}</p>}
      {hasReadError && <div className="task-board-read-error" role="status">部分任务的执行状态尚未确认。<button className="text-button" onClick={retry}>重新读取</button></div>}
      <div className={`task-overview-scroll task-view-${view}`}>
        {!entries.length ? <div className="task-empty"><FileText size={28} /><h2>从一个目标开始</h2><p>新建任务后，在这里查看进展和下一步。</p></div>
        : !visible.length ? <div className="task-empty"><Search size={24} /><h2>没有符合条件的任务</h2><button className="text-button" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button></div>
        : view === 'board' ? <div className="task-board">{taskColumns.filter(column => filter === 'all' || filter === column.id).map(column => <section className="task-board-column" data-column={column.id} aria-label={column.label} key={column.id}><header><h2><span className="task-column-dot" />{column.label}</h2><span>{visible.filter(entry => entry.status.column === column.id).length}</span></header><div className="task-column-cards">{visible.filter(entry => entry.status.column === column.id).map(card)}{!visible.some(entry => entry.status.column === column.id) && <p className="task-column-empty">暂无任务</p>}</div></section>)}</div>
        : <div className="task-list" aria-label="任务列表">{visible.map(card)}</div>}
      </div>
    </div>
    {showingDetail && <section className="task-workspace-detail" aria-label="任务页详情"><header className="task-drawer-heading"><button className="button small ghost task-list-back" onClick={closeDetail}><ArrowLeft size={14} />任务列表</button><h2 ref={detailHeading} tabIndex={-1}>任务详情</h2><button className="icon-button" aria-label="关闭任务详情" onClick={closeDetail}><X size={16} /></button></header>
      {selectedPlan ? <TaskDetailContent key={selectedPlan.id} {...props} plan={selectedPlan} /> : selectedTask ? <div className="task-detail-content"><div className="task-detail-toolbar"><span>项目历史 · 只读</span></div><h1>{selectedTask.title}</h1><p>{taskStateLabel(selectedTask.status)}</p><section className="task-content-section"><h2>目标</h2><p>{selectedTask.goal}</p></section><section className="task-content-section"><h2>完成条件</h2>{selectedTask.acceptance.map(condition => <p key={condition.id}>{condition.description}</p>)}</section><section className="task-content-section"><h2>运行记录</h2>{selectedProject?.runs.filter(run => run.task_id === selectedTask.task_id).map(run => <article key={run.run_id}><strong>{run.status}</strong><p>{run.summary}</p></article>)}</section></div> : null}
    </section>}
  </div>;
}
