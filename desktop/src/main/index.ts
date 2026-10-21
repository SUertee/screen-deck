import { createTaskPlanningModule } from './task-planning-module.js';
import { ChatTaskService } from './chat-task-service';
import { installChatTaskRoutes } from './chat-task-routes';
import { installTaskKnowledgeModule } from './task-knowledge-module.js';
import { TaskHandoffService } from './task-handoff-service.js';
import { installTaskHandoffRoutes } from './task-handoff-routes.js';
import { existsSync } from 'node:fs';
import { migrateApplicationData } from './data-migration.js';
import { DirectoryProjects } from '../projects/directory-projects.js';
import { installTaskAdviceRoutes } from './task-advice-routes.js';
import { selectNativeTaskMaterials } from '../core/tasks/native-work-item-task-adapter.js';
import { uuidInput } from './ipc-validation.js';
import { createNativeWorkItemRuntime } from '../core/tasks/native-work-item-runtime.js';
import { nativeWorkItemRouteHandlers } from '../core/tasks/native-work-item-routes.js';
import { TaskContextService } from './task-context-service.js';
import { installScreenTimelineModule } from './screen-timeline-module.js';
import { AgentChatModeRouter } from '../core/agents/agent-chat-mode-router.js';
import { agentProfileConnection } from './agent-profile-connection.js';
import { AgentExecutionController } from '../core/agents/agent-execution-controller.js';
import { OpenCodeNativeChatAdapter } from '../core/agents/opencode/opencode-native-chat-adapter.js';
import { installAgentExecutionRoutes } from './agent-execution-routes.js';
import { CodexRuntime } from './codex-runtime.js';
import { installCodexRoutes } from './codex-routes.js';
import { CodexAgentChatAdapter } from '../core/agents/codex/codex-agent-chat-adapter.js';
import { findCodexBinary } from './codex-discovery.js';
import { AgentChatRegistry } from '../core/agents/agent-chat-registry.js';
import { app, dialog, shell, powerMonitor } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ChatCompletionsAdapter, SessionHistoryStore, SessionManager, TaskOrchestrator, StorageError, type ExecutionDriver } from '../core/index.js';
import { ProjectWorkspaceReader } from '../projects/index.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { ProviderModelsService } from './provider-models.js';
import { LocalState } from './local-state.js';
import { ElectronHost } from './electron-host.js';
import { installDesktopRoutes } from './desktop-routes.js';
import { ProjectRegistry } from './project-registry.js';
import { TaskSessionHistoryStore } from '../core/sessions/task-session-history-store.js';
import { OpenCodeAcpAdapter } from '../core/agents/opencode/opencode-acp-adapter.js';
import { installTaskExecutionRoutes } from './task-execution-routes.js';
import { ApprovalService } from '../core/approvals/approval-service.js';
import { OpenCodeRuntime } from './opencode-runtime.js';
import { installOpenCodeRoutes } from './opencode-routes.js';
import { OpenCodeDiscovery } from './opencode-discovery.js';
import { AgentSessionHistoryStore } from '../core/sessions/agent-session-history-store.js';
import { OpenCodeAgentChatAdapter } from '../core/agents/opencode/opencode-agent-chat-adapter.js';
import { installAgentChatRoutes } from './agent-chat-routes.js';

ElectronHost.registerScheme();
app.setName('ScreenDeck Preview');
// Test/preview override is main-process environment only; renderer cannot choose a history root.
const legacyRoot = path.resolve(process.env.SCREENDECK_LEGACY_ROOT ?? path.join(os.homedir(), '.screendeck', 'previews', 'electron-v1'));
const formalData = !!process.env.SCREENDECK_DATA_ROOT || !process.env.SCREENDECK_PREVIEW_ROOT;
const previewRoot = path.resolve(process.env.SCREENDECK_DATA_ROOT ?? process.env.SCREENDECK_PREVIEW_ROOT ?? path.join(os.homedir(), '.screendeck'));
// Keep installed provider-owned credentials and historical cwd paths intact during record migration.
const codexRoot = formalData && existsSync(path.join(legacyRoot, 'codex')) ? path.join(legacyRoot, 'codex') : path.join(previewRoot, 'codex');
app.setPath('userData', path.join(previewRoot, 'electron-host'));
const host = new ElectronHost(__dirname);
let manager: SessionManager;
let settings: ProviderSettingsStore;
let local: LocalState;
let quitting = false;
let screens: Awaited<ReturnType<typeof installScreenTimelineModule>> | undefined;
const diagnostics: string[] = [];
const callSettings = new AsyncLocalStorage<ReturnType<ProviderSettingsStore['snapshot']>>();
const runtime = new OpenCodeRuntime();
const agentRuntime = new OpenCodeRuntime({ nativeTools: true });
const codexRuntime = new CodexRuntime(codexRoot, () => host.broadcast({ type: 'agent-sources-updated' }), async url => { await shell.openExternal(url); }, { nativeTools: true });
let runtimeSettingsGeneration: string | undefined;

