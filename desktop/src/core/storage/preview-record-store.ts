import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { isUUID } from '../sessions/session-schema.js';

const LIMIT = 2 * 1024 * 1024;
/** Separate directories and explicit kind prevent these drafts being mistaken for task/run v1. */
export class PreviewRecordStore<T extends { id: string; kind: string; schema_version: number }> {
  private readonly observed = new Map<string, Buffer>();
  readonly directory: string;
  constructor(previewRoot: string, private readonly folder: 'preview-plans' | 'preview-approvals', private readonly validate: (value: unknown) => T) {
    this.directory = join(safeRoot(previewRoot), folder);
  }
  async load(id: string): Promise<T | undefined> {
    if (!isUUID(id)) throw new StorageError('invalid-id', '草案标识无效。');
    const bytes = await readBytes(join(this.directory, `${id}.json`), LIMIT);
    if (!bytes) { if (this.observed.has(id)) throw new StorageError('missing-file', '已读取草案丢失，未重建。'); return undefined; }
    let record: T;
    try { record = this.validate(JSON.parse(bytes.toString('utf8'))); }
    catch { throw new StorageError('invalid-record', '预览草案无效或版本不受支持。'); }
    if (record.id !== id) throw new StorageError('invalid-record', '预览草案身份与文件名不一致。');
    this.observed.set(id, bytes); return structuredClone(record);
  }
  async list(): Promise<T[]> {
    if (!(await checkDirectories(this.directory))) return [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    if (entries.length > 2000) throw new StorageError('too-large', '预览草案数量超过上限。');
    const result: T[] = [];
    for (const entry of entries) {
      if (/^\..+\.tmp$/.test(entry.name) && entry.isFile()) continue;
      const id = entry.name.slice(0, -5);
      if (!entry.name.endsWith('.json') || !isUUID(id) || !entry.isFile() || entry.isSymbolicLink()) throw new StorageError('unsafe-path', '预览草案目录结构无效。');
      const value = await this.load(id); if (value) result.push(value);
    }
    return result;
  }
  async save(record: T, existing: boolean): Promise<T> {
    this.validate(record);
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    if (bytes.length > LIMIT) throw new StorageError('too-large', '预览草案超过容量上限。');
    const lock = join(this.directory, '..', `.${this.folder}.write.lock`);
    return withExclusiveLock(lock, async () => {
      const expected = this.observed.get(record.id);
      if (existing && !expected) throw new StorageError('unobserved-record', '请先读取预览草案。');
      if (!existing && expected) throw new StorageError('revision-changed', '草案已存在。');
      if (existing && this.folder === 'preview-plans') {
        const currentBytes = await readBytes(join(this.directory, `${record.id}.json`), LIMIT);
        if (!currentBytes) throw new StorageError('missing-file', '预览计划已丢失。');
        const current = this.validate(JSON.parse(currentBytes.toString('utf8'))) as T & { version: number };
        if ((record as T & { version: number }).version !== current.version + 1) throw new StorageError('revision-changed', '预览计划版本已变化，未覆盖。');
      }
      await atomicReplace(join(this.directory, `${record.id}.json`), bytes, existing ? expected : undefined, LIMIT);
      this.observed.set(record.id, bytes); return structuredClone(record);
    });
  }
}
