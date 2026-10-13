import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, CircleHelp, FileText, Folder, FolderPlus, MessageSquare, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Search, Settings2, Square, Clock3, RefreshCw, ExternalLink } from 'lucide-react';
import type { DesktopAPI, DesktopEvent, ProviderSettings } from '../shared/desktop-api';
import type { ModelSelection, PreviewPlan, SessionRecord, SessionScope } from '../shared/types';
import type { ArtifactReferenceDTO, ProjectWorkspaceResult, TaskDTO } from '../projects/types';
import { Brand, Empty, formatDate, isBusy, Markdown, Notice, StateLabel, TimelineRow } from './components';
import { Settings } from './Settings';
import { TaskDetails, taskStateLabel, StoredSummary } from './TaskDetails';
import { TaskExecutionHistory } from './TaskExecutionChat';
import type { TaskSessionRecord } from '../shared/task-execution';

type View = 'chat' | 'search' | 'tasks' | 'timeline';
interface Navigation { view: View; sessionID?: string; projectID?: string; taskID?: string }
const draftKey = (nav: Navigation) => nav.sessionID ? `session:${nav.sessionID}` : nav.taskID ? `project:${nav.projectID}:task:${nav.taskID}` : nav.projectID ? `project:${nav.projectID}` : 'new-chat';
const errorText = (value: unknown) => value instanceof Error ? value.message : '操作失败，请重试。';

export function App() {
  const api = window.screendeck;
  if (!api) return <div className="bridge-error"><Brand /><Empty icon={<CircleHelp size={28} />} title="请在 ScreenDeck 桌面应用中打开">当前页面没有连接桌面进程，无法读取项目、保存设置或请求模型。请启动 Electron 应用。</Empty></div>;
  return new URLSearchParams(location.search).get('window') === 'deck' || new URLSearchParams(location.search).get('deck') === '1' ? <Deck api={api} /> : <Workbench api={api} />;
}

