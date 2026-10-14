import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentChatReadySource, AgentSendResult, AgentSessionEvent, AgentSessionListing, AgentSessionRecord } from '../shared/agent-chat.js';
import type { SessionScope, TurnRecord } from '../shared/types.js';
import type { AgentChatDriver, AgentChatExecutionEvent } from './agent-chat-driver.js';
import type { AgentSessionHistoryStoring } from './agent-session-history-store.js';
import { AGENT_CHAT_INPUT_BYTES, validateAgentBinding, validateAgentSession, validateAgentSource } from './agent-session-schema.js';
import { ExecutionError } from './execution-driver.js';
import { StorageError } from './private-storage.js';
import { isUUID, SESSION_LIMITS, validateModel } from './session-schema.js';

const terminal = new Set(['finished', 'failed', 'cancelled', 'unknown']);
interface ActiveAgentTurn {
  controller: AbortController;
  turnID: string;
  assistantID: string;
  attempted: boolean;
  driverStarted: boolean;
  completed: boolean;
  stopRequested: boolean;
  cancelConfirmed: boolean;
  cancellation?: Promise<void>;
  lastPersisted: number;
  done: Promise<void>;
  resolve: () => void;
}

/** Private local writer for the Agent format. Drivers own protocol, never this history. */
export class AgentSessionLifecycle {
  private readonly cache = new Map<string, AgentSessionRecord>();
  private readonly active = new Map<string, ActiveAgentTurn>();
  private readonly pending = new Map<string, AgentSessionRecord>();
  private readonly loading = new Map<string, Promise<AgentSessionRecord | undefined>>();
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private closed = false;

  constructor(
    private readonly store: AgentSessionHistoryStoring,
    private readonly driver: AgentChatDriver,
    private readonly clock?: () => Date,
    private readonly persistIntervalMs = 250,
  ) {}

  async create(input: { title: string; agentID: string; scope?: SessionScope }): Promise<AgentSessionRecord> {
    this.ensureOpen();
    const source = this.ready();
    if (input.agentID !== source.agentID) throw new StorageError('unsupported-agent', '此 Agent 来源尚不可用。');
    const id = randomUUID();
    const now = this.now();
    const record: AgentSessionRecord = {
      schema_version: 1,
      kind: 'electron_agent_chat',
      conversation_id: id,
      title: input.title.trim(),
      scope: input.scope ? structuredClone(input.scope) : { kind: 'local_chat', local_chat_id: id },
      source: { agentID: source.agentID, configDigest: source.configDigest },
      created_at: now,
      updated_at: now,
      revision: 0,
      turns: [],
      messages: [],
    };
    validateAgentSession(record);
    const saved = await this.store.save(record);
    this.cache.set(id, saved);
    this.updated(saved);
    return structuredClone(saved);
  }

  async list(): Promise<AgentSessionListing> {
    this.ensureOpen();
    const listing = await this.store.list({ observeRecord: id => !this.active.has(id) && !this.pending.has(id) });
    const records: AgentSessionRecord[] = [];
    for (const record of listing.records) {
      const id = record.conversation_id;
      try {
        const snapshot = this.active.has(id) || this.pending.has(id) ? this.cache.get(id) ?? record : await this.load(id) ?? record;
        records.push(structuredClone(snapshot));
      } catch (error) {
        listing.diagnostics.push({ filename: `${id}.json`, reason: error instanceof StorageError ? error.message : 'Agent 会话恢复记录未能保存。' });
        const pending = this.cache.get(id);
        if (pending) records.push(structuredClone(pending));
      }
    }
    records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { records, diagnostics: listing.diagnostics };
  }

  async load(id: string): Promise<AgentSessionRecord | undefined> {
    this.ensureOpen();
    id = this.identifier(id);
    if (this.active.has(id) || this.pending.has(id)) return structuredClone(this.cache.get(id));
    const existing = this.loading.get(id);
    if (existing) return structuredClone(await existing);
    const loading = this.store.load(id).then(record => record ? this.recover(record) : undefined);
    this.loading.set(id, loading);
    try { return structuredClone(await loading); }
    finally { this.loading.delete(id); }
  }

