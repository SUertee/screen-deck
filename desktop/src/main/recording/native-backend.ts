import { validDisplay, validFrameMetadata } from './frame-metadata.js';
import { StorageError } from '../../core/storage/private-storage.js';
import { execFile } from 'node:child_process';
import os from 'node:os';
import type { ScreenCaptureBackend, CapturedScreen } from './recording-service.js';
import type { ScreenDisplay, ScreenRecordingSettings } from '../../shared/screen-recording.js';
export class NativeScreenBackend implements ScreenCaptureBackend {
  readonly supported = process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 23;
  constructor(private readonly binary: string, private readonly invoke?: (command: string, input?: unknown) => Promise<unknown>) {}
  private run(command: string, input?: unknown): Promise<unknown> {
    if (this.invoke) return this.invoke(command, input);
    return new Promise((resolve, reject) => {
      const child = execFile(this.binary, [command], { timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new Error('Screen capture helper failed')); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Screen capture unavailable')); }
      });
      child.stdin?.end(input === undefined ? '' : JSON.stringify(input));
    });
  }
  async permission(): Promise<boolean> { const result = await this.run('permission') as { granted?: boolean }; return result?.granted === true; }
  async displays(): Promise<ScreenDisplay[]> {
    if (!this.supported) return [];
    const result = await this.run('displays');
    if (!Array.isArray(result) || result.length > 32 || result.some(d => !validDisplay(d))) throw new Error('Invalid displays');
    return result;
  }
  async capture(settings: ScreenRecordingSettings): Promise<CapturedScreen | undefined> {
    const r = await this.run('capture', { displayID: settings.displayID, excludedApps: settings.excludedApps }) as Record<string, unknown>;
    if (r?.error === 'display') throw new StorageError('recording-display-missing', '所选显示器未连接。');
    if (r?.skipped === true) return undefined;
    if (!r || typeof r.jpeg !== 'string' || typeof r.text !== 'string' || r.text.length > 24000 || typeof r.appName !== 'string' || r.appName.length > 200 || typeof r.bundleID !== 'string' || !Number.isInteger(r.displayID) || !Number.isInteger(r.width) || !Number.isInteger(r.height) || (r.displayID as number) <= 0 || (r.width as number) <= 0 || (r.height as number) <= 0 || settings.displayID !== null && r.displayID !== settings.displayID || !validFrameMetadata({displayID: r.displayID as number, display: r.display, context: r.context}) || r.capturedAt !== undefined && (typeof r.capturedAt !== 'string' || !Number.isFinite(Date.parse(r.capturedAt)))) throw new Error('Invalid capture');
    const jpeg = Buffer.from(r.jpeg, 'base64');
    if (jpeg.length < 4 || jpeg.length > 8 * 1024 * 1024 || jpeg[0] !== 255 || jpeg[1] !== 216) throw new Error('Invalid image');
    return { jpeg, ...(typeof r.capturedAt === 'string' ? {capturedAt: r.capturedAt} : {}), frame: { ...(r.display === undefined ? {} : {display: structuredClone(r.display) as ScreenDisplay}), ...(r.context === undefined ? {} : {context: structuredClone(r.context) as import('../../shared/screen-recording.js').ScreenWindowContext}), appName: r.appName, bundleID: r.bundleID, displayID: r.displayID as number, width: r.width as number, height: r.height as number, text: r.text } };
  }
  async captureMany(settings: ScreenRecordingSettings, isCurrent: () => boolean = () => true) {
    const frames: CapturedScreen[] = [], skippedDisplayIDs: number[] = [], unavailableDisplayIDs: number[] = [];
    const selected = settings.displayIDs ?? [settings.displayID];
    if (settings.displayIDs !== undefined && selected.some(id => id === null) || !selected.length || selected.length > 8 || new Set(selected).size !== selected.length || selected.some(id => id !== null && (!Number.isSafeInteger(id) || id <= 0))) throw new StorageError('recording-input', '采集显示器选择无效。');
    for (const displayID of selected) {
      if (!isCurrent()) break;
      try {
        const frame = await this.capture({...settings, displayID});
        if (frame) frames.push(frame);
        else if (displayID !== null) skippedDisplayIDs.push(displayID);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'recording-display-missing' && displayID !== null) unavailableDisplayIDs.push(displayID);
        else throw error;
      }
    }
    return {frames, skippedDisplayIDs, unavailableDisplayIDs};
  }

}
