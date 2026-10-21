import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryDiagnostic } from '../../shared/types.js';
import type { TaskSessionRecord } from '../../shared/task-execution.js';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../storage/private-storage.js';
import { isUUID, SESSION_LIMITS } from './session-schema.js';
import { canonicalTask, decodeTaskSession, validateTaskSession } from './task-session-schema.js';

export interface TaskSessionHistoryStoring {
  load(id: string, options?: { observeRecord?: (record: TaskSessionRecord) => boolean }): Promise<TaskSessionRecord | undefined>;
  list(options?: { observeRecord?: (id: string) => boolean }): Promise<{ records: TaskSessionRecord[]; diagnostics: HistoryDiagnostic[] }>;
  save(record: TaskSessionRecord, expectedRevision?: number): Promise<TaskSessionRecord>;
}
/** New format only. No copies, migration, or writes to the existing sessions directory. */
export class TaskSessionHistoryStore implements TaskSessionHistoryStoring {
  readonly root: string;
  private readonly previewRoot: string;
  private readonly observed = new Map<string, Buffer>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(previewRoot: string) { this.previewRoot = safeRoot(previewRoot); this.root = join(this.previewRoot, 'task-sessions-v2'); }
  load(id: string, options?: { observeRecord?: (record: TaskSessionRecord) => boolean }): Promise<TaskSessionRecord | undefined> {
    return this.serial(async () => { if (!isUUID(id)) throw new StorageError('invalid-id', '任务会话标识无效。'); const record = await this.read(id, options?.observeRecord ?? (() => true)); if (record) await this.checkChatConflict(id); return record; });
  }
  list(options?: { observeRecord?: (id: string) => boolean }): Promise<{ records: TaskSessionRecord[]; diagnostics: HistoryDiagnostic[] }> {
    return this.serial(async () => {
      if (!await checkDirectories(this.root)) return { records: [], diagnostics: [] };
      const entries = await readdir(this.root, { withFileTypes: true }); if (entries.length > 2000) throw new StorageError('too-large', '任务会话数量超过上限。');
      const records: TaskSessionRecord[] = []; const diagnostics: HistoryDiagnostic[] = [];
      for (const entry of entries) {
        if (/^\..+\.(?:tmp|lock)$/.test(entry.name) && entry.isFile()) continue;
        try {
          const id = entry.name.slice(0, -5); if (!entry.name.endsWith('.json') || !isUUID(id) || !entry.isFile() || entry.isSymbolicLink()) throw new StorageError('unsafe-path', '任务会话目录含未知记录。');
          await this.checkChatConflict(id); const record = await this.read(id, () => options?.observeRecord?.(id) ?? true); if (record) records.push(record);
        } catch (error) { diagnostics.push({ filename: entry.name, reason: error instanceof StorageError ? error.message : '任务会话读取失败。' }); }
      }
      return { records, diagnostics };
    });
  }
  save(record: TaskSessionRecord, expectedRevision?: number): Promise<TaskSessionRecord> {
    return this.serial(async () => {
      validateTaskSession(record); await this.checkChatConflict(record.conversation_id);
      return withExclusiveLock(join(this.previewRoot, '.task-sessions-v2.write.lock'), async () => {
        await checkDirectories(this.root, true);
        const entries = await readdir(this.root, { withFileTypes: true });
        if (entries.length > 2000) throw new StorageError('too-large', '任务会话数量超过上限。');
        for (const entry of entries) {
          if (/^\..+\.(?:tmp|lock)$/.test(entry.name) && entry.isFile()) continue;
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || !isUUID(entry.name.slice(0, -5))) throw new StorageError('unsafe-path', '任务会话目录含未知记录。');
        }
        if (!entries.some(entry => entry.name === `${record.conversation_id}.json`) && entries.length >= 2000) throw new StorageError('too-large', '任务会话数量达到上限，未创建新记录。');
        const current = await this.read(record.conversation_id, () => false); const expected = this.observed.get(record.conversation_id);
        if (current) {
          if (!expected || expectedRevision !== current.revision || record.revision !== current.revision) throw new StorageError('revision-changed', '任务会话修订冲突。');
          if (current.created_at !== record.created_at || canonicalTask(current.scope) !== canonicalTask(record.scope)) throw new StorageError('scope-changed', '任务会话身份和范围不可更改。');
          for (const old of current.turns) {
            const next = record.turns.find(turn => turn.turn_id === old.turn_id); const input = current.messages.find(message => message.message_id === old.execution.spec.inputMessageID);
            const nextInput = record.messages.find(message => message.message_id === old.execution.spec.inputMessageID);
            if (!next || old.client_request_id !== next.client_request_id || canonicalTask(old.execution.spec) !== canonicalTask(next.execution.spec) || canonicalTask(old.requested_model) !== canonicalTask(next.requested_model) || canonicalTask(input) !== canonicalTask(nextInput)) throw new StorageError('scope-changed', '冻结的尝试与输入不可改写。');
          }
        } else if (this.observed.has(record.conversation_id) || expectedRevision !== undefined || record.revision !== 0) throw new StorageError('missing-file', '任务会话丢失，未重新创建。');
        const saved = structuredClone(record); saved.revision += 1; validateTaskSession(saved, true);
        const bytes = Buffer.from(`${JSON.stringify(saved, null, 2)}\n`);
        await atomicReplace(join(this.root, `${record.conversation_id}.json`), bytes, current ? expected : undefined, SESSION_LIMITS.fileBytes);
        this.observed.set(record.conversation_id, bytes); return saved;
      });
    });
  }
  private async read(id: string, observe: (record: TaskSessionRecord) => boolean): Promise<TaskSessionRecord | undefined> {
    const bytes = await readBytes(join(this.root, `${id}.json`), SESSION_LIMITS.fileBytes);
    if (!bytes) { if (this.observed.has(id)) throw new StorageError('missing-file', '任务会话丢失，未重新创建。'); return undefined; }
    const record = decodeTaskSession(bytes); if (record.conversation_id !== id) throw new StorageError('invalid-id', '文件与任务会话身份不一致。');
    if (observe(record)) this.observed.set(id, bytes); return record;
  }
  private async checkChatConflict(id: string): Promise<void> {
    const root = join(this.previewRoot, 'sessions'); if (!await checkDirectories(root)) return;
    let count = 0;
    const scan = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > SESSION_LIMITS.entries || depth > 3) throw new StorageError('incomplete-scan', '聊天身份扫描不完整。');
        if (entry.name.toLowerCase() === `${id.toLowerCase()}.json`) throw new StorageError('duplicate-session', '两个格式声明相同会话身份。');
        if (entry.isDirectory()) { await checkDirectories(join(directory, entry.name)); await scan(join(directory, entry.name), depth + 1); }
        else if (entry.isSymbolicLink()) throw new StorageError('unsafe-path', '聊天身份扫描包含符号链接。');
      }
    }; await scan(root, 0);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation, operation); this.queue = result.catch(() => undefined); return result; }
}
