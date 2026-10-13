import { app, dialog, safeStorage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ChatCompletionsAdapter, SessionHistoryStore, SessionManager, TaskOrchestrator, StorageError, type ExecutionDriver } from '../core/index.js';
import { ProjectWorkspaceReader } from '../projects/index.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { LocalState } from './local-state.js';
import { ElectronHost } from './electron-host.js';
import { installDesktopRoutes, persistProjectRegistry } from './desktop-routes.js';
import { TaskSessionHistoryStore } from '../core/task-session-history-store.js';
import { FakeTaskExecutionDriver } from '../core/fake-task-execution-driver.js';
import { installTaskExecutionRoutes } from './task-execution-routes.js';
import { ApprovalService } from '../core/approval-service.js';

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

async function initialize(): Promise<void> {
  await app.whenReady();
  host.installProtocol();
  settings = new ProviderSettingsStore(previewRoot, {
    available: async () => await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
  });
  await settings.initialize();
  const driver: ExecutionDriver = {
    capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false },
    async execute(request, onEvent, signal) {
      const snapshot = callSettings.getStore();
      if (!snapshot || request.model.model_id !== snapshot.modelID) throw new StorageError('settings-changed', '本轮模型设置未确认，请重新发送。');
      return new ChatCompletionsAdapter({ endpoint: snapshot.endpoint, credential: async () => snapshot.credential }).execute(request, onEvent, signal);
    },
  };
  const approvals = new ApprovalService(previewRoot);
  manager = new SessionManager({ store: new SessionHistoryStore(path.join(previewRoot, 'sessions')), driver, task: { store: new TaskSessionHistoryStore(previewRoot), driver: new FakeTaskExecutionDriver(), resolveApproval: id => approvals.loadExecutionApproval(id) } });
  manager.subscribe(event => host.broadcast(event));
  const plans = new TaskOrchestrator(previewRoot);
  local = new LocalState(path.join(previewRoot, 'local-state'));
  const projects = new ProjectWorkspaceReader({ privateRoot: process.env.SCREENDECK_PROJECT_HISTORY_ROOT });
  try {
    const roots = await local.read<unknown>('project-roots', []);
    if (!Array.isArray(roots) || roots.length > 100 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error();
    for (const root of roots) { const result = await projects.read(root); if (!result.project) diagnostics.push(...result.diagnostics.map(issue => issue.message)); }
    // Explicit developer launch request to view ScreenDeck's own project, not arbitrary path from a web page.
    if (process.env.SCREENDECK_INITIAL_PROJECT) { const result = await projects.read(process.env.SCREENDECK_INITIAL_PROJECT); if (result.project && result.status !== 'error') await persistProjectRegistry(local, projects); else diagnostics.push(...result.diagnostics.map(issue => issue.message)); }
  } catch { diagnostics.push('预览项目索引读取失败，未修改来源记录。'); }
  installDesktopRoutes({
    settings, manager, projects, plans, local, host, diagnostics, previewRoot,
    withSettingsSnapshot: (snapshot, operation) => callSettings.run(snapshot, operation),
  });
  installTaskExecutionRoutes({ manager, plans, projects, host, previewRoot, approvals });
  await host.showWorkbench();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void startup.then(() => host.showWorkbench()); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !manager) return;
    event.preventDefault(); quitting = true;
    void manager.shutdown().then(() => Promise.all([local.flush(), settings.flush()])).finally(() => app.quit());
  });
  const startup = initialize();
  startup.catch(() => { dialog.showErrorBox('ScreenDeck 未能启动', '预览数据目录或应用文件无法安全读取。原 Swift 应用和项目文件未修改。'); app.quit(); });
}