async function initialize(): Promise<void> {
  await app.whenReady();
  if (formalData) await migrateApplicationData(legacyRoot, previewRoot);
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'brand', 'screendeck-icon-black.png'));
  host.installProtocol();
  settings = new ProviderSettingsStore(previewRoot);
  await settings.initialize();
  const driver: ExecutionDriver = {
    capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false },
    async execute(request, onEvent, signal) {
      const snapshot = callSettings.getStore();
      if (!snapshot || request.model.model_id !== snapshot.modelID) throw new StorageError('settings-changed', '本轮模型设置未确认，请重新发送。');
      return new ChatCompletionsAdapter({ baseURL: snapshot.baseURL, credential: async () => snapshot.credential }).execute(request, onEvent, signal);
    },
  };
  const approvals = new ApprovalService(previewRoot);
  const executionController = new AgentExecutionController(previewRoot, execution => host.broadcast({ type: 'agent-execution-updated', execution }));
  const agentDriver = new OpenCodeNativeChatAdapter({ getConnection: () => agentRuntime.getACPConnection(), canStart: () => runtimeSettingsGeneration === settings.generation });
  const opencodeText = new OpenCodeAgentChatAdapter({ getConnection: agentProfileConnection(() => runtime.getACPConnection(), () => agentDriver.getSource()), canStart: () => runtimeSettingsGeneration === settings.generation });
  const codexNative = new CodexAgentChatAdapter({ getConnection: () => codexRuntime.getConnection(), nativeTools: true });
  const codexText = new CodexAgentChatAdapter({ getConnection: agentProfileConnection(() => codexRuntime.getTextConnection(), () => codexNative.getSource()) });
  const plans = new TaskOrchestrator(previewRoot, { formalTasks: formalData });
  const handoffs = new TaskHandoffService(previewRoot, id => plans.loadPlan(id), () => host.broadcast({ type: 'task-handoffs-updated' }));
  const nativeWorkItems = createNativeWorkItemRuntime({
    ...(formalData ? { handoffContext: (plan: import('../shared/types.js').PreviewPlan) => handoffs.context(plan), onAttemptSaved: async (attempt: import('../core/tasks/native-work-item-contract.js').NativeWorkItemAttempt) => { try { await handoffs.record(attempt); } catch { host.broadcast({ type: 'diagnostic', message: '执行记录已保存，但交接摘要未能保存，请核对后重试。' }); } } } : {}),
    root: previewRoot, approvals, execution: executionController,
    loadPlan: id => plans.loadPlan(id), transactPlan: (id, operation) => plans.transactPlan(id, operation), actor: () => 'local-user',
    onBackgroundError: () => host.broadcast({ type:'diagnostic', message:'原生尝试的结果或记录尚未确认，请核对原尝试；请求未重发。' }),
    registrations: [
      { driver: new AgentChatModeRouter(agentDriver, opencodeText), unavailableReason: () => agentRuntime.getACPConnection() ? 'requires-restart' : 'stopped' },
      { driver: new AgentChatModeRouter(codexNative, codexText, () => codexRuntime.prepareText()) },
    ],
    createSessions: agentDrivers => new SessionManager({ store: new SessionHistoryStore(path.join(previewRoot, 'sessions')), driver,
      agent: { store: new AgentSessionHistoryStore(previewRoot), drivers: agentDrivers },
      task: { store: new TaskSessionHistoryStore(previewRoot), driver: new OpenCodeAcpAdapter({ getConnection: () => runtime.getACPConnection(), canStart: () => runtimeSettingsGeneration === settings.generation }), resolveApproval: id => approvals.loadExecutionApproval(id) },
    }),
  });
  const agentDrivers = nativeWorkItems.registry;
  manager = nativeWorkItems.sessions;
  plans.configureNativeWorkItems({ assertPlanIdle: plan => nativeWorkItems.owner.assertIdle(plan), assertProjectIdle: scope => nativeWorkItems.owner.assertProjectIdle(scope) });
  for (const [channel, handler] of Object.entries(nativeWorkItemRouteHandlers(nativeWorkItems))) host.handle(channel, handler);
  const planningModule = createTaskPlanningModule({ root: previewRoot, plans, native: nativeWorkItems, execution: executionController, settings, changed: plan => host.broadcast({ type: 'plan-updated', plan }) });
  for (const [channel, handler] of Object.entries(planningModule.handlers)) host.handle(channel, handler);
  manager.subscribe(event => host.broadcast(event));
  manager.subscribeAgent(event => host.broadcast(event));
  local = new LocalState(path.join(previewRoot, 'local-state'));
  installTaskAdviceRoutes({ host, plans, local, drivers: agentDrivers, provider: settings });
  installTaskKnowledgeModule(previewRoot, host, plans, nativeWorkItems);
  installTaskHandoffRoutes(host, plans, handoffs, id => projects.get(id)?.project?.root_path);
  host.handle('task:native:materials', async input => {
    const plan = await plans.loadPlan(uuidInput(input));
    if (!plan || plan.scope) throw new StorageError('missing-plan', '本地任务不可读取。');
    return (plan.task?.materials ?? []).filter(material => material.summary.trim()).map(material => ({ id: material.id, title: material.title, ...selectNativeTaskMaterials(plan, [material.id])[0] }));
  });
  const projects = new ProjectWorkspaceReader({ privateRoot: process.env.SCREENDECK_PROJECT_HISTORY_ROOT, ...(formalData ? { directoryProjects: new DirectoryProjects(previewRoot) } : {}) });
  const projectRegistry = new ProjectRegistry(local, projects);
  // Explicit developer launch request, never a project path supplied by a web page.
  await projectRegistry.initialize(process.env.SCREENDECK_INITIAL_PROJECT);
  installDesktopRoutes({
    settings, providerModels: new ProviderModelsService(settings, local), manager, projects, projectRegistry, plans, local, host, diagnostics, previewRoot,
    withSettingsSnapshot: (snapshot, operation) => callSettings.run(snapshot, operation),
  });
  installAgentChatRoutes({ host, manager, projects, sources: () => agentDrivers.listSources(), prepareExecution: (sessionID, source, selection) => executionController.configure(sessionID, source, selection) });
  host.handle('choose-project-workspace', async input => { if (typeof input !== 'string') throw new StorageError('project-input','项目标识无效。'); const refreshed = await projectRegistry.refresh(input); if (!refreshed.project || refreshed.status === 'error' || refreshed.status === 'stale') throw new StorageError('project-unavailable','项目目录无法核对，请重新选择。'); return executionController.choose(refreshed.project.root_path); });
  installAgentExecutionRoutes({ host, controller: executionController, choose: async () => { const choice = await dialog.showOpenDialog({ title: '选择 Agent 工作目录', properties: ['openDirectory'] }); return choice.canceled ? undefined : choice.filePaths[0]; } });
  let discovery: OpenCodeDiscovery;
  try { discovery = new OpenCodeDiscovery(local); }
  catch (error) {
    if (!(error instanceof StorageError) || !['discovery-input', 'discovery-limit'].includes(error.code)) throw error;
    // A host PATH problem must not prevent model chat or explicit manual selection.
    diagnostics.push('OpenCode 环境搜索路径超出检测范围，已改查常见安装目录；也可手动指定程序。');
    discovery = new OpenCodeDiscovery(local, { searchPath: '' });
  }
  installOpenCodeRoutes({ discovery, openInstallGuide: async () => { await shell.openExternal('https://opencode.ai/docs/'); }, host, runtime: { start: async input => { try { await runtime.startACP(input); return await agentRuntime.startACP(input); } catch (error) { await Promise.all([runtime.stop(), agentRuntime.stop()]); throw error; } }, stop: async () => { await Promise.all([runtime.stop(), agentRuntime.stop()]); }, getConnection: () => agentRuntime.getACPConnection() }, settings, onStarted: generation => { runtimeSettingsGeneration = generation; }, requiresRestart: () => runtimeSettingsGeneration !== settings.generation, chooseBinary: async () => {
    const choice = await dialog.showOpenDialog({ title: '选择 OpenCode 1.19.0 可执行文件', properties: ['openFile'] });
    return choice.canceled ? undefined : choice.filePaths[0];
  } });
  installCodexRoutes({ host, runtime: codexRuntime, resolveBinary: findCodexBinary, chooseBinary: async () => {
    const choice = await dialog.showOpenDialog({ title: '选择 Codex CLI 0.133.0 可执行文件', properties: ['openFile'] });
    return choice.canceled ? undefined : choice.filePaths[0];
  } });
  installTaskExecutionRoutes({ manager, plans, projects, host, previewRoot, approvals, execution: {
    current: () => {
      const connection = runtime.getACPConnection();
      return connection && runtimeSettingsGeneration === settings.generation ? { drivers: [{ driverID: 'opencode-acp-no-tools', configDigest: connection.configDigest, mode: 'external' }], model: { ...connection.model } } : { drivers: [], model: connection ? { ...connection.model } : { provider_id: 'screendeck', model_id: settings.publicSettings().modelID } };
    },
    verifyResult: (turn, result) => {
      if (!['opencode-no-tools', 'opencode-acp-no-tools'].includes(turn.execution.spec.driver.driverID) || turn.execution.spec.driver.mode !== 'external' || turn.execution.spec.tools.kind !== 'none' || result.artifacts.length || result.evidence.length) throw new StorageError('unsupported', '当前只支持验收原无工具执行的文本结果。');
    },
  } });
  screens = await installScreenTimelineModule({ previewRoot, nativeBinary: path.join(__dirname, 'native', 'ScreenRecorder'), host, manager, local, projects, projectRegistry, diagnostics, plans,
    openPermissions: async () => { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); },
  });
  installChatTaskRoutes(host, new ChatTaskService(manager, plans, plan => host.broadcast({ type: 'plan-updated', plan })));
  const taskContexts = new TaskContextService(plans, screens, plan => host.broadcast({ type: 'plan-updated', plan }));
  host.handle('confirm-task-context', input => taskContexts.confirm(input));
  powerMonitor.on('lock-screen', screens.pause);
  powerMonitor.on('suspend', screens.pause);
  await host.showWorkbench();
  await host.initializeDeckDock();
  // Explicit one-shot local launch request. Never persisted as a startup preference.
  if (process.argv.includes('--start-screen-recording')) {
    try {
      if (!screens.recording) throw new Error('recording unavailable');
      const status = await screens.recording.start();
      console.info('[screen-recording-launch]', JSON.stringify({ state: status.state, needsPermission: status.needsPermission, frameCount: status.frameCount }));
      if (status.state !== 'recording') host.broadcast({ type: 'diagnostic', message: status.message });
    } catch {
      host.broadcast({ type: 'diagnostic', message: '屏幕记录未能开启，请从时间线检查录制权限后重试。' });
      console.info('[screen-recording-launch]', JSON.stringify({ state: 'unavailable' }));
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void startup.then(() => host.showWorkbench()); });
  app.on('activate', () => { void startup.then(() => host.showWorkbench()); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !manager) return;
    event.preventDefault(); quitting = true;
    host.disposeDeckDock();
    void Promise.all([manager.shutdown(), screens?.shutdown()]).then(() => Promise.all([local.flush(), settings.flush()])).finally(() => Promise.all([runtime.stop(), agentRuntime.stop(), codexRuntime.stop()])).finally(() => app.quit());
  });
  const startup = initialize();
  startup.catch(error => { dialog.showErrorBox('ScreenDeck 未能启动', error instanceof StorageError && error.code.startsWith('migration') ? error.message : '应用数据目录或文件无法安全读取；原数据未删除。'); app.quit(); });
}
