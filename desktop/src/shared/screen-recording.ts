export interface ScreenRecordingSettings {
  intervalSeconds: number;
  retentionDays: number;
  maxStorageMB: number;
  displayID: number | null;
  /** Explicit fixed selection; absent preserves the legacy single/main display. */
  displayIDs?: number[];
  excludedApps: string[];
}
export interface ScreenBounds { x: number; y: number; width: number; height: number }
export interface ScreenDisplay { id: number; name: string; width: number; height: number; uuid?: string; bounds?: ScreenBounds }
export interface ScreenWindowContext {
  kind: 'topmost-window-on-display' | 'unattributed';
  observedAt: string;
  appIsFrontmost: boolean | null;
  /** No Accessibility permission requested; app activation is not window focus. */
  windowFocus: 'unknown';
  window?: { id: number; title: string; bounds: ScreenBounds };
}
export interface ScreenFrame {
  id: string; timestamp: string; appName: string; bundleID: string;
  displayID: number; width: number; height: number; text: string; bytes: number;
  display?: ScreenDisplay; context?: ScreenWindowContext;
}
export interface ScreenQuery { query?: string; app?: string; day?: string; offset?: number }
export interface ScreenPage { frames: ScreenFrame[]; total: number; apps: string[] }
export interface ScreenRecordingStatus {
  state: 'stopped' | 'recording' | 'paused' | 'error';
  message: string; needsPermission?: boolean; supported: boolean; settings: ScreenRecordingSettings;
  frameCount: number; storageBytes: number; lastCapturedAt?: string;
}
export interface ScreenRecordingAPI {
  screenStatus(): Promise<ScreenRecordingStatus>;
  screenDisplays(): Promise<ScreenDisplay[]>;
  screenStart(): Promise<ScreenRecordingStatus>;
  screenStop(): Promise<ScreenRecordingStatus>;
  screenSettings(input: ScreenRecordingSettings): Promise<ScreenRecordingStatus>;
  screenSearch(input: ScreenQuery): Promise<ScreenPage>;
  screenImage(id: string): Promise<string>;
  screenDelete(id: string): Promise<void>;
  screenClear(): Promise<void>;
  screenOpenPermissions(): Promise<void>;
}
