import { StorageError, type SessionManager, type TaskOrchestrator } from '../core/index.js';
import type { ProjectWorkspaceReader } from '../projects/index.js';
import type { PreviewPlan, PreviewPlanScope, SessionScope } from '../shared/types.js';
import { validatePreviewPlanScope } from '../core/tasks/task-orchestrator.js';
import type { BootstrapResult, SettingsInput } from '../shared/desktop-api.js';
import type { ElectronHost } from './electron-host.js';
import type { ProviderSettingsStore } from './provider-settings.js';
import type { ProviderModelsService } from './provider-models.js';
import type { LocalState } from './local-state.js';
import { payload, textInput, uuidInput } from './ipc-validation.js';
import { ChatPreferencesStore } from './chat-preferences.js';
import type { ChatPreferences, ChatReference, RenameChatInput } from '../shared/chat-management.js';
import { ProjectRegistry } from './project-registry.js';

export interface DesktopRouteDependencies {
  settings: ProviderSettingsStore;
  providerModels?: ProviderModelsService;
  manager: SessionManager;
  projects: ProjectWorkspaceReader;
  projectRegistry?: ProjectRegistry;
  plans: TaskOrchestrator;
  local: LocalState;
  host: ElectronHost;
  diagnostics: readonly string[];
  previewRoot: string;
  withSettingsSnapshot: <T>(snapshot: ReturnType<ProviderSettingsStore['snapshot']>, operation: () => T) => T;
}

