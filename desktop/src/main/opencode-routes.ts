import type { OpenCodeStatus } from '../shared/desktop-api.js';
import type { ProviderSettingsStore } from './provider-settings.js';
import { OpenCodeRuntimeError, type OpenCodeStartInput } from './opencode-runtime.js';
import type { ElectronHost } from './electron-host.js';
import { StorageError } from '../core/private-storage.js';
import type { OpenCodeDiscovery } from './opencode-discovery.js';
import { payload, textInput } from './ipc-validation.js';

interface OpenCodeRuntimePort {
  start(input: OpenCodeStartInput): Promise<unknown>;
  stop(): Promise<void>;
  getConnection(): { version: string; model: import('../shared/types.js').ModelSelection } | undefined;
}

/** Discovery is metadata-only. Only explicit connection loads credentials and starts ACP. */
export function installOpenCodeRoutes({ host, runtime, settings, discovery, chooseBinary, openInstallGuide, onStarted, requiresRestart = () => false }: {
  host: Pick<ElectronHost, 'handle' | 'broadcast'>;
  runtime: OpenCodeRuntimePort;
  settings: ProviderSettingsStore;
  discovery: Pick<OpenCodeDiscovery, 'discover' | 'choose' | 'resolve' | 'remember'>;
  chooseBinary: () => Promise<string | undefined>;
  openInstallGuide: () => Promise<void>;
  onStarted?: (settingsGeneration: string) => void;
  requiresRestart?: () => boolean;
}): void {
  let pending = false;
  const status = (): OpenCodeStatus => {
    const connection = runtime.getConnection();
    return connection ? { state: 'ready', version: connection.version, model: { ...connection.model }, requiresRestart: requiresRestart() } : { state: 'stopped' };
  };
  const noInput = (input: unknown) => { if (input !== undefined) throw new StorageError('ipc-input', '此操作不接受配置参数。'); };
  const notBusy = () => { if (pending) throw new StorageError('runtime-busy', '正在处理 OpenCode 连接，请稍后重试。'); };
  host.handle('opencode-status', input => { noInput(input); return status(); });
  host.handle('opencode-installation', input => { noInput(input); return discovery.discover(); });
  host.handle('opencode-install-guide', async input => {
    noInput(input);
    try { await openInstallGuide(); }
    catch { throw new StorageError('install-guide', '无法打开安装说明，请稍后重试。'); }
  });
  host.handle('choose-opencode-binary', async input => {
    noInput(input); notBusy();
    if (runtime.getConnection()) throw new StorageError('runtime-ready', '请先关闭当前连接，再选择其他程序。');
    pending = true;
    try {
      const binaryPath = await chooseBinary();
      return binaryPath ? await discovery.choose(binaryPath) : undefined;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('runtime-binary', '程序位置无法确认，请选择可执行的 OpenCode 文件。');
    } finally { pending = false; }
  });
  host.handle('start-opencode', async input => {
    let candidateID: string | undefined;
    if (input !== undefined) {
      const value = payload(input, ['candidateID']);
      candidateID = textInput(value.candidateID, 64);
      if (!/^[a-f0-9]{64}$/.test(candidateID)) throw new StorageError('ipc-input', '程序候选标识无效，请重新检测。');
    }
    notBusy();
    if (runtime.getConnection()) return status();
    pending = true;
    try {
      // Recheck current file identity before credential access. No chooser or fallback.
      const installation = await discovery.discover();
      candidateID ??= installation.preferredID ?? (installation.candidates.length === 1 ? installation.candidates[0].id : undefined);
      if (!candidateID) throw new StorageError(installation.candidates.length ? 'discovery-ambiguous' : 'discovery-missing', installation.candidates.length ? '检测到多个 OpenCode，请先选择本次使用的程序。' : '未检测到 OpenCode，请安装支持版本或手动选择程序。');
      const binaryPath = await discovery.resolve(candidateID);
      let generation = '';
      const snapshot = await settings.prepareRequest(async () => {
        const current = settings.publicSettings();
        if (!current.hasKey && current.credentialStorage !== 'locked') throw new StorageError('credential-missing', '请先保存模型地址、名称与 API 密钥。');
        generation = settings.generation;
      });
      if (!snapshot.credential) throw new StorageError('credential-missing', '请先保存 API 密钥。');
      if (await discovery.resolve(candidateID) !== binaryPath) throw new StorageError('runtime-binary', '程序位置已变化，请重新检测。');
      await runtime.start({ binaryPath, provider: { baseURL: snapshot.baseURL, modelID: snapshot.modelID, credential: snapshot.credential } });
      onStarted?.(generation);
      // Recording a path must not turn an already verified live connection into a failed Start.
      try { await discovery.remember(binaryPath); }
      catch { host.broadcast({ type: 'diagnostic', message: 'OpenCode 已连接，但程序位置未能保存；下次将重新检测。' }); }
      host.broadcast({ type: 'settings-updated', settings: settings.publicSettings() });
      return status();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (error instanceof OpenCodeRuntimeError) {
        const message = error.code === 'runtime-version' ? 'OpenCode 版本不匹配，当前支持 1.19.0；请指定兼容版本的程序。' : error.code === 'runtime-acp-version' ? 'OpenCode 的 ACP 版本或能力不匹配，当前支持 1.19.0／ACP v1。' : error.message;
        throw new StorageError(error.code, message);
      }
      throw new StorageError('runtime-start', 'OpenCode 未能连接，请检查程序版本与模型连接。');
    } finally { pending = false; }
  });
  host.handle('stop-opencode', async input => {
    noInput(input); notBusy(); pending = true;
    try { await runtime.stop(); host.broadcast({ type: 'settings-updated', settings: settings.publicSettings() }); return status(); }
    catch { throw new StorageError('runtime-stop', '执行器关闭尚未确认，请刷新状态。'); }
    finally { pending = false; }
  });
}
