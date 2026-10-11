import { randomUUID } from 'node:crypto';
import type { SendMessageInput, SendResult, SessionEvent, SessionListing, SessionRecord, SessionScope, TurnRecord } from '../shared/types.js';
import { ExecutionError, type ExecutionDriver, type ExecutionEvent } from './execution-driver.js';
import { StorageError } from './private-storage.js';
import type { SessionHistoryStoring } from './session-history-store.js';
import { SESSION_LIMITS, validateModel } from './session-schema.js';

const terminal = new Set(['finished', 'failed', 'cancelled']);
const comparable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${comparable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
interface ActiveTurn {
  controller: AbortController;
  turnID: string;
  assistantID: string;
  attempted: boolean;
  completed: boolean;
  lastPersisted: number;
  done: Promise<void>;
  resolve: () => void;
}
export interface SessionManagerOptions {
  store: SessionHistoryStoring;
  driver: ExecutionDriver;
  now?: () => Date;
  persistIntervalMs?: number;
}

/** Owns local turn state. Drivers cannot authorize tools, edit plans, or own this history. */
export class SessionManager {
  private readonly cache = new Map<string, SessionRecord>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly pendingWrites = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly loading = new Map<string, Promise<SessionRecord | undefined>>();
  private closed = false;
  constructor(private readonly options: SessionManagerOptions) {}

  async createSession(title: string, scope?: SessionScope): Promise<SessionRecord> {
    this.ensureOpen();
    const id = randomUUID(); const now = this.now();
    const record: SessionRecord = { schema_version: 1, conversation_id: id, title: title.trim(), scope: scope ?? { kind: 'local_chat', local_chat_id: id }, created_at: now, updated_at: now, revision: 0, turns: [], messages: [] };
    const saved = await this.options.store.save(record);
    this.cache.set(id, saved); this.updated(saved); return structuredClone(saved);
  }

  async listSessions(): Promise<SessionListing> {
    this.ensureOpen();
    const listing = await this.options.store.list({ observeRecord: id => !this.active.has(id) && !this.pendingWrites.has(id) });
    const records: SessionRecord[] = [];
    for (const record of listing.records) {
      const id = record.conversation_id;
      if (this.active.has(id) || this.pendingWrites.has(id)) records.push(structuredClone(this.cache.get(id) ?? record));
      else records.push(structuredClone(await this.recover(record)));
    }
    records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { records, diagnostics: listing.diagnostics };
  }

  async loadSession(id: string): Promise<SessionRecord | undefined> {
    this.ensureOpen();
    if (this.active.has(id) || this.pendingWrites.has(id)) return structuredClone(this.cache.get(id));
    const loading = this.loading.get(id);
    if (loading) return structuredClone(await loading);
    const promise = this.options.store.load(id).then(async record => record ? this.recover(record) : undefined);
    this.loading.set(id, promise);
    try { return structuredClone(await promise); } finally { this.loading.delete(id); }
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    this.ensureOpen();
    const id = input.sessionID;
    if (this.active.has(id)) throw new StorageError('turn-active', '此会话已有活动轮次。');
    if (this.pendingWrites.has(id)) throw new StorageError('pending-write', '此会话有未保存的事实，请先重试本地保存。');
    if (!input.text.trim() || Buffer.byteLength(input.text) > SESSION_LIMITS.messageBytes) throw new StorageError('invalid-input', '消息为空或超过容量上限。');
    validateModel(input.model);
    if (!this.options.driver.capabilities.chat || this.options.driver.capabilities.tools) throw new StorageError('unsupported-driver', '此入口只支持无工具聊天。');
    let resolve!: () => void;
    const active: ActiveTurn = { controller: new AbortController(), turnID: randomUUID(), assistantID: randomUUID(), attempted: false, completed: false, lastPersisted: 0, done: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    this.active.set(id, active);
    let prepared = false;
    try {
      // Always pair the source with a fresh observation. A list operation may have
      // observed newer bytes before this turn became active, while the UI cache lagged.
      const loaded = await this.options.store.load(id);
      const source = loaded ? await this.recover(loaded, true) : undefined;
      if (!source) throw new StorageError('missing-session', '会话不存在。');
      if (source.turns.some(turn => !terminal.has(turn.state))) throw new StorageError('unresolved-turn', '此会话有结果未知的轮次；不会自动重发。');
      if (source.turns.length >= SESSION_LIMITS.turns || source.messages.length + 2 > SESSION_LIMITS.messages) throw new StorageError('too-large', '会话轮次或消息数量达到上限。');
      const session = structuredClone(source); const now = this.now();
      session.turns.push({ turn_id: active.turnID, client_request_id: randomUUID(), requested_model: structuredClone(input.model), state: 'prepared', created_at: now, updated_at: now, draft_revision: 0 });
      session.messages.push({ message_id: randomUUID(), turn_id: active.turnID, role: 'user', text: input.text, created_at: now, updated_at: now });
      session.messages.push({ message_id: active.assistantID, turn_id: active.turnID, role: 'assistant', text: '', created_at: now, updated_at: now });
      session.updated_at = now; this.cache.set(id, session);
      await this.persist(id); prepared = true;
      if (this.closed || active.controller.signal.aborted) {
        this.setTurn(id, active, 'cancelled', '已取消本地发送；本轮尚未提交。'); await this.persist(id);
        return this.result(id, 'notSubmitted');
      }
      this.setTurn(id, active, 'submitting'); await this.persist(id);
      // Persistence is the last awaited operation before the driver. Stop/shutdown during it prevents sending.
      if (this.closed || active.controller.signal.aborted) {
        this.setTurn(id, active, 'cancelled', '已取消本地发送；本轮尚未提交。'); await this.persist(id);
        return this.result(id, 'notSubmitted');
      }
      const current = this.record(id); const turn = this.turn(id, active);
      const finishedTurnIDs = new Set(current.turns.filter(value => value.state === 'finished').map(value => value.turn_id));
      const messages = current.messages.filter(message => finishedTurnIDs.has(message.turn_id) || message.turn_id === active.turnID && message.role === 'user').map(message => ({ role: message.role, content: message.text }));
      await this.options.driver.execute({ clientRequestID: turn.client_request_id, model: structuredClone(input.model), messages }, event => this.onExecutionEvent(id, active, event), active.controller.signal);
      if (!active.completed) throw new ExecutionError('incomplete', '执行器结束但未确认回复完成。', active.attempted);
      return this.result(id, 'accepted');
    } catch (error) {
      if (!this.cache.get(id)?.turns.some(turn => turn.turn_id === active.turnID)) throw error;
      const execution = error instanceof ExecutionError ? error : undefined;
      const attempted = active.attempted || execution?.attempted === true;
      if (this.pendingWrites.has(id)) {
        // Preserve completion facts if only the terminal write failed; do not roll them back.
        if (!active.completed) this.setTurn(id, active, attempted ? 'unknown' : 'failed', '本地记录未能保存；没有自动重发请求。');
        this.pendingWrites.set(id, structuredClone(this.record(id))); this.updated(this.record(id));
        return this.result(id, attempted ? 'uncertain' : 'notSubmitted', '本地记录保存失败；请重试保存，不会重发请求。');
      }
      let state: TurnRecord['state'];
      if (execution?.code === 'cancelled' || active.controller.signal.aborted || this.closed) state = 'cancelled';
      else if (attempted && (!execution || ['network', 'timeout', 'incomplete'].includes(execution.code))) state = 'unknown';
      else state = 'failed';
      const message = state === 'cancelled' ? attempted ? '已取消本地接收；远端是否停止未知。' : '已取消本地发送；本轮尚未提交。' : execution?.message ?? (error instanceof StorageError ? error.message : '本轮未能完成，未自动重试。');
      if (!active.completed) this.setTurn(id, active, state, message);
      try { await this.persist(id); }
      catch { return this.result(id, attempted ? 'uncertain' : 'notSubmitted', '本地记录保存失败；不会重发请求。'); }
      return this.result(id, attempted ? active.attempted ? 'accepted' : 'uncertain' : 'notSubmitted', message);
    } finally {
      // A prepared-save failure is also a local pending write; it never reaches the driver.
      if (!prepared && this.pendingWrites.has(id)) active.controller.abort();
      this.active.delete(id); active.resolve();
    }
  }

  async stopGeneration(sessionID: string): Promise<void> {
    const active = this.active.get(sessionID);
    if (!active || active.completed) return;
    active.controller.abort();
    // The execution callback finalizes local cancellation. Avoid overlapping a streaming save.
    this.emit({ type: 'diagnostic', sessionID, message: '已请求取消本地接收；远端是否停止未知。' });
    await active.done;
  }

  subscribe(callback: (event: SessionEvent) => void): () => void {
    this.listeners.add(callback); return () => this.listeners.delete(callback);
  }

  async retryPendingWrites(sessionID?: string): Promise<void> {
    this.ensureOpen();
    for (const id of sessionID ? [sessionID] : [...this.pendingWrites.keys()]) {
      if (this.active.has(id)) throw new StorageError('turn-active', '请等待活动轮次退出后重试保存。');
      if (!this.pendingWrites.has(id)) continue;
      const pending = structuredClone(this.record(id));
      try { await this.persist(id); }
      catch (error) {
        // A filesystem error can occur after atomic replacement. Adopt only an exact
        // matching next revision, never another writer's different facts.
        if (!(error instanceof StorageError) || !['revision-changed', 'write-uncertain', 'revisionChanged'].includes(error.code)) throw error;
        const matchesPending = (existing: SessionRecord): boolean => existing.revision === pending.revision + 1 && comparable({ ...existing, revision: pending.revision }) === comparable(pending);
        const existing = await this.options.store.load(id, { observeRecord: matchesPending });
        if (!existing || !matchesPending(existing)) throw error;
        this.cache.set(id, existing); this.pendingWrites.delete(id); this.updated(existing);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const turns = [...this.active.values()];
    for (const turn of turns) turn.controller.abort();
    await Promise.all(turns.map(turn => turn.done));
    this.listeners.clear();
  }

  private async recover(record: SessionRecord, startingTurn = false): Promise<SessionRecord> {
    const latest = this.cache.get(record.conversation_id);
    if ((!startingTurn && this.active.has(record.conversation_id)) || this.pendingWrites.has(record.conversation_id) || latest && latest.revision > record.revision) return latest ?? record;
    const recovered = structuredClone(record); let changed = false;
    for (const turn of recovered.turns) {
      if (terminal.has(turn.state) || turn.state === 'unknown') continue;
      turn.state = turn.state === 'prepared' ? 'failed' : 'unknown';
      turn.failure = turn.state === 'failed' ? '应用中断时本轮尚未提交，未自动重发。' : '应用中断后本轮结果未知，未自动重发。';
      turn.updated_at = this.now(); changed = true;
    }
    this.cache.set(recovered.conversation_id, recovered);
    if (changed) { recovered.updated_at = this.now(); await this.persist(recovered.conversation_id); }
    return this.record(recovered.conversation_id);
  }

  private async onExecutionEvent(id: string, active: ActiveTurn, event: ExecutionEvent): Promise<void> {
    if (this.active.get(id) !== active || active.completed) return;
    if (active.controller.signal.aborted || this.closed) throw new ExecutionError('cancelled', '已取消本地接收；远端是否停止未知。', active.attempted);
    if (event.type === 'submitted') { active.attempted = true; return; }
    if (event.type === 'observed-model') {
      validateModel(event.model); const turn = this.turn(id, active);
      if (turn.observed_model && JSON.stringify(turn.observed_model) !== JSON.stringify(event.model)) throw new ExecutionError('protocol', '观测模型发生变化，已停止接收。', true);
      turn.observed_model = structuredClone(event.model); this.touch(id, active);
    } else if (event.type === 'text-delta') {
      const session = this.record(id); const message = session.messages.find(value => value.message_id === active.assistantID)!;
      if (Buffer.byteLength(message.text) + Buffer.byteLength(event.text) > SESSION_LIMITS.messageBytes) throw new ExecutionError('protocol', '模型回复超过单条消息容量上限。', true);
      message.text += event.text; message.updated_at = this.now(); this.setTurn(id, active, 'streaming');
    } else if (event.type === 'completed') {
      active.attempted = true; active.completed = true; this.setTurn(id, active, 'finished'); await this.persist(id); return;
    }
    this.updated(this.record(id));
    if (Date.now() - active.lastPersisted >= (this.options.persistIntervalMs ?? 250)) { await this.persist(id); active.lastPersisted = Date.now(); }
  }

  private setTurn(id: string, active: ActiveTurn, state: TurnRecord['state'], failure?: string): void {
    const turn = this.turn(id, active); turn.state = state;
    if (failure) turn.failure = failure; else delete turn.failure;
    this.touch(id, active);
  }
  private touch(id: string, active: ActiveTurn): void { const now = this.now(); this.turn(id, active).updated_at = now; this.record(id).updated_at = now; }
  private turn(id: string, active: ActiveTurn): TurnRecord { return this.record(id).turns.find(turn => turn.turn_id === active.turnID)!; }
  private record(id: string): SessionRecord { const value = this.cache.get(id); if (!value) throw new StorageError('missing-session', '会话不存在。'); return value; }
  private async persist(id: string): Promise<void> {
    const record = this.record(id);
    try {
      const saved = await this.options.store.save(structuredClone(record), record.revision || undefined);
      this.cache.set(id, saved); this.pendingWrites.delete(id); this.updated(saved);
    } catch (error) {
      this.pendingWrites.set(id, structuredClone(record));
      this.emit({ type: 'diagnostic', sessionID: id, message: error instanceof StorageError ? error.message : '本地记录保存失败；不会重发请求。' });
      throw error;
    }
  }
  private result(id: string, status: SendResult['status'], reason?: string): SendResult { return { status, session: structuredClone(this.record(id)), ...(reason ? { reason } : {}) }; }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private ensureOpen(): void { if (this.closed) throw new StorageError('closed', '会话管理器已关闭。'); }
  private updated(session: SessionRecord): void { this.emit({ type: 'session-updated', session: structuredClone(session) }); }
  private emit(event: SessionEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Observers cannot alter execution or persistence. */ } } }
}
