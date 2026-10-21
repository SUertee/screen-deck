import type { PromptResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import { ExecutionError } from '../../sessions/execution-driver.js';
import type { ModelSelection } from '../../../shared/types.js';
import type { AgentChatBinding } from '../../../shared/agent-chat.js';
import type { OpenCodeAcpConnection, OpenCodeAcpEvent } from './opencode-acp-connection.js';

export interface OpenCodeAcpSessionOptions {
  getConnection: () => OpenCodeAcpConnection | undefined;
  canStart?: () => boolean;
  requestTimeoutMs?: number;
  executionTimeoutMs?: number;
  cancelTimeoutMs?: number;
}
export interface AcpSessionInput {
  ownerID: string;
  clientRequestID: string;
  configDigest: string;
  model: ModelSelection;
  input: string;
  binding?: AgentChatBinding;
  continuous: boolean;
  /** Existing task turns count uncertain preparation RPCs as attempted. */
  preparationCountsAsAttempt?: boolean;
}
export type AcpSessionEvent =
  | { type: 'bound'; binding: AgentChatBinding }
  | { type: 'submitted' }
  | { type: 'text-delta'; text: string }
  | { type: 'settled'; outcome: 'finished' | 'failed' | 'cancelled'; reason?: string };
export interface AcpSessionProof { binding: AgentChatBinding; output: string; outcome: 'finished' | 'failed' | 'cancelled'; reason?: string }
export interface AcpSessionLookup { clientRequestID: string; configDigest: string; binding?: AgentChatBinding }
interface NativeSession {
  binding: AgentChatBinding;
  connection: OpenCodeAcpConnection;
  ownerID: string;
  continuous: boolean;
  phase: 'preparing' | 'active' | 'ready' | 'blocked';
  turns: number;
  messageIDs: Set<string>;
  active?: Attempt;
}
interface Attempt {
  connection: OpenCodeAcpConnection;
  request: AcpSessionInput;
  native?: NativeSession;
  preparationStarted: boolean;
  promptIssued: boolean;
  stopRequested: boolean;
  localStopped: boolean;
  output: string;
  messageID?: string;
  updates: number;
  queue: Promise<void>;
  failure?: ExecutionError;
  failed: Promise<never>;
  rejectFailure: (error: ExecutionError) => void;
  completed: Promise<void>;
  finish: () => void;
  proof?: AcpSessionProof;
  onEvent: (event: AcpSessionEvent) => Promise<void>;
}
export const acpSameModel = (a: ModelSelection, b: ModelSelection): boolean => a.provider_id === b.provider_id && a.model_id === b.model_id && a.variant === b.variant;
const bounded = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f]/.test(value);
const MAX_TEXT = 1024 * 1024;
const duration = (value: number | undefined, fallback: number, maximum: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ExecutionError('configuration', 'ACP 等待时间无效。', false);
  return result;
};

/** Concrete private SDK v1 session implementation shared by text chat and task adapters.
 * Owns no local history, approvals, Task, or provider secret. Reuse is possible only
 * for a native session this instance created for the same local owner and live RPC.
 */
