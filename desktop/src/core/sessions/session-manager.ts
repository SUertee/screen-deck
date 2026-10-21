import { FileTaskLifecycle, type FileTaskOptions } from './file-task-lifecycle.js';
import { randomUUID } from 'node:crypto';
import type { SendMessageInput, SendResult, SessionEvent, SessionListing, SessionRecord, SessionScope, TurnRecord } from '../../shared/types.js';
import { ExecutionError, type ExecutionDriver, type ExecutionEvent } from './execution-driver.js';
import { StorageError } from '../storage/private-storage.js';
import type { SessionHistoryStoring } from './session-history-store.js';
import { isUUID, SESSION_LIMITS, validateModel } from './session-schema.js';
import type { ApprovalRequest, ExecutionSpec, TaskExecutionRequest, TaskSessionRef, TaskTurnRef } from '../../shared/task-execution.js';
import type { TaskSessionHistoryStoring } from './task-session-history-store.js';
import type { TaskExecutionDriver } from './task-execution-driver.js';
import { TaskSessionLifecycle } from './task-session-lifecycle.js';
import type { AgentSessionHistoryStoring } from './agent-session-history-store.js';
import type { AgentChatDriver } from './agent-chat-driver.js';
import { AgentSessionLifecycle } from './agent-session-lifecycle.js';

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
  file?: FileTaskOptions;
  task?: { store: TaskSessionHistoryStoring; driver: TaskExecutionDriver; resolveApproval?: (id: string) => Promise<ApprovalRequest | undefined> };
  agent?: { store: AgentSessionHistoryStoring; driver: AgentChatDriver };
}

/** Owns local turn state. Drivers cannot authorize tools, edit plans, or own this history. */
export class SessionManager {
  private readonly cache = new Map<string, SessionRecord>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly pendingWrites = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly loading = new Map<string, Promise<SessionRecord | undefined>>();
  private readonly metadataEditing = new Map<string, Promise<void>>();
  private closed = false;
  private readonly fileLifecycle?: FileTaskLifecycle;
  private readonly taskLifecycle?: TaskSessionLifecycle;
  private readonly agentLifecycle?: AgentSessionLifecycle;
  constructor(private readonly options: SessionManagerOptions) {
    if (options.file) this.fileLifecycle = new FileTaskLifecycle(options.file);
    if (options.task) {
      const store = options.task.store;
      this.taskLifecycle = new TaskSessionLifecycle({
        load: async (id, observe) => { await this.assertNotAgent(id); return store.load(id, observe); },
        save: async (record, revision) => { await this.assertNotAgent(record.conversation_id); return store.save(record, revision); },
        list: async observe => {
          const listing = await store.list(observe);
          const records: typeof listing.records = [];
          for (const record of listing.records) {
            try { await this.assertNotAgent(record.conversation_id); records.push(record); }
            catch (error) { listing.diagnostics.push({ filename: `${record.conversation_id}.json`, reason: error instanceof StorageError ? error.message : 'Agent 身份核对失败。' }); }
          }
          return { records, diagnostics: listing.diagnostics };
        },
      }, options.task.driver, options.now, options.task.resolveApproval);
    }
    if (options.agent) this.agentLifecycle = new AgentSessionLifecycle(options.agent.store, options.agent.driver, options.now, options.persistIntervalMs);
  }

  createFileTaskSession(input: Parameters<FileTaskLifecycle['create']>[0]) { this.ensureOpen(); return this.files().create(input); }
  listFileTaskSessions() { return this.fileLifecycle?.list() ?? Promise.resolve([]); }
  loadFileTaskSession(ref: Parameters<FileTaskLifecycle['load']>[0]) { return this.files().load(ref); }
  prepareFileWrite(input: Parameters<FileTaskLifecycle['prepare']>[0]) { this.ensureOpen(); return this.files().prepare(input); }
  requestFileWriteApproval(ref: Parameters<FileTaskLifecycle['requestApproval']>[0]) { this.ensureOpen(); return this.files().requestApproval(ref); }
  decideFileWrite(...args: Parameters<FileTaskLifecycle['decide']>) { this.ensureOpen(); return this.files().decide(...args); }
  applyFileWrite(...args: Parameters<FileTaskLifecycle['apply']>) { this.ensureOpen(); return this.files().apply(...args); }
  inspectFileWrite(ref: Parameters<FileTaskLifecycle['inspect']>[0]) { return this.files().inspect(ref); }
  cancelFileWrite(ref: Parameters<FileTaskLifecycle['cancel']>[0]) { return this.files().cancel(ref); }
  reviewFileWrite(ref: Parameters<FileTaskLifecycle['review']>[0]) { return this.files().review(ref); }
  verifyFileResult(...args: Parameters<FileTaskLifecycle['verifyResult']>) { return this.files().verifyResult(...args); }
  private files(): FileTaskLifecycle { if (!this.fileLifecycle) throw new StorageError('unsupported', '宿主文件工具尚未配置。'); return this.fileLifecycle; }

