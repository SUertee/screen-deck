import { StorageError, type SessionManager, type TaskOrchestrator } from '../core/index.js';
import type { ProjectWorkspaceReader } from '../projects/index.js';
import type { PreviewPlan, PreviewPlanScope, SessionScope } from '../shared/types.js';
import { validatePreviewPlanScope } from '../core/task-orchestrator.js';
import type { BootstrapResult, SettingsInput } from '../shared/desktop-api.js';
import type { ElectronHost } from './electron-host.js';
import type { ProviderSettingsStore } from './provider-settings.js';
import type { LocalState } from './local-state.js';
import { payload, textInput, uuidInput } from './ipc-validation.js';

export interface DesktopRouteDependencies {
  settings: ProviderSettingsStore;
  manager: SessionManager;
  projects: ProjectWorkspaceReader;
  plans: TaskOrchestrator;
  local: LocalState;
  host: ElectronHost;
  diagnostics: readonly string[];
  previewRoot: string;
  withSettingsSnapshot: <T>(snapshot: ReturnType<ProviderSettingsStore['snapshot']>, operation: () => T) => T;
}

export async function persistProjectRegistry(local: LocalState, projects: ProjectWorkspaceReader): Promise<void> {
  await local.write('project-roots', projects.list().flatMap(result => result.project ? [result.project.root_path] : []));
}

/** Routes coordinate existing services; all state stays with its injected owner. */
export function installDesktopRoutes(dependencies: DesktopRouteDependencies): void {
  const { settings, manager, projects, plans, local, host, diagnostics, previewRoot, withSettingsSnapshot } = dependencies;
  const handler = (channel: string, operation: (input: unknown) => unknown) => host.handle(channel, operation);
  const pendingSubmissions = new Map<string, { cancelled: boolean }>();
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
    const sessions = await manager.listSessions();
    const taskSessions = await manager.listTaskSessions?.() ?? { records: [], diagnostics: [] };
    return { settings: settings.publicSettings(), sessions: sessions.records, taskSessions: taskSessions.records, projects: projects.list(), plans: await plans.listPlans(), diagnostics: [...diagnostics, ...settings.diagnostics, ...sessions.diagnostics.map(issue => issue.reason), ...taskSessions.diagnostics.map(issue => issue.reason)], dataRootLabel: previewRoot };
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
        if (!current.hasKey && current.credentialStorage !== 'locked') throw new StorageError('credential-missing', '请先在设置中填写 API Key。');
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
    const result = await settings.save(value as unknown as SettingsInput);
    host.broadcast({ type: 'settings-updated', settings: result }); return result;
  });
  handler('choose-project', async () => {
    const root = await host.chooseProject();
    if (!root) return null;
    const snapshot = await projects.read(root);
    if (snapshot.project && snapshot.status !== 'stale' && snapshot.status !== 'error') await persistProjectRegistry(local, projects);
    return snapshot;
  });
  handler('refresh-project', input => projects.refresh(projectID(input)));
  handler('preview-artifact', input => {
    const value = payload(input, ['projectID', 'referenceID']);
    return projects.preview(projectID(value.projectID), textInput(value.referenceID, 200));
  });
  handler('create-plan', input => {
    const value = payload(input, ['title', 'scope']);
    return plans.createPlan(textInput(value.title, 600), [], planScope(value.scope));
  });
  handler('save-plan', input => {
    const value = payload(input, ['plan', 'expectedVersion']);
    if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1) throw new StorageError('plan-version', '计划版本无效。');
    planScope((value.plan as PreviewPlan | undefined)?.scope);
    return plans.savePlan(value.plan as PreviewPlan, value.expectedVersion as number);
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
    const id = input === undefined ? undefined : uuidInput(input);
    if (id && !await manager.loadSession(id)) throw new StorageError('missing-session', '会话不存在。');
    await host.openDeck(id);
  });
  handler('show-workbench', () => host.showWorkbench());
}
