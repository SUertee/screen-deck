import { app, dialog, shell } from 'electron';
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
const previewRoot = path.resolve(process.env.SCREENDECK_PREVIEW_ROOT ?? path.join(os.homedir(), '.screendeck', 'previews', 'electron-v1'));
app.setPath('userData', path.join(previewRoot, 'electron-host'));
const host = new ElectronHost(__dirname);
let manager: SessionManager;
let settings: ProviderSettingsStore;
let local: LocalState;
let quitting = false;
const diagnostics: string[] = [];
const callSettings = new AsyncLocalStorage<ReturnType<ProviderSettingsStore['snapshot']>>();
const runtime = new OpenCodeRuntime();
let runtimeSettingsGeneration: string | undefined;

async function initialize(): Promise<void> {
  await app.whenReady();
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
  const agentDriver = new OpenCodeAgentChatAdapter({ getConnection: () => runtime.getACPConnection(), canStart: () => runtimeSettingsGeneration === settings.generation });
  manager = new SessionManager({ store: new SessionHistoryStore(path.join(previewRoot, 'sessions')), driver, agent: { store: new AgentSessionHistoryStore(previewRoot), driver: agentDriver }, task: { store: new TaskSessionHistoryStore(previewRoot), driver: new OpenCodeAcpAdapter({ getConnection: () => runtime.getACPConnection(), canStart: () => runtimeSettingsGeneration === settings.generation }), resolveApproval: id => approvals.loadExecutionApproval(id) } });
  manager.subscribe(event => host.broadcast(event));
  manager.subscribeAgent(event => host.broadcast(event));
  const plans = new TaskOrchestrator(previewRoot);
  local = new LocalState(path.join(previewRoot, 'local-state'));
  const projects = new ProjectWorkspaceReader({ privateRoot: process.env.SCREENDECK_PROJECT_HISTORY_ROOT });
  const projectRegistry = new ProjectRegistry(local, projects);
  // Explicit developer launch request, never a project path supplied by a web page.
  await projectRegistry.initialize(process.env.SCREENDECK_INITIAL_PROJECT);
  installDesktopRoutes({
    settings, providerModels: new ProviderModelsService(settings, local), manager, projects, projectRegistry, plans, local, host, diagnostics, previewRoot,
    withSettingsSnapshot: (snapshot, operation) => callSettings.run(snapshot, operation),
  });
  installAgentChatRoutes({ host, manager, projects, sources: () => {
    const source = agentDriver.getSource();
    return source ? [source] : [{ agentID: 'opencode', name: 'OpenCode', state: 'unavailable', reason: runtime.getACPConnection() ? 'requires-restart' : 'stopped' }];
  } });
  let discovery: OpenCodeDiscovery;
  try { discovery = new OpenCodeDiscovery(local); }
  catch (error) {
    if (!(error instanceof StorageError) || !['discovery-input', 'discovery-limit'].includes(error.code)) throw error;
    // A host PATH problem must not prevent model chat or explicit manual selection.
    diagnostics.push('OpenCode 环境搜索路径超出检测范围，已改查常见安装目录；也可手动指定程序。');
    discovery = new OpenCodeDiscovery(local, { searchPath: '' });
  }
  installOpenCodeRoutes({ discovery, openInstallGuide: async () => { await shell.openExternal('https://opencode.ai/docs/'); }, host, runtime: { start: input => runtime.startACP(input), stop: () => runtime.stop(), getConnection: () => runtime.getACPConnection() }, settings, onStarted: generation => { runtimeSettingsGeneration = generation; }, requiresRestart: () => runtimeSettingsGeneration !== settings.generation, chooseBinary: async () => {
    const choice = await dialog.showOpenDialog({ title: '选择 OpenCode 1.19.0 可执行文件', properties: ['openFile'] });
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
  await host.showWorkbench();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void startup.then(() => host.showWorkbench()); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !manager) return;
    event.preventDefault(); quitting = true;
    void manager.shutdown().then(() => Promise.all([local.flush(), settings.flush()])).finally(() => runtime.stop()).finally(() => app.quit());
  });
  const startup = initialize();
  startup.catch(() => { dialog.showErrorBox('ScreenDeck 未能启动', '预览数据目录或应用文件无法安全读取。原 Swift 应用和项目文件未修改。'); app.quit(); });
}
