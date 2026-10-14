import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentSessionListing, AgentSessionRecord } from '../shared/agent-chat.js';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { isUUID, SESSION_LIMITS } from './session-schema.js';
import { decodeAgentSession, validateAgentSession } from './agent-session-schema.js';

export interface AgentSessionHistoryStoring {
  load(id: string, options?: { observeRecord?: (record: AgentSessionRecord) => boolean }): Promise<AgentSessionRecord | undefined>;
  list(options?: { observeRecord?: (id: string) => boolean }): Promise<AgentSessionListing>;
  save(record: AgentSessionRecord, expectedRevision?: number): Promise<AgentSessionRecord>;
}

/** Flat, separate aggregates with byte CAS and one cooperating directory lock. */
export class AgentSessionHistoryStore implements AgentSessionHistoryStoring {
  readonly root: string;
  private readonly previewRoot: string;
  private readonly observed = new Map<string, Buffer>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(previewRoot: string) {
    this.previewRoot = safeRoot(previewRoot);
    this.root = join(this.previewRoot, 'agent-sessions-v1');
  }

  load(id: string, options?: { observeRecord?: (record: AgentSessionRecord) => boolean }): Promise<AgentSessionRecord | undefined> {
    return this.serial(async () => {
      if (!isUUID(id)) throw new StorageError('invalid-id', 'Agent 会话标识无效。');
      await this.entries();
      const record = await this.read(id.toLowerCase(), options?.observeRecord ?? (() => true));
      if (record) await this.checkOtherFormats(id);
      return record;
    });
  }

  list(options?: { observeRecord?: (id: string) => boolean }): Promise<AgentSessionListing> {
    return this.serial(async () => {
      const records: AgentSessionRecord[] = [];
      const diagnostics: AgentSessionListing['diagnostics'] = [];
      for (const entry of await this.entries()) {
        if (entry.name.startsWith('.')) continue;
        try {
          const id = entry.name.slice(0, -5);
          await this.checkOtherFormats(id);
          const record = await this.read(id, () => options?.observeRecord?.(id) ?? true);
          if (record) records.push(record);
        } catch (error) {
          diagnostics.push({ filename: entry.name, reason: error instanceof StorageError ? error.message : 'Agent 会话读取失败。' });
        }
      }
      records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { records, diagnostics };
    });
  }

  save(record: AgentSessionRecord, expectedRevision?: number): Promise<AgentSessionRecord> {
    return this.serial(async () => {
      validateAgentSession(record);
      return withExclusiveLock(join(this.previewRoot, '.agent-sessions-v1.write.lock'), async () => {
        await checkDirectories(this.root, true);
        const entries = await this.entries();
        const id = record.conversation_id.toLowerCase();
        await this.checkOtherFormats(id);
        const current = await this.read(id, () => false);
        const previous = this.observed.get(id);
        if (current) {
          if (!previous || expectedRevision !== current.revision || record.revision !== current.revision) throw new StorageError('revision-changed', 'Agent 会话修订冲突，原文件未覆盖。');
          this.assertFrozen(current, record);
        } else {
          if (previous || expectedRevision !== undefined || record.revision !== 0) throw new StorageError('missing-file', 'Agent 会话丢失，未重新创建。');
          if (entries.filter(entry => !entry.name.startsWith('.')).length >= SESSION_LIMITS.sessions) throw new StorageError('too-large', 'Agent 会话数量达到上限。');
        }
        if (record.revision >= Number.MAX_SAFE_INTEGER) throw new StorageError('too-large', 'Agent 会话修订达到上限。');
        const saved = structuredClone(record);
        saved.revision += 1;
        validateAgentSession(saved, true);
        const bytes = Buffer.from(`${JSON.stringify(saved, null, 2)}\n`);
        await atomicReplace(join(this.root, `${id}.json`), bytes, current ? previous : undefined, SESSION_LIMITS.fileBytes);
        this.observed.set(id, bytes);
        return saved;
      });
    });
  }

