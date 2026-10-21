import { BrowserWindow, clipboard, dialog, ipcMain, net, protocol, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StorageError } from '../core/index.js';
import { ProjectReadFailure } from '../projects/index.js';
import type { DeckContext, DeckPresentation, DesktopEvent } from '../shared/desktop-api.js';
import type { TaskSessionEvent } from '../shared/task-execution.js';
import { isTrustedURL } from './ipc-validation.js';
import { DeckHoverController, pointInDeckRect, selectNotchLayout, type DeckPoint, type NotchLayout } from './deck-hover-controller.js';
import { getNativeDeckWindow, type NativeDeckWindow } from './native-deck-window.js';

export interface DeckDockDependencies {
  nativeProvider?: () => NativeDeckWindow | undefined;
  cursorPoint?: () => DeckPoint;
  mouseButtons?: () => number;
}

/** Owns Electron windows and the trusted renderer boundary, never domain state. */
export class ElectronHost {
  private readonly windows = new Set<BrowserWindow>();
  private workbench: BrowserWindow | undefined;
  private deck: BrowserWindow | undefined;
  private deckLoading: Promise<void> | undefined;
  private deckCollapsed = false;
  private deckExpandedSize: [number, number] = [380, 380];
  private deckContext: DeckContext = { revision: 0 };
  private presentation: DeckPresentation = { revision: 0, mode: 'floating', state: 'expanded', notchWidth: 0, notchHeight: 0 };
  private nativeDeck: NativeDeckWindow | undefined;
  private hover: DeckHoverController | undefined;
  private notchLayout: NotchLayout | null = null;
  private hoverPoll: ReturnType<typeof setInterval> | undefined;
  private dockInitialized = false;
  private dockDisposed = false;
  private deckLoaded = false;
  private layoutGeneration = 0;
  private deckBusy = false;
  private ignoringMouse: boolean | undefined;

  constructor(private readonly desktopRoot: string, private readonly dockDependencies: DeckDockDependencies = {}) {}

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

  broadcastTask(event: TaskSessionEvent): void {
    for (const window of this.windows) if (!window.isDestroyed()) window.webContents.send('screendeck:task-event', event);
  }

  writeClipboardText(text: string): void { clipboard.writeText(text); }

