import type { CodexRuntime } from './codex-runtime.js';
import type { ElectronHost } from './electron-host.js';
import { StorageError } from '../core/storage/private-storage.js';
/** No arbitrary config, login URL, key, method, thread ID or native arguments cross renderer IPC. */
export function installCodexRoutes({ host, runtime, resolveBinary, chooseBinary }: {
  host: Pick<ElectronHost, 'handle'>; runtime: CodexRuntime;
  resolveBinary(): Promise<string | undefined>; chooseBinary(): Promise<string | undefined>;
}): void {
  const noInput = (input: unknown) => { if (input !== undefined) throw new StorageError('ipc-input', '此操作不接受配置参数。'); };
  host.handle('codex-status', input => { noInput(input); return runtime.getStatus(); });
  host.handle('start-codex', async input => {
    noInput(input);
    const binary = await resolveBinary(); if (!binary) throw new StorageError('runtime-missing', '未检测到 Codex，请安装 Codex CLI 或手动选择程序。');
    return runtime.start(binary);
  });
  host.handle('choose-codex', async input => { noInput(input); if (runtime.getStatus().state !== 'stopped') throw new StorageError('runtime-ready', '请先断开 Codex。'); const binary = await chooseBinary(); return binary ? runtime.start(binary) : runtime.getStatus(); });
  host.handle('login-codex', input => { noInput(input); return runtime.login(); });
  host.handle('cancel-codex-login', input => { noInput(input); return runtime.cancelLogin(); });
  host.handle('refresh-codex', input => { noInput(input); return runtime.refresh(); });
  host.handle('stop-codex', input => { noInput(input); return runtime.stop(); });
}