function Workbench({ api }: { api: DesktopAPI }) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [projects, setProjects] = useState<ProjectWorkspaceResult[]>([]);
  const [plans, setPlans] = useState<PreviewPlan[]>([]);
  const [taskSessions, setTaskSessions] = useState<TaskSessionRecord[]>([]);
  const [historySessionID, setHistorySessionID] = useState<string | null>(null);
  const [workItemContext, setWorkItemContext] = useState<{ title: string } | null>(null);
  const [nav, setNav] = useState<Navigation>({ view: 'chat' });
  const [collapsed, setCollapsed] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState(false);
  const [openReference, setOpenReference] = useState<ArtifactReferenceDTO | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [projectBusy, setProjectBusy] = useState(false);
  const [refreshingProjectID, setRefreshingProjectID] = useState<string | null>(null);
  const [dataRootLabel, setDataRootLabel] = useState('');
  const [notice, setNoticeValue] = useState('');
  const [noticeSessionID, setNoticeSessionID] = useState<string | undefined>();
  const [connectionRecovery, setConnectionRecovery] = useState(false);
  const [recordSaving, setRecordSaving] = useState(false);
  const setNotice = (message: string, sourceID?: string) => { if (sourceID && navRef.current.sessionID !== sourceID) return; setNoticeValue(message); setNoticeSessionID(sourceID); setConnectionRecovery(false); };
  const [draft, setDraft] = useState('');
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [draftError, setDraftError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const navRef = useRef(nav); navRef.current = nav;
  const draftMap = useRef(new Map<string, string>());
  const draftStates = useRef(new Map<string, { status: 'idle' | 'saving' | 'saved' | 'failed'; error: string }>());
  const draftQueues = useRef(new Map<string, Promise<void>>());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navGeneration = useRef(0);
  const navigationSerial = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const inFlightID = useRef<string | null>(null);
  const submissionPending = useRef(false);
  const updateSession = useCallback((incoming: SessionRecord) => setSessions(current => {
    const existing = current.find(value => value.conversation_id === incoming.conversation_id);
    if (existing && existing.revision > incoming.revision) return current;
    return [incoming, ...current.filter(value => value.conversation_id !== incoming.conversation_id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }), []);
  const updateTaskSession = useCallback((incoming: TaskSessionRecord) => setTaskSessions(current => {
    const existing = current.find(value => value.conversation_id === incoming.conversation_id);
    if (existing && existing.revision > incoming.revision) return current;
    return [incoming, ...current.filter(value => value.conversation_id !== incoming.conversation_id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }), []);
  const bootstrap = useCallback(async () => {
    setLoading(true);
    try { const data = await api.bootstrap(); setSettings(data.settings); setSessions(current => { const merged = new Map(data.sessions.map(record => [record.conversation_id, record])); for (const record of current) { if (!merged.has(record.conversation_id) || merged.get(record.conversation_id)!.revision < record.revision) merged.set(record.conversation_id, record); } return [...merged.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }); setTaskSessions(current => { const merged = new Map((data.taskSessions ?? []).map(record => [record.conversation_id, record])); for (const record of current) { if (!merged.has(record.conversation_id) || merged.get(record.conversation_id)!.revision < record.revision) merged.set(record.conversation_id, record); } return [...merged.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }); setProjects(data.projects); setPlans(data.plans); setDataRootLabel(data.dataRootLabel); if (data.diagnostics.length) setNotice(data.diagnostics.join('；')); }
    catch (error) { setNotice(errorText(error)); try { setSettings(await api.getSettings()); } catch { /* The visible bootstrap error remains available. */ } }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => {
    void bootstrap();
    return api.subscribe((event: DesktopEvent) => {
      if (event.type === 'session-updated') updateSession(event.session);
      else if (event.type === 'settings-updated') setSettings(event.settings);
      else if (!event.sessionID || event.sessionID === navRef.current.sessionID) setNotice(event.message, event.sessionID);
    });
  }, [api, bootstrap, updateSession]);
  useEffect(() => api.onTaskSessionEvent(event => { if (event.type === 'task-session-updated') updateTaskSession(event.session); }), [api, updateTaskSession]);
  const persistDraft = useCallback((key: string, text: string) => {
    draftStates.current.set(key, { status: 'saving', error: '' });
    if (draftKey(navRef.current) === key) setDraftStatus('saving');
    const previous = draftQueues.current.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => api.saveDraft({ key, text })).then(() => {
      if (draftMap.current.get(key) === text) { draftStates.current.set(key, { status: 'saved', error: '' }); if (draftKey(navRef.current) === key) { setDraftStatus('saved'); setDraftError(''); } }
    }).catch(error => { if (draftMap.current.get(key) === text) { const message = `草稿未保存：${errorText(error)} 当前输入已保留。`; draftStates.current.set(key, { status: 'failed', error: message }); if (draftKey(navRef.current) === key) { setDraftStatus('failed'); setDraftError(message); } } });
    draftQueues.current.set(key, next); return next;
  }, [api]);
  useEffect(() => {
    const generation = ++navGeneration.current;
    const key = draftKey(nav);
    setDraftStatus('idle'); setDraftError('');
    const existing = draftMap.current.get(key);
    if (existing !== undefined) { setDraft(existing); const state = draftStates.current.get(key); setDraftStatus(state?.status ?? 'idle'); setDraftError(state?.error ?? ''); return; }
    setDraft('');
    void api.loadDraft(key).then(text => {
      if (generation !== navGeneration.current || draftMap.current.has(key)) return;
      draftMap.current.set(key, text); draftStates.current.set(key, { status: text ? 'saved' : 'idle', error: '' }); setDraft(text); setDraftStatus(text ? 'saved' : 'idle');
    }).catch(error => { if (generation === navGeneration.current) { const message = `无法读取草稿：${errorText(error)}`; draftStates.current.set(key, { status: 'failed', error: message }); setDraftStatus('failed'); setDraftError(message); } });
  }, [api, nav.sessionID, nav.projectID, nav.taskID]);
  const editDraft = (text: string) => {
    const key = draftKey(navRef.current); draftMap.current.set(key, text); draftStates.current.set(key, { status: 'idle', error: '' }); setDraft(text); setDraftStatus('idle'); setDraftError('');
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void persistDraft(key, text); }, 450);
  };
  const retryDraft = async () => {
    const key = draftKey(navRef.current);
    if (draftMap.current.has(key)) { await persistDraft(key, draftMap.current.get(key)!); return; }
    try { const text = await api.loadDraft(key); if (draftKey(navRef.current) === key && !draftMap.current.has(key)) { draftMap.current.set(key, text); draftStates.current.set(key, { status: 'saved', error: '' }); setDraft(text); setDraftStatus('saved'); setDraftError(''); } }
    catch (error) { if (draftKey(navRef.current) === key) setDraftError(`无法读取草稿：${errorText(error)}`); }
  };
  const navigate = (next: Navigation) => {
    navigationSerial.current++;
    setOpenReference(null);
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    const previousKey = draftKey(navRef.current);
    if (draftMap.current.has(previousKey)) void persistDraft(previousKey, draftMap.current.get(previousKey)!);
    setHistorySessionID(null); setWorkItemContext(null); setNav(next); setNotice(''); setConnectionRecovery(false); followOutput.current = true;
  };
  const session = sessions.find(value => value.conversation_id === nav.sessionID);
  const latestTurn = session?.turns.at(-1);
  const visibleDraftKey = draftKey(nav);
  const pendingForView = submitting && submittingKey === visibleDraftKey;
  const stoppingForView = stopping && stoppingKey === visibleDraftKey;
  const active = isBusy(latestTurn?.state);
  const hasCredential = !!settings && (settings.hasKey || settings.credentialStorage === 'locked');
  const currentProject = projects.find(value => value.project?.project_id === nav.projectID);
  const currentTask = currentProject?.tasks.find(value => value.task_id === nav.taskID) ?? null;
  const recoverySessions = taskSessions.filter(record => !projects.some(workspace => workspace.project?.project_id === record.scope.project_id && workspace.tasks.some(task => task.task_id === record.scope.task_id)));
  const panelTaskSessions = currentTask ? taskSessions.filter(record => record.scope.project_id === currentTask.project_id && record.scope.task_id === currentTask.task_id) : recoverySessions;
  const selectedHistory = panelTaskSessions.find(record => record.conversation_id === historySessionID);
  const historyTask = selectedHistory ? currentTask ?? { project_id: selectedHistory.scope.project_id, task_id: selectedHistory.scope.task_id, title: `原任务 ${selectedHistory.scope.task_id}（暂不可读）` } : undefined;
  const allTasks = projects.flatMap(value => value.tasks.map(task => ({ task, workspace: value })));
  const model: ModelSelection | null = settings?.modelID ? { provider_id: 'chat-completions', model_id: settings.modelID } : null;
  useEffect(() => { if (followOutput.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [session?.revision, selectedHistory?.revision, historySessionID, submitting]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`; } }, [draft, nav.view, loading]);
  const chooseProject = async () => {
    const startedNavigation = navigationSerial.current;
    setProjectBusy(true); setNotice('');
    try { const result = await api.chooseProject(); if (result) { setProjects(current => [...current.filter(value => value.project?.project_id !== result.project?.project_id), result]); if (result.project) { setExpandedProjects(current => new Set([...current, result.project!.project_id])); if (startedNavigation === navigationSerial.current) navigate({ view: 'tasks', projectID: result.project.project_id }); } else setNotice(result.diagnostics.map(value => value.message).join('；') || '选中目录没有可读取的项目身份。'); } }
    catch (error) { setNotice(errorText(error)); }
    finally { setProjectBusy(false); }
  };
  const selectTask = (workspace: ProjectWorkspaceResult, task: TaskDTO) => { if (!workspace.project) return; navigate({ view: 'chat', projectID: workspace.project.project_id, taskID: task.task_id }); setDetails(true); };
  const openTaskHistory = (record: TaskSessionRecord) => {
    if (!panelTaskSessions.some(value => value.conversation_id === record.conversation_id)) return;
    if (nav.view !== 'chat') navigate({ view: 'chat' });
    setHistorySessionID(record.conversation_id);
    followOutput.current = true;
    if (matchMedia('(max-width: 960px)').matches) setDetails(false);
  };
  const discussWorkItem = (plan: PreviewPlan, workItemID: string) => {
    if (!currentTask || !plan.scope || plan.scope.project_id !== currentTask.project_id || plan.scope.task_id !== currentTask.task_id) return;
    const item = plan.work_items.find(value => value.id === workItemID);
    if (!item) return;
    setWorkItemContext({ title: item.title });
    const addition = `讨论工作项：${item.title}\n预期结果：${item.expected_result}`;
    editDraft(draft.trim() ? `${draft}\n\n${addition}` : addition);
    if (matchMedia('(max-width: 960px)').matches) setDetails(false);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const refreshCurrentProject = async () => {
    const projectID = currentProject?.project?.project_id;
    if (!projectID || projectBusy) return;
    setProjectBusy(true); setRefreshingProjectID(projectID); setNotice('');
    try {
      const result = await api.refreshProject(projectID);
      setProjects(current => current.map(workspace => workspace.project?.project_id === projectID ? result : workspace));
      if (navRef.current.projectID === projectID) {
        const diagnostics = result.diagnostics.map(value => value.message).join('；');
        setNotice(result.status === 'stale' ? `项目快照已过期，当前显示上次可读记录。${diagnostics}` : result.status === 'error' ? diagnostics || '项目读取失败，请检查原目录后重试。' : diagnostics || '项目记录已刷新。');
      }
    } catch (error) { if (navRef.current.projectID === projectID) setNotice(`项目刷新失败：${errorText(error)}`); }
    finally { setProjectBusy(false); setRefreshingProjectID(null); }
  };
  const openSession = async (record: SessionRecord) => {
    const scope = record.scope;
    navigate({ view: 'chat', sessionID: record.conversation_id, ...(scope.kind === 'project' ? { projectID: scope.project_id, taskID: scope.task_id } : {}) });
    if (scope.kind !== 'project' || !scope.task_id) setDetails(false);
    try { const loaded = await api.loadSession(record.conversation_id); if (loaded) updateSession(loaded); } catch (error) { setNotice(errorText(error), record.conversation_id); }
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || submissionPending.current || active || !hasCredential || loading || latestTurn?.state === 'unknown') return;
    submissionPending.current = true;
    setSubmitting(true); setNotice(''); setConnectionRecovery(false);
    const readingSavedKey = settings?.credentialStorage === 'locked';
    let target = session;
    const originalKey = draftKey(navRef.current);
    setSubmittingKey(originalKey);
    const startedNavigation = navigationSerial.current;
    const originalNavigation = navRef.current;
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    void persistDraft(originalKey, draft);
    try {
      if (!target) {
        const scope: SessionScope | undefined = originalNavigation.projectID ? { kind: 'project', project_id: originalNavigation.projectID, ...(originalNavigation.taskID ? { task_id: originalNavigation.taskID } : {}) } : undefined;
        target = await api.createSession({ title: Array.from(text).slice(0, 38).join(''), scope }); updateSession(target);
        const nextNav = { ...originalNavigation, view: 'chat' as const, sessionID: target.conversation_id };
        const nextKey = draftKey(nextNav); draftMap.current.set(nextKey, draft); setSubmittingKey(nextKey); if (startedNavigation === navigationSerial.current) { navRef.current = nextNav; setNav(nextNav); }
      }
      inFlightID.current = target.conversation_id;
      const result = await api.sendMessage({ sessionID: target.conversation_id, text }); updateSession(result.session);
      if (result.status === 'accepted') {
        const targetKey = `session:${target.conversation_id}`;
        if (draftMap.current.get(targetKey)?.trim() === text) { draftMap.current.set(targetKey, ''); void persistDraft(targetKey, ''); if (draftKey(navRef.current) === targetKey) setDraft(''); }
        if (originalKey !== targetKey && draftMap.current.get(originalKey)?.trim() === text) { draftMap.current.set(originalKey, ''); void persistDraft(originalKey, ''); if (draftKey(navRef.current) === originalKey) setDraft(''); }
      }
      if (result.reason) { setNotice(result.reason, target.conversation_id); if (readingSavedKey && result.status !== 'accepted' && navRef.current.sessionID === target.conversation_id) setConnectionRecovery(true); }
    } catch (error) { setNotice(errorText(error), target?.conversation_id); if (readingSavedKey && (!target || navRef.current.sessionID === target.conversation_id)) setConnectionRecovery(true); }
    finally { submissionPending.current = false; setSubmitting(false); setSubmittingKey(null); setStopping(false); setStoppingKey(null); inFlightID.current = null; }
  };
  const stop = async () => {
    const id = session?.conversation_id ?? (pendingForView ? inFlightID.current : null);
    if (stopping) return;
    setStopping(true);
    setStoppingKey(visibleDraftKey);
    if (!id) { setStopping(false); setStoppingKey(null); return; }
    try { await api.stopGeneration(id); } catch (error) { setNotice(`停止请求未确认：${errorText(error)}`, id); }
    finally { setStopping(false); setStoppingKey(null); }
  };
  const addPlan = (plan: PreviewPlan) => { setPlans(current => [plan, ...current.filter(value => value.id !== plan.id)]); return plan; };
  const retryRecord = async () => { if (!session || recordSaving) return; setRecordSaving(true); try { await api.retryPendingWrites(session.conversation_id); setNotice('本地记录已保存，请求没有重发。', session.conversation_id); } catch (error) { setNotice(`本地记录保存失败：${errorText(error)}；没有重发请求。`, session.conversation_id); } finally { setRecordSaving(false); } };
  const filteredTasks = allTasks.filter(({ task, workspace }) => (!nav.projectID || workspace.project?.project_id === nav.projectID) && (nav.view !== 'search' || !searchText || `${task.title} ${task.goal}`.toLowerCase().includes(searchText.toLowerCase())));
  const sendReason = loading ? '正在读取本地记录。' : !hasCredential ? '配置模型连接后即可发送。' : latestTurn?.state === 'unknown' ? '上一轮状态未知，请新建聊天，避免重复提交。' : stoppingForView || latestTurn?.state === 'cancelling' ? '已请求停止，正在确认结果。' : pendingForView && !active ? settings?.credentialStorage === 'locked' ? '正在读取已保存密钥；如系统提示，请完成授权。' : '正在提交请求…' : submitting && !pendingForView ? '另一个聊天正在请求，完成后可发送。' : '';
  const topTitle = nav.view === 'search' ? '搜索' : nav.view === 'tasks' ? currentProject?.project?.name ?? '任务' : nav.view === 'timeline' ? '时间线' : currentTask ? '任务讨论' : session?.title ?? currentProject?.project?.name ?? '新聊天';
  const mac = navigator.platform.toLowerCase().includes('mac');
  return <><div id="app-shell" className={`app-shell ${mac ? 'mac' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="brand-header"><Brand /><button className="icon-button" title={collapsed ? '展开侧栏' : '折叠侧栏'} aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
    <header className="topbar"><div className="topbar-context"><span className="topbar-title">{topTitle}</span>{latestTurn && <StateLabel state={stoppingForView ? 'cancelling' : latestTurn.state} />}</div><div className="topbar-actions"><button className="icon-button" title="打开 Deck" aria-label="打开 Deck" onClick={() => void api.openDeck(session?.conversation_id).catch(error => setNotice(errorText(error)))}><ExternalLink size={15} /></button><button className={`icon-button ${details ? 'is-selected' : ''}`} title={details ? '收起右栏' : '展开右栏'} aria-label={details ? '收起右栏' : '展开右栏'} aria-pressed={details} onClick={() => setDetails(value => !value)}><PanelRight size={16} /></button></div></header>
    <aside className="sidebar" aria-label="主导航"><nav className="nav-group">{([['chat', '新聊天', Plus], ['search', '搜索', Search], ['tasks', '任务', FileText], ['timeline', '时间线', Clock3]] as const).map(([id, label, Icon]) => <button key={id} className={`nav-item ${nav.view === id && (id !== 'chat' || !session) ? 'active' : ''}`} aria-label={label} onClick={() => { navigate({ view: id }); if (id === 'chat') { setDetails(false); textarea.current?.focus(); } }}><Icon size={17} /><span className="nav-label">{label}</span></button>)}</nav>
      <div className="sidebar-scroll"><section className="sidebar-section"><div className="sidebar-heading"><span>项目</span><button className="icon-button" aria-label="添加项目" disabled={projectBusy} onClick={() => void chooseProject()}>{projectBusy ? <RefreshCw size={13} /> : <Plus size={15} />}</button></div>{projects.filter(value => value.project).length ? projects.filter(value => value.project).map(workspace => <div key={workspace.project!.project_id}><button className={`project-button ${nav.projectID === workspace.project!.project_id ? 'active' : ''}`} onClick={() => { const id = workspace.project!.project_id; setExpandedProjects(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); navigate({ view: 'tasks', projectID: id }); }}><Folder size={14} /><span>{workspace.project!.name}</span>{expandedProjects.has(workspace.project!.project_id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>{expandedProjects.has(workspace.project!.project_id) && <div className="project-tasks">{workspace.tasks.map(task => <button className={`task-shortcut ${task.task_id === nav.taskID ? 'active' : ''}`} key={task.task_id} onClick={() => selectTask(workspace, task)} title={task.title}>{task.title}</button>)}{!workspace.tasks.length && <p className="sidebar-empty">没有可读取的任务</p>}</div>}</div>) : <p className="sidebar-empty">添加本机项目后<br />在这里查看任务。</p>}</section>
      <section className="sidebar-section"><div className="sidebar-heading"><span>最近聊天</span></div>{sessions.length ? sessions.slice(0, 30).map(record => <button key={record.conversation_id} className={`session-button ${record.conversation_id === nav.sessionID ? 'active' : ''}`} onClick={() => void openSession(record)}><MessageSquare size={13} /><span>{record.title || '未命名聊天'}</span></button>) : <p className="sidebar-empty">还没有聊天记录</p>}</section></div>
      <footer className="sidebar-footer"><button className="nav-item" aria-label="设置" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /><span className="nav-label">设置</span></button></footer>
    </aside>
    <main className={`workbench ${details ? 'has-detail' : ''}`}><section className="center-column" id="center-column" aria-label="工作区">{notice && <div className="global-notice"><Notice onDismiss={() => setNotice('')}>{notice}{connectionRecovery && <button className="text-button" onClick={() => setSettingsOpen(true)}>打开设置</button>}{session && noticeSessionID === session.conversation_id && /记录.*保存|未能保存|未保存的事实|写入|落盘/.test(notice) && <button className="button small" disabled={recordSaving} onClick={() => void retryRecord()}>{recordSaving ? '正在保存…' : '重试记录保存'}</button>}</Notice></div>}
      {loading ? <div className="center-content"><div className="loading-lines" aria-label="正在读取本地记录"><div /><div /><div /></div></div> : nav.view === 'chat' ? <>
        {session?.messages.length || selectedHistory ? <div className="center-content" ref={stream} onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}><div className="messages">{session?.messages.map(message => { const turn = session.turns.find(value => value.turn_id === message.turn_id); return <article key={message.message_id} className={`message ${message.role}`}><div className="message-header"><strong>{message.role === 'user' ? '你' : '模型回复'}</strong><time>{formatDate(message.created_at)}</time>{message.role === 'assistant' && turn?.observed_model && <span>{turn.observed_model.model_id}</span>}</div><div className="message-body">{message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}</div></article>; })}{latestTurn && <div className="turn-receipt"><StateLabel state={stoppingForView ? 'cancelling' : latestTurn.state} /><span>请求 {latestTurn.requested_model.model_id}{latestTurn.observed_model ? ` · 响应 ${latestTurn.observed_model.model_id}` : ' · 响应模型未报告'}</span></div>}{latestTurn?.failure && <Notice>{latestTurn.failure}</Notice>}{selectedHistory && historyTask && <TaskExecutionHistory key={selectedHistory.conversation_id} api={api} task={historyTask} projectName={currentProject?.project?.name} sessionID={selectedHistory.conversation_id} onSessionChange={updateTaskSession} onClose={() => setHistorySessionID(null)} />}</div></div> : <div className="welcome-content"><div className="welcome"><h1>今天想推进什么？</h1><p>{currentTask ? '从当前任务开始，写下你的下一步。' : '写下问题，或从一个具体任务开始。'}</p><div className="welcome-actions"><button className="button" onClick={() => { editDraft(draft ? `${draft}\n\n我想讨论一个想法：` : '我想讨论一个想法：'); textarea.current?.focus(); }}>讨论一个想法</button><button className="button" onClick={() => { editDraft(draft ? `${draft}\n\n帮我梳理这个任务的目标和下一步：` : '帮我梳理这个任务的目标和下一步：'); textarea.current?.focus(); }}>梳理一个任务</button></div></div></div>}
        <div className="composer-wrap">{workItemContext && <div className="composer-task-context"><FileText size={13} /><span>讨论工作项 · {workItemContext.title}</span><button className="text-button" onClick={() => setWorkItemContext(null)}>清除提示</button></div>}<div className="composer"><textarea ref={textarea} aria-label="输入消息" placeholder="补充要求，或继续讨论…" value={draft} onChange={event => editDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }} /><div className="composer-bottom"><div className="composer-left">{draftStatus === 'saving' ? '正在保存草稿' : draftStatus === 'saved' && draft ? '草稿已保存' : draftStatus === 'failed' ? <button className="button ghost small" onClick={() => void retryDraft()}>{draftMap.current.has(draftKey(navRef.current)) ? '重试保存草稿' : '重新读取草稿'}</button> : ''}</div><div className="composer-right"><button className="model-select" title="选择模型连接" onClick={() => setSettingsOpen(true)}><span>{settings?.modelID || '选择模型'}</span><ChevronDown size={11} /></button><button className="send-button" aria-label={active ? '停止生成' : pendingForView ? '正在准备请求' : '发送消息'} aria-busy={pendingForView && !active} title={active ? '停止生成' : sendReason || '发送消息'} disabled={active ? stoppingForView || latestTurn?.state === 'cancelling' : !draft.trim() || !!sendReason} onClick={() => active ? void stop() : void send()}>{active ? <Square size={14} fill="currentColor" /> : pendingForView ? <RefreshCw size={17} className="busy-icon" /> : <ArrowUp size={18} />}</button></div></div></div>{sendReason && (hasCredential || loading) && <p className="composer-reason" role="status">{sendReason}</p>}{draftStatus === 'failed' && <p className="composer-reason">{draftError}</p>}</div>
      </> : nav.view === 'tasks' ? <div className="center-content"><div className="list-header"><div><h1>{currentProject?.project?.name ?? '任务'}</h1><p>查看项目实际保存的任务与执行历史。</p></div><div className="list-actions">{currentProject?.project && <button className="button small ghost" disabled={projectBusy} onClick={() => void refreshCurrentProject()}><RefreshCw size={13} className={refreshingProjectID ? 'busy-icon' : ''} />{refreshingProjectID ? '刷新中…' : '刷新'}</button>}<button className="button small" disabled={projectBusy} onClick={() => void chooseProject()}><FolderPlus size={14} />添加项目</button></div></div>{currentProject?.artifact_refs.some(ref => ref.owner_kind === 'project') && <details className="project-files"><summary>项目文件</summary>{currentProject.artifact_refs.filter(ref => ref.owner_kind === 'project').map(ref => <button key={ref.reference_id} className="artifact-link" onClick={() => { setOpenReference({ ...ref }); setDetails(true); }}><FileText size={14} /><span>{ref.label}</span></button>)}</details>}{currentProject?.status === 'stale' && <Notice>项目快照已过期，当前显示上次可读记录。刷新成功前，关联文件不能预览。</Notice>}{currentProject?.diagnostics.map((value, index) => <Notice key={`${value.code}-${index}`}>{value.message}</Notice>)}{filteredTasks.length ? <div className="task-list">{filteredTasks.map(({ task, workspace }) => <button className="task-list-row" key={`${task.project_id}:${task.task_id}`} onClick={() => selectTask(workspace, task)}><div><strong>{task.title}</strong><p>{workspace.project?.name} · 更新于 {formatDate(task.updated_at)}</p></div><span className="task-status">{taskStateLabel(task.status)} <ChevronRight size={12} /></span></button>)}</div> : <Empty icon={<Folder size={24} />} title="还没有可读取的任务">添加含 ScreenDeck 项目身份的目录，任务记录将在这里只读显示。</Empty>}</div> : nav.view === 'search' ? <div className="center-content"><div className="list-header"><div><h1>搜索</h1><p>搜索已加载的任务和本地聊天。</p></div></div><input className="search-input" autoFocus aria-label="搜索任务和聊天" placeholder="任务、目标或聊天内容" value={searchText} onChange={event => setSearchText(event.target.value)} />{searchText.trim() ? <><h2 className="search-section-title">任务</h2>{filteredTasks.map(({ task, workspace }) => <button className="task-list-row" key={`${task.project_id}:${task.task_id}`} onClick={() => selectTask(workspace, task)}><div><strong>{task.title}</strong><p>{workspace.project?.name}</p></div><ChevronRight size={14} /></button>)}<h2 className="search-section-title">聊天</h2>{sessions.filter(record => `${record.title} ${record.messages.map(message => message.text).join(' ')}`.toLowerCase().includes(searchText.toLowerCase())).map(record => <button className="task-list-row" key={record.conversation_id} onClick={() => void openSession(record)}><div><strong>{record.title}</strong><p>{formatDate(record.updated_at)}</p></div><ChevronRight size={14} /></button>)}</> : <Empty icon={<Search size={24} />} title="寻找之前的线索">输入关键词，检索当前已加载的本地记录。</Empty>}</div> : <div className="center-content"><div className="list-header"><div><h1>时间线</h1><p>项目历史和模型请求，按实际保存时间排列。</p></div></div>{sessions.length || projects.some(value => value.runs.length) ? [...sessions.flatMap(record => record.turns.map(turn => ({ date: turn.created_at, key: turn.turn_id, node: <TimelineRow title={record.title} date={turn.created_at} state={<StateLabel state={turn.state} />}><p>请求模型：{turn.requested_model.model_id}{turn.observed_model ? ` · 响应：${turn.observed_model.model_id}` : ''}</p><button className="button small ghost" onClick={() => void openSession(record)}>打开聊天</button></TimelineRow> }))), ...projects.flatMap(workspace => workspace.runs.map(run => ({ date: run.recorded_at, key: run.run_id, node: <TimelineRow title={workspace.tasks.find(task => task.task_id === run.task_id)?.title ?? run.task_id} date={run.started_at} state={<span className="task-status">只读历史</span>}><StoredSummary text={run.summary} /><p>补录于 {formatDate(run.recorded_at)}</p></TimelineRow> })))].sort((a,b) => b.date.localeCompare(a.date)).map(value => <React.Fragment key={value.key}>{value.node}</React.Fragment>) : <Empty icon={<Clock3 size={24} />} title="时间线从第一次推进开始">发送一条消息，或添加项目查看已有记录。</Empty>}</div>}
    </section><TaskDetails open={details} key={`${nav.projectID ?? 'local'}:${nav.taskID ?? 'none'}`} task={currentTask} runs={currentProject?.runs ?? []} references={currentProject?.artifact_refs ?? []} plans={currentTask ? plans.filter(plan => plan.scope?.project_id === currentTask.project_id && plan.scope?.task_id === currentTask.task_id) : []} model={model} openReference={openReference} onClose={() => setDetails(false)} onPreview={ref => api.previewArtifact({ projectID: ref.project_id, referenceID: ref.reference_id })} onCreatePlan={async (title, items) => { if (!currentTask) throw new Error('请先选择确切的项目任务。'); const empty = await api.createPlan({ title, scope: { project_id: currentTask.project_id, task_id: currentTask.task_id } }); return addPlan(await api.savePlan({ plan: { ...empty, work_items: items }, expectedVersion: empty.version })); }} onSavePlan={async plan => addPlan(await api.savePlan({ plan, expectedVersion: plan.version }))} onRecommend={plan => api.recommendations(plan.id)} onDiscussWorkItem={discussWorkItem} taskSessions={panelTaskSessions} onOpenTaskHistory={openTaskHistory} /></main>
  </div>{settings && <Settings open={settingsOpen} settings={settings} dataRootLabel={dataRootLabel} onClose={() => setSettingsOpen(false)} onSave={async input => { const saved = await api.saveSettings(input); setSettings(saved); return saved; }} />}</>;
}

function Deck({ api }: { api: DesktopAPI }) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [notice, setNotice] = useState('');
  const [stopping, setStopping] = useState(false);
  const selectedID = new URLSearchParams(location.search).get('sessionID');
  useEffect(() => {
    let current = true;
    const update = (value: SessionRecord) => setSession(previous => previous && previous.revision > value.revision ? previous : value);
    if (selectedID) void api.loadSession(selectedID).then(value => { if (!current) return; if (value) update(value); else setNotice('所选聊天没有可读取的记录。'); }).catch(error => { if (current) setNotice(errorText(error)); });
    const unsubscribe = api.subscribe(event => { if (event.type === 'session-updated' && event.session.conversation_id === selectedID) update(event.session); if (event.type === 'diagnostic' && (!event.sessionID || event.sessionID === selectedID)) setNotice(event.message); });
    return () => { current = false; unsubscribe(); };
  }, [api, selectedID]);
  const turn = session?.turns.at(-1);
  return <div className={`deck ${navigator.platform.toLowerCase().includes('mac') ? 'mac' : ''}`}><header><Brand /><button className="icon-button" title="打开工作台" aria-label="打开工作台" onClick={() => void api.showWorkbench().catch(error => setNotice(errorText(error)))} style={{ marginLeft: 'auto' }}><ExternalLink size={15} /></button></header><h1 className="deck-title">{session?.title ?? '从工作台开始'}</h1><div className="deck-status">{turn ? <><StateLabel state={stopping ? 'cancelling' : turn.state} /><span>请求模型：{turn.requested_model.model_id}</span><span>{turn.observed_model ? `响应模型：${turn.observed_model.model_id}` : '响应模型未报告'}</span></> : <span>还没有模型请求。</span>}{notice && <Notice>{notice}</Notice>}</div><div className="deck-actions"><button className="button" onClick={() => void api.showWorkbench().catch(error => setNotice(errorText(error)))}>打开工作台</button><button className="button primary" disabled={!session || !isBusy(turn?.state) || stopping} onClick={() => { if (!session) return; setStopping(true); void api.stopGeneration(session.conversation_id).catch(error => setNotice(errorText(error))).finally(() => setStopping(false)); }}><Square size={12} />{stopping ? '停止中…' : '停止'}</button></div></div>;
}