  private assertFrozen(current: AgentSessionRecord, next: AgentSessionRecord): void {
    if (current.conversation_id !== next.conversation_id || current.created_at !== next.created_at || !isDeepStrictEqual(current.scope, next.scope) || !isDeepStrictEqual(current.source, next.source) || current.binding && !isDeepStrictEqual(current.binding, next.binding)) throw new StorageError('scope-changed', 'Agent 会话来源、范围和原生绑定不可改写。');
    for (const old of current.turns) {
      const turn = next.turns.find(value => value.turn_id === old.turn_id);
      const input = current.messages.find(value => value.turn_id === old.turn_id && value.role === 'user');
      const nextInput = next.messages.find(value => value.turn_id === old.turn_id && value.role === 'user');
      if (!turn || turn.client_request_id !== old.client_request_id || turn.created_at !== old.created_at || !isDeepStrictEqual(turn.requested_model, old.requested_model) || !isDeepStrictEqual(input, nextInput)) throw new StorageError('scope-changed', 'Agent 轮次的冻结输入不可改写。');
      if (['finished', 'failed', 'cancelled', 'unknown'].includes(old.state) && !isDeepStrictEqual(old, turn)) throw new StorageError('scope-changed', '已收口的 Agent 轮次不可改写。');
      const assistant = current.messages.find(value => value.turn_id === old.turn_id && value.role === 'assistant')!;
      const nextAssistant = next.messages.find(value => value.turn_id === old.turn_id && value.role === 'assistant')!;
      if (assistant.message_id !== nextAssistant.message_id || assistant.created_at !== nextAssistant.created_at || !nextAssistant.text.startsWith(assistant.text) || ['finished', 'failed', 'cancelled', 'unknown'].includes(old.state) && !isDeepStrictEqual(assistant, nextAssistant)) throw new StorageError('scope-changed', '已记录的 Agent 回复不可替换。');
    }
  }

  private async entries() {
    if (!await checkDirectories(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > SESSION_LIMITS.entries) throw new StorageError('too-large', 'Agent 会话目录超过容量上限。');
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile() && /^\.[a-f0-9-]+\.json\.[a-f0-9-]+\.tmp$/.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9-]+\.json$/.test(entry.name) || !isUUID(entry.name.slice(0, -5))) throw new StorageError('unsafe-path', 'Agent 会话目录含未知条目，未读写记录。');
      const bytes = await readBytes(join(this.root, entry.name), SESSION_LIMITS.fileBytes);
      let identity: unknown;
      try { identity = bytes && JSON.parse(bytes.toString('utf8')); } catch { throw new StorageError('incomplete-scan', 'Agent 会话记录身份无法确认。'); }
      if (!identity || typeof identity !== 'object' || (identity as Record<string, unknown>).conversation_id !== entry.name.slice(0, -5)) throw new StorageError('duplicate-session', 'Agent 会话文件与声明身份不一致，未选择或覆盖。');
      count += 1;
    }
    if (count > SESSION_LIMITS.sessions) throw new StorageError('too-large', 'Agent 会话数量超过上限。');
    return entries;
  }

  private async read(id: string, observe: (record: AgentSessionRecord) => boolean): Promise<AgentSessionRecord | undefined> {
    const bytes = await readBytes(join(this.root, `${id}.json`), SESSION_LIMITS.fileBytes);
    if (!bytes) {
      if (this.observed.has(id)) throw new StorageError('missing-file', 'Agent 会话丢失，未重新创建。');
      return undefined;
    }
    const record = decodeAgentSession(bytes);
    if (record.conversation_id.toLowerCase() !== id) throw new StorageError('invalid-id', 'Agent 文件与会话身份不一致。');
    if (observe(record)) this.observed.set(id, bytes);
    return record;
  }

  private async checkOtherFormats(id: string): Promise<void> {
    let entries = 0;
    const scan = async (directory: string, depth: number): Promise<void> => {
      if (!await checkDirectories(directory)) return;
      if (depth > 3) throw new StorageError('incomplete-scan', '会话身份扫描不完整。');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > SESSION_LIMITS.entries) throw new StorageError('incomplete-scan', '会话身份扫描超过上限。');
        if (entry.isSymbolicLink()) throw new StorageError('unsafe-path', '会话身份扫描包含符号链接。');
        if (entry.name.toLowerCase() === `${id.toLowerCase()}.json`) throw new StorageError('duplicate-session', '不同格式声明相同会话身份，未选择或覆盖。');
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await scan(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          const bytes = await readBytes(file, SESSION_LIMITS.fileBytes);
          let identity: unknown;
          try { identity = bytes && JSON.parse(bytes.toString('utf8')); } catch { throw new StorageError('incomplete-scan', '其他格式含无法确认身份的记录。'); }
          if (!identity || typeof identity !== 'object' || !isUUID((identity as Record<string, unknown>).conversation_id)) throw new StorageError('incomplete-scan', '其他格式含无法确认身份的记录。');
          if ((identity as { conversation_id: string }).conversation_id.toLowerCase() === id.toLowerCase()) throw new StorageError('duplicate-session', '不同格式声明相同会话身份，未选择或覆盖。');
        } else if (!entry.isFile()) throw new StorageError('unsafe-path', '会话身份扫描包含异常条目。');
      }
    };
    await scan(join(this.previewRoot, 'sessions'), 0);
    await scan(join(this.previewRoot, 'task-sessions-v2'), 0);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
