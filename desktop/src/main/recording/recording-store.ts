import { validFrameMetadata, frameSearchText } from './frame-metadata.js';
import path from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError } from '../../core/storage/private-storage.js';
import type { ScreenFrame, ScreenPage, ScreenQuery, ScreenRecordingSettings } from '../../shared/screen-recording.js';

export const defaultRecordingSettings: ScreenRecordingSettings = { intervalSeconds: 10, retentionDays: 7, maxStorageMB: 1024, displayID: null, excludedApps: ['com.apple.keychainaccess', 'com.1password.1password', 'com.agilebits.onepassword7', 'com.bitwarden.desktop'] };
const idPattern = /^\d{13}-[0-9a-f-]{36}$/;
export function validateFrameID(id: unknown): string {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new StorageError('recording-input', '屏幕记录标识无效。');
  return id;
}
export function validateRecordingSettings(value: unknown): ScreenRecordingSettings {
  const v = value as ScreenRecordingSettings;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['displayID','displayIDs','excludedApps','intervalSeconds','maxStorageMB','retentionDays'].includes(k)) || !Number.isInteger(v.intervalSeconds) || v.intervalSeconds < 5 || v.intervalSeconds > 300 || !Number.isInteger(v.retentionDays) || v.retentionDays < 1 || v.retentionDays > 90 || !Number.isInteger(v.maxStorageMB) || v.maxStorageMB < 32 || v.maxStorageMB > 10240 || v.displayID !== null && (!Number.isInteger(v.displayID) || v.displayID <= 0) || v.displayIDs !== undefined && (!Array.isArray(v.displayIDs) || !v.displayIDs.length || v.displayIDs.length > 8 || new Set(v.displayIDs).size !== v.displayIDs.length || v.displayIDs.some(id => !Number.isSafeInteger(id) || id <= 0)) || !Array.isArray(v.excludedApps) || v.excludedApps.length > 100 || v.excludedApps.some(s => typeof s !== 'string' || !s.trim() || s.length > 200)) throw new StorageError('recording-input', '采集设置无效：间隔 5–300 秒，保留 1–90 天，容量 32–10240 MB，指定显示器需 1–8 个不重复的有效 ID。');
  return { ...v, ...(v.displayIDs ? { displayIDs: [...v.displayIDs] } : {}), excludedApps: [...new Set(v.excludedApps.map(s => s.trim()))] };
}
export function validateScreenQuery(value: unknown): ScreenQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['query', 'app', 'day', 'offset'].includes(k))) throw new StorageError('recording-input', '查询条件无效。');
  const v = value as ScreenQuery;
  if (v.query !== undefined && (typeof v.query !== 'string' || v.query.length > 200) || v.app !== undefined && (typeof v.app !== 'string' || v.app.length > 200) || v.day !== undefined && (typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || !Number.isFinite(Date.parse(v.day))) || v.offset !== undefined && (!Number.isInteger(v.offset) || v.offset < 0 || v.offset > 20000)) throw new StorageError('recording-input', '查询条件无效。');
  return v;
}

