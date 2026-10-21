import { BrowserWindow, type Rectangle } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface NativeDeckDisplay {
  displayID: string;
  /** Global Electron top-left coordinates in DIP, including displays above/left. */
  bounds: Rectangle;
  builtIn: boolean;
  hasNotch: boolean;
  notchWidth: number;
  notchHeight: number;
  safeAreaInsets: { top: number; left: number; bottom: number; right: number };
  auxiliaryTopLeftArea: Rectangle | null;
  auxiliaryTopRightArea: Rectangle | null;
}
export interface NativeDeckWindow {
  getDisplays(): NativeDeckDisplay[];
  /** Current button-state bitmask only; no input event monitor or event contents. */
  getMouseButtons(): number;
  /** The handle is obtained internally from a live window owned by this process. */
  applyWindow(window: BrowserWindow, bounds: Rectangle): boolean;
  /** Restore the original Cocoa style without reloading the renderer. */
  restoreWindow(window: BrowserWindow): boolean;
}
interface NativeModule {
  getDisplays(): NativeDeckDisplay[];
  getMouseButtons(): number;
  applyWindow(handle: Buffer, bounds: Rectangle): boolean;
  restoreWindow(handle: Buffer): boolean;
}
export type NativeDeckWindowLoad = { available: true; bridge: NativeDeckWindow } | { available: false; reason: string };
let loaded: NativeDeckWindowLoad | undefined;
const rectangle = (value: Rectangle): boolean => value !== null && typeof value === 'object'
  && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key as keyof Rectangle]))
  && Math.abs(value.x) <= 10_000_000 && Math.abs(value.y) <= 10_000_000
  && value.width >= 1 && value.height >= 1 && value.width <= 100_000 && value.height <= 100_000;

/** Main-only fixed-path loader. No renderer-selected path, pointer, or evaluation. */
export function loadNativeDeckWindow(): NativeDeckWindowLoad {
  if (loaded) return loaded;
  if (process.platform !== 'darwin') return loaded = { available: false, reason: 'Native Deck is available only on macOS.' };
  if (typeof __dirname !== 'string') return loaded = { available: false, reason: 'Native Deck requires the built Electron main process.' };
  try {
    const requireNative = createRequire(path.join(__dirname, 'native-deck-loader.cjs'));
    const native = requireNative(path.join(__dirname, 'native', 'deck-window.node')) as NativeModule;
    if (!native || !['getDisplays', 'getMouseButtons', 'applyWindow', 'restoreWindow'].every(key => typeof native[key as keyof NativeModule] === 'function')) throw new Error('invalid-native-module');
    const bridge: NativeDeckWindow = {
      getDisplays() {
        const displays = native.getDisplays();
        if (!Array.isArray(displays) || displays.some(display => !display || !/^[1-9]\d*$/.test(display.displayID) || !rectangle(display.bounds)
          || typeof display.hasNotch !== 'boolean' || typeof display.builtIn !== 'boolean'
          || !Number.isFinite(display.notchWidth) || !Number.isFinite(display.notchHeight)
          || display.notchWidth < 0 || display.notchHeight < 0
          || display.notchWidth > display.bounds.width || display.notchHeight > display.bounds.height
          || display.hasNotch && (display.notchWidth <= 0 || display.notchHeight <= 0)
          || !display.hasNotch && (display.notchWidth !== 0 || display.notchHeight !== 0))) throw new Error('Native display geometry is unavailable.');
        return displays;
      },
      getMouseButtons() {
        const value = native.getMouseButtons();
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Native mouse-button state is unavailable.');
        return value;
      },
      applyWindow(window, bounds) {
        if (!rectangle(bounds) || !BrowserWindow.getAllWindows().includes(window) || window.isDestroyed()) return false;
        const handle = window.getNativeWindowHandle();
        if (!Buffer.isBuffer(handle) || handle.length !== 8) return false;
        return native.applyWindow(handle, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }) === true;
      },
      restoreWindow(window) {
        if (!BrowserWindow.getAllWindows().includes(window) || window.isDestroyed()) return false;
        const handle = window.getNativeWindowHandle();
        if (!Buffer.isBuffer(handle) || handle.length !== 8) return false;
        return native.restoreWindow(handle) === true;
      },
    };
    return loaded = { available: true, bridge };
  } catch {
    return loaded = { available: false, reason: 'The native Deck bridge could not be loaded; use the floating window.' };
  }
}

export function getNativeDeckWindow(): NativeDeckWindow | undefined {
  const result = loadNativeDeckWindow();
  return result.available ? result.bridge : undefined;
}
