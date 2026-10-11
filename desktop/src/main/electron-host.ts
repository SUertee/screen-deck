import { BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StorageError } from '../core/index.js';
import { ProjectReadFailure } from '../projects/index.js';
import type { DesktopEvent } from '../shared/desktop-api.js';
import { isTrustedURL } from './ipc-validation.js';

/** Owns Electron windows and the trusted renderer boundary, never domain state. */
export class ElectronHost {
  private readonly windows = new Set<BrowserWindow>();
  private workbench: BrowserWindow | undefined;
  private deck: BrowserWindow | undefined;

  constructor(private readonly desktopRoot: string) {}

  static registerScheme(): void {
    protocol.registerSchemesAsPrivileged([{ scheme: 'screendeck-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  }

  installProtocol(): void {
    protocol.handle('screendeck-app', request => {
      const url = new URL(request.url);
      let relative: string;
      try { relative = decodeURIComponent(url.pathname).slice(1); } catch { return new Response('Invalid path', { status: 400 }); }
      if (url.hostname !== 'workbench' || !/^(?:index\.html|assets\/[A-Za-z0-9_.-]+\.(?:js|css))$/.test(relative)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(this.desktopRoot, 'renderer', relative)).href);
    });
  }

  broadcast(event: DesktopEvent): void {
    for (const window of this.windows) if (!window.isDestroyed()) window.webContents.send('screendeck:event', event);
  }

  handle(channel: string, operation: (input: unknown) => unknown): void {
    ipcMain.handle(`screendeck:${channel}`, async (event, input) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || !this.windows.has(window) || event.senderFrame !== event.sender.mainFrame || !isTrustedURL(event.senderFrame.url)) throw new Error('未授权的桌面请求。');
      try { return await operation(input); }
      catch (error) {
        // No provider body, stack, credential, or raw OS exception crosses IPC.
        if (error instanceof StorageError || error instanceof ProjectReadFailure) throw new Error(error.message);
        throw new Error('操作未完成。请检查本地记录或设置后重试。');
      }
    });
  }

  async showWorkbench(): Promise<void> {
    if (!this.workbench || this.workbench.isDestroyed()) {
      this.workbench = this.createWindow();
      await this.workbench.loadURL('screendeck-app://workbench/index.html');
    }
    if (this.workbench.isMinimized()) this.workbench.restore(); this.workbench.show(); this.workbench.focus();
  }

  async chooseProject(): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.workbench!, { title: '选择项目文件夹', properties: ['openDirectory'], buttonLabel: '关联项目' });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  }

  async openDeck(sessionID?: string): Promise<void> {
    if (!this.deck || this.deck.isDestroyed()) this.deck = this.createWindow(true);
    await this.deck.loadURL(`screendeck-app://workbench/index.html?deck=1${sessionID ? `&sessionID=${sessionID}` : ''}`);
    this.deck.show(); this.deck.focus();
  }

  private createWindow(compact = false): BrowserWindow {
    const window = new BrowserWindow({
      width: compact ? 430 : 1440, height: compact ? 310 : 940,
      minWidth: compact ? 360 : 860, minHeight: compact ? 220 : 600,
      title: compact ? 'ScreenDeck Deck' : 'ScreenDeck Preview',
      backgroundColor: compact ? '#111113' : '#fcfcfd', show: false,
      titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 17 },
      ...(compact ? { alwaysOnTop: true } : {}),
      webPreferences: { preload: path.join(this.desktopRoot, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    this.windows.add(window);
    const wc = window.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', event => event.preventDefault());
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => this.windows.delete(window));
    return window;
  }
}