/** Main-process owned records. Images never enter the renderer until one is explicitly opened. */
export class RecordingStore {
  readonly root: string;
  private readonly added = new Set<(id: string) => void>();
  onAdded(listener: (id: string) => void) { this.added.add(listener); return () => this.added.delete(listener); }
  private readonly removed = new Set<(id: string) => void>();
  onRemoved(listener: (id: string) => void) { this.removed.add(listener); return () => this.removed.delete(listener); }
  private frames = new Map<string, ScreenFrame>();
  private settingsBytes?: Buffer;
  private operationTail: Promise<void> = Promise.resolve();
  /** One main-owned queue orders destructive maintenance and context commits. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => {}, () => {});
    return result;
  }
  /** Sources remain indexed until operation settles. Trusted callback must not await
   * another mutation/lease on this store; it may resolve metadata and commit a plan.
   * Protects this process's store operations, not external filesystem edits. */
  async withContextSources<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 32) throw new StorageError('recording-input', '请选择 1–32 条屏幕来源。');
    const keys = ids.map(validateFrameID);
    if (new Set(keys).size !== keys.length) throw new StorageError('recording-input', '屏幕来源不能重复。');
    return this.enqueue(async () => {
      if (keys.some(id => !this.frames.has(id))) throw new StorageError('recording-missing', '屏幕来源已删除或过期，请重新选择。');
      return operation();
    });
  }
  settings = structuredClone(defaultRecordingSettings);
  constructor(root: string) { this.root = safeRoot(path.join(root, 'screen-recordings')); }
  private file(id: string, ext: string) { return path.join(this.root, `${validateFrameID(id)}.${ext}`); }
  async initialize() {
    await checkDirectories(this.root, true);
    this.settingsBytes = await readBytes(path.join(this.root, 'settings.json'), 32000);
    if (this.settingsBytes) this.settings = validateRecordingSettings(JSON.parse(this.settingsBytes.toString()));
    const files = (await readdir(this.root)).filter(s => s.endsWith('.json') && idPattern.test(s.slice(0, -5))).sort();
    if (files.length > 20000) throw new StorageError('recording-limit', '屏幕记录超过索引上限，请先备份并整理记录目录。');
    for (const file of files) {
      const bytes = await readBytes(path.join(this.root, file), 160000);
      if (!bytes) continue;
      const f = JSON.parse(bytes.toString()) as ScreenFrame;
      if (f.id !== file.slice(0, -5) || typeof f.timestamp !== 'string' || !Number.isFinite(Date.parse(f.timestamp)) || typeof f.appName !== 'string' || f.appName.length > 200 || typeof f.bundleID !== 'string' || typeof f.text !== 'string' || f.text.length > 24000 || !Number.isInteger(f.bytes) || f.bytes < 1 || f.bytes > 8 * 1024 * 1024 || !Number.isInteger(f.width) || !Number.isInteger(f.height) || !Number.isInteger(f.displayID) || !validFrameMetadata(f)) throw new StorageError('recording-data', '屏幕索引损坏，原记录未覆盖。');
      this.frames.set(f.id, f);
    }
    // A crash between image and index commits can leave a private orphan; reclaim only owned names.
    for (const file of await readdir(this.root)) if (file.endsWith('.jpg') && idPattern.test(file.slice(0, -4)) && !this.frames.has(file.slice(0, -4))) await unlink(path.join(this.root, file));
    await this.prune();
  }
  async saveSettings(input: unknown) {
    const validated = validateRecordingSettings(input);
    return this.enqueue(() => this.saveSettingsUnlocked(validated));
  }
  private async saveSettingsUnlocked(input: unknown) {
    const settings = validateRecordingSettings(input);
    const bytes = Buffer.from(JSON.stringify(settings));
    await atomicReplace(path.join(this.root, 'settings.json'), bytes, this.settingsBytes, 32000);
    this.settingsBytes = bytes; this.settings = settings;
    await this.pruneUnlocked();
  }
  /** Bounded metadata snapshot for main-process projections; never return this whole index over IPC. */
  listFrames(): ScreenFrame[] { return [...this.frames.values()].map(f => structuredClone(f)); }
  getFrame(id: string): ScreenFrame | undefined { const f = this.frames.get(validateFrameID(id)); return f ? structuredClone(f) : undefined; }
  stats() { const all = [...this.frames.values()]; return { frameCount: all.length, storageBytes: all.reduce((sum, f) => sum + f.bytes, 0), lastCapturedAt: all.sort((a,b) => b.timestamp.localeCompare(a.timestamp))[0]?.timestamp }; }
  async add(frame: Omit<ScreenFrame, 'id' | 'timestamp' | 'bytes'>, jpeg: Buffer, now = new Date()): Promise<ScreenFrame> {
    if (!validFrameMetadata(frame)) throw new StorageError('recording-data', '屏幕来源元数据无效。');
    const snapshot = structuredClone(frame), image = Buffer.from(jpeg), capturedAt = new Date(now);
    return this.enqueue(() => this.addUnlocked(snapshot, image, capturedAt));
  }
  private async addUnlocked(frame: Omit<ScreenFrame, 'id' | 'timestamp' | 'bytes'>, jpeg: Buffer, now: Date): Promise<ScreenFrame> {
    const id = `${now.getTime()}-${randomUUID()}`;
    const record: ScreenFrame = { ...frame, id, timestamp: now.toISOString(), bytes: jpeg.length };
    if (this.frames.size >= 20000) await this.deleteUnlocked([...this.frames.keys()].sort()[0]);
    await atomicReplace(this.file(id, 'jpg'), jpeg, undefined, 8 * 1024 * 1024);
    try { await atomicReplace(this.file(id, 'json'), Buffer.from(JSON.stringify(record)), undefined, 160000); }
    catch (error) { await unlink(this.file(id, 'jpg')); throw error; }
    this.frames.set(id, record); await this.pruneUnlocked(now); for (const listener of this.added) listener(id); return record;
  }
  search(input: unknown): ScreenPage {
    const v = validateScreenQuery(input); const needle = v.query?.trim().toLocaleLowerCase() ?? '';
    const all = [...this.frames.values()].sort((a,b) => b.id.localeCompare(a.id));
    const frames = all.filter(f => (!v.app || f.appName === v.app) && (!v.day || localDay(f.timestamp) === v.day) && (!needle || frameSearchText(f).toLocaleLowerCase().includes(needle)));
    return { frames: frames.slice(v.offset ?? 0, (v.offset ?? 0) + 50), total: frames.length, apps: [...new Set(all.map(f => f.appName))].sort() };
  }
  async image(id: unknown) {
    const key = validateFrameID(id);
    if (!this.frames.has(key)) throw new StorageError('recording-missing', '这条屏幕记录已删除或过期。');
    const bytes = await readBytes(this.file(key, 'jpg'), 8 * 1024 * 1024);
    if (!bytes) throw new StorageError('recording-missing', '截图文件不存在。');
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }
  async delete(id: unknown) {
    const key = validateFrameID(id);
    return this.enqueue(() => this.deleteUnlocked(key));
  }
  private async deleteUnlocked(key: string) {
    if (!this.frames.has(key)) return;
    // Remove the index first so a partially failed deletion never serves a missing image.
    try { await unlink(this.file(key, 'json')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    this.frames.delete(key);
    for (const listener of this.removed) listener(key);
    try { await unlink(this.file(key, 'jpg')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async clear() { return this.enqueue(async () => { for (const id of [...this.frames.keys()]) await this.deleteUnlocked(id); }); }
  async prune(now = new Date()) {
    const snapshot = new Date(now);
    return this.enqueue(() => this.pruneUnlocked(snapshot));
  }
  private async pruneUnlocked(now = new Date()) {
    const cutoff = now.getTime() - this.settings.retentionDays * 86400000;
    let bytes = this.stats().storageBytes;
    for (const f of [...this.frames.values()].sort((a,b) => a.id.localeCompare(b.id))) {
      if (Date.parse(f.timestamp) >= cutoff && bytes <= this.settings.maxStorageMB * 1024 * 1024) break;
      await this.deleteUnlocked(f.id); bytes -= f.bytes;
    }
  }
}
function localDay(timestamp: string) { const d = new Date(timestamp); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
