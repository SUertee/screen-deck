/** Screen coordinates are Electron DIP coordinates, including negative origins. */
export interface DeckPoint { x: number; y: number }
export interface DeckRect extends DeckPoint { width: number; height: number }
export interface NotchLayout {
  displayID: string;
  hotZone: DeckRect;
  panel: DeckRect;
  notchHeight: number;
  notchWidth: number;
}
export interface DeckDisplayGeometry {
  displayID: string;
  bounds: DeckRect;
  builtIn: boolean;
  hasNotch: boolean;
  notchHeight: number;
  notchWidth: number;
  notchX?: number;
}
export type DeckHoverState = 'collapsed' | 'peeked' | 'expanded';
export interface DeckHoverScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface DeckHoverOptions {
  onState(state: DeckHoverState): void;
  onLayout?(layout: NotchLayout | null): void;
  scheduler?: DeckHoverScheduler;
  expandDelayMs?: number;
  leaveDelayMs?: number;
}

const validRect = (rect: DeckRect | null | undefined): rect is DeckRect => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
export const pointInDeckRect = (point: DeckPoint | null, rect: DeckRect): boolean => !!point && point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
const cloneLayout = (layout: NotchLayout): NotchLayout => ({ ...layout, hotZone: { ...layout.hotZone }, panel: { ...layout.panel } });
const sameRect = (a: DeckRect, b: DeckRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameLayout = (a: NotchLayout | null, b: NotchLayout | null): boolean => a === b || !!a && !!b && a.displayID === b.displayID && a.notchHeight === b.notchHeight && a.notchWidth === b.notchWidth && sameRect(a.hotZone, b.hotZone) && sameRect(a.panel, b.panel);
const defaultScheduler: DeckHoverScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/** Only native-confirmed notches participate; non-notched screens stay floating. */
export function selectNotchLayout(displays: readonly DeckDisplayGeometry[], panelWidth = 380, panelBodyHeight = 380): NotchLayout | null {
  if (![panelWidth, panelBodyHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const candidates = displays.filter(display => typeof display.displayID === 'string' && display.displayID.trim() && display.hasNotch === true && validRect(display.bounds) && Number.isFinite(display.notchWidth) && display.notchWidth > 0 && display.notchWidth <= display.bounds.width && Number.isFinite(display.notchHeight) && display.notchHeight > 0 && display.notchHeight <= display.bounds.height);
  const display = candidates.find(candidate => candidate.builtIn) ?? candidates[0];
  if (!display) return null;
  const { bounds, notchWidth, notchHeight, displayID } = display;
  const width = Math.min(panelWidth, bounds.width), height = Math.min(notchHeight + panelBodyHeight, bounds.height);
  const notchX = Number.isFinite(display.notchX) && display.notchX! >= bounds.x && display.notchX! + notchWidth <= bounds.x + bounds.width
    ? display.notchX! : bounds.x + (bounds.width - notchWidth) / 2;
  return {
    displayID, notchWidth, notchHeight,
    hotZone: { x: notchX, y: bounds.y, width: notchWidth, height: notchHeight },
    panel: { x: Math.max(bounds.x, Math.min(notchX + (notchWidth - width) / 2, bounds.x + bounds.width - width)), y: bounds.y, width, height },
  };
}
interface PendingTimer { handle: unknown }

/** Pure hover policy. The host owns screen discovery, windows, focus and polling. */
export class DeckHoverController {
  private currentState: DeckHoverState = 'collapsed';
  private currentLayout: NotchLayout | null = null;
  private point: DeckPoint | null = null;
  private previousButtons: number | null = null;
  private editing = false;
  private disposed = false;
  private hasLayout = false;
  private hoverSuppressed = false;
  private expandTimer: PendingTimer | null = null;
  private leaveTimer: PendingTimer | null = null;
  private readonly scheduler: DeckHoverScheduler;
  private readonly expandDelay: number;
  private readonly leaveDelay: number;

  constructor(private readonly options: DeckHoverOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.expandDelay = options.expandDelayMs ?? 160;
    this.leaveDelay = options.leaveDelayMs ?? 180;
    if (![this.expandDelay, this.leaveDelay].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('Hover delays must be finite and nonnegative.');
  }

  get state(): DeckHoverState { return this.currentState; }
  get layout(): NotchLayout | null { return this.currentLayout ? cloneLayout(this.currentLayout) : null; }

  /** A null or non-notched layout disables hover; no synthetic notch is invented. */
  setLayout(layout: NotchLayout | null): void {
    if (this.disposed) return;
    const next = layout && typeof layout.displayID === 'string' && layout.displayID.trim() && validRect(layout.hotZone) && validRect(layout.panel) && Number.isFinite(layout.notchHeight) && layout.notchHeight > 0 && Number.isFinite(layout.notchWidth) && layout.notchWidth > 0 ? cloneLayout(layout) : null;
    if (sameLayout(this.currentLayout, next)) return;
    this.cancelTimers();
    this.currentLayout = next;
    this.point = null; this.previousButtons = null;
    // After a display change, a stationary cursor is not a fresh hover gesture.
    this.hoverSuppressed = this.hasLayout;
    this.hasLayout ||= next !== null;
    this.options.onLayout?.(this.layout);
    this.transition('collapsed');
  }

  tick(point: DeckPoint | null, buttons?: number): void {
    if (this.disposed) return;
    this.point = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { ...point } : null;
    let pressed = false;
    if (buttons !== undefined && Number.isSafeInteger(buttons) && buttons >= 0) {
      pressed = this.previousButtons === 0 && buttons > 0;
      this.previousButtons = buttons;
    }
    if (pressed && this.currentState === 'expanded' && this.currentLayout && this.point && !pointInDeckRect(this.point, this.currentLayout.panel) && !this.editing) {
      this.collapse(); return;
    }
    this.reconcile();
  }

  expand(): void {
    if (this.disposed || !this.currentLayout) return;
    this.transition('expanded');
  }

  /** Explicit user collapse is allowed; only automatic dismissal is protected. */
  collapse(): void {
    if (this.disposed) return;
    this.hoverSuppressed = !!this.currentLayout && pointInDeckRect(this.point, this.currentLayout.hotZone);
    this.transition('collapsed');
  }

  /** The host combines draft, menu, IME composition and pending writes here. */
  setEditing(value: boolean): void {
    if (this.disposed || this.editing === value) return;
    this.editing = value;
    if (value) this.cancelLeave();
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancelTimers();
    this.point = null; this.previousButtons = null;
  }

  private reconcile(): void {
    if (this.disposed || !this.currentLayout) return;
    const hot = pointInDeckRect(this.point, this.currentLayout.hotZone);
    if (this.currentState === 'collapsed') {
      if (this.hoverSuppressed) { if (!hot) this.hoverSuppressed = false; return; }
      if (!hot) return;
      this.transition('peeked');
    }
    if (this.currentState === 'expanded') { this.cancelTimers(); return; }
    if (hot) { this.cancelLeave(); this.scheduleExpand(); }
    else { this.cancelExpand(); if (this.editing) this.cancelLeave(); else this.scheduleLeave(); }
  }

  private transition(state: DeckHoverState): void {
    this.cancelTimers();
    if (this.currentState === state) return;
    this.currentState = state;
    this.options.onState(state);
  }
  private scheduleExpand(): void {
    if (this.expandTimer) return;
    const timer: PendingTimer = { handle: undefined }; this.expandTimer = timer;
    timer.handle = this.scheduler.setTimeout(() => {
      if (this.disposed || this.expandTimer !== timer) return;
      this.expandTimer = null;
      if (this.currentState === 'peeked' && this.currentLayout && pointInDeckRect(this.point, this.currentLayout.hotZone)) this.transition('expanded');
    }, this.expandDelay);
  }
  private scheduleLeave(): void {
    if (this.leaveTimer) return;
    const timer: PendingTimer = { handle: undefined }; this.leaveTimer = timer;
    timer.handle = this.scheduler.setTimeout(() => {
      if (this.disposed || this.leaveTimer !== timer) return;
      this.leaveTimer = null;
      if (this.currentState === 'peeked' && !this.editing && this.currentLayout && !pointInDeckRect(this.point, this.currentLayout.hotZone)) this.transition('collapsed');
    }, this.leaveDelay);
  }
  private cancelExpand(): void { if (this.expandTimer) { this.scheduler.clearTimeout(this.expandTimer.handle); this.expandTimer = null; } }
  private cancelLeave(): void { if (this.leaveTimer) { this.scheduler.clearTimeout(this.leaveTimer.handle); this.leaveTimer = null; } }
  private cancelTimers(): void { this.cancelExpand(); this.cancelLeave(); }
}