  handle(channel: string, operation: (input: unknown, sender?: BrowserWindow) => unknown): void {
    ipcMain.handle(`screendeck:${channel}`, async (event, input) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || !this.windows.has(window) || event.senderFrame !== event.sender.mainFrame || !isTrustedURL(event.senderFrame.url)) throw new Error('未授权的桌面请求。');
      try { return await operation(input, window); }
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

  async openDeck(sessionID?: string, planID?: string): Promise<void> {
    this.deckContext = { revision: this.deckContext.revision + 1, ...(sessionID ? { sessionID } : {}), ...(planID ? { planID } : {}) };
    const deck = this.ensureDeck();
    await this.deckLoading;
    if (deck.isDestroyed()) return;
    if (this.notchLayout && this.hover) { this.hover.expand(); this.applyDockState(); }
    else if (this.deckCollapsed) this.setDeckCollapsed(false);
    // Explicit opening may focus; the hover path only uses showInactive().
    deck.webContents.send('screendeck:event', { type: 'deck-context-updated', ...this.deckContext } satisfies DesktopEvent);
    if (deck.isMinimized()) deck.restore();
    deck.show(); deck.focus();
  }

  private ensureDeck(): BrowserWindow {
    if (!this.deck || this.deck.isDestroyed()) {
      this.deck = this.createWindow(true);
      this.deckLoaded = false;
      this.deckCollapsed = false;
      this.deckExpandedSize = [380, 380];
      this.ignoringMouse = undefined;
      const { sessionID, planID } = this.deckContext;
      const query = new URLSearchParams({ deck: '1', ...(sessionID ? { sessionID } : {}), ...(planID ? { planID } : {}) });
      const deck = this.deck;
      this.deckLoading = deck.loadURL(`screendeck-app://workbench/index.html?${query}`).then(() => { if (this.deck === deck && !deck.isDestroyed()) this.deckLoaded = true; });
      deck.on('close', event => { if (this.notchLayout && !this.dockDisposed) { event.preventDefault(); this.hover?.collapse(); } });
      deck.webContents.on('render-process-gone', () => { this.deckBusy = false; this.hover?.setEditing(false); this.hover?.collapse(); });
    }
    return this.deck;
  }

  getDeckContext(): DeckContext { return { ...this.deckContext }; }
  getDeckPresentation(): DeckPresentation { return { ...this.presentation }; }

  setDeckInteraction(busy: boolean, sender?: BrowserWindow): void {
    if (!sender || sender !== this.deck || sender.isDestroyed()) throw new StorageError('invalid-window', '交互状态只能由任务浮窗更新。');
    this.deckBusy = busy; this.hover?.setEditing(busy);
  }

  /** Starts only window observation; it never starts a task, model or Agent. */
  async initializeDeckDock(): Promise<void> {
    if (this.dockInitialized || this.dockDisposed || process.platform !== 'darwin') return;
    this.dockInitialized = true;
    try { this.nativeDeck = (this.dockDependencies.nativeProvider ?? getNativeDeckWindow)(); } catch { return; }
    if (!this.nativeDeck) return;
    this.hover = new DeckHoverController({ onState: () => this.applyDockState() });
    screen.on('display-added', this.displayChanged);
    screen.on('display-removed', this.displayChanged);
    screen.on('display-metrics-changed', this.displayChanged);
    await this.refreshDockLayout().catch(() => this.fallbackToFloating());
  }

  private readonly displayChanged = () => { void this.refreshDockLayout().catch(() => this.fallbackToFloating()); };

  private async refreshDockLayout(): Promise<void> {
    if (this.dockDisposed || !this.nativeDeck || !this.hover) return;
    const generation = ++this.layoutGeneration;
    // Display/Space changes may need native style restoration even at identical bounds.
    this.appliedDockGeometry = undefined;
    const layout = selectNotchLayout(this.nativeDeck.getDisplays().map(display => ({ ...display,
      ...(display.auxiliaryTopLeftArea ? { notchX: display.auxiliaryTopLeftArea.x + display.auxiliaryTopLeftArea.width } : {}),
    })));
    if (!layout) { this.fallbackToFloating(); return; }
    const expanded = this.hover.state === 'expanded' || this.deckBusy;
    this.notchLayout = layout;
    this.hover.setLayout(layout);
    if (expanded) this.hover.expand();
    this.applyDockState();
    this.ensureDeck(); await this.deckLoading;
    if (generation !== this.layoutGeneration || this.dockDisposed) return;
    this.applyDockState();
    if (!this.hoverPoll) { this.hoverPoll = setInterval(() => this.samplePointer(), 20); this.hoverPoll.unref(); }
  }

  private publishPresentation(mode: DeckPresentation['mode'], state: DeckPresentation['state'], notchWidth = 0, notchHeight = 0): void {
    const current = this.presentation;
    if (current.mode === mode && current.state === state && current.notchWidth === notchWidth && current.notchHeight === notchHeight) return;
    this.presentation = { revision: current.revision + 1, mode, state, notchWidth, notchHeight };
    this.broadcast({ type: 'deck-presentation-updated', presentation: this.getDeckPresentation() });
  }

  private setMousePassthrough(ignore: boolean): void {
    if (!this.deck || this.deck.isDestroyed() || this.ignoringMouse === ignore) return;
    this.deck.setIgnoreMouseEvents(ignore, { forward: ignore }); this.ignoringMouse = ignore;
  }

  private deckRevealReadyAt = 0;
  private appliedDockGeometry: string | undefined;

  private applyDockState(): void {
    const layout = this.notchLayout, deck = this.deck;
    if (this.dockDisposed || !layout || !this.hover || !this.nativeDeck) return;
    const state = this.hover.state;
    if (this.presentation.mode !== 'notch' || this.presentation.state !== state) {
      // Transparent portions stay click-through while the visual shell opens.
      this.deckRevealReadyAt = state === 'expanded' ? Date.now() + 340 : 0;
    }
    this.publishPresentation('notch', state, layout.notchWidth, layout.notchHeight);
    if (!deck || deck.isDestroyed() || !this.deckLoaded) return;
    // Like the Swift prototype, keep native geometry stable; only the renderer mask moves.
    const height = layout.panel.height;
    const geometry = JSON.stringify([deck.id, layout.panel.x, layout.panel.y, layout.panel.width, height]);
    if (this.appliedDockGeometry !== geometry) {
      deck.setMinimumSize(1, 1); deck.setResizable(false); deck.setMovable(false);
      deck.setWindowButtonVisibility(false); deck.setBackgroundColor('#00000000');
      let applied = false;
      try { applied = this.nativeDeck.applyWindow(deck, { x: layout.panel.x, y: layout.panel.y, width: layout.panel.width, height }); } catch { /* Keep the renderer and recover as a floating window. */ }
      if (!applied) { this.fallbackToFloating(); return; }
      this.appliedDockGeometry = geometry;
    }
    this.deckCollapsed = state !== 'expanded';
    this.setMousePassthrough(state !== 'expanded' || Date.now() < this.deckRevealReadyAt);
    if (!deck.isVisible()) deck.showInactive();
  }

  private samplePointer(): void {
    if (this.dockDisposed || !this.notchLayout || !this.hover || !this.nativeDeck) return;
    try {
      const point = (this.dockDependencies.cursorPoint ?? (() => screen.getCursorScreenPoint()))();
      const buttons = (this.dockDependencies.mouseButtons ?? (() => this.nativeDeck!.getMouseButtons()))();
      this.hover.tick(point, buttons);
      const layout = this.notchLayout;
      if (layout && this.hover.state === 'expanded') {
        // Transparent corners alongside the camera must not cover menu-bar clicks.
        const body = { ...layout.panel, y: layout.panel.y + layout.notchHeight, height: layout.panel.height - layout.notchHeight };
        this.setMousePassthrough(Date.now() < this.deckRevealReadyAt || !pointInDeckRect(point, body) && !pointInDeckRect(point, layout.hotZone));
      }
    } catch { this.fallbackToFloating(); }
  }

  private fallbackToFloating(): void {
    this.appliedDockGeometry = undefined;
    const wasNotch = !!this.notchLayout;
    this.notchLayout = null; this.hover?.setLayout(null);
    if (this.hoverPoll) { clearInterval(this.hoverPoll); this.hoverPoll = undefined; }
    const deck = this.deck;
    if (wasNotch && deck && !deck.isDestroyed()) {
      // A failed native restoration must not block visible Electron recovery.
      try { this.nativeDeck?.restoreWindow(deck); } catch { /* Continue with ordinary window bounds and controls. */ }
      this.setMousePassthrough(false);
      deck.setMinimumSize(360, 300); deck.setResizable(true); deck.setMovable(true); deck.setClosable(true);
      deck.setWindowButtonVisibility(true); deck.setBackgroundColor('#101010'); deck.setAlwaysOnTop(true);
      const area = screen.getPrimaryDisplay().workArea;
      const width = Math.min(380, area.width), height = Math.min(380, area.height);
      deck.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height });
      this.deckCollapsed = false; deck.showInactive();
    }
    this.publishPresentation('floating', this.deckCollapsed ? 'collapsed' : 'expanded');
  }

  disposeDeckDock(): void {
    this.dockDisposed = true; ++this.layoutGeneration;
    if (this.hoverPoll) { clearInterval(this.hoverPoll); this.hoverPoll = undefined; }
    this.hover?.dispose();
    screen.removeListener('display-added', this.displayChanged);
    screen.removeListener('display-removed', this.displayChanged);
    screen.removeListener('display-metrics-changed', this.displayChanged);
    const deck = this.deck;
    if (this.nativeDeck && deck && !deck.isDestroyed()) {
      // Cocoa's borderless panel may refuse Electron's normal quit close.
      // Restore its original closable style without showing or activating it.
      let restored = false;
      try { restored = this.nativeDeck?.restoreWindow(deck) === true; } catch { /* Explicit shutdown may destroy an unrestorable window. */ }
      if (restored) deck.setClosable(true);
      else deck.destroy();
    }
  }

  setDeckCollapsed(collapsed: boolean): void {
    const deck = this.deck;
    if (!deck || deck.isDestroyed()) throw new StorageError('missing-window', '请先打开任务浮窗。');
    if (this.notchLayout && this.hover) { if (collapsed) this.hover.collapse(); else this.hover.expand(); return; }
    if (collapsed === this.deckCollapsed) return;
    if (collapsed) {
      const [width, height] = deck.getSize();
      this.deckExpandedSize = [width, height];
      deck.setMinimumSize(360, 96);
      deck.setSize(this.deckExpandedSize[0], 96);
      deck.setResizable(false);
    } else {
      deck.setResizable(true);
      deck.setMinimumSize(360, 300);
      deck.setSize(Math.max(360, this.deckExpandedSize[0]), Math.max(300, this.deckExpandedSize[1]));
    }
    this.deckCollapsed = collapsed;
    this.publishPresentation('floating', collapsed ? 'collapsed' : 'expanded');
  }

  private createWindow(compact = false): BrowserWindow {
    const window = new BrowserWindow({
      width: compact ? 380 : 1440, height: compact ? 380 : 940,
      minWidth: compact ? 360 : 860, minHeight: compact ? 300 : 600,
      title: compact ? 'ScreenDeck Deck' : 'ScreenDeck Preview',
      icon: path.join(this.desktopRoot, 'brand', 'screendeck-icon-black.png'),
      backgroundColor: compact ? '#101010' : '#fcfcfd', show: false,
      titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 17 },
      ...(compact ? { alwaysOnTop: true } : {}),
      ...(compact && process.platform === 'darwin' ? { type: 'panel', transparent: true, hiddenInMissionControl: true } : {}),
      webPreferences: { preload: path.join(this.desktopRoot, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    if (compact && process.platform === 'darwin') window.excludedFromShownWindowsMenu = true;
    this.windows.add(window);
    const wc = window.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', event => event.preventDefault());
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    if (!compact) window.once('ready-to-show', () => window.show());
    window.on('closed', () => this.windows.delete(window));
    return window;
  }
}
