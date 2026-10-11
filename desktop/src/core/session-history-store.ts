import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { SessionListing, SessionRecord } from '../shared/types.js';
import { atomicReplace, checkDirectories, isMissing, readBytes, safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { decodeSession, isUUID, SESSION_LIMITS, validateSession } from './session-schema.js';

export interface SessionHistoryStoring {
  load(sessionID: string, options?: { observeRecord?: (record: SessionRecord) => boolean }): Promise<SessionRecord | undefined>;
  list(options?: { observeRecord?: (sessionID: string) => boolean }): Promise<SessionListing>;
  save(session: SessionRecord, expectedRevision?: number): Promise<SessionRecord>;
}
interface Observation { bytes: Buffer; file: string }
interface Scan {
  files: Map<string, string[]>;
  candidates: string[];
  diagnostics: SessionListing['diagnostics'];
  unclassified: boolean;
  entries: number;
  directories: number;
}
const canonical = (value: unknown): string => JSON.stringify(value, Object.keys(value as object).sort());
const recordPath = (root: string, record: SessionRecord): string => join(root, ...record.created_at.slice(0, 10).split('-'), `${record.conversation_id.toLowerCase()}.json`);
const reason = (error: unknown) => error instanceof StorageError ? error.message : '记录读取失败，原文件未覆盖。';

/** One aggregate per session, with bounded scans, byte CAS, and cooperating O_EXCL locks. */
export class SessionHistoryStore implements SessionHistoryStoring {
  readonly root: string;
  private readonly observed = new Map<string, Observation>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.root = safeRoot(root); }

  load(sessionID: string, options?: { observeRecord?: (record: SessionRecord) => boolean }): Promise<SessionRecord | undefined> {
    return this.serial(async () => {
      if (!isUUID(sessionID)) throw new StorageError('invalid-id', '会话标识无效。');
      const id = sessionID.toLowerCase(); const index = await this.scan(); const candidates = index.files.get(id);
      if (!candidates) {
        if (this.observed.has(id)) throw new StorageError('missing-file', '已读取的记录丢失或移动，未重新创建。');
        if (index.unclassified) throw new StorageError('incomplete-scan', '历史含无法识别的记录，不能确认会话不存在。');
        return undefined;
      }
      return (await this.read(id, candidates, options?.observeRecord ?? true)).record;
    });
  }

  list(options?: { observeRecord?: (sessionID: string) => boolean }): Promise<SessionListing> {
    return this.serial(async () => {
      const index = await this.scan(); const records: SessionRecord[] = []; const diagnostics = [...index.diagnostics];
      for (const [id, files] of index.files) {
        try { records.push((await this.read(id, files, options?.observeRecord ? record => options.observeRecord!(record.conversation_id) : true)).record); }
        catch (error) { for (const file of files) diagnostics.push({ filename: relative(this.root, file), reason: reason(error) }); }
      }
      records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { records, diagnostics };
    });
  }

  save(session: SessionRecord, expectedRevision?: number): Promise<SessionRecord> {
    return this.serial(async () => {
      validateSession(session);
      const id = session.conversation_id.toLowerCase();
      // The library lock prevents concurrent creation of one ID in different date buckets.
      const libraryLock = join(dirname(this.root), `.${basename(this.root)}.write.lock`);
      return withExclusiveLock(libraryLock, async () => {
        const index = await this.scan(); const candidates = index.files.get(id);
        let file = recordPath(this.root, session); let previous: Buffer | undefined;
        if (candidates) {
          const existing = await this.read(id, candidates, false); const observation = this.observed.get(id);
          if (!observation) throw new StorageError('unobserved-record', '请先读取原记录，再保存修改。');
          if (!observation.bytes.equals(existing.bytes)) throw new StorageError('revision-changed', '记录已由其他写入者修改，原文件未覆盖。');
          if (existing.record.created_at !== session.created_at) throw new StorageError('creation-date-changed', '会话创建时间不可更改。');
          if (canonical(existing.record.scope) !== canonical(session.scope)) throw new StorageError('scope-changed', '会话范围不可更改。');
          if (expectedRevision === undefined || expectedRevision !== existing.record.revision || session.revision !== expectedRevision) throw new StorageError('revision-changed', '记录修订冲突，原文件未覆盖。');
          file = candidates[0]!; previous = existing.bytes;
        } else {
          if (this.observed.has(id) || expectedRevision !== undefined) throw new StorageError('missing-file', '原记录丢失或移动，未重新创建。');
          if (session.revision !== 0) throw new StorageError('revision-changed', '新记录修订必须为零。');
          if (index.unclassified) throw new StorageError('incomplete-scan', '历史含无法识别的记录，未创建新记录。');
          if (index.candidates.length >= SESSION_LIMITS.sessions) throw new StorageError('too-large', '会话数量超过上限。');
        }
        if (session.revision >= Number.MAX_SAFE_INTEGER) throw new StorageError('invalid-record', '记录修订超过上限。');
        const updated = structuredClone(session); updated.revision += 1;
        const bytes = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`);
        if (bytes.length > SESSION_LIMITS.fileBytes) throw new StorageError('too-large', '聊天记录超过容量上限。');
        const persisted = decodeSession(bytes);
        let additionalDirectories = 0;
        let directory = this.root;
        if (!(await checkDirectories(directory))) additionalDirectories += 1;
        for (const part of relative(this.root, dirname(file)).split('/')) { directory = join(directory, part); if (!(await checkDirectories(directory))) additionalDirectories += 1; }
        if (index.directories + additionalDirectories > SESSION_LIMITS.directories || index.entries + additionalDirectories + (previous ? 0 : 1) + 2 > SESSION_LIMITS.entries) throw new StorageError('too-large', '会话目录容量不足。');
        await withExclusiveLock(join(dirname(file), `.${basename(file)}.lock`), () => atomicReplace(file, bytes, previous, SESSION_LIMITS.fileBytes));
        this.observed.set(id, { bytes, file });
        return persisted;
      });
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation); this.queue = result.catch(() => undefined); return result;
  }

  private async scan(): Promise<Scan> {
    for (const legacy of [join(this.root, 'history'), join(dirname(this.root), 'conversations', 'history')]) {
      try { await lstat(legacy); throw new StorageError('migration-required', '发现旧会话目录，需明确迁移后再读写。'); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    const result: Scan = { files: new Map(), candidates: [], diagnostics: [], unclassified: false, entries: 0, directories: 0 };
    if (!(await checkDirectories(this.root))) return result;
    const claim = (id: string, file: string) => { const files = result.files.get(id) ?? []; if (!files.includes(file)) files.push(file); result.files.set(id, files); };
    const walk = async (directory: string, parts: string[]): Promise<void> => {
      result.directories += 1;
      if (result.directories > SESSION_LIMITS.directories) throw new StorageError('too-large', '会话目录数量超过上限。');
      let children;
      try { children = await readdir(directory, { withFileTypes: true }); }
      catch { throw new StorageError('incomplete-scan', '会话目录扫描未完成。'); }
      result.entries += children.length;
      if (result.entries > SESSION_LIMITS.entries) throw new StorageError('too-large', '会话目录条目超过上限。');
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(directory, child.name);
        if (child.name === '.DS_Store' && child.isFile()) continue;
        if (parts.length < 3) {
          if (parts.length === 0 && child.name.endsWith('.json')) throw new StorageError('migration-required', '发现旧平铺会话目录，需明确迁移。');
          const valid = parts.length === 0 ? /^(?:19[7-9]\d|[2-9]\d{3})$/.test(child.name) : parts.length === 1 ? /^(?:0[1-9]|1[0-2])$/.test(child.name) : /^\d\d$/.test(child.name) && validBucket([...parts, child.name]);
          if (!valid || !child.isDirectory() || child.isSymbolicLink()) throw new StorageError('incomplete-scan', '会话日期目录结构无效或包含符号链接。');
          await checkDirectories(file); await walk(file, [...parts, child.name]);
        } else {
          if (/^\..+\.json(?:\.lock|\.[\da-f-]{36}\.tmp)$/.test(child.name)) {
            if (!child.isFile() || child.isSymbolicLink()) throw new StorageError('unsafe-path', '会话锁或临时文件类型异常。');
            continue;
          }
          if (!child.name.endsWith('.json')) throw new StorageError('incomplete-scan', '会话日期目录包含未知文件。');
          result.candidates.push(file);
          if (result.candidates.length > SESSION_LIMITS.sessions) throw new StorageError('too-large', '会话数量超过上限。');
          const stem = child.name.slice(0, -5);
          if (isUUID(stem)) claim(stem.toLowerCase(), file);
          else { result.unclassified = true; result.diagnostics.push({ filename: relative(this.root, file), reason: '会话文件名无效。' }); }
          try {
            const bytes = await readBytes(file, SESSION_LIMITS.fileBytes);
            if (!bytes) throw new StorageError('missing-file', '扫描期间记录丢失。');
            try { const identity = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; if (isUUID(identity?.conversation_id)) claim(identity.conversation_id.toLowerCase(), file); } catch { /* Decode below reports malformed JSON. */ }
            decodeSession(bytes);
          } catch (error) { result.unclassified = true; if (!isUUID(stem)) result.diagnostics.push({ filename: relative(this.root, file), reason: reason(error) }); }
        }
      }
    };
    await walk(this.root, []);
    return result;
  }

  private async read(id: string, files: string[], observe: boolean | ((record: SessionRecord) => boolean)): Promise<{ record: SessionRecord; bytes: Buffer }> {
    if (files.length !== 1) throw new StorageError('duplicate-session', '多个文件声明同一会话，未选择或覆盖。');
    const file = files[0]!; const observation = this.observed.get(id);
    if (observation && observation.file !== file) throw new StorageError('missing-file', '已读会话被移动，未重新创建。');
    const bytes = await readBytes(file, SESSION_LIMITS.fileBytes);
    if (!bytes) throw new StorageError('missing-file', '会话记录丢失，未重新创建。');
    const record = decodeSession(bytes);
    if (record.conversation_id.toLowerCase() !== id || recordPath(this.root, record) !== file) throw new StorageError('invalid-date-path', '会话文件名、日期与正文不一致。');
    if (typeof observe === 'function' ? observe(structuredClone(record)) : observe) this.observed.set(id, { bytes, file });
    return { record, bytes };
  }
}

function validBucket(parts: string[]): boolean {
  const date = `${parts.join('-')}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date;
}
