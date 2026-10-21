import { BookOpen } from 'lucide-react';
import { KnowledgeWorkspace } from './knowledge/KnowledgeWorkspace';
import type { KnowledgeMemory } from './knowledge/knowledge-model';
import { TaskDraftComposer } from './tasks/TaskDraftComposer';
import { ChatTaskComposer } from './task-chat/ChatTaskComposer';
import type { ChatTaskReference } from '../shared/chat-task';
import { TaskExtras } from './tasks/TaskExtras';
import { UnifiedTimeline, type TimelineMemory } from './UnifiedTimeline';
import { ScreenRecordingIndicator } from './RecordingControls';
import type { TimelineEvent } from '../shared/timeline';
import { TaskWorkspace, TaskDetailContent, taskContent, type TaskDraftMemory } from './tasks/TaskWorkspace';
import { TaskDiscussion } from './tasks/TaskDiscussion';
import type { TaskReference } from '../shared/types';
import type { TaskChatHandoff } from './task-chat/task-chat-model';
import { DeckWorkbench } from './deck/DeckWorkbench';
import { mergePlans } from './deck/deck-model';
import { AgentWorkspaceControls, AgentTurnTools } from './AgentExecution';
import type { AgentExecutionContext } from '../shared/agent-execution';
import { supportsAgentChat } from '../shared/agent-capabilities';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleHelp, FileText, Folder, FolderPlus, MessageSquare, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Search, Settings2, Square, Clock3, RefreshCw, ExternalLink, Maximize2, Minimize2 } from 'lucide-react';
import type { DesktopAPI, DesktopEvent, ProjectSourceDiagnostic, ProviderModelCatalog, ProviderSettings } from '../shared/desktop-api';
import type { ModelSelection, PreviewPlan, SessionRecord, SessionScope } from '../shared/types';
import type { AgentChatReadySource, AgentChatSourceInfo, AgentSessionRecord } from '../shared/agent-chat';
import type { ArtifactReferenceDTO, ProjectWorkspaceResult, TaskDTO } from '../projects/types';
import { Brand, ChatSourcePicker, ChatModelPicker, Empty, formatDate, isBusy, Notice, StateLabel, TimelineRow } from './components';
import { Settings } from './Settings';
import { ProjectNotices } from './ProjectNotices';
import { ChatHistory } from './ChatHistory';
import { ChatSearch } from './ChatSearch';
import { ChatMessage } from './ChatMessage';
import { chatKey, chatPreference, chatReference, isAgentChat as agentRecord, type ChatRecord } from './chat-history';
import type { ChatPreferences } from '../shared/chat-management';
import { TaskDetails, taskStateLabel, StoredSummary } from './TaskDetails';
import { TaskExecutionHistory } from './TaskExecutionChat';
import type { AuthorizationInput, TaskSessionRecord } from '../shared/task-execution';

type View = 'chat' | 'tasks' | 'timeline' | 'knowledge';
interface Navigation { planID?: string; view: View; sessionID?: string; projectID?: string; taskID?: string; source?: 'model' | 'agent'; agentID?: string }
const draftKey = (nav: Navigation) => {
  const scope = nav.planID ? 'local-task:' + nav.planID : nav.taskID ? 'project:' + nav.projectID + ':task:' + nav.taskID : nav.projectID ? 'project:' + nav.projectID : 'new-chat';
  return nav.source === 'agent' ? nav.sessionID ? 'agent-session:' + nav.sessionID : 'agent:' + (nav.agentID ?? 'unselected') + ':' + scope : nav.sessionID ? 'session:' + nav.sessionID : scope;
};
const matchingAgent = (source: AgentChatReadySource, record?: AgentSessionRecord) => !record || record.source.agentID === source.agentID && record.source.configDigest === source.configDigest && (!record.binding || record.binding.runtimeID === source.runtimeID && record.binding.connectionGeneration === source.connectionGeneration);
const errorText = (value: unknown) => (value instanceof Error ? value.message : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : '操作失败，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export function App() {
  const api = window.screendeck;
  if (!api) return <div className="bridge-error"><Brand /><Empty icon={<CircleHelp size={28} />} title="请在 ScreenDeck 桌面应用中打开">当前页面没有连接桌面进程，无法读取项目、保存设置或请求模型。请启动 Electron 应用。</Empty></div>;
  return new URLSearchParams(location.search).get('window') === 'deck' || new URLSearchParams(location.search).get('deck') === '1' ? <DeckWorkbench api={api} /> : <Workbench api={api} />;
}