/** Routes coordinate existing services; all state stays with its injected owner. */
export function installDesktopRoutes(dependencies: DesktopRouteDependencies): void {
  const { settings, providerModels, manager, projects, plans, local, host, diagnostics, previewRoot, withSettingsSnapshot } = dependencies;
  const handler = (channel: string, operation: (input: unknown) => unknown) => host.handle(channel, operation);
  const pendingSubmissions = new Map<string, { cancelled: boolean }>();
  let deckNavigation = 0;
  let taskNavigation: BootstrapResult['taskNavigation'];
  let workbenchNavigation = 0;
  const preferences = new ChatPreferencesStore(local);
  const projectRegistry = dependencies.projectRegistry ?? new ProjectRegistry(local, projects);
  const publishProjectDiagnostics = () => host.broadcast({ type: 'project-diagnostics-updated', diagnostics: projectRegistry.diagnostics() });
  const chatReference = (value: Record<string, unknown>): ChatReference => {
    if (value.source !== 'model' && value.source !== 'agent') throw new StorageError('ipc-input', '聊天来源无效。');
    return { source: value.source, sessionID: uuidInput(value.sessionID) };
  };
  const existingChat = async (ref: ChatReference): Promise<void> => {
    const record = ref.source === 'model' ? await manager.loadSession(ref.sessionID) : await manager.loadAgentSession(ref.sessionID);
    if (!record) throw new StorageError('missing-session', '聊天记录不存在。');
  };
  const assertArchivable = (ref: ChatReference): void => {
    if (ref.source === 'model' ? pendingSubmissions.has(ref.sessionID) || manager.isSessionBusy(ref.sessionID) : manager.isAgentSessionBusy(ref.sessionID)) throw new StorageError('request-busy', '聊天正在请求或有待保存事实，暂不能归档。');
  };
  const renameInput = (input: unknown): RenameChatInput => {
    const value = payload(input, ['sessionID', 'title', 'expectedRevision']);
    const title = textInput(value.title, 600).trim();
    if (!title || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new StorageError('ipc-input', '聊天标题或修订无效。');
    return { sessionID: uuidInput(value.sessionID), title, expectedRevision: value.expectedRevision as number };
  };
  const projectID = (value: unknown): string => {
    const id = textInput(value, 100);
    if (!projects.get(id)) throw new StorageError('project-unregistered', '项目尚未明确关联。');
    return id;
  };
  const planScope = (value: unknown): PreviewPlanScope | undefined => {
    if (value === undefined) return undefined;
    validatePreviewPlanScope(value);
    const registered = projects.get(projectID(value.project_id));
    if (!registered?.project || registered.project.project_id !== value.project_id || registered.status === 'stale' || registered.status === 'error' || !registered.tasks.some(task => task.task_id === value.task_id && task.project_id === value.project_id)) throw new StorageError('scope-invalid', '预览计划关联的项目或任务未确认或已失效。');
    return value;
  };

  handler('bootstrap', async (): Promise<BootstrapResult> => {
    await projectRegistry.initialize();
    const sessions = await manager.listSessions();
    const taskSessions = await manager.listTaskSessions?.() ?? { records: [], diagnostics: [] };
    const agentSessions = await manager.listAgentSessions?.() ?? { records: [], diagnostics: [] };
    let chatPreferences: ChatPreferences | undefined;
    const preferenceDiagnostics: string[] = [];
    try { chatPreferences = await preferences.load(); }
    catch { preferenceDiagnostics.push('聊天整理偏好读取失败，暂不可整理；原记录未覆盖，聊天历史仍可读取。'); }
    const listedPlans = await plans.listPlans();
    return { settings: settings.publicSettings(), sessions: sessions.records, taskSessions: taskSessions.records, agentSessions: agentSessions.records, ...(chatPreferences ? { chatPreferences } : {}), projects: projects.list(), projectDiagnostics: projectRegistry.diagnostics(), plans: listedPlans, ...(taskNavigation ? { taskNavigation } : {}), diagnostics: [...diagnostics, ...settings.diagnostics, ...(providerModels?.diagnostics ?? []), ...sessions.diagnostics.map(issue => issue.reason), ...taskSessions.diagnostics.map(issue => issue.reason), ...agentSessions.diagnostics.map(issue => issue.reason), ...preferenceDiagnostics], dataRootLabel: previewRoot };
  });
  handler('create-session', async input => {
    const value = payload(input, ['title', 'scope']);
    const scope = value.scope as SessionScope | undefined;
    if (scope?.kind === 'project') {
      const registered = projects.get(projectID(scope.project_id));
      if (registered?.status === 'stale' || scope.task_id && !registered?.tasks.some(task => task.task_id === scope.task_id)) throw new StorageError('scope-invalid', '任务来源未确认或已失效。');
    }
    return manager.createSession(textInput(value.title, 600), scope);
  });
  handler('load-session', input => manager.loadSession(uuidInput(input)));
  handler('set-chat-archived', async input => {
    const value = payload(input, ['source', 'sessionID', 'archived']);
    if (typeof value.archived !== 'boolean') throw new StorageError('ipc-input', '归档状态无效。');
    const ref = chatReference(value);
    const check = () => { if (value.archived) assertArchivable(ref); };
    check(); await existingChat(ref); check();
    const result = await preferences.setArchived(ref, value.archived, check);
    host.broadcast({ type: 'chat-preferences-updated', preferences: result }); return result;
  });
  handler('set-chat-pinned', async input => {
    const value = payload(input, ['source', 'sessionID', 'pinned']);
    if (typeof value.pinned !== 'boolean') throw new StorageError('ipc-input', '置顶状态无效。');
    const ref = chatReference(value); await existingChat(ref);
    const result = await preferences.setPinned(ref, value.pinned, () => {});
    host.broadcast({ type: 'chat-preferences-updated', preferences: result }); return result;
  });
  handler('rename-session', input => {
    const value = renameInput(input);
    if (pendingSubmissions.has(value.sessionID)) throw new StorageError('request-busy', '本聊天正在准备请求，暂不能重命名。');
    return manager.renameSession(value);
  });
  handler('rename-agent-session', input => manager.renameAgentSession(renameInput(input)));
  handler('copy-text', input => host.writeClipboardText(textInput(input, 1024 * 1024)));
  handler('send-message', async input => {
    const value = payload(input, ['sessionID', 'text']);
    const sessionID = uuidInput(value.sessionID);
    const text = textInput(value.text, 1024 * 1024);
    if (!text.trim()) throw new StorageError('input-invalid', '请先填写消息。');
    if (pendingSubmissions.has(sessionID)) throw new StorageError('request-busy', '本聊天正在准备或执行请求，请勿重复发送。');
    const pending = { cancelled: false };
    pendingSubmissions.set(sessionID, pending);
    try {
      // Reserve settings order now; a later save must not retarget this Send while validation waits.
      const snapshot = await settings.prepareRequest(async () => {
        if (!await manager.loadSession(sessionID)) throw new StorageError('missing-session', '会话不存在。');
        if (pending.cancelled) throw new StorageError('submission-cancelled', '提交已取消，消息尚未发送。');
        const current = settings.publicSettings();
        if (!current.hasKey) throw new StorageError('credential-missing', '请先在设置中填写 API Key。');
      });
      host.broadcast({ type: 'settings-updated', settings: settings.publicSettings() });
      if (pending.cancelled) throw new StorageError('submission-cancelled', '提交已取消，消息尚未发送。');
      return await withSettingsSnapshot(snapshot, () => manager.sendMessage({ sessionID, text, model: { provider_id: 'chat-completions', model_id: snapshot.modelID } }));
    } finally { pendingSubmissions.delete(sessionID); }
  });
  handler('stop-generation', input => {
    const sessionID = uuidInput(input);
    const pending = pendingSubmissions.get(sessionID);
    if (pending) pending.cancelled = true;
    return manager.stopGeneration(sessionID);
  });
  handler('retry-pending-writes', input => manager.retryPendingWrites(uuidInput(input)));
  handler('get-settings', () => settings.publicSettings());
  handler('save-settings', async input => {
    const value = payload(input, ['baseURL', 'modelID', 'apiKey', 'rememberKey', 'forgetKey']);
    const previous = settings.snapshot();
    const previousGeneration = settings.generation;
    await settings.save(value as unknown as SettingsInput, previousGeneration);
    await providerModels?.afterSave(previous, settings.snapshot(), previousGeneration);
    const result = settings.publicSettings();
    host.broadcast({ type: 'settings-updated', settings: result }); return result;
  });
  handler('get-provider-models', () => providerModels ? providerModels.get() : { baseURL: settings.publicSettings().baseURL, modelIDs: [] });
  handler('list-provider-models', input => {
    const value = payload(input, ['baseURL', 'apiKey']);
    const baseURL = textInput(value.baseURL, 2048);
    const apiKey = value.apiKey === undefined ? undefined : textInput(value.apiKey, 8192);
    if (!providerModels) throw new StorageError('provider-models-unavailable', '当前无法获取模型列表。');
    return providerModels.list({ baseURL, ...(apiKey !== undefined ? { apiKey } : {}) });
  });
  handler('select-provider-model', async input => {
    const value = payload(input, ['modelID']);
    const modelID = textInput(value.modelID, 200);
    if (!providerModels) throw new StorageError('provider-models-unavailable', '当前无法选择模型。');
    await providerModels.select(modelID);
    const result = settings.publicSettings();
    host.broadcast({ type: 'settings-updated', settings: result }); return result;
  });
  handler('choose-project', async () => {
    const root = await host.chooseProject();
    if (!root) return null;
    const snapshot = await projectRegistry.choose(root);
    publishProjectDiagnostics();
    return snapshot;
  });
  handler('refresh-project', async input => {
    const snapshot = await projectRegistry.refresh(projectID(input));
    publishProjectDiagnostics();
    return snapshot;
  });
  handler('preview-artifact', input => {
    const value = payload(input, ['projectID', 'referenceID']);
    return projects.preview(projectID(value.projectID), textInput(value.referenceID, 200));
  });
  handler('create-plan', async input => {
    const value = payload(input, ['title', 'scope', 'schemaVersion']);
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) throw new StorageError('plan-version', '计划格式版本无效。');
    const plan = await plans.createPlan(textInput(value.title, 600), [], planScope(value.scope), { schemaVersion: value.schemaVersion as 1 | 2 | 3 | undefined });
    host.broadcast({ type: 'plan-updated', plan });
    return plan;
  });
  handler('save-plan', async input => {
    const value = payload(input, ['plan', 'expectedVersion']);
    if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1) throw new StorageError('plan-version', '计划版本无效。');
    planScope((value.plan as PreviewPlan | undefined)?.scope);
    const projectID = (value.plan as PreviewPlan | undefined)?.task?.project_id;
    if (projectID && !projects.get(projectID)?.project) throw new StorageError('project-missing','请先选择并读取任务所属项目。');
    const plan = await plans.savePlan(value.plan as PreviewPlan, value.expectedVersion as number);
    host.broadcast({ type: 'plan-updated', plan });
    return plan;
  });
  handler('recommendations', async input => {
    const plan = await plans.loadPlan(uuidInput(input));
    if (!plan) throw new StorageError('missing-plan', '预览计划不存在。');
    planScope(plan.scope);
    return plans.recommendations(plan);
  });
  handler('save-draft', input => {
    const value = payload(input, ['key', 'text']);
    return local.write(`draft:${textInput(value.key, 512)}`, { text: textInput(value.text, 64 * 1024) });
  });
  handler('load-draft', async input => {
    const value = await local.read<{ text: string }>(`draft:${textInput(input, 512)}`, { text: '' });
    return textInput(value.text, 64 * 1024);
  });
  handler('open-deck', async input => {
    const navigation = ++deckNavigation;
    const value = input !== null && typeof input === 'object' ? payload(input, ['sessionID', 'planID']) : { sessionID: input };
    const id = value.sessionID === undefined ? undefined : uuidInput(value.sessionID);
    const planID = value.planID === undefined ? undefined : uuidInput(value.planID);
    if (id && !await manager.loadSession(id)) throw new StorageError('missing-session', '会话不存在。');
    if (planID && !await plans.loadPlan(planID)) throw new StorageError('missing-plan', '任务计划不存在。');
    if (navigation !== deckNavigation) return;
    await host.openDeck(id, planID);
  });
  handler('deck-context', () => host.getDeckContext());
  handler('deck-presentation', () => host.getDeckPresentation());
  host.handle('set-deck-interaction', (input, sender) => {
    const value = payload(input, ['busy']);
    if (typeof value.busy !== 'boolean') throw new StorageError('invalid-input', '浮窗交互状态无效。');
    host.setDeckInteraction(value.busy, sender);
  });
  handler('set-deck-collapsed', input => {
    if (typeof input !== 'boolean') throw new StorageError('invalid-input', '浮窗状态无效。');
    host.setDeckCollapsed(input);
  });
  handler('show-workbench', async input => {
    const navigation = ++workbenchNavigation;
    if (input === undefined) { await host.showWorkbench(); return; }
    const planID = uuidInput(input);
    const targetPlan = await plans.loadPlan(planID);
    if (!targetPlan) throw new StorageError('missing-plan', '任务计划不存在。');
    if (navigation !== workbenchNavigation) return;
    taskNavigation = { revision: (taskNavigation?.revision ?? 0) + 1, planID, reference: targetPlan.scope ? { kind: 'project', projectID: targetPlan.scope.project_id, taskID: targetPlan.scope.task_id } : { kind: 'local', planID } };
    await host.showWorkbench();
    if (navigation === workbenchNavigation) host.broadcast({ type: 'workbench-task-requested', ...taskNavigation });
  });
}