export class OpenCodeAcpSessionClient {
  private readonly claimed = new Set<string>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly sessions = new Map<string, NativeSession>();
  private readonly activeOwners = new Set<string>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly requestTimeout: number;
  private readonly executionTimeout: number;
  private readonly cancelTimeout: number;
  constructor(private readonly options: OpenCodeAcpSessionOptions) {
    this.requestTimeout = duration(options.requestTimeoutMs, 10_000, 60_000);
    this.executionTimeout = duration(options.executionTimeoutMs, 180_000, 600_000);
    this.cancelTimeout = duration(options.cancelTimeoutMs, 1500, 30_000);
  }
  getConnection(): OpenCodeAcpConnection {
    const connection = this.options.getConnection();
    if (!connection || connection.version !== '1.19.0' || !bounded(connection.runtimeID) || !bounded(connection.connectionGeneration) || !bounded(connection.configDigest) || !bounded(connection.directory, 4096) || !connection.directory.startsWith('/') || !bounded(connection.model.provider_id) || !bounded(connection.model.model_id) || connection.model.variant !== undefined || connection.rpc.signal.aborted) throw new ExecutionError('configuration', '受控 ACP v1 连接尚未就绪。', false);
    return { ...connection, model: { ...connection.model }, subscribe: connection.subscribe.bind(connection) };
  }
  async send(input: AcpSessionInput, onEvent: Attempt['onEvent'], signal: AbortSignal): Promise<void> {
    const connection = this.getConnection();
    if (this.options.canStart && !this.options.canStart()) throw new ExecutionError('configuration', '模型配置已变化，请明确重新连接后开始新消息。', false);
    if (input.configDigest !== connection.configDigest || !acpSameModel(input.model, connection.model) || input.model.variant !== undefined || !input.input.trim() || input.input.trimStart().startsWith('/') || Buffer.byteLength(input.input) > 256 * 1024 || !bounded(input.clientRequestID) || !bounded(input.ownerID)) throw new ExecutionError('configuration', '此 ACP 连接只接受当前模型的明确无工具文本。', false);
    if (signal.aborted) throw new ExecutionError('cancelled', '首次 ACP 调用前已停止。', false);
    const key = this.key(connection, input.clientRequestID);
    const ownerKey = this.key(connection, input.ownerID);
    if (this.claimed.has(key) || this.claimed.size >= 2000 || this.activeOwners.has(ownerKey)) throw new ExecutionError('configuration', '本地调用已领取提交权、会话仍活动或达到上限，不会重复提交。', false);
    let native: NativeSession | undefined;
    if (input.binding) {
      if (!input.continuous) throw new ExecutionError('configuration', '工作项只创建新的原生会话。', false);
      native = this.sessions.get(this.bindingKey(input.binding));
      if (!native || native.ownerID !== input.ownerID || !native.continuous || native.phase !== 'ready' || !this.sameBinding(native.binding, input.binding) || native.connection.rpc !== connection.rpc) throw new ExecutionError('configuration', '原 Agent 上下文不可继续，请明确新建聊天；不会重绑或加载旧会话。', false);
      this.current(native.connection);
    } else if (input.continuous && [...this.sessions.values()].some(value => value.ownerID === input.ownerID)) {
      throw new ExecutionError('configuration', '已有 Agent 原生绑定，不能隐式创建替代会话。', false);
    }
    if (this.attempts.size >= 64) {
      const disposable = [...this.attempts.entries()].find(([, value]) => value.proof || value.failure || value.connection.rpc.signal.aborted);
      if (!disposable) throw new ExecutionError('configuration', 'ACP 未决尝试已达到本地容量上限。', false);
      this.attempts.delete(disposable[0]);
    }
    this.claimed.add(key); this.activeOwners.add(ownerKey);
    let rejectFailure!: Attempt['rejectFailure']; const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; }); void failed.catch(() => undefined);
    let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; });
    const attempt: Attempt = { connection, request: structuredClone(input), native, preparationStarted: false, promptIssued: false, stopRequested: false, localStopped: false, output: '', updates: 0, queue: Promise.resolve(), failed, rejectFailure, completed, finish, onEvent };
    this.attempts.set(key, attempt);
    if (native) { native.phase = 'preparing'; native.active = attempt; }
    const abort = () => { attempt.localStopped = true; };
    signal.addEventListener('abort', abort, { once: true });
    try {
      this.subscribe(connection);
      if (!native) {
        this.ready(attempt, signal); attempt.preparationStarted = true;
        const created = await this.wait(connection.rpc.agent.request('session/new', { cwd: connection.directory, mcpServers: [] }), attempt, signal, this.requestTimeout);
        const binding = { runtimeID: connection.runtimeID, connectionGeneration: connection.connectionGeneration, externalSessionID: created.sessionId };
        if (!bounded(created.sessionId) || this.sessions.has(this.bindingKey(binding)) || this.sessions.size >= 2000) throw this.error(attempt, 'protocol', 'ACP 原生会话身份无法确认。');
        native = { binding, connection, ownerID: input.ownerID, continuous: input.continuous, phase: 'preparing', turns: 0, messageIDs: new Set(), active: attempt };
        this.sessions.set(this.bindingKey(binding), native); attempt.native = native;
        this.modelOption(created.configOptions, connection, attempt);
        if (created.modes && created.modes.currentModeId !== 'build') throw this.error(attempt, 'protocol', 'ACP 模式超出无工具范围。');
      }
      this.ready(attempt, signal); attempt.preparationStarted = true;
      const configured = await this.wait(connection.rpc.agent.request('session/set_config_option', { sessionId: native.binding.externalSessionID, configId: 'model', value: this.modelID(connection) }), attempt, signal, this.requestTimeout);
      this.modelOption(configured.configOptions, connection, attempt);
      if (!input.binding) await this.enqueue(attempt, () => this.emit(attempt, { type: 'bound', binding: structuredClone(native!.binding) }));
      this.ready(attempt, signal);
      if (this.options.canStart && !this.options.canStart()) throw this.error(attempt, 'configuration', '首次 prompt 前配置已变化，尚未提交本次文本。');
      native.phase = 'active'; attempt.promptIssued = true;
      // No await after the last exact-connection and stop check.
      const prompt = connection.rpc.agent.request('session/prompt', { sessionId: native.binding.externalSessionID, prompt: [{ type: 'text', text: attempt.request.input }] });
      attempt.request.input = '';
      void prompt.then(response => this.complete(attempt, response), () => this.fail(attempt, this.error(attempt, 'network', 'ACP 原 prompt 未获得明确结束回执，不会重发。'))).catch(() => undefined);
      await this.enqueue(attempt, () => this.emit(attempt, { type: 'submitted' }));
      await this.wait(attempt.completed, attempt, signal, this.executionTimeout);
      await attempt.queue; this.ready(attempt, signal);
      if (!attempt.proof) throw this.error(attempt, 'protocol', 'ACP 原 prompt 没有明确终结事实。');
      await this.enqueue(attempt, () => this.emit(attempt, { type: 'settled', outcome: attempt.proof!.outcome, ...(attempt.proof!.reason ? { reason: attempt.proof!.reason } : {}) }));
      await attempt.queue; this.ready(attempt, signal);
      native.turns++;
      if (attempt.messageID) native.messageIDs.add(attempt.messageID);
      if (!this.blocked(native)) native.phase = attempt.proof.outcome === 'finished' || attempt.proof.outcome === 'cancelled' ? 'ready' : 'blocked';
    } catch (error) {
      attempt.localStopped = true;
      if (native) native.phase = 'blocked';
      // A connection can close while a delivered chunk is still being saved.
      // Drain it before the caller writes terminal facts, or the older save
      // can replace unknown with streaming and erase the failure observation.
      await attempt.queue;
      if (error instanceof ExecutionError) throw error;
      throw this.error(attempt, 'network', 'ACP 尝试未能确认完成，不会重新创建或提交。');
    } finally {
      attempt.localStopped = true; signal.removeEventListener('abort', abort); this.activeOwners.delete(ownerKey);
      if (native?.active === attempt) native.active = undefined;
    }
  }
  inspect(lookup: AcpSessionLookup): AcpSessionProof | undefined {
    const attempt = this.original(lookup); return attempt?.proof && structuredClone(attempt.proof);
  }
  async cancel(lookup: AcpSessionLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    const attempt = this.original(lookup, true);
    if (!attempt) return { status: 'unknown' };
    if (attempt.proof) return { status: attempt.proof.outcome === 'cancelled' ? 'confirmed' : 'unknown' };
    attempt.stopRequested = true;
    if (!attempt.promptIssued || !attempt.native) return { status: 'unknown' };
    try {
      this.current(attempt.connection);
      await this.wait(attempt.connection.rpc.agent.notify('session/cancel', { sessionId: attempt.native.binding.externalSessionID }), attempt, undefined, this.cancelTimeout);
      await this.wait(attempt.completed, attempt, undefined, this.cancelTimeout); this.current(attempt.connection);
      const confirmed = this.proof(attempt)?.outcome === 'cancelled';
      if (!confirmed && attempt.native.continuous) attempt.native.phase = 'blocked';
      return { status: confirmed ? 'confirmed' : 'unknown' };
    } catch { if (attempt.native?.continuous) attempt.native.phase = 'blocked'; return { status: 'unknown' }; }
  }
  private proof(attempt: Attempt): AcpSessionProof | undefined { return attempt.proof; }
  private blocked(native: NativeSession): boolean { return native.phase === 'blocked'; }
  private attempted(attempt: Attempt): boolean { return attempt.promptIssued || attempt.request.preparationCountsAsAttempt === true && attempt.preparationStarted; }
  private error(attempt: Attempt, code: ConstructorParameters<typeof ExecutionError>[0], message: string): ExecutionError { return new ExecutionError(code, message, this.attempted(attempt)); }
  private modelID(connection: OpenCodeAcpConnection): string { return `${connection.model.provider_id}/${connection.model.model_id}`; }
  private modelOption(options: SessionConfigOption[] | null | undefined, connection: OpenCodeAcpConnection, attempt?: Attempt): void {
    const invalid = () => attempt ? this.error(attempt, 'protocol', 'ACP 模型选择与冻结配置不一致。') : new ExecutionError('protocol', 'ACP 原上下文配置发生变化。', true);
    if (!Array.isArray(options) || options.length > 32) throw invalid();
    const selected = options.filter(option => option.id === 'model');
    if (selected.length !== 1 || selected[0].type !== 'select' || selected[0].currentValue !== this.modelID(connection)) throw invalid();
    const values = selected[0].options.flatMap(option => 'options' in option ? option.options.map(value => value.value) : [option.value]);
    if (values.length !== 1 || values[0] !== this.modelID(connection)) throw invalid();
    const mode = options.find(option => option.id === 'mode'); if (mode && (mode.type !== 'select' || mode.currentValue !== 'build')) throw invalid();
  }
  private current(expected: OpenCodeAcpConnection): void {
    let actual: OpenCodeAcpConnection; try { actual = this.getConnection(); } catch { throw new ExecutionError('configuration', '原 ACP 连接已失效，不会切换实例或重发。', false); }
    if (actual.rpc !== expected.rpc || actual.runtimeID !== expected.runtimeID || actual.connectionGeneration !== expected.connectionGeneration || actual.configDigest !== expected.configDigest || actual.directory !== expected.directory || actual.version !== expected.version || !acpSameModel(actual.model, expected.model)) throw new ExecutionError('configuration', '原 ACP 连接已失效，不会切换实例或重发。', false);
  }
  private ready(attempt: Attempt, signal?: AbortSignal): void {
    try { this.current(attempt.connection); } catch { throw this.error(attempt, 'configuration', '原 ACP 连接已失效，不会切换实例或重发。'); }
    if (attempt.failure) throw attempt.failure;
    if (signal?.aborted || attempt.localStopped || attempt.stopRequested && !attempt.promptIssued) throw this.error(attempt, 'cancelled', 'ACP 本地接收或提交准备已停止；远端结果需要明确核对。');
  }
  private key(connection: OpenCodeAcpConnection, value: string): string { return JSON.stringify([connection.runtimeID, connection.connectionGeneration, value]); }
  private bindingKey(binding: AgentChatBinding): string { return JSON.stringify([binding.runtimeID, binding.connectionGeneration, binding.externalSessionID]); }
  private sameBinding(a: AgentChatBinding, b: AgentChatBinding): boolean { return a.runtimeID === b.runtimeID && a.connectionGeneration === b.connectionGeneration && a.externalSessionID === b.externalSessionID; }
  private original(lookup: AcpSessionLookup, beforeBinding = false): Attempt | undefined {
    try {
      const connection = this.getConnection(); const attempt = this.attempts.get(this.key(connection, lookup.clientRequestID));
      if (!attempt || lookup.configDigest !== attempt.request.configDigest || lookup.configDigest !== connection.configDigest) return undefined;
      this.current(attempt.connection);
      if (!lookup.binding) return beforeBinding && !attempt.promptIssued ? attempt : undefined;
      if (!attempt.native || !this.sameBinding(attempt.native.binding, lookup.binding) || 'externalSubmissionID' in lookup.binding && lookup.binding.externalSubmissionID !== undefined) return undefined;
      return attempt;
    } catch { return undefined; }
  }
  private subscribe(connection: OpenCodeAcpConnection): void {
    const key = this.key(connection, 'subscription'); if (this.subscriptions.has(key)) return;
    const unsubscribe = connection.subscribe(async event => {
      const sessionID = event.type === 'session-update' ? event.notification.sessionId : event.request.sessionId;
      const native = this.sessions.get(this.bindingKey({ runtimeID: connection.runtimeID, connectionGeneration: connection.connectionGeneration, externalSessionID: sessionID }));
      if (!native) return;
      const active = native.active;
      if (active && !active.localStopped) return this.enqueue(active, () => this.update(active, event));
      if (!native.continuous) return; // Task records preserve their existing fresh-session observation contract.
      if (event.type === 'session-update' && ['usage_update', 'session_info_update', 'available_commands_update'].includes(event.notification.update.sessionUpdate)) return;
      if (event.type === 'session-update' && event.notification.update.sessionUpdate === 'config_option_update') { try { this.modelOption(event.notification.update.configOptions, connection); } catch (error) { native.phase = 'blocked'; throw error; } return; }
      native.phase = 'blocked';
      throw new ExecutionError('protocol', '已结束的 Agent 上下文收到迟到执行事件，不能继续该会话。', true);
    });
    this.subscriptions.set(key, unsubscribe);
    const closed = () => { unsubscribe(); this.subscriptions.delete(key); for (const session of this.sessions.values()) if (session.connection.rpc === connection.rpc) session.phase = 'blocked'; };
    connection.rpc.signal.addEventListener('abort', closed, { once: true }); if (connection.rpc.signal.aborted) closed();
  }
  private enqueue(attempt: Attempt, action: () => Promise<void>): Promise<void> {
    const work = attempt.queue.then(async () => { if (attempt.failure) throw attempt.failure; await action(); });
    attempt.queue = work.catch(error => { this.fail(attempt, error instanceof ExecutionError ? this.error(attempt, error.code, error.message) : this.error(attempt, 'protocol', 'ACP 事件未能保存，原尝试需要核对。')); });
    return work;
  }
  private async emit(attempt: Attempt, event: AcpSessionEvent): Promise<void> {
    if (attempt.localStopped || attempt.connection.rpc.signal.aborted) throw this.error(attempt, 'incomplete', 'ACP 原连接已停止。');
    this.ready(attempt); await attempt.onEvent(event);
  }
  private async update(attempt: Attempt, event: OpenCodeAcpEvent): Promise<void> {
    if (attempt.localStopped) return;
    this.ready(attempt);
    if (++attempt.updates > 4090) throw this.error(attempt, 'protocol', 'ACP 更新超过上限。');
    if (event.type === 'forbidden-permission') throw this.error(attempt, 'tools-forbidden', '无工具 ACP 尝试请求了工具许可，已拒绝继续。');
    const update = event.notification.update;
    if (attempt.request.continuous && attempt.proof && !['usage_update', 'session_info_update', 'available_commands_update', 'config_option_update', 'current_mode_update'].includes(update.sessionUpdate)) throw this.error(attempt, 'protocol', '原 prompt 终结后收到迟到执行事件，不能继续原 Agent 上下文。');
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (!attempt.promptIssued || update.content.type !== 'text' || typeof update.content.text !== 'string') throw this.error(attempt, 'protocol', 'ACP 文本事件无法归属原 prompt。');
      if (update.messageId != null) {
        if (!bounded(update.messageId) || attempt.messageID && attempt.messageID !== update.messageId || attempt.native!.messageIDs.has(update.messageId)) throw this.error(attempt, 'protocol', 'ACP 助手消息身份属于其他轮次。');
        attempt.messageID = update.messageId;
      } else if (attempt.request.continuous && attempt.native!.turns > 0) throw this.error(attempt, 'protocol', '连续 ACP 文本缺少可核对的新消息身份。');
      if (Buffer.byteLength(attempt.output) + Buffer.byteLength(update.content.text) > MAX_TEXT) throw this.error(attempt, 'protocol', 'ACP 输出超过上限。');
      if (update.content.text) { await this.emit(attempt, { type: 'text-delta', text: update.content.text }); attempt.output += update.content.text; } return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk') { if (update.content.type !== 'text' || Buffer.byteLength(update.content.text) > MAX_TEXT) throw this.error(attempt, 'protocol', 'ACP 思考事件无效。'); return; }
    if (update.sessionUpdate === 'config_option_update') { this.modelOption(update.configOptions, attempt.connection, attempt); return; }
    if (update.sessionUpdate === 'current_mode_update') { if (update.currentModeId !== 'build') throw this.error(attempt, 'protocol', 'ACP 模式已改变。'); return; }
    if (['usage_update', 'session_info_update', 'available_commands_update'].includes(update.sessionUpdate)) return;
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') throw this.error(attempt, 'tools-forbidden', '无工具 ACP 尝试报告了工具动作，已拒绝继续。');
    throw this.error(attempt, 'protocol', 'ACP 返回了不支持的替换、重放或执行事件。');
  }
  private async complete(attempt: Attempt, response: PromptResponse): Promise<void> {
    await attempt.queue;
    if (attempt.failure || !attempt.native) return;
    const stopReason = response?.stopReason;
    if (!['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(stopReason)) { this.fail(attempt, this.error(attempt, 'protocol', 'ACP 终结原因无法确认。')); return; }
    if (attempt.localStopped && stopReason !== 'cancelled') { attempt.finish(); return; }
    const common = { binding: structuredClone(attempt.native.binding), output: attempt.output };
    attempt.proof = stopReason === 'end_turn' ? { ...common, outcome: 'finished' } : stopReason === 'cancelled' ? { ...common, outcome: 'cancelled', reason: '原 ACP prompt 已明确报告取消。' } : { ...common, outcome: 'failed', reason: '原 ACP prompt 明确结束，但没有完整的正常回复。' };
    attempt.finish();
  }
  private fail(attempt: Attempt, error: ExecutionError): void { if (!attempt.failure) { attempt.failure = error; if (attempt.native) attempt.native.phase = 'blocked'; attempt.rejectFailure(error); } }
  private wait<T>(work: Promise<T>, attempt: Attempt, signal: AbortSignal | undefined, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stop = () => finish(this.error(attempt, 'cancelled', '已停止本地 ACP 接收，原尝试结果需要核对。'));
      const closed = () => finish(this.error(attempt, 'incomplete', 'ACP 原连接已关闭，结果未知；不会重连或重发。'));
      const timer = setTimeout(() => finish(this.error(attempt, 'timeout', 'ACP 等待已超时，原尝试结果需要核对。')), timeout);
      const finish = (error?: unknown, value?: T) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); attempt.connection.rpc.signal.removeEventListener('abort', closed); if (error) reject(error); else resolve(value!); };
      signal?.addEventListener('abort', stop, { once: true }); attempt.connection.rpc.signal.addEventListener('abort', closed, { once: true });
      void work.then(value => finish(undefined, value), () => finish(this.error(attempt, 'network', 'ACP 原请求未获得有效回执，不会重新提交。')));
      void attempt.failed.catch(error => finish(error));
      if (signal?.aborted) stop(); else if (attempt.connection.rpc.signal.aborted) closed();
    });
  }
}