  createAgentSession(input: Parameters<AgentSessionLifecycle['create']>[0]) { return this.agents().create(input); }
  listAgentSessions() { return this.agentLifecycle?.list() ?? Promise.resolve({ records: [], diagnostics: [] }); }
  loadAgentSession(id: string) { return this.agents().load(id); }
  renameAgentSession(input: { sessionID: string; title: string; expectedRevision: number }) { return this.agents().rename(input); }
  isAgentSessionBusy(id: string): boolean { return this.agentLifecycle?.isBusy(id) ?? false; }
  sendAgentMessage(input: Parameters<AgentSessionLifecycle['send']>[0]) { return this.agents().send(input); }
  stopAgentGeneration(id: string) { return this.agents().stop(id); }
  retryAgentPendingWrites(id: string) { return this.agents().retry(id); }
  subscribeAgent(callback: Parameters<AgentSessionLifecycle['subscribe']>[0]) { return this.agents().subscribe(callback); }
  private agents(): AgentSessionLifecycle { if (!this.agentLifecycle) throw new StorageError('unsupported', 'Agent 聊天能力尚未配置。'); return this.agentLifecycle; }
  private async assertNotAgent(id: string): Promise<void> {
    if (await this.options.agent?.store.load(id)) throw new StorageError('duplicate-session', 'Agent 会话不能作为其他格式读取或写入。');
  }

  createTaskSession(input: { title: string; projectID: string; taskID: string }) { return this.tasks().create(input); }
  async listTaskSessions(input?: { projectID: string; taskID: string }) {
    const listing = await (this.taskLifecycle?.list(input) ?? Promise.resolve({ records: [], diagnostics: [] }));
    const records: typeof listing.records = [];
    for (const record of listing.records) {
      try { await this.assertNotAgent(record.conversation_id); records.push(record); }
      catch (error) { listing.diagnostics.push({ filename: `${record.conversation_id}.json`, reason: error instanceof StorageError ? error.message : 'Agent 身份核对失败。' }); }
    }
    return { records, diagnostics: listing.diagnostics };
  }
  async loadTaskSession(ref: TaskSessionRef) { await this.assertNotAgent(ref.sessionID); return this.tasks().load(ref); }
  async getTaskTurn(turn: TaskTurnRef) { await this.assertNotAgent(turn.session.sessionID); return this.tasks().get(turn); }
  async prepareTaskTurn(input: { session: TaskSessionRef; clientRequestID: string; text: string; model: SendMessageInput['model']; spec: ExecutionSpec }) { await this.assertNotAgent(input.session.sessionID); return this.tasks().prepare(input); }
  async startTaskTurn(input: { turn: TaskTurnRef; approvalID: string; check: () => void; resolved: TaskExecutionRequest['resolved'] }) { await this.assertNotAgent(input.turn.session.sessionID); return this.tasks().start(input); }
  async cancelTaskExecution(turn: TaskTurnRef) { await this.assertNotAgent(turn.session.sessionID); return this.tasks().cancel(turn); }
  async replyTaskPermission(input: { turn: TaskTurnRef; approval: ApprovalRequest; check: () => void }) { await this.assertNotAgent(input.turn.session.sessionID); return this.tasks().reply(input); }
  async reconcileTaskExecution(turn: TaskTurnRef) { await this.assertNotAgent(turn.session.sessionID); return this.tasks().reconcile(turn); }
  async failPreparedTaskTurn(turn: TaskTurnRef, reason: string) { await this.assertNotAgent(turn.session.sessionID); return this.tasks().failPrepared(turn, reason); }
  hasTaskPendingWrites(id: string): boolean { return this.tasks().hasPending(id); }
  async retryTaskPendingWrites(ref: TaskSessionRef) { await this.assertNotAgent(ref.sessionID); return this.tasks().retry(ref); }
  subscribeTask(callback: Parameters<TaskSessionLifecycle['subscribe']>[0]) { return this.tasks().subscribe(callback); }
  private tasks(): TaskSessionLifecycle { if (!this.taskLifecycle) throw new StorageError('unsupported', '任务执行能力尚未配置。'); return this.taskLifecycle; }

  async createSession(title: string, scope?: SessionScope): Promise<SessionRecord> {
    this.ensureOpen();
    const id = randomUUID(); const now = this.now();
    await this.assertNotAgent(id);
    if (await this.options.task?.store.load(id)) throw new StorageError('duplicate-session', '另一格式已使用此会话身份。');
    const record: SessionRecord = { schema_version: 1, conversation_id: id, title: title.trim(), scope: scope ?? { kind: 'local_chat', local_chat_id: id }, created_at: now, updated_at: now, revision: 0, turns: [], messages: [] };
    const saved = await this.options.store.save(record);
    this.cache.set(id, saved); this.updated(saved); return structuredClone(saved);
  }

  isSessionBusy(id: string): boolean {
    id = id.toLowerCase();
    return this.active.has(id) || this.pendingWrites.has(id) || this.metadataEditing.has(id) || this.loading.has(id);
  }