function Workbench({ api }: { api: DesktopAPI }) {
  const knowledgeMemory = useRef<KnowledgeMemory>({drafts:new Map()});
  const timelineMemory = useRef<TimelineMemory>({});
  const [taskDraftOpen,setTaskDraftOpen]=useState(false);
  const [chatTaskSource, setChatTaskSource] = useState<ChatTaskReference>();
  const [timelineReturn, setTimelineReturn] = useState(false);
  const [timelineTaskMessage, setTimelineTaskMessage] = useState<string>();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ProviderModelCatalog | null>(null);
  const [modelSelecting, setModelSelecting] = useState(false);
  const [modelSelectionStatus, setModelSelectionStatus] = useState<'default' | 'error' | 'success'>('default');
  const modelSelectionPending = useRef(false);
  useEffect(() => {
    let current = true;
    setModelCatalog(previous => settings?.hasKey && previous?.baseURL === settings.baseURL ? previous : null);
    if (settings?.hasKey && typeof api.getProviderModels === 'function') {
      void api.getProviderModels().then(catalog => { if (current) setModelCatalog(catalog.baseURL === settings.baseURL ? catalog : null); }).catch(() => { if (current) setModelCatalog(null); });
    }
    return () => { current = false; };
  }, [api, settings]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSessionRecord[]>([]);
  const [agentExecutions, setAgentExecutions] = useState<Record<string, AgentExecutionContext>>({});
  const [agentSources, setAgentSources] = useState<AgentChatSourceInfo[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const sourceReadSerial = useRef(0);
  const [projects, setProjects] = useState<ProjectWorkspaceResult[]>([]);
  const [projectDiagnostics, setProjectDiagnostics] = useState<ProjectSourceDiagnostic[]>([]);
  const [projectSelectionNotice, setProjectSelectionNotice] = useState('');
  const [projectRefreshNotices, setProjectRefreshNotices] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<PreviewPlan[]>([]);
  const [pageTask, setPageTask] = useState<TaskReference>();
  const pageTaskDrafts = useRef<TaskDraftMemory>(new Map());
  const chatTaskDrafts = useRef<TaskDraftMemory>(new Map());
  const taskNavigationRevision = useRef(0);
  const focusTask = useRef<(request: { revision: number; planID: string; reference?: TaskReference }) => void>(() => {});
  const handoffPending = useRef(false);
  const [taskSessions, setTaskSessions] = useState<TaskSessionRecord[]>([]);
  const [historySessionID, setHistorySessionID] = useState<string | null>(null);
  const [preparingWorkItem, setPreparingWorkItem] = useState(false);
  const preparationBusy = useRef(false);
  const authorizationInputs = useRef(new Map<string, AuthorizationInput>());
  const [workItemContext, setWorkItemContext] = useState<{ title: string } | null>(null);
  const [nav, setNav] = useState<Navigation>({ view: 'chat' });
  const [collapsed, setCollapsed] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState(false);
  const [panelContext, setPanelContext] = useState<Pick<Navigation, 'projectID' | 'taskID' | 'planID'>>({});
  const [panelFiles, setPanelFiles] = useState<{ key: string; hasFiles: boolean } | null>(null);
  const [openReference, setOpenReference] = useState<ArtifactReferenceDTO | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'models' | 'tools' | 'data' | undefined>();
  const [settingsJevFocus, setSettingsJevFocus] = useState(false);
  const [jevSettingsRevision, setJevSettingsRevision] = useState(0);
  const openSettings = (section?: 'models' | 'tools' | 'data') => { setSettingsInitialSection(section); setSettingsOpen(true); };
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
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [draftError, setDraftError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchOrigin, setSearchOrigin] = useState<{ x: number; y: number } | null>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [chatPreferences, setChatPreferences] = useState<ChatPreferences>({ revision: 0, entries: {} });
  const chatPreferencesRef = useRef(chatPreferences); chatPreferencesRef.current = chatPreferences;
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [searchHit, setSearchHit] = useState<{ key: string; messageID: string } | null>(null);
  const updatePreferences = useCallback((incoming: ChatPreferences) => { if (incoming.revision >= chatPreferencesRef.current.revision) { chatPreferencesRef.current = incoming; setChatPreferences(incoming); } setPreferencesReady(true); }, []);
  const navRef = useRef(nav); navRef.current = nav;
  const draftMap = useRef(new Map<string, string>());
  const draftVersions = useRef(new Map<string, number>());
  const draftStates = useRef(new Map<string, { status: 'idle' | 'saving' | 'saved' | 'failed'; error: string }>());
  const draftQueues = useRef(new Map<string, Promise<void>>());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navGeneration = useRef(0);
  const navigationSerial = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const inFlightID = useRef<string | null>(null);
  const inFlightSource = useRef<'model' | 'agent'>('model');
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
  const updateAgentSession = useCallback((incoming: AgentSessionRecord) => setAgentSessions(current => {
    const existing = current.find(value => value.conversation_id === incoming.conversation_id);
    if (existing && existing.revision > incoming.revision) return current;
    return [incoming, ...current.filter(value => value.conversation_id !== incoming.conversation_id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }), []);
  const refreshSources = useCallback(async (): Promise<AgentChatSourceInfo[]> => {
    if (typeof api.getAgentSources !== 'function') return [];
    const serial = ++sourceReadSerial.current; setSourcesLoading(true);
    try {
      const sources = await api.getAgentSources();
      if (serial === sourceReadSerial.current) { setAgentSources(sources); setSourcesError(''); }
      return sources;
    } catch (error) {
      if (serial === sourceReadSerial.current) { setAgentSources([]); setSourcesError('无法读取 OpenCode 连接：' + errorText(error)); }
      throw error;
    } finally { if (serial === sourceReadSerial.current) setSourcesLoading(false); }
  }, [api]);
  const bootstrap = useCallback(async () => {
    setLoading(true);
    try { const data = await api.bootstrap(); setSettings(data.settings); setSessions(current => { const merged = new Map(data.sessions.map(record => [record.conversation_id, record])); for (const record of current) { if (!merged.has(record.conversation_id) || merged.get(record.conversation_id)!.revision < record.revision) merged.set(record.conversation_id, record); } return [...merged.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }); setTaskSessions(current => { const merged = new Map((data.taskSessions ?? []).map(record => [record.conversation_id, record])); for (const record of current) { if (!merged.has(record.conversation_id) || merged.get(record.conversation_id)!.revision < record.revision) merged.set(record.conversation_id, record); } return [...merged.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }); setAgentSessions(current => { const merged = new Map((data.agentSessions ?? []).map(record => [record.conversation_id, record])); for (const record of current) if (!merged.has(record.conversation_id) || merged.get(record.conversation_id)!.revision < record.revision) merged.set(record.conversation_id, record); return [...merged.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }); if (data.chatPreferences) updatePreferences(data.chatPreferences); setProjects(data.projects); setProjectDiagnostics(data.projectDiagnostics ?? []); setPlans(current => mergePlans(current, data.plans)); if (data.taskNavigation) focusTask.current(data.taskNavigation); setDataRootLabel(data.dataRootLabel); if (data.diagnostics.length) setNotice(data.diagnostics.join('；')); }
    catch (error) { setNotice(errorText(error)); try { setSettings(await api.getSettings()); } catch { /* The visible bootstrap error remains available. */ } }
    finally { setLoading(false); void refreshSources().catch(() => {}); }
  }, [api, refreshSources, updatePreferences]);
  useEffect(() => {
    void bootstrap();
    return api.subscribe((event: DesktopEvent) => {
      if (event.type === 'workbench-task-requested') focusTask.current(event);
      else if (event.type === 'plan-updated') setPlans(current => mergePlans(current, [event.plan]));
      else if (event.type === 'deck-context-updated' || event.type === 'deck-presentation-updated') { /* Only Deck consumes its window state. */ }
      else if (event.type === 'project-diagnostics-updated') setProjectDiagnostics(event.diagnostics);
      else if (event.type === 'chat-preferences-updated') updatePreferences(event.preferences);
      else if (event.type === 'session-updated') updateSession(event.session);
      else if (event.type === 'agent-session-updated') updateAgentSession(event.session);
      else if (event.type === 'agent-execution-updated') { /* Per-turn tool views subscribe independently. */ }
      else if (event.type === 'agent-sources-updated') { void refreshSources().catch(() => {}); }
      else if (event.type === 'settings-updated') { setSettings(event.settings); void refreshSources().catch(() => {}); }
      else if ((event.type === 'diagnostic' || event.type === 'agent-diagnostic') && (!event.sessionID || event.sessionID === navRef.current.sessionID)) setNotice(event.message, event.sessionID);
    });
  }, [api, bootstrap, updateSession, updateAgentSession, refreshSources, updatePreferences]);
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
  }, [api, nav.sessionID, nav.projectID, nav.taskID, nav.planID, nav.source, nav.agentID]);
  const editDraft = (text: string) => {
    const key = draftKey(navRef.current); draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1); draftMap.current.set(key, text); draftStates.current.set(key, { status: 'idle', error: '' }); setDraft(text); setDraftStatus('idle'); setDraftError('');
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void persistDraft(key, text); }, 450);
  };
  const retryDraft = async () => {
    const key = draftKey(navRef.current);
    if (draftMap.current.has(key)) { await persistDraft(key, draftMap.current.get(key)!); return; }
    try { const text = await api.loadDraft(key); if (draftKey(navRef.current) === key && !draftMap.current.has(key)) { draftMap.current.set(key, text); draftStates.current.set(key, { status: 'saved', error: '' }); setDraft(text); setDraftStatus('saved'); setDraftError(''); } }
    catch (error) { if (draftKey(navRef.current) === key) setDraftError(`无法读取草稿：${errorText(error)}`); }
  };
  const navigate = (next: Navigation, options: { preserveNotice?: boolean } = {}) => {
    navigationSerial.current++;
    setOpenReference(null);
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    const previousKey = draftKey(navRef.current);
    if (draftMap.current.has(previousKey)) void persistDraft(previousKey, draftMap.current.get(previousKey)!);
    if (next.view === 'chat') setPanelContext({ projectID: next.projectID, taskID: next.taskID, planID: next.planID });
    setHistorySessionID(null); setWorkItemContext(null); setSearchHit(null); setShowJump(false); navRef.current = next; setNav(next); if (!options.preserveNotice) { setNotice(''); setConnectionRecovery(false); } followOutput.current = true;
  };
  focusTask.current = request => {
    if (request.revision <= taskNavigationRevision.current) return;
    taskNavigationRevision.current = request.revision;
    setPageTask(request.reference ?? { kind: 'local', planID: request.planID });
    navigate({ view: 'tasks' });
  };
  const isAgent = nav.source === 'agent';
  const agentSession = isAgent ? agentSessions.find(value => value.conversation_id === nav.sessionID) : undefined;
  const session: ChatRecord | undefined = isAgent ? agentSession : sessions.find(value => value.conversation_id === nav.sessionID);
  const agentNames = Object.fromEntries(agentSources.map(source => [source.agentID, source.name]));
  const selectedAgentID = agentSession?.source.agentID ?? nav.agentID;
  const selectedAgentSource = agentSources.find(value => value.agentID === selectedAgentID);
  const selectedAgentName = selectedAgentSource?.name ?? selectedAgentID ?? 'Agent';
  const readyAgentSource = selectedAgentSource?.state === 'ready' && supportsAgentChat(selectedAgentSource.capabilities) ? selectedAgentSource : undefined;
  const agentCanContinue = !!readyAgentSource && matchingAgent(readyAgentSource, agentSession);
  const agentReason = sourcesLoading ? `正在读取 ${selectedAgentName} 连接状态。` : sourcesError || (!readyAgentSource ? selectedAgentSource?.state === 'unavailable' && selectedAgentSource.reason === 'requires-restart' ? `模型连接已变化，请重新连接 ${selectedAgentName}。` : selectedAgentSource?.state === 'unavailable' && ['unsupported', 'invalid-source'].includes(selectedAgentSource.reason) ? `${selectedAgentName} 当前能力或连接信息不支持此聊天入口。` : selectedAgentSource ? `${selectedAgentName} 尚未连接。` : '原 Agent 尚未注册，请选择可用来源。' : !agentCanContinue ? `这份 ${selectedAgentName} 聊天属于之前的连接，当前无法继续。` : '');
  const chooseSource = (source: 'model' | 'agent', agentID?: string) => {
    if (source === 'agent' && !agentSources.some(agent => agent.agentID === agentID)) return;
    if (source === (navRef.current.source ?? 'model') && (source === 'model' || navRef.current.agentID === agentID)) return;
    const current = navRef.current;
    navigate({ view: 'chat', projectID: current.projectID, taskID: current.taskID, planID: current.planID, source, ...(source === 'agent' ? { agentID } : {}) });
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const newAgentChat = () => {
    const current = navRef.current;
    navigate({ view: 'chat', projectID: current.projectID, taskID: current.taskID, planID: current.planID, source: 'agent', agentID: selectedAgentID });
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const latestTurn = session?.turns.at(-1);
  const visibleDraftKey = draftKey(nav);
  const pendingForView = submitting && submittingKey === visibleDraftKey;
  const stoppingForView = stopping && stoppingKey === visibleDraftKey;
  const active = isBusy(latestTurn?.state);
  const hasCredential = !!settings?.hasKey;
  const currentProject = projects.find(value => value.project?.project_id === nav.projectID);
  const currentTask = currentProject?.tasks.find(value => value.task_id === nav.taskID) ?? null;
  const panelProject = projects.find(value => value.project?.project_id === panelContext.projectID);
  const panelTask = panelProject?.tasks.find(value => value.task_id === panelContext.taskID) ?? null;
  const panelPlan = plans.find(plan => plan.id === panelContext.planID);
  const panelKey = `${panelContext.planID ?? ''}:${panelContext.projectID ?? 'local'}:${panelContext.taskID ?? 'none'}`;
  const reportPanelFiles = useCallback((hasFiles: boolean) => setPanelFiles({ key: panelKey, hasFiles }), [panelKey]);
  const recoverySessions = taskSessions.filter(record => !projects.some(workspace => workspace.project?.project_id === record.scope.project_id && workspace.tasks.some(task => task.task_id === record.scope.task_id)));
  const panelTaskSessions = panelTask ? taskSessions.filter(record => record.scope.project_id === panelTask.project_id && record.scope.task_id === panelTask.task_id) : recoverySessions;
  const filePreviewOnly = nav.view !== 'chat' && !!openReference;
  const hasPanelContext = !!panelPlan || !!panelTask || !!openReference || panelFiles?.key === panelKey && panelFiles.hasFiles || panelTaskSessions.length > 0;
  const canTogglePanel = nav.view === 'knowledge' ? false : nav.view === 'chat' ? hasPanelContext : filePreviewOnly;
  const panelOpen = details && canTogglePanel;
  const selectedHistory = panelTaskSessions.find(record => record.conversation_id === historySessionID);
  const historyTask = selectedHistory ? currentTask ?? { project_id: selectedHistory.scope.project_id, task_id: selectedHistory.scope.task_id, title: `原任务 ${selectedHistory.scope.task_id}（暂不可读）` } : undefined;
  const requestWorkItem = async (plan: PreviewPlan, workItemID: string) => {
    if (preparationBusy.current || !currentTask || !plan.scope || plan.scope.project_id !== currentTask.project_id || plan.scope.task_id !== currentTask.task_id) return;
    const item = plan.work_items.find(value => value.id === workItemID);
    if (!item || item.kind !== 'discussion' || item.assignee !== 'unassigned') return;
    const sourceTask = currentTask;
    const navigation = navigationSerial.current;
    const key = `${sourceTask.project_id}:${sourceTask.task_id}:${plan.id}:${plan.version}:${workItemID}`;
    preparationBusy.current = true; setPreparingWorkItem(true); setNotice('');
    let targetID: string | undefined;
    try {
      let input = authorizationInputs.current.get(key);
      if (input) {
        const saved = await api.loadTaskSession(input.session);
        if (saved) updateTaskSession(saved);
        const previous = saved?.turns.find(turn => turn.client_request_id === input!.clientRequestID);
        const permissionUnresolved = previous?.execution.permissions.some(permission => permission.delivery === 'sending' || permission.delivery === 'unknown' || !permission.delivery && !['failed', 'cancelled'].includes(previous.state));
        if (previous && ['finished', 'failed', 'cancelled'].includes(previous.state) && !permissionUnresolved) {
          authorizationInputs.current.delete(key); input = undefined;
        }
      }
      if (!input) {
        const options = await api.getTaskExecutionOptions({ projectID: sourceTask.project_id, taskID: sourceTask.task_id });
        const driver = options.drivers.find(value => value.mode === 'external' && value.driverID === 'opencode-acp-no-tools');
        if (!driver) { const status = await api.getOpenCodeStatus(); throw new Error(status.state === 'ready' && status.requiresRestart ? '模型连接已更新，请在设置中关闭并重新启动 OpenCode，再申请执行。' : '请先在设置中连接 OpenCode。'); }
        const existing = await api.listTaskSessions({ projectID: sourceTask.project_id, taskID: sourceTask.task_id });
        if (existing.diagnostics.length) throw new Error('执行记录读取失败，请先核对原记录。');
        const record = existing.records[0] ?? await api.createTaskSession({ title: `OpenCode · ${sourceTask.title}`, projectID: sourceTask.project_id, taskID: sourceTask.task_id });
        updateTaskSession(record);
        input = { planID: plan.id, expectedPlanVersion: plan.version, workItemID, session: { format: 'task-v2', sessionID: record.conversation_id }, clientRequestID: crypto.randomUUID(), text: `请讨论以下工作项，给出文本建议。

工作项：${item.title}
预期结果：${item.expected_result}

本次只使用以上输入，不读取项目文件，不调用工具。`, materialIDs: [], workspaceID: options.workspace.workspaceID, driverID: driver.driverID, model: options.model, tools: { kind: 'none' } };
        authorizationInputs.current.set(key, input);
      }
      targetID = input.session.sessionID;
      // Preserve this exact command after a lost save receipt; preparing never sends a prompt.
      await api.requestExecutionAuthorization(input);
      const record = await api.loadTaskSession(input.session);
      if (record) updateTaskSession(record);
      if (navigation === navigationSerial.current) {
        if (navRef.current.view !== 'chat') navigate({ view: 'chat', projectID: sourceTask.project_id, taskID: sourceTask.task_id });
        setHistorySessionID(targetID);
      }
    } catch (error) {
      if (navigation === navigationSerial.current) { if (targetID) setHistorySessionID(targetID); setNotice(errorText(error)); }
    } finally { preparationBusy.current = false; setPreparingWorkItem(false); }
  };
  const allTasks = projects.flatMap(value => value.tasks.map(task => ({ task, workspace: value })));
  const model: ModelSelection | null = settings?.modelID ? { provider_id: 'chat-completions', model_id: settings.modelID } : null;
  useEffect(() => {
    const node = stream.current;
    if (!node) return;
    if (followOutput.current) { node.scrollTop = node.scrollHeight; setShowJump(false); }
    else setShowJump(node.scrollHeight - node.scrollTop - node.clientHeight >= 80);
  }, [session?.revision, selectedHistory?.revision, historySessionID, submitting]);
  useLayoutEffect(() => {
    const node = stream.current, column = node?.parentElement;
    if (!node || !column) return;
    // Match the message column even when its scroll container reserves a gutter.
    const update = () => column.style.setProperty('--chat-scrollbar', `${Math.max(0, node.offsetWidth - node.clientWidth)}px`);
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    return () => { observer.disconnect(); column.style.removeProperty('--chat-scrollbar'); };
  }, [loading, nav.view, session?.conversation_id, !!session?.messages.length, selectedHistory?.conversation_id]);
  const resizeComposer = useCallback(() => {
    const node = textarea.current;
    if (!node) return;
    const maximum = Number.parseFloat(getComputedStyle(node).maxHeight) || 180;
    node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, maximum)}px`;
    node.style.overflowY = node.scrollHeight > maximum ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(resizeComposer, [draft, nav.view, loading, collapsed, panelOpen, composerExpanded, resizeComposer]);
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => { if (node.clientWidth !== width) { width = node.clientWidth; resizeComposer(); } });
    observer.observe(node); return () => observer.disconnect();
  }, [nav.view, loading, resizeComposer]);
  useEffect(() => {
    if (!searchHit || !session || chatKey(session) !== searchHit.key) return;
    const frame = requestAnimationFrame(() => {
      const node = [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(value => value.dataset.messageId === searchHit.messageID);
      if (!node) return;
      followOutput.current = false; node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchHit, session?.conversation_id]);
  const chooseProject = async () => {
    if (projectBusy) return;
    const startedNavigation = navigationSerial.current;
    setProjectBusy(true);
    try {
      const result = await api.chooseProject();
      if (!result) return;
      setProjectSelectionNotice('');
      if (result.project) {
        const projectID = result.project.project_id;
        setProjects(current => [...current.filter(value => value.project?.project_id !== projectID), result]);
        setExpandedProjects(current => new Set([...current, projectID]));
        setProjectRefreshNotices(current => { const next = { ...current }; delete next[projectID]; return next; });
      }
      // An old file chooser must not take the user out of a newer chat.
      if (startedNavigation === navigationSerial.current) navigate({ view: 'tasks', ...(result.project ? { projectID: result.project.project_id } : {}) }, { preserveNotice: true });
    } catch (error) {
      setProjectSelectionNotice(`无法选择项目：${errorText(error)}`);
      if (startedNavigation === navigationSerial.current) navigate({ view: 'tasks' }, { preserveNotice: true });
    } finally { setProjectBusy(false); }
  };
  const selectTask = (workspace: ProjectWorkspaceResult, task: TaskDTO) => { if (!workspace.project) return; setPageTask({ kind: 'project', projectID: workspace.project.project_id, taskID: task.task_id }); navigate({ view: 'tasks', projectID: workspace.project.project_id }); };
  const openTaskHistory = (record: TaskSessionRecord) => {
    navigationSerial.current++;
    if (!panelTaskSessions.some(value => value.conversation_id === record.conversation_id)) return;
    if (nav.view !== 'chat') navigate({ view: 'chat', projectID: record.scope.project_id, taskID: record.scope.task_id });
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
    setProjectBusy(true); setRefreshingProjectID(projectID);
    setProjectRefreshNotices(current => { const next = { ...current }; delete next[projectID]; return next; });
    try {
      const result = await api.refreshProject(projectID);
      setProjects(current => current.map(workspace => workspace.project?.project_id === projectID ? result : workspace));
    } catch (error) {
      setProjectRefreshNotices(current => ({ ...current, [projectID]: `项目刷新失败：${errorText(error)}` }));
    } finally { setProjectBusy(false); setRefreshingProjectID(null); }
  };
  const openSession = async (record: ChatRecord) => {
    const scope = record.scope, agent = agentRecord(record);
    const linkedPlan = plans.find(plan => plan.task?.chat_refs.some(ref => ref.source === (agent ? 'agent' : 'model') && ref.sessionID === record.conversation_id));
    navigate({ view: 'chat', sessionID: record.conversation_id, source: agent ? 'agent' : 'model', ...(agent ? { agentID: record.source.agentID } : {}), ...(linkedPlan ? { planID: linkedPlan.id } : {}), ...(scope.kind === 'project' ? { projectID: scope.project_id, taskID: scope.task_id } : {}) });
    if (linkedPlan) setDetails(true); else if (scope.kind !== 'project' || !scope.task_id) setDetails(false);
    if (agent) void refreshSources().catch(() => {});
    try {
      if (agent) { const loaded = await api.loadAgentSession(record.conversation_id); if (loaded) updateAgentSession(loaded); }
      else { const loaded = await api.loadSession(record.conversation_id); if (loaded) updateSession(loaded); }
    } catch (error) { setNotice(errorText(error), record.conversation_id); }
  };
  const openTimelineSource = async (event: TimelineEvent, messageID?: string) => {
    const ref = event.ref;
    if (ref.source === 'local-plan') {
      await api.showWorkbench(ref.id);
    } else if (ref.source === 'model' || ref.source === 'agent') {
      const record = ref.source === 'model' ? await api.loadSession(ref.id) : await api.loadAgentSession(ref.id);
      if (!record) throw new Error('原会话已不可读；时间线仍保留来源说明。');
      if (ref.source === 'model') updateSession(record as SessionRecord); else updateAgentSession(record as AgentSessionRecord);
      await openSession(record); if (messageID) setSearchHit({ key: chatKey(record), messageID });
    } else if (ref.source === 'task-session') {
      const record = await api.loadTaskSession({ format: 'task-v2', sessionID: ref.id });
      if (!record) throw new Error('原任务会话已不可读。');
      updateTaskSession(record); navigate({ view: 'chat', projectID: record.scope.project_id, taskID: record.scope.task_id });
      setPanelContext({ projectID: record.scope.project_id, taskID: record.scope.task_id }); setHistorySessionID(record.conversation_id); setTimelineTaskMessage(messageID); setDetails(false);
    } else {
      const workspace = await api.refreshProject(ref.projectID!);
      setProjects(previous => [...previous.filter(p => p.project?.project_id !== ref.projectID), workspace]);
      const task = workspace?.tasks.find(t => t.task_id === (event.taskID ?? ref.id));
      if (!workspace || !task) throw new Error('原任务来源不可读，请先刷新项目或重新选择项目目录。');
      selectTask(workspace, task);
    }
    setTimelineReturn(true);
  };
  const send = async () => {
    const originalNavigation = navRef.current, originalKey = draftKey(originalNavigation);
    const submittedDraft = draftMap.current.get(originalKey) ?? draft, text = submittedDraft.trim();
    const useAgent = originalNavigation.source === 'agent';
    const archivedNow = () => !!originalNavigation.sessionID && !!chatPreferencesRef.current.entries[`${useAgent ? 'agent' : 'model'}:${originalNavigation.sessionID}`]?.archived;
    if (archivedNow()) { setNotice('恢复聊天后可继续发送。'); return; }
    if (!text || submissionPending.current || modelSelectionPending.current || active || loading || latestTurn?.state === 'unknown' || (useAgent ? !agentCanContinue : !hasCredential)) return;
    submissionPending.current = true;
    setSubmitting(true); setNotice(''); setConnectionRecovery(false); setSubmittingKey(originalKey);
    const submittedVersion = draftVersions.current.get(originalKey) ?? 0;
    const startedNavigation = navigationSerial.current;
    const consumedKeys = new Set<string>();
    const consumeDraft = (targetID: string) => {
      const targetKey = draftKey({ ...originalNavigation, sessionID: targetID });
      for (const key of new Set([targetKey, originalKey])) {
        if ((draftVersions.current.get(key) ?? 0) !== submittedVersion || draftMap.current.get(key)?.trim() !== text) continue;
        consumedKeys.add(key); draftMap.current.set(key, ''); void persistDraft(key, '');
        if (draftKey(navRef.current) === key) setDraft('');
      }
    };
    const restoreDraft = () => {
      for (const key of consumedKeys) {
        if ((draftVersions.current.get(key) ?? 0) !== submittedVersion || draftMap.current.get(key) !== '') continue;
        draftMap.current.set(key, submittedDraft); void persistDraft(key, submittedDraft);
        if (draftKey(navRef.current) === key) setDraft(submittedDraft);
      }
    };
    let target: ChatRecord | undefined = session;
    const report = (message: string) => { if (target) setNotice(message, target.conversation_id); else if (startedNavigation === navigationSerial.current) setNotice(message); };
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    void persistDraft(originalKey, submittedDraft);
    try {
      let source: AgentChatReadySource | undefined;
      if (useAgent) {
        const fresh = await refreshSources();
        const selected = fresh.find(value => value.agentID === (target && agentRecord(target) ? target.source.agentID : originalNavigation.agentID));
        source = selected?.state === 'ready' ? selected : undefined;
        if (!source || !supportsAgentChat(source.capabilities) || !matchingAgent(source, target && agentRecord(target) ? target : undefined)) { report('原 Agent 连接不可继续，请检查 Agent 设置或新建聊天。'); return; }
      }
      if (!target) {
        const scope: SessionScope | undefined = originalNavigation.planID ? { kind: 'local_task', local_task_id: originalNavigation.planID } : originalNavigation.projectID ? { kind: 'project', project_id: originalNavigation.projectID, ...(originalNavigation.taskID ? { task_id: originalNavigation.taskID } : {}) } : undefined;
        if (useAgent) { target = await api.createAgentSession({ title: Array.from(text).slice(0, 38).join(''), agentID: source!.agentID, scope, ...(agentExecutions[source!.agentID] ? { execution: { workspaceID: agentExecutions[source!.agentID].workspace.id, mode: agentExecutions[source!.agentID].mode } } : {}) }); updateAgentSession(target as AgentSessionRecord); }
        else { target = await api.createSession({ title: Array.from(text).slice(0, 38).join(''), scope }); updateSession(target as SessionRecord); }
        if (originalNavigation.planID) {
          const freshPlan = (await api.bootstrap()).plans.find(p => p.id === originalNavigation.planID);
          if (!freshPlan) throw new Error('任务已不可读取，聊天尚未发送。');
          const content = taskContent(freshPlan);
          addPlan(await api.savePlan({ plan: { ...freshPlan, schema_version: 3, task: { ...content, chat_refs: [...content.chat_refs, { source: useAgent ? 'agent' : 'model', sessionID: target.conversation_id }] } }, expectedVersion: freshPlan.version }));
        }
        const nextNav = { ...originalNavigation, view: 'chat' as const, sessionID: target.conversation_id };
        const nextKey = draftKey(nextNav);
        draftMap.current.set(nextKey, draftMap.current.get(originalKey) ?? submittedDraft);
        draftVersions.current.set(nextKey, draftVersions.current.get(originalKey) ?? submittedVersion);
        setSubmittingKey(nextKey);
        if (startedNavigation === navigationSerial.current) { navRef.current = nextNav; setNav(nextNav); }
      }
      if (archivedNow()) { report('聊天已归档，请恢复后再发送。'); return; }
      inFlightID.current = target.conversation_id; inFlightSource.current = useAgent ? 'agent' : 'model';
      const pendingResult = useAgent ? api.sendAgentMessage({ sessionID: target.conversation_id, text }) : api.sendMessage({ sessionID: target.conversation_id, text });
      consumeDraft(target.conversation_id);
      const result = await pendingResult;
      if (useAgent) updateAgentSession(result.session as AgentSessionRecord); else updateSession(result.session as SessionRecord);
      if (result.status === 'notSubmitted') restoreDraft();
      if (result.reason) { report(result.reason); if (!useAgent && result.status !== 'accepted' && navRef.current.sessionID === target.conversation_id) setConnectionRecovery(true); }
    } catch (error) { restoreDraft(); report(errorText(error)); if (!useAgent && startedNavigation === navigationSerial.current) setConnectionRecovery(true); }
    finally { submissionPending.current = false; setSubmitting(false); setSubmittingKey(null); inFlightID.current = null; }
  };
  const stop = async () => {
    const id = session?.conversation_id ?? (pendingForView ? inFlightID.current : null);
    if (stopping || !id) return;
    const key = visibleDraftKey, agent = session ? agentRecord(session) : inFlightSource.current === 'agent';
    setStopping(true); setStoppingKey(key);
    try { if (agent) await api.stopAgentGeneration(id); else await api.stopGeneration(id); }
    catch (error) { setNotice('停止请求未确认：' + errorText(error), id); }
    finally { setStopping(false); setStoppingKey(null); }
  };
  const addPlan = (plan: PreviewPlan) => { setPlans(current => mergePlans(current, [plan])); return plan; };
  const retryRecord = async () => { if (!session || recordSaving) return; setRecordSaving(true); try { if (agentRecord(session)) await api.retryAgentPendingWrites(session.conversation_id); else await api.retryPendingWrites(session.conversation_id); setNotice('本地记录已保存，请求没有重发。', session.conversation_id); } catch (error) { setNotice(`本地记录保存失败：${errorText(error)}；没有重发请求。`, session.conversation_id); } finally { setRecordSaving(false); } };
  const filteredTasks = allTasks.filter(({ workspace }) => !nav.projectID || workspace.project?.project_id === nav.projectID);
  const localPlans = nav.projectID ? [] : plans.filter(plan => !plan.scope);
  const chatSessions: ChatRecord[] = [...sessions, ...agentSessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const openTaskScreen = async (frameID: string) => {
    try {
      const frame = await api.timelineFrame(frameID);
      const parts = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(frame.timestamp));
      const day = ['year','month','day'].map(kind => parts.find(p => p.type === kind)!.value).join('-');
      timelineMemory.current = { ...timelineMemory.current, day, query:'', allDates:false, sceneMode:true, showScene:true, frameID, eventID:undefined };
      navigate({ view:'timeline' });
    } catch (error) { setNotice(`原画面不可读取，已保存摘要仍保留：${errorText(error)}`); }
  };
  const saveTaskPlan = async (plan: PreviewPlan) => addPlan(await api.savePlan({ plan, expectedVersion: plan.version }));
  const startTaskDiscussion = (plan: PreviewPlan, workItemID?: string) => {
    const item = plan.work_items.find(item => item.id === workItemID);
    const next: Navigation = { view: 'chat', planID: plan.id, source: navRef.current.source, agentID: navRef.current.agentID };
    navigate(next); setDetails(true);
    if (!draftMap.current.has(draftKey(next))) {
      // A new task draft is loaded before any addition, never overwritten by an async load.
      void api.loadDraft(draftKey(next)).then(existing => {
        if (draftKey(navRef.current) !== draftKey(next) || draftMap.current.has(draftKey(next))) return;
        draftMap.current.set(draftKey(next), existing); setDraft(existing);
      }).catch(error => setNotice(errorText(error)));
    }
    if (item) { setWorkItemContext({ title: item.title }); void prepareTaskDiscussion({ kind: 'discussion-draft', taskKey: `local:${plan.id}`, baseVersion: plan.version, workItemID: item.id, target: { kind: 'new' }, text: `讨论工作项：${item.title}\n预期结果：${item.expected_result}`, materials: [] }).catch(error => setNotice(errorText(error))); }
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const prepareTaskDiscussion = async (handoff: TaskChatHandoff) => {
    if (handoffPending.current) return;
    handoffPending.current = true;
    const started = navigationSerial.current;
    try {
      const fresh = (await api.bootstrap()).plans.find(plan => `local:${plan.id}` === handoff.taskKey);
      if (!fresh || fresh.version !== handoff.baseVersion) throw new Error('任务版本已变化，请核对后重试。');
      const content = taskContent(fresh);
      const materials = handoff.materials.map(selected => {
        const source = content.materials.find(m => m.id === selected.id);
        if (!source || source.summary !== selected.summary) throw new Error('材料已变化，请重新选择。');
        return `材料：${source.title}（${source.source.label}）\n${source.summary}`;
      });
      const record = handoff.target.kind === 'existing' ? chatSessions.find(r => chatKey(r) === (handoff.target.kind === 'existing' ? handoff.target.sessionID : '')) : undefined;
      if (handoff.target.kind === 'existing' && !record) throw new Error('所选聊天不可用。');
      const next: Navigation = record ? { view: 'chat', sessionID: record.conversation_id, source: agentRecord(record) ? 'agent' : 'model', ...(agentRecord(record) ? { agentID: record.source.agentID } : {}), planID: fresh.id } : { view: 'chat', planID: fresh.id, source: navRef.current.source, agentID: navRef.current.agentID };
      const key = draftKey(next);
      const existing = draftMap.current.has(key) ? draftMap.current.get(key)! : await api.loadDraft(key);
      const addition = [handoff.text, ...materials].join('\n\n');
      const merged = [draftMap.current.get(key) ?? existing, addition].filter(Boolean).join('\n\n');
      if (new TextEncoder().encode(merged).byteLength > 64 * 1024) throw new Error('草稿过长，请减少带入内容。原草稿已保留。');
      if (record && !content.chat_refs.some(ref => ref.sessionID === record.conversation_id && ref.source === (agentRecord(record) ? 'agent' : 'model'))) {
        await saveTaskPlan({ ...fresh, schema_version: 3, task: { ...content, chat_refs: [...content.chat_refs, { source: agentRecord(record) ? 'agent' : 'model', sessionID: record.conversation_id }] } });
      }
      if (started !== navigationSerial.current) throw new Error('页面已切换，未带入聊天草稿。');
      // Re-read the in-memory input after async saves, preserving newer typing.
      const latest = draftMap.current.get(key) ?? existing;
      const combined = [latest, addition].filter(Boolean).join('\n\n');
      if (new TextEncoder().encode(combined).byteLength > 64 * 1024) throw new Error('草稿过长，未带入内容。');
      if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
      draftMap.current.set(key, combined); draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1);
      if (draftKey(navRef.current) === key) setDraft(combined);
      await persistDraft(key, combined);
      const failed = draftStates.current.get(key)?.status === 'failed';
      if (failed) throw new Error('讨论草稿未保存，请重试。');
      if (started === navigationSerial.current) { navigate(next); setDetails(true); setDraft(draftMap.current.get(key) ?? combined); }
    } finally { handoffPending.current = false; }
  };
  const selectModel = async (modelID: string) => {
    if (modelSelectionPending.current || active || submitting || stopping || !settings || modelID === settings.modelID) return;
    modelSelectionPending.current = true; setModelSelecting(true); setModelSelectionStatus('default');
    try { setSettings(await api.selectProviderModel({ modelID })); setModelSelectionStatus('success'); }
    catch (error) { setNotice(errorText(error)); setModelSelectionStatus('error'); }
    finally { modelSelectionPending.current = false; setModelSelecting(false); }
  };
  const pendingChatKey = submitting && submittingKey?.startsWith('agent-session:') ? 'agent:' + submittingKey.slice(14) : submitting && submittingKey?.startsWith('session:') ? 'model:' + submittingKey.slice(8) : inFlightID.current ? `${inFlightSource.current}:${inFlightID.current}` : undefined;
  const currentArchived = !!session && !!chatPreference(session, chatPreferences).archived;
  const connectionReason = currentArchived ? '恢复聊天后可继续发送。' : isAgent ? agentReason : !hasCredential ? '配置模型连接后即可发送。' : '';
  const sendReason = loading ? '正在读取本地记录。' : modelSelecting ? '正在切换模型…' : latestTurn?.state === 'unknown' ? '上一轮状态未知，请新建聊天，避免重复提交。' : connectionReason || (stoppingForView || latestTurn?.state === 'cancelling' ? '已请求停止，正在确认结果。' : pendingForView && !active ? '正在提交请求…' : submitting && !pendingForView ? '另一个聊天正在请求，完成后可发送。' : '');
  const showAgentFeedback = !!agentSession || !!readyAgentSource || !!sourcesError || (selectedAgentSource?.state === 'unavailable' && selectedAgentSource.reason === 'requires-restart');
  const agentConnectionNeeded = isAgent && !showAgentFeedback && !sourcesLoading;
  const agentModelLabel = agentCanContinue ? readyAgentSource!.model.model_id : agentSession ? '原请求：' + (latestTurn?.requested_model.model_id ?? '尚未记录模型') : readyAgentSource?.model.model_id ?? '连接后显示模型';
  const topTitle = nav.view === 'knowledge' ? '知识' : nav.view === 'tasks' ? currentProject?.project?.name ?? '任务' : nav.view === 'timeline' ? '时间线' : currentTask ? '任务讨论' : session?.title ?? currentProject?.project?.name ?? '新聊天';
  const mac = navigator.platform.toLowerCase().includes('mac');
  const quoteMessage = (text: string) => {
    const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
    const next = `${draft}${draft ? '\n\n' : ''}${quoted}\n\n`;
    if (new TextEncoder().encode(next).byteLength > 64 * 1024) {
      setNotice('引用后草稿过长，请选取较短的内容；原草稿已保留。');
      return;
    }
    editDraft(next);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(next.length, next.length); });
  };
  const newChat = () => { setSearchOpen(false); setComposerExpanded(false); navigate({ view: 'chat', source: navRef.current.source, agentID: navRef.current.agentID }); setDetails(false); requestAnimationFrame(() => textarea.current?.focus()); };
  const openSearch = () => {
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    const bounds = searchTrigger.current?.getBoundingClientRect();
    setSearchOrigin(bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null);
    setSearchText(''); setSearchOpen(true);
  };
  const openSearchResult = (record: ChatRecord, messageID?: string) => {
    setSearchOpen(false);
    const opened = openSession(record);
    const serial = navigationSerial.current;
    void opened.then(() => {
      if (serial !== navigationSerial.current || navRef.current.sessionID !== record.conversation_id || (navRef.current.source ?? 'model') !== chatReference(record).source) return;
      if (messageID) setSearchHit({ key: chatKey(record), messageID });
      else requestAnimationFrame(() => { if (serial === navigationSerial.current) textarea.current?.focus(); });
    });
  };
  const renameChat = async (record: ChatRecord, title: string) => {
    const input = { sessionID: record.conversation_id, title, expectedRevision: record.revision };
    if (agentRecord(record)) updateAgentSession(await api.renameAgentSession(input)); else updateSession(await api.renameSession(input));
  };
  const archiveChat = async (record: ChatRecord, archived: boolean) => { updatePreferences(await api.setChatArchived({ ...chatReference(record), archived })); };
  const pinChat = async (record: ChatRecord, pinned: boolean) => { updatePreferences(await api.setChatPinned({ ...chatReference(record), pinned })); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); newChat(); }
      else if (key === 'k') { event.preventDefault(); openSearch(); }
      else if (key === 'l' && navRef.current.view === 'chat') { event.preventDefault(); textarea.current?.focus(); }
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  });
  return <><div id="app-shell" className={`app-shell ${mac ? 'mac' : ''} ${collapsed ? 'sidebar-collapsed' : ''} ${panelOpen ? 'context-open' : 'context-closed'}`}>
    <div className="brand-header"><Brand /><button className="icon-button" title={collapsed ? '展开侧栏' : '折叠侧栏'} aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
    <header className="topbar"><div className="topbar-context"><span className="topbar-title">{topTitle}</span>{latestTurn && <StateLabel state={stoppingForView ? 'cancelling' : latestTurn.state} />}</div><div className="topbar-actions"><button className="icon-button" title="打开 Deck" aria-label="打开 Deck" onClick={() => void api.openDeck(isAgent ? undefined : session?.conversation_id).catch(error => setNotice(errorText(error)))}><ExternalLink size={15} /></button>{canTogglePanel && <button className={`icon-button ${panelOpen ? 'is-selected' : ''}`} title={panelOpen ? '收起右栏' : '展开右栏'} aria-label={panelOpen ? '收起右栏' : '展开右栏'} aria-pressed={panelOpen} aria-controls="task-context-panel" onClick={() => setDetails(value => !value)}><PanelRight size={16} /></button>}</div></header>
    <aside className="sidebar" aria-label="主导航"><nav className="nav-group">{([['chat', '新聊天', Plus], ['search', '搜索', Search], ['tasks', '任务', FileText], ['timeline', '时间线', Clock3], ['knowledge', '知识', BookOpen]] as const).map(([id, label, Icon]) => <button key={id} ref={id === 'search' ? searchTrigger : undefined} className={`nav-item ${(id === 'search' ? searchOpen : nav.view === id && (id !== 'chat' || !session)) ? 'active' : ''}`} aria-label={label} aria-haspopup={id === 'search' ? 'dialog' : undefined} aria-expanded={id === 'search' ? searchOpen : undefined} title={id === 'chat' ? `新聊天 ${mac ? '⌘' : 'Ctrl+'}N` : id === 'search' ? `搜索 ${mac ? '⌘' : 'Ctrl+'}K` : label} onClick={() => { if (id === 'chat') newChat(); else if (id === 'search') openSearch(); else navigate({ view: id, source: navRef.current.source, agentID: navRef.current.agentID }); }}><Icon size={17} /><span className="nav-label">{label}</span></button>)}</nav>
      <div className="sidebar-scroll"><section className="sidebar-section"><div className="sidebar-heading"><span>项目</span><button className="icon-button" aria-label="添加项目" disabled={projectBusy} onClick={() => void chooseProject()}>{projectBusy ? <RefreshCw size={13} /> : <Plus size={15} />}</button></div>{projects.filter(value => value.project).length ? projects.filter(value => value.project).map(workspace => <div key={workspace.project!.project_id}><button className={`project-button ${nav.projectID === workspace.project!.project_id ? 'active' : ''}`} onClick={() => { const id = workspace.project!.project_id; if (pageTask?.kind !== 'project' || pageTask.projectID !== id) setPageTask(undefined); setExpandedProjects(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); navigate({ view: 'tasks', projectID: id }); }}><Folder size={14} /><span>{workspace.project!.name}</span>{expandedProjects.has(workspace.project!.project_id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>{expandedProjects.has(workspace.project!.project_id) && <div className="project-tasks">{workspace.tasks.map(task => <button className={`task-shortcut ${task.task_id === nav.taskID ? 'active' : ''}`} key={task.task_id} onClick={() => selectTask(workspace, task)} title={task.title}>{task.title}</button>)}{!workspace.tasks.length && <p className="sidebar-empty">没有可读取的任务</p>}</div>}</div>) : <p className="sidebar-empty">添加本机项目后<br />在这里查看任务。</p>}</section>
      <ChatHistory agentNames={agentNames} records={chatSessions} preferences={chatPreferences} selectedKey={nav.sessionID ? `${isAgent ? 'agent' : 'model'}:${nav.sessionID}` : undefined} pendingKey={pendingChatKey} disabled={!preferencesReady} onOpen={record => void openSession(record)} onRename={renameChat} onArchive={archiveChat} onPin={pinChat} onSearch={openSearch} onNewChat={newChat} /></div>
      <footer className="sidebar-footer"><ScreenRecordingIndicator api={api} onOpen={() => navigate({ view: 'timeline', source: navRef.current.source, agentID: navRef.current.agentID })} /><button className="nav-item" aria-label="设置" onClick={() => openSettings()}><Settings2 size={17} /><span className="nav-label">设置</span></button></footer>
    </aside>
    <main className={`workbench ${panelOpen ? 'has-detail' : ''}`}><section className="center-column" id="center-column" aria-label="工作区">{timelineReturn && nav.view !== 'timeline' && <button className="tl-return-search text-button" onClick={() => { setTimelineReturn(false); navigate({ view: 'timeline', source: navRef.current.source, agentID: navRef.current.agentID }); }}>返回时间线</button>}{notice && <div className="global-notice"><Notice onDismiss={() => setNotice('')}>{notice}{connectionRecovery && <button className="text-button" onClick={() => openSettings('models')}>打开设置</button>}{session && noticeSessionID === session.conversation_id && /记录.*保存|事实.*保存|未能保存|未保存的事实|写入|落盘/.test(notice) && <button className="button small" disabled={recordSaving} onClick={() => void retryRecord()}>{recordSaving ? '正在保存…' : '重试记录保存'}</button>}</Notice></div>}
      <div hidden={loading || nav.view !== 'knowledge'} className="knowledge-host"><KnowledgeWorkspace api={api} active={!loading && nav.view === 'knowledge'} plans={plans} memory={knowledgeMemory.current} onPlanSaved={addPlan} onOpenTask={taskID => { setPageTask({kind:'local',planID:taskID}); navigate({view:'tasks'}); }} /></div>
      <div hidden={loading || nav.view !== 'tasks'} className="task-workspace-host"><ProjectNotices diagnostics={projectDiagnostics} workspace={currentProject} selectionNotice={projectSelectionNotice} refreshNotice={nav.projectID ? projectRefreshNotices[nav.projectID] : undefined} busy={projectBusy} onChoose={() => void chooseProject()} /><TaskWorkspace api={api} active={!loading && nav.view === 'tasks'} projectID={nav.projectID} onRefresh={refreshCurrentProject} onOpenScreen={id => void openTaskScreen(id)} renderExtra={(plan, disabled) => <TaskExtras key={plan.id} api={api} plan={plan} agents={agentSources} disabled={disabled} onConfigureModel={() => openSettings('models')} jevSettingsRevision={jevSettingsRevision} onConfigureJev={() => { setSettingsInitialSection('tools'); setSettingsJevFocus(true); setSettingsOpen(true); }} />} plans={plans} projects={projects} agents={agentSources} selection={pageTask} memory={pageTaskDrafts.current} onSelect={setPageTask} onCreate={async () => { setTaskDraftOpen(true); }} onSave={saveTaskPlan} onDeck={plan => api.openDeck(undefined, plan.id)} onDiscuss={startTaskDiscussion} /></div>
      {loading ? <div className="center-content"><div className="loading-lines" aria-label="正在读取本地记录"><div /><div /><div /></div></div> : nav.view === 'chat' ? <>
        {currentArchived && session && <div className="chat-archived-banner"><span>已归档</span><button className="text-button" disabled={!preferencesReady} onClick={() => void archiveChat(session, false).catch(error => setNotice(errorText(error)))}>恢复聊天</button></div>}
        {session?.messages.length || selectedHistory ? <div className="center-content" ref={stream} onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; setShowJump(!followOutput.current); }}><div className="messages">{session?.messages.map(message => { const turn = session.turns.find(value => value.turn_id === message.turn_id); return <article key={message.message_id} className={`message ${message.role}`} data-message-id={message.message_id} data-search-hit={searchHit?.key === chatKey(session) && searchHit.messageID === message.message_id || undefined} tabIndex={-1}><ChatMessage message={message} isAgent={isAgent} agentName={selectedAgentName} observedModel={turn?.observed_model?.model_id} showActions={!!turn && !isBusy(turn.state)} onQuote={quoteMessage} onCreateTask={turn?.state === 'finished' ? () => setChatTaskSource({ source: isAgent ? 'agent' : 'model', sessionID: session.conversation_id, messageID: message.message_id }) : undefined} />{isAgent && message.role === 'assistant' && <AgentTurnTools api={api} sessionID={session.conversation_id} turnID={message.turn_id} />}</article>; })}{latestTurn?.failure && <Notice>{latestTurn.failure}</Notice>}{selectedHistory && historyTask && <TaskExecutionHistory key={selectedHistory.conversation_id} api={api} task={historyTask} projectName={currentProject?.project?.name} sessionID={selectedHistory.conversation_id} focusMessageID={timelineTaskMessage} onSessionChange={updateTaskSession} onClose={() => { navigationSerial.current++; setHistorySessionID(null); }} />}</div></div> : <div className="welcome-content"><div className="welcome"><h1>今天想推进什么？</h1><p>{currentTask ? '从当前任务开始，写下你的下一步。' : '从一个问题开始。'}</p></div></div>}
        <div className="composer-wrap">
          {showJump && <button className="button small jump-to-latest" onClick={() => { followOutput.current = true; if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; setShowJump(false); }}><ArrowDown size={13} />回到最新</button>}
          {workItemContext && <div className="composer-task-context"><FileText size={13} /><span>讨论工作项 · {workItemContext.title}</span><button className="text-button" onClick={() => setWorkItemContext(null)}>清除提示</button></div>}
          <div className={`composer${composerExpanded ? ' is-expanded' : ''}`}>
            <textarea id="chat-draft" ref={textarea} aria-label="输入消息" placeholder="输入消息，或继续讨论…" value={draft} onChange={event => editDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }} />
            <div className="composer-bottom" data-testid="composer-toolbar">
              <div className="composer-left"><ChatSourcePicker value={isAgent ? 'agent' : 'model'} agentID={selectedAgentID} agents={agentSources} disabled={active || pendingForView || stoppingForView || submitting || modelSelecting} state={isAgent && sourcesLoading ? 'loading' : isAgent && (sourcesError || !agentCanContinue && !!agentSession) ? 'error' : isAgent && agentCanContinue ? 'success' : 'default'} onChange={chooseSource} />{isAgent && selectedAgentSource?.capabilities.tools && <AgentWorkspaceControls key={selectedAgentID + ':' + (agentSession?.conversation_id ?? 'new')} api={api} agentID={selectedAgentID ?? ''} sessionID={agentSession?.conversation_id} selection={agentExecutions[selectedAgentID ?? '']} disabled={active || submitting || stoppingForView} onChange={value => setAgentExecutions(current => { const next = { ...current }; if (value) next[selectedAgentID ?? ''] = value; else delete next[selectedAgentID ?? '']; return next; })} />}</div>
              <div className="composer-right">
                {!isAgent && settings && modelCatalog?.baseURL === settings.baseURL && modelCatalog.modelIDs.length > 0 ? <ChatModelPicker value={settings.modelID} modelIDs={modelCatalog.modelIDs} disabled={active || submitting || stopping || loading} loading={modelSelecting} state={modelSelectionStatus} onChange={id => void selectModel(id)} onSettings={() => openSettings('models')} /> : <button className={`model-select${agentConnectionNeeded ? ' agent-connect' : ''}`} aria-label={isAgent ? 'Agent 设置' : '模型设置'} aria-describedby="composer-current-model" aria-haspopup="dialog" title={agentConnectionNeeded ? `${selectedAgentName} 未连接 · 打开 Agent 设置` : `${isAgent ? agentModelLabel : settings?.modelID || '尚未配置模型'} · ${isAgent ? 'Agent 设置' : '模型设置'}`} onClick={() => openSettings(isAgent ? 'tools' : 'models')}><span className="model-select-label">{agentConnectionNeeded ? '未连接' : isAgent ? agentModelLabel : settings?.modelID || '配置模型'}</span></button>}<span className="visually-hidden" id="composer-current-model">{agentConnectionNeeded ? `${selectedAgentName} 未连接，点击打开 Agent 设置。` : isAgent ? agentModelLabel : settings?.modelID || '尚未配置模型'}</span>
                <button className="icon-button composer-expand" aria-label={composerExpanded ? '收起输入框' : '展开输入框'} title={composerExpanded ? '收起输入框' : '展开输入框'} aria-expanded={composerExpanded} aria-controls="chat-draft" onClick={() => setComposerExpanded(value => !value)}>{composerExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
                <button className="send-button" aria-label={active ? '停止生成' : pendingForView ? '正在准备请求' : '发送消息'} aria-busy={pendingForView && !active} title={active ? isAgent && !selectedAgentSource?.capabilities.interrupt ? '此 Agent 未提供确认停止能力' : '停止生成' : sendReason || '发送消息'} disabled={active ? isAgent && !selectedAgentSource?.capabilities.interrupt || stoppingForView || latestTurn?.state === 'cancelling' : !draft.trim() || !!sendReason} onClick={() => active ? void stop() : void send()}>{active ? <Square size={14} fill="currentColor" /> : pendingForView ? <RefreshCw size={17} className="busy-icon" /> : <ArrowUp size={14} />}</button>
              </div>
            </div>
          </div>
          {isAgent ? showAgentFeedback && sendReason && <div className="composer-source-feedback" data-state={agentCanContinue ? 'ready' : 'unavailable'}><p className="composer-reason" role="status">{sendReason}</p>{!agentCanContinue && !sourcesLoading && <button className="text-button" onClick={() => openSettings('tools')}>打开 Agent 设置</button>}{agentSession && (!agentCanContinue || latestTurn?.state === 'unknown') && <button className="text-button" onClick={newAgentChat}>新建 {selectedAgentName} 聊天</button>}{sourcesError && <button className="text-button" onClick={() => void refreshSources().catch(() => {})}>重新读取连接</button>}</div> : sendReason && (hasCredential || loading) && <p className="composer-reason" role="status">{sendReason}</p>}
          {draftStatus === 'failed' && <p className="composer-reason">{draftError}</p>}
          <div className={draftStatus === 'failed' ? 'composer-footer' : undefined}>
            <span className={`composer-draft-status${draftStatus === 'failed' ? '' : ' visually-hidden'}`} role="status">{draftStatus === 'saving' ? '正在保存草稿' : draftStatus === 'saved' && draft ? '草稿已保存' : draftStatus === 'failed' ? <button className="text-button" onClick={() => void retryDraft()}>{draftMap.current.has(draftKey(navRef.current)) ? '重试保存草稿' : '重新读取草稿'}</button> : ''}</span>
          </div>
        </div>
      </> : nav.view === 'tasks' || nav.view === 'knowledge' ? null : <UnifiedTimeline api={api} memory={timelineMemory} onSettings={() => openSettings('data')} onOpen={openTimelineSource} screenContextBridge={{ targets: plans.filter(plan => !plan.scope).map(plan => ({ key: `local:${plan.id}`, title: plan.title, sourceLabel: '本地任务', version: plan.version })), refreshTargets: () => { void api.bootstrap().then(data => setPlans(current => mergePlans(current, data.plans))).catch(error => setNotice(errorText(error))); }, confirm: input => api.confirmTaskContext(input) }} />}
    </section>{panelPlan && nav.view === 'chat' ? <aside hidden={!panelOpen} className="local-task-sidebar" id="task-context-panel" aria-label="当前聊天任务"><header><strong>{panelPlan.title}</strong><button className="icon-button" aria-label="关闭任务详情" onClick={() => setDetails(false)}>×</button></header><TaskDetailContent projects={projects} key={panelPlan.id} plan={panelPlan} onOpenScreen={id => void openTaskScreen(id)} renderExtra={(plan, disabled) => <TaskExtras key={plan.id} api={api} plan={plan} agents={agentSources} disabled={disabled} onConfigureModel={() => openSettings('models')} jevSettingsRevision={jevSettingsRevision} onConfigureJev={() => { setSettingsInitialSection('tools'); setSettingsJevFocus(true); setSettingsOpen(true); }} />} memory={chatTaskDrafts.current} agents={agentSources} onSave={saveTaskPlan} onDeck={plan => api.openDeck(undefined, plan.id)} onDiscuss={startTaskDiscussion} /><TaskDiscussion key={'discussion:' + panelPlan.id} plan={panelPlan} api={api} records={chatSessions} sources={agentSources} onPrepare={prepareTaskDiscussion} onOpenSession={id => { const record = chatSessions.find(r => chatKey(r) === id); if (record) void openSession(record); }} onUnlink={async id => { const content = taskContent(panelPlan); await saveTaskPlan({ ...panelPlan, schema_version: 3, task: { ...content, chat_refs: content.chat_refs.filter(ref => `${ref.source}:${ref.sessionID}` !== id) } }); }} onStandalone={newChat} /></aside> : <TaskDetails open={panelOpen} key={panelKey} task={panelTask} runs={panelProject?.runs ?? []} references={panelProject?.artifact_refs ?? []} plans={panelTask ? plans.filter(plan => plan.scope?.project_id === panelTask.project_id && plan.scope?.task_id === panelTask.task_id) : []} model={model} openReference={openReference} filePreviewOnly={filePreviewOnly} onFilesChange={reportPanelFiles} onClose={() => setDetails(false)} onPreview={ref => api.previewArtifact({ projectID: ref.project_id, referenceID: ref.reference_id })} onCreatePlan={async (title, items) => { if (!panelTask) throw new Error('请先选择确切的项目任务。'); const empty = await api.createPlan({ title, scope: { project_id: panelTask.project_id, task_id: panelTask.task_id } }); return addPlan(await api.savePlan({ plan: { ...empty, work_items: items }, expectedVersion: empty.version })); }} onSavePlan={async plan => addPlan(await api.savePlan({ plan, expectedVersion: plan.version }))} onRecommend={plan => api.recommendations(plan.id)} onDiscussWorkItem={discussWorkItem} onRequestWorkItem={(plan, id) => void requestWorkItem(plan, id)} executionPending={preparingWorkItem} taskSessions={panelTaskSessions} onOpenTaskHistory={openTaskHistory} />}</main>
  </div>{taskDraftOpen && <TaskDraftComposer api={api} projects={projects.flatMap(p=>p.project?[{id:p.project.project_id,name:p.project.name}]:[])} defaultProjectID={nav.projectID} onClose={()=>setTaskDraftOpen(false)} onCreated={plan=>{addPlan(plan);setPageTask({kind:'local',planID:plan.id});setTaskDraftOpen(false);navigate({view:'tasks',source:navRef.current.source,agentID:navRef.current.agentID});}} />}{chatTaskSource && <ChatTaskComposer key={`${chatTaskSource.source}:${chatTaskSource.sessionID}:${chatTaskSource.messageID}`} api={api} projects={projects.flatMap(p=>p.project?[{id:p.project.project_id,name:p.project.name}]:[])} reference={chatTaskSource} onClose={() => setChatTaskSource(undefined)} onCreated={plan => { addPlan(plan); const ref = chatTaskSource; setChatTaskSource(undefined); setPageTask({ kind: 'local', planID: plan.id }); navigate({ view: 'chat', sessionID: ref.sessionID, source: ref.source, ...(ref.source === 'agent' ? { agentID: agentSessions.find(record => record.conversation_id === ref.sessionID)?.source.agentID } : {}), planID: plan.id }); setDetails(true); }} />}{searchOpen && <ChatSearch agentNames={agentNames} origin={searchOrigin} records={chatSessions} preferences={chatPreferences} query={searchText} onQuery={setSearchText} onOpen={openSearchResult} onClose={() => setSearchOpen(false)} loading={loading} />}{settings && <Settings runtimeAPI={api} open={settingsOpen} initialSection={settingsInitialSection} initialJev={settingsJevFocus} settings={settings} dataRootLabel={dataRootLabel} onClose={() => { setSettingsOpen(false); setSettingsJevFocus(false); setJevSettingsRevision(value => value + 1); void refreshSources().catch(() => {}); }} onSave={async input => { const saved = await api.saveSettings(input); setSettings(saved); return saved; }} />}</>;
}
