import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { isUUID } from '../sessions/session-schema.js';

const LIMIT = 2 * 1024 * 1024;
export function canonicalJSON(value: unknown, depth = 0): string {
  if (depth > 64) throw new StorageError('invalid-context', '执行记录嵌套超过上限。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJSON(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  throw new StorageError('invalid-context', '执行记录必须为有限 JSON 值。');
}
export function canonicalDigest(value: unknown): string {
  const bytes = canonicalJSON(value);
  if (Buffer.byteLength(bytes) > LIMIT) throw new StorageError('too-large', '执行记录超过容量上限。');
  return createHash('sha256').update(bytes).digest('hex');
}
/** A deterministic identity enforces one record per immutable target, without an index file. */
export function executionRecordID(target: unknown): string {
  const hash = canonicalDigest(target);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function exactObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new StorageError('invalid-record', '执行记录对象无效。');
  const object = value as Record<string, unknown>;
  if (required.some(key => !(key in object)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) throw new StorageError('invalid-record', '执行记录字段无效。');
  return object;
}
export function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= max;
}
export function strictDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validateTaskTurnRef(value: unknown): void {
  const ref = exactObject(value, ['session', 'turnID']); const session = exactObject(ref.session, ['format', 'sessionID']);
  if (session.format !== 'task-v2' || !isUUID(session.sessionID) || !isUUID(ref.turnID)) throw new StorageError('invalid-reference', '任务轮次引用无效。');
}

/** New execution records only; no old task, session or approval contract is rewritten. */
export class ExecutionRecordStore<T extends { id: string }> {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string, folder: 'execution-approvals-v1' | 'execution-acceptances-v1' | 'execution-approvals-v2' | 'execution-acceptances-v2' | 'task-sessions-v3', private readonly validate: (value: unknown) => T) { this.directory = join(safeRoot(root), folder); }
  async load(id: string): Promise<T | undefined> {
    if (!isUUID(id)) throw new StorageError('invalid-id', '执行记录标识无效。');
    const bytes = await readBytes(join(this.directory, `${id}.json`), LIMIT);
    if (!bytes) return undefined;
    const record = this.decode(bytes); if (record.id !== id) throw new StorageError('invalid-record', '执行记录身份不一致。');
    return structuredClone(record);
  }
  async list(): Promise<T[]> {
    if (!await checkDirectories(this.directory)) return [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    if (entries.length > 2000) throw new StorageError('too-large', '执行记录数量超过上限。');
    const records: T[] = [];
    for (const entry of entries) {
      if (/^\..+\.tmp$/.test(entry.name) && entry.isFile()) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || !isUUID(entry.name.slice(0, -5))) throw new StorageError('unsafe-path', '执行记录目录结构无效。');
      const record = await this.load(entry.name.slice(0, -5)); if (!record) throw new StorageError('missing-file', '执行记录读取期间丢失。'); records.push(record);
    }
    return records;
  }
  update(id: string, operation: (current: T | undefined) => T): Promise<T> {
    const run = this.queue.then(() => withExclusiveLock(join(this.directory, '..', `.${this.directory.slice(this.directory.lastIndexOf('/') + 1)}.write.lock`), async () => {
      if (!isUUID(id)) throw new StorageError('invalid-id', '执行记录标识无效。');
      await checkDirectories(this.directory, true);
      const entries = await readdir(this.directory, { withFileTypes: true });
      if (entries.length > 2000) throw new StorageError('too-large', '执行记录数量超过上限。');
      for (const entry of entries) {
        if (/^\..+\.tmp$/.test(entry.name) && entry.isFile()) continue;
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || !isUUID(entry.name.slice(0, -5))) throw new StorageError('unsafe-path', '执行记录目录结构无效。');
      }
      const file = join(this.directory, `${id}.json`); const observed = await readBytes(file, LIMIT);
      if (!observed && entries.length >= 2000) throw new StorageError('too-large', '执行记录数量达到上限，未创建新记录。');
      const current = observed ? this.decode(observed) : undefined;
      if (current && current.id !== id) throw new StorageError('invalid-record', '执行记录身份不一致。');
      const record = this.validate(operation(current ? structuredClone(current) : undefined));
      if (record.id !== id) throw new StorageError('invalid-record', '执行记录身份不可变。');
      const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      if (observed && observed.equals(bytes)) return structuredClone(record);
      await atomicReplace(file, bytes, observed, LIMIT); return structuredClone(record);
    }));
    this.queue = run.catch(() => undefined); return run;
  }
  private decode(bytes: Buffer): T {
    try { return this.validate(JSON.parse(bytes.toString('utf8'))); }
    catch (error) { if (error instanceof StorageError) throw error; throw new StorageError('invalid-record', '执行记录无效或不受支持。'); }
  }
}