  async send(input: { sessionID: string; text: string }): Promise<AgentSendResult> {
    this.ensureOpen();
    const id = this.identifier(input.sessionID);
    if (this.active.has(id)) throw new StorageError('turn-active', '此 Agent 会话已有活动轮次。');
    if (this.pending.has(id)) throw new StorageError('pending-write', '请先补存 Agent 会话事实，不会重发请求。');
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > AGENT_CHAT_INPUT_BYTES) throw new StorageError('invalid-input', '消息为空或超过容量上限。');
    if (input.text.trimStart().startsWith('/')) throw new StorageError('invalid-input', '此 Agent 聊天首版不支持原生命令，请发送普通文本。');
    let resolve!: () => void;
    const active: ActiveAgentTurn = {
      controller: new AbortController(),
      turnID: randomUUID(),
      assistantID: randomUUID(),
      attempted: false,
      driverStarted: false,
      completed: false,
      stopRequested: false,
      cancelConfirmed: false,
      lastPersisted: 0,
      done: new Promise<void>(done => { resolve = done; }),
      resolve: () => resolve(),
    };
    // Reserve synchronously before loading or saving; concurrent UI sends cannot both submit.
    this.active.set(id, active);
    try {
      await this.loading.get(id);
      const loaded = await this.store.load(id);
      const record = loaded ? await this.recover(loaded, true) : undefined;
      if (!record) throw new StorageError('missing-session', 'Agent 会话不存在。');
      if (record.turns.some(turn => !terminal.has(turn.state) || turn.state === 'unknown')) throw new StorageError('unresolved-turn', '原 Agent 轮次结果未知，不能继续或自动重发。');
      if (record.turns.length >= SESSION_LIMITS.turns || record.messages.length + 2 > SESSION_LIMITS.messages) throw new StorageError('too-large', 'Agent 会话轮次达到上限。');
      const source = this.assertSource(record);
      const session = structuredClone(record);
      const now = this.now();
      session.turns.push({ turn_id: active.turnID, client_request_id: randomUUID(), requested_model: structuredClone(source.model), state: 'prepared', created_at: now, updated_at: now, draft_revision: 0 });
      session.messages.push({ message_id: randomUUID(), turn_id: active.turnID, role: 'user', text: input.text, created_at: now, updated_at: now });
      session.messages.push({ message_id: active.assistantID, turn_id: active.turnID, role: 'assistant', text: '', created_at: now, updated_at: now });
      session.updated_at = now;
      this.cache.set(id, session);
      await this.persist(id);
      if (active.stopRequested || this.closed) return await this.finishBeforeSubmit(id, active);
      this.setTurn(id, active, 'submitting');
      await this.persist(id);
      if (active.stopRequested || this.closed) return await this.finishBeforeSubmit(id, active);
      const current = this.record(id);
      const turn = this.turn(id, active);
      const currentSource = this.assertSource(current);
      if (!isDeepStrictEqual(currentSource.model, turn.requested_model)) throw new StorageError('source-changed', 'Agent 模型已变化，请新建聊天。');
      active.driverStarted = true;
      await this.driver.sendTurn({
        sessionID: id,
        turnID: turn.turn_id,
        clientRequestID: turn.client_request_id,
        source: structuredClone(current.source),
        ...(current.binding ? { binding: structuredClone(current.binding) } : {}),
        model: structuredClone(turn.requested_model),
        input: input.text,
      }, event => this.onEvent(id, active, event), active.controller.signal);
      if (!active.completed) throw new ExecutionError('incomplete', 'Agent 未确认原轮次结束。', active.attempted);
      return this.result(id, 'accepted');
    } catch (error) {
      if (!this.cache.get(id)?.turns.some(turn => turn.turn_id === active.turnID)) throw error;
      await active.cancellation;
      const execution = error instanceof ExecutionError ? error : undefined;
      const attempted = active.attempted || execution?.attempted === true || active.driverStarted && !execution && !this.pending.has(id);
      if (!active.completed) {
        const state = attempted ? active.cancelConfirmed ? 'cancelled' : 'unknown' : active.stopRequested || this.closed ? 'cancelled' : 'failed';
        const reason = state === 'unknown' ? '原 Agent 轮次结果未知，未自动重发；请新建聊天。' : state === 'cancelled' ? attempted ? '原 Agent prompt 已确认取消。' : '本轮尚未提交，已取消本地准备。' : execution?.message ?? (error instanceof StorageError ? error.message : '本轮未能提交，未自动重发。');
        this.setTurn(id, active, state, reason);
      }
      if (this.pending.has(id)) {
        this.pending.set(id, structuredClone(this.record(id)));
        this.updated(this.record(id));
        return this.result(id, attempted && !active.completed ? 'uncertain' : attempted ? 'accepted' : 'notSubmitted', '本地事实保存失败；重试仅补存，不会执行。');
      }
      try { await this.persist(id); }
      catch { return this.result(id, attempted && !active.completed ? 'uncertain' : attempted ? 'accepted' : 'notSubmitted', '本地事实保存失败；重试仅补存，不会执行。'); }
      return this.result(id, attempted ? this.turn(id, active).state === 'unknown' ? 'uncertain' : 'accepted' : 'notSubmitted', this.turn(id, active).failure);
    } finally {
      this.active.delete(id);
      active.resolve();
    }
  }

  async stop(id: string): Promise<void> {
    id = this.identifier(id);
    const active = this.active.get(id);
    if (!active || active.completed) return;
    if (!active.stopRequested) {
      active.stopRequested = true;
      if (active.driverStarted) {
        const record = this.record(id);
        const turn = this.turn(id, active);
        try {
          active.cancellation = this.driver.cancelTurn({ clientRequestID: turn.client_request_id, source: structuredClone(record.source), ...(record.binding ? { binding: structuredClone(record.binding) } : {}) }).then(result => {
            active.cancelConfirmed = result.status === 'confirmed';
          }, () => { active.cancelConfirmed = false; });
        } catch { active.cancelConfirmed = false; }
      }
      if (!active.attempted) active.controller.abort();
      this.emit({ type: 'agent-diagnostic', sessionID: id, message: '已请求停止原 Agent 轮次；等待明确回执。' });
    }
    await active.cancellation;
    // Keep receiving the original prompt until an explicit cancelled/finished proof.
    // A local abort is only safe after an unconfirmed stop has been classified unknown.
    if (!active.cancelConfirmed && !active.completed) active.controller.abort();
    await active.done;
  }

  async retry(id: string): Promise<void> {
    this.ensureOpen();
    id = this.identifier(id);
    if (this.active.has(id)) throw new StorageError('turn-active', '请等待原 Agent 轮次退出后补存。');
    if (!this.pending.has(id)) return;
    const pending = structuredClone(this.record(id));
    try { await this.persist(id); }
    catch (error) {
      if (!(error instanceof StorageError) || !['revision-changed', 'write-uncertain', 'revisionChanged'].includes(error.code)) throw error;
      const matches = (record: AgentSessionRecord): boolean => record.revision === pending.revision + 1 && isDeepStrictEqual({ ...record, revision: pending.revision }, pending);
      const saved = await this.store.load(id, { observeRecord: matches });
      if (!saved || !matches(saved)) throw error;
      this.cache.set(id, saved);
      this.pending.delete(id);
      this.updated(saved);
    }
  }

  subscribe(callback: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    this.listeners.clear();
  }

  private async recover(record: AgentSessionRecord, starting = false): Promise<AgentSessionRecord> {
    const id = record.conversation_id;
    const cached = this.cache.get(id);
    if (!starting && this.active.has(id) || this.pending.has(id) || cached && cached.revision > record.revision) return cached ?? record;
    const recovered = structuredClone(record);
    let changed = false;
    for (const turn of recovered.turns) {
      if (terminal.has(turn.state)) continue;
      turn.state = turn.state === 'prepared' ? 'failed' : 'unknown';
      turn.failure = turn.state === 'failed' ? '应用中断时本轮尚未提交，未自动重发。' : '应用中断后原 Agent 轮次结果未知，未自动重发。';
      turn.updated_at = this.now();
      changed = true;
    }
    this.cache.set(id, recovered);
    if (changed) {
      recovered.updated_at = this.now();
      await this.persist(id);
    }
    return this.record(id);
  }

  private async onEvent(id: string, active: ActiveAgentTurn, event: AgentChatExecutionEvent): Promise<void> {
    if (this.active.get(id) !== active || active.completed) return;
    if (event.type === 'bound') {
      if (active.attempted || active.stopRequested || this.closed) throw new ExecutionError('cancelled', '本轮尚未提交，绑定准备已停止。', active.attempted);
      try { validateAgentBinding(event.binding); }
      catch { throw new ExecutionError('protocol', 'Agent 原生绑定字段无效，尚未提交。', false); }
      const record = this.record(id);
      let source: AgentChatReadySource;
      try { source = this.assertSource(record); }
      catch { throw new ExecutionError('configuration', 'Agent 来源已失效，尚未提交。', false); }
      if (event.binding.runtimeID !== source.runtimeID || event.binding.connectionGeneration !== source.connectionGeneration || record.binding && !isDeepStrictEqual(record.binding, event.binding)) throw new ExecutionError('configuration', '不能替换原 Agent 会话绑定。', false);
      record.binding = structuredClone(event.binding);
      record.updated_at = this.now();
      // This callback must finish successfully before the driver may issue prompt.
      await this.persist(id);
      if (active.stopRequested || this.closed) throw new ExecutionError('cancelled', '本轮尚未提交，绑定准备已停止。', false);
      try { this.assertSource(this.record(id)); }
      catch { throw new ExecutionError('configuration', 'Agent 来源已失效，尚未提交。', false); }
      return;
    }
    if (event.type === 'submitted') {
      active.attempted = true;
      if (!this.record(id).binding) throw new ExecutionError('protocol', 'Agent 提交前没有已保存的原生绑定。', true);
      return;
    }
    if (event.type === 'settled') {
      if (!active.attempted || !['finished', 'failed', 'cancelled'].includes(event.outcome)) throw new ExecutionError('protocol', 'Agent 缺少原 prompt 的有效结束事实。', active.attempted);
      if (event.reason !== undefined && (typeof event.reason !== 'string' || Buffer.byteLength(event.reason) > 4096)) throw new ExecutionError('protocol', 'Agent 回执字段无效。', true);
      active.completed = true;
      if (event.outcome === 'cancelled') active.cancelConfirmed = true;
      this.setTurn(id, active, event.outcome, event.reason);
      await this.persist(id);
      return;
    }
    if (active.controller.signal.aborted) throw new ExecutionError('cancelled', '本地接收已停止；原 prompt 结果仍须核对。', active.attempted);
    if (!active.attempted || !this.record(id).binding) throw new ExecutionError('protocol', 'Agent 回复缺少原提交事实。', active.attempted);
    if (event.type === 'text-delta') {
      const message = this.record(id).messages.find(value => value.message_id === active.assistantID)!;
      if (typeof event.text !== 'string' || Buffer.byteLength(message.text) + Buffer.byteLength(event.text) > SESSION_LIMITS.messageBytes) throw new ExecutionError('protocol', 'Agent 回复超过容量上限。', true);
      message.text += event.text;
      message.updated_at = this.now();
      this.setTurn(id, active, 'streaming');
    } else if (event.type === 'observed-model') {
      validateModel(event.model);
      const turn = this.turn(id, active);
      if (turn.observed_model && !isDeepStrictEqual(turn.observed_model, event.model)) throw new ExecutionError('protocol', 'Agent 观测模型发生变化。', true);
      turn.observed_model = structuredClone(event.model);
      this.touch(id, active);
    } else throw new ExecutionError('tools-forbidden', '此 Agent 聊天入口不接受工具或其他事件。', true);
    this.updated(this.record(id));
    if (Date.now() - active.lastPersisted >= this.persistIntervalMs) {
      await this.persist(id);
      active.lastPersisted = Date.now();
    }
  }

  private ready(): AgentChatReadySource {
    const source = this.driver.getSource();
    if (!source || source.state !== 'ready') throw new StorageError('agent-unavailable', 'Agent 尚未就绪，请在编码工具设置中明确启动。');
    validateAgentSource({ agentID: source.agentID, configDigest: source.configDigest });
    validateModel(source.model);
    validateAgentBinding({ runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration, externalSessionID: 'ready' });
    return structuredClone(source);
  }

  private assertSource(record: AgentSessionRecord): AgentChatReadySource {
    const source = this.ready();
    if (record.source.agentID !== source.agentID || record.source.configDigest !== source.configDigest) throw new StorageError('source-changed', '原 Agent 配置已失效，请新建聊天。');
    if (record.binding && (record.binding.runtimeID !== source.runtimeID || record.binding.connectionGeneration !== source.connectionGeneration)) throw new StorageError('binding-unavailable', '原 Agent 实例已不可确认，请新建聊天；不会重新绑定。');
    return source;
  }

  private async finishBeforeSubmit(id: string, active: ActiveAgentTurn): Promise<AgentSendResult> {
    this.setTurn(id, active, 'cancelled', '本轮尚未提交，已取消本地准备。');
    await this.persist(id);
    return this.result(id, 'notSubmitted');
  }

  private setTurn(id: string, active: ActiveAgentTurn, state: TurnRecord['state'], reason?: string): void {
    const turn = this.turn(id, active);
    turn.state = state;
    if (reason !== undefined) turn.failure = reason;
    else delete turn.failure;
    this.touch(id, active);
  }
  private touch(id: string, active: ActiveAgentTurn): void {
    const now = this.now();
    this.turn(id, active).updated_at = now;
    this.record(id).updated_at = now;
  }
  private turn(id: string, active: ActiveAgentTurn): TurnRecord { return this.record(id).turns.find(value => value.turn_id === active.turnID)!; }
  private record(id: string): AgentSessionRecord {
    const record = this.cache.get(id);
    if (!record) throw new StorageError('missing-session', 'Agent 会话不存在。');
    return record;
  }
  private async persist(id: string): Promise<void> {
    const record = this.record(id);
    try {
      const saved = await this.store.save(structuredClone(record), record.revision || undefined);
      this.cache.set(id, saved);
      this.pending.delete(id);
      this.updated(saved);
    } catch (error) {
      this.pending.set(id, structuredClone(record));
      this.emit({ type: 'agent-diagnostic', sessionID: id, message: error instanceof StorageError ? error.message : 'Agent 本地事实保存失败，不会重发。' });
      throw error;
    }
  }
  private result(id: string, status: AgentSendResult['status'], reason?: string): AgentSendResult { return { status, session: structuredClone(this.record(id)), ...(reason ? { reason } : {}) }; }
  private now(): string { return (this.clock?.() ?? new Date()).toISOString(); }
  private ensureOpen(): void { if (this.closed) throw new StorageError('closed', '会话管理器已关闭。'); }
  private identifier(id: string): string { if (!isUUID(id)) throw new StorageError('invalid-id', 'Agent 会话标识无效。'); return id.toLowerCase(); }
  private updated(session: AgentSessionRecord): void { this.emit({ type: 'agent-session-updated', session: structuredClone(session) }); }
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* Observers cannot mutate execution or storage. */ }
    }
  }
}