  async renameSession(input: { sessionID: string; title: string; expectedRevision: number }): Promise<SessionRecord> {
    this.ensureOpen();
    if (!isUUID(input.sessionID)) throw new StorageError('invalid-id', '会话标识无效。');
    const id = input.sessionID.toLowerCase();
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.includes('\0') || Buffer.byteLength(input.title) > 600) throw new StorageError('invalid-input', '聊天标题为空或超过容量上限。');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new StorageError('revision-changed', '聊天修订无效，请重新读取后再修改。');
    if (this.active.has(id)) throw new StorageError('turn-active', '请等待活动轮次退出后修改标题。');
    if (this.pendingWrites.has(id)) throw new StorageError('pending-write', '请先补存此会话的本地事实。');
    if (this.isSessionBusy(id)) throw new StorageError('session-busy', '此会话正在读取或修改，请稍后重试。');
    let finish!: () => void;
    const editing = new Promise<void>(resolve => { finish = resolve; });
    // Reserve before any await. Sending and other metadata edits cannot overtake this CAS.
    this.metadataEditing.set(id, editing);
    try {
      await this.assertNotAgent(id);
      if (await this.options.task?.store.load(id)) throw new StorageError('duplicate-session', '任务会话不能作为普通聊天修改。');
      const record = await this.options.store.load(id);
      this.ensureOpen();
      if (!record) throw new StorageError('missing-session', '会话不存在。');
      if (record.revision !== input.expectedRevision) throw new StorageError('revision-changed', '聊天已变化，请重新读取后再修改标题。');
      const title = input.title.trim();
      this.cache.set(id, structuredClone(record));
      if (record.title === title) return structuredClone(record);
      const next = structuredClone(record);
      next.title = title;
      next.updated_at = this.now();
      this.cache.set(id, next);
      await this.persist(id);
      return structuredClone(this.record(id));
    } finally {
      this.metadataEditing.delete(id);
      finish();
    }
  }

  async listSessions(): Promise<SessionListing> {
    this.ensureOpen();
    const listing = await this.options.store.list({ observeRecord: id => !this.active.has(id) && !this.pendingWrites.has(id) && !this.metadataEditing.has(id) });
    const records: SessionRecord[] = [];
    for (const record of listing.records) {
      const id = record.conversation_id;
      try {
        await this.assertNotAgent(id);
        if (await this.options.task?.store.load(id)) throw new StorageError('duplicate-session', '两个格式声明相同会话身份。');
      } catch (error) {
        listing.diagnostics.push({ filename: `${id}.json`, reason: error instanceof StorageError ? error.message : '任务会话身份核对失败。' });
        continue;
      }
      if (this.active.has(id) || this.pendingWrites.has(id)) records.push(structuredClone(this.cache.get(id) ?? record));
      else if (this.metadataEditing.has(id)) records.push(structuredClone(await this.loadSession(id) ?? record));
      else {
        // Reuse the observed list snapshot without rescanning the whole library per row.
        const existing = this.loading.get(id);
        if (existing) records.push(structuredClone(await existing ?? record));
        else {
          const recovery = this.recover(record);
          this.loading.set(id, recovery);
          try { records.push(structuredClone(await recovery)); }
          finally { if (this.loading.get(id) === recovery) this.loading.delete(id); }
        }
      }
    }
    records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { records, diagnostics: listing.diagnostics };
  }

  async loadSession(id: string): Promise<SessionRecord | undefined> {
    this.ensureOpen();
    await this.assertNotAgent(id);
    if (await this.options.task?.store.load(id)) throw new StorageError('duplicate-session', '任务会话不能作为普通聊天读取。');
    const editing = this.metadataEditing.get(id.toLowerCase());
    if (editing) { await editing; return this.loadSession(id); }
    if (this.active.has(id) || this.pendingWrites.has(id)) return structuredClone(this.cache.get(id));
    const loading = this.loading.get(id);
    if (loading) return structuredClone(await loading);
    const promise = this.options.store.load(id, { observeRecord: () => !this.metadataEditing.has(id.toLowerCase()) }).then(async record => record ? this.recover(record) : undefined);
    this.loading.set(id, promise);
    try { return structuredClone(await promise); } finally { this.loading.delete(id); }
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    this.ensureOpen();
    const id = input.sessionID;
    if (this.metadataEditing.has(id.toLowerCase())) throw new StorageError('session-busy', '此会话正在修改标题，请稍后发送。');
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
      await this.assertNotAgent(id);
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
      if (this.metadataEditing.has(id.toLowerCase())) throw new StorageError('session-busy', '请等待标题修改结束后补存。');
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
    await this.fileLifecycle?.shutdown();
    await Promise.all(this.metadataEditing.values());
    await this.agentLifecycle?.shutdown();
    await this.taskLifecycle?.shutdown();
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
      await this.assertNotAgent(id);
      if (await this.options.task?.store.load(id)) throw new StorageError('duplicate-session', '不同格式声明相同会话身份，未覆盖原记录。');
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
