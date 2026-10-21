import { createHash } from 'node:crypto';
import type { ScreenDisplay, ScreenFrame, ScreenRecordingStatus } from '../../shared/screen-recording.js';
import { RecordingStore } from './recording-store.js';
import { StorageError } from '../../core/storage/private-storage.js';
export interface CapturedScreen { frame: Omit<ScreenFrame, 'id' | 'timestamp' | 'bytes'>; jpeg: Buffer; capturedAt?: string }
export interface ScreenCaptureBackend {
  supported: boolean; permission(): Promise<boolean>; displays(): Promise<ScreenDisplay[]>;
  captureMany?(settings: RecordingStore['settings'], isCurrent?: () => boolean): Promise<{ frames: CapturedScreen[]; skippedDisplayIDs: number[]; unavailableDisplayIDs: number[] }>;
  capture(settings: RecordingStore['settings']): Promise<CapturedScreen | undefined>;
}
export class RecordingService {
  private state: ScreenRecordingStatus['state'] = 'stopped';
  private message = '记录已关闭';
  private needsPermission = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private previous = new Map<number, string>();
  private controls: Promise<unknown> = Promise.resolve();
  constructor(readonly store: RecordingStore, readonly backend: ScreenCaptureBackend) {}
  status(): ScreenRecordingStatus { return { state: this.state, message: this.message, needsPermission: this.needsPermission, supported: this.backend.supported, settings: structuredClone(this.store.settings), ...this.store.stats() }; }
  private control<T>(fn: () => Promise<T>): Promise<T> { const task = this.controls.then(fn); this.controls = task.catch(() => {}); return task; }
  start() { return this.control(async () => {
    if (this.state === 'recording') return this.status();
    if (!this.backend.supported) throw new StorageError('recording-platform', '屏幕记录需要 macOS 14 或更高版本。');
    const generation = this.generation;
    const granted = await this.backend.permission();
    if (generation !== this.generation) return this.status();
    if (!granted) { this.needsPermission = true; this.state = 'error'; this.message = '尚未获得屏幕录制权限，当前没有记录。'; return this.status(); }
    this.needsPermission = false;
    await this.active; await this.store.prune();
    if (generation !== this.generation) return this.status();
    this.previous.clear(); this.generation++;
    this.state = 'recording'; this.message = '正在记录屏幕'; this.tick(this.generation); return this.status();
  }); }
  stop() { this.generation++; clearTimeout(this.timer); return this.control(async () => { await this.halt('stopped', '记录已关闭'); return this.status(); }); }
  pause() { this.generation++; clearTimeout(this.timer); if (this.state === 'recording') { this.state = 'paused'; this.message = '锁屏或休眠后已暂停，点击开始继续'; } }
  private async halt(state: ScreenRecordingStatus['state'], message: string) { this.generation++; clearTimeout(this.timer); this.state = state; this.message = message; await this.active; }
  saveSettings(input: unknown) { return this.control(async () => { await this.halt('stopped', '设置已更新，请点击开始记录'); await this.store.saveSettings(input); return this.status(); }); }
  delete(id: unknown) { return this.control(async () => { await this.halt('stopped', '记录已关闭'); await this.store.delete(id); this.previous.clear(); }); }
  clear() { return this.control(async () => { await this.halt('stopped', '记录已清空'); await this.store.clear(); this.previous.clear(); }); }
  async shutdown() { await this.stop(); }
  private tick(generation: number) {
    if (generation !== this.generation || this.state !== 'recording') return;
    this.active = this.sample(generation).catch(() => {
      if (generation === this.generation) { this.state = 'error'; this.message = '采集或保存失败，已停止记录。请检查屏幕权限、显示器和本地存储后重试。'; this.generation++; }
    }).finally(() => {
      this.active = undefined;
      if (generation === this.generation && this.state === 'recording') this.timer = setTimeout(() => this.tick(generation), this.store.settings.intervalSeconds * 1000);
    });
  }
  private async sample(generation: number) {
    const settings = structuredClone(this.store.settings);
    const startedAt = new Date();
    const captured = this.backend.captureMany ? await this.backend.captureMany(settings, () => generation === this.generation && this.state === 'recording') : { frames: [await this.backend.capture(settings)].filter((f): f is CapturedScreen => !!f), skippedDisplayIDs: [], unavailableDisplayIDs: [] };
    if (generation !== this.generation || this.state !== 'recording') return;
    for (const id of [...captured.skippedDisplayIDs, ...captured.unavailableDisplayIDs]) this.previous.delete(id);
    if (!captured.frames.length) {
      await this.store.prune();
      this.message = captured.unavailableDisplayIDs.length ? `所选显示器未连接（${captured.unavailableDisplayIDs.join('、')}），等待重新连接` : '当前应用已排除，本次未记录';
      this.previous.clear(); return;
    }
    let saved = 0;
    for (const item of captured.frames) {
      if (generation !== this.generation || this.state !== 'recording') return;
      const hash = createHash('sha256').update(item.jpeg).update(JSON.stringify({appName: item.frame.appName, bundleID: item.frame.bundleID, displayID: item.frame.displayID, display: item.frame.display, context: item.frame.context ? {...item.frame.context, observedAt: undefined} : undefined})).digest('hex');
      if (hash === this.previous.get(item.frame.displayID)) continue;
      await this.store.add(item.frame, item.jpeg, item.capturedAt ? new Date(item.capturedAt) : startedAt);
      this.previous.set(item.frame.displayID, hash); saved++;
    }
    await this.store.prune();
    const partial = captured.unavailableDisplayIDs.length ? ` · 显示器 ${captured.unavailableDisplayIDs.join('、')} 未连接` : '';
    this.message = (saved ? `正在记录屏幕${captured.frames.length > 1 ? ` · ${captured.frames.length} 个显示器逐屏采样` : ''}` : '正在记录 · 静止画面已跳过') + partial + (captured.skippedDisplayIDs.length ? ' · 部分显示器因排除规则跳过' : '');
  }
}
