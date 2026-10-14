import { createHash, randomBytes } from 'node:crypto';
import type { ModelSelection } from '../shared/types.js';
import type { ExecutionLookup, ExternalExecutionBinding, ExternalObservation, TaskEventEnvelope, TaskExecutionRequest } from '../shared/task-execution.js';
import { ExecutionError } from './execution-driver.js';
import type { TaskExecutionDriver } from './task-execution-driver.js';

/** Private main-process connection. It contains no provider key and is never persisted. */
export interface OpenCodeConnection {
  baseURL: string;
  authorization: string;
  runtimeID: string;
  connectionGeneration: string;
  directory: string;
  version: string;
  configDigest: string;
  model: ModelSelection;
}
export interface OpenCodeAdapterOptions {
  getConnection: () => OpenCodeConnection | undefined | Promise<OpenCodeConnection | undefined>;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  executionTimeoutMs?: number;
  pollIntervalMs?: number;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const bounded = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f]/.test(value);
const nativeID = (value: unknown, prefix: string): value is string => bounded(value) && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const sameModel = (left: ModelSelection, right: ModelSelection) => left.provider_id === right.provider_id && left.model_id === right.model_id && left.variant === right.variant;
const protocol = () => new ExecutionError('protocol', 'OpenCode 返回的原尝试事实无法确认；不会重新提交。', true);
const denied = [{ permission: '*', pattern: '*', action: 'deny' }];
const MAX_JSON = 16 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

/** v1.19.0 only. /event is a notification stream; complete message snapshots are authoritative.
 * The project workspace reference is local authorization identity only. All requests use the
 * host's empty directory; this adapter never mounts or opens the selected project or materials.
 */
export class OpenCodeAdapter implements TaskExecutionDriver {
  readonly capabilities = Object.freeze({ chat: false, tools: false, remoteSessions: true, remoteAbort: true });
  readonly taskCapabilities = Object.freeze({ reconcile: true, confirmedCancel: true, permissionReply: false, enforcedToolScope: false });
  private readonly claimed = new Set<string>();
  constructor(private readonly options: OpenCodeAdapterOptions) {}
  async replyPermission(): Promise<{ status: 'accepted' | 'rejected' | 'unknown' }> { throw new ExecutionError('tools-forbidden', '此 OpenCode 连接没有工具许可能力。', false); }

  async executeTask(request: TaskExecutionRequest, onEvent: (event: TaskEventEnvelope) => Promise<void>, signal: AbortSignal): Promise<void> {
    const connection = await this.connection();
    if (request.spec.tools.kind !== 'none' || request.spec.materials.length || request.resolved.materials.length || request.spec.driver.mode !== 'external' || request.spec.driver.configDigest !== connection.configDigest || !sameModel(request.model, connection.model) || request.model.variant !== undefined || !request.input.trim() || Buffer.byteLength(request.input) > 256 * 1024) throw new ExecutionError('configuration', '此连接只接受当前模型、无工具、无附件的明确输入。', false);
    if (signal.aborted) throw new ExecutionError('cancelled', '首次外部调用前已停止。', false);
    const claim = `${connection.runtimeID}:${connection.connectionGeneration}:${request.clientRequestID}`;
    if (this.claimed.has(claim) || this.claimed.size >= 2000) throw new ExecutionError('configuration', '该本地调用已取得提交权或达到容量上限，不会再次提交。', false);
    this.claimed.add(claim); // In-process refusal only; this is not remote idempotency.
    const executionTimeout = this.duration(this.options.executionTimeoutMs, 180_000, 600_000);
    this.duration(this.options.requestTimeoutMs, 10_000, 60_000); this.duration(this.options.pollIntervalMs, 200, 5000);
    const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const totalTimer = setTimeout(abort, executionTimeout);
    let binding: ExternalExecutionBinding | undefined;
    let pump: Promise<void> | undefined;
    let failure: unknown;
    let sequence = 0;
    const emit = async (event: TaskEventEnvelope['event']) => {
      if (controller.signal.aborted) throw new ExecutionError('cancelled', '已停止本地 OpenCode 接收，远端结果需要核对。', true);
      const next = ++sequence;
      await onEvent({ eventID: `${request.turn.turnID}:${next}`, sequence: next, event });
    };
    try {
      const session = object(await this.json(connection, '/session', { method: 'POST', body: JSON.stringify({ title: 'ScreenDeck 无工具尝试', permission: denied }) }, controller.signal));
      this.session(session, connection);
      const sessionID = session!.id as string;
      const messages = await this.json(connection, `/session/${sessionID}/message`, {}, controller.signal);
      if (!Array.isArray(messages) || messages.length) throw protocol();
      // v1.19.0 PromptInput accepts a caller-selected msg_ ID. Persist it BEFORE any prompt.
      // Its timestamp prefix follows the official ascending ID layout; randomness is not a retry key.
      const stamp = (BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0');
      const submission = `msg_${stamp}${randomBytes(7).toString('hex')}`;
      binding = { runtimeID: connection.runtimeID, connectionGeneration: connection.connectionGeneration, externalSessionID: sessionID, externalSubmissionID: submission };
      await emit({ type: 'bound', binding: structuredClone(binding) });
      let ready!: () => void;
      let readyFailure!: (error: unknown) => void;
      const readiness = new Promise<void>((resolve, reject) => { ready = resolve; readyFailure = reject; });
      let notified = false;
      pump = this.events(connection, sessionID, controller.signal, error => { notified = true; if (error) failure = error; ready(); });
      // Immediately attach a rejection handler: a stream can close while prompt HTTP is in flight.
      void pump.catch(error => { failure = error; readyFailure(error); });
      await readiness;
      if (failure) throw failure;
      await this.json(connection, `/session/${sessionID}/prompt_async`, {
        method: 'POST', body: JSON.stringify({ messageID: submission, model: { providerID: request.model.provider_id, modelID: request.model.model_id }, tools: { '*': false }, parts: [{ type: 'text', text: request.input }] }),
      }, controller.signal, 204);
      await emit({ type: 'submitted', externalSubmissionID: submission });
      let output = '';
      let observed: ModelSelection | undefined;
      while (!controller.signal.aborted) {
        if (failure) throw failure;
        const snapshot = await this.snapshot(connection, binding, controller.signal, true);
        if (failure) throw failure;
        if (snapshot.status === 'unverifiable') throw protocol();
        if (!snapshot.output.startsWith(output)) throw protocol();
        const delta = snapshot.output.slice(output.length);
        if (delta) await emit({ type: 'text-delta', text: delta });
        output = snapshot.output;
        if (snapshot.observedModel && !observed) { observed = snapshot.observedModel; await emit({ type: 'observed-model', model: observed }); }
        else if (snapshot.observedModel && observed && !sameModel(snapshot.observedModel, observed)) throw protocol();
        if (snapshot.status === 'finished') { await emit({ type: 'settled', outcome: 'finished', result: snapshot.result }); return; }
        if (snapshot.status === 'failed' || snapshot.status === 'cancelled') { await emit({ type: 'settled', outcome: snapshot.status, reason: snapshot.reason }); return; }
        const delay = this.duration(this.options.pollIntervalMs, 200, 5000);
        if (!notified) await this.pause(delay, controller.signal);
        notified = false;
      }
      throw new ExecutionError('timeout', 'OpenCode 接收已停止，原尝试结果需要核对。', true);
    } catch (error) {
      // Save/callback failures also stop further side effects. Never send another prompt.
      if (error instanceof ExecutionError && error.code === 'tools-forbidden' && binding) await this.rejectUnexpected(connection, binding.externalSessionID);
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError('network', 'OpenCode 调用未能确认，原尝试需要核对；不会重新提交。', true);
    } finally {
      clearTimeout(totalTimer); signal.removeEventListener('abort', abort); controller.abort(); await pump?.catch(() => undefined);
    }
  }

  async inspectExecution(lookup: ExecutionLookup): Promise<ExternalObservation> {
    try {
      const connection = await this.connection();
      if (!this.matches(lookup, connection)) return { status: 'unverifiable', reason: '原 OpenCode 实例或提交绑定无法确认。' };
      return await this.snapshot(connection, lookup.binding!);
    } catch { return { status: 'unverifiable', reason: '无法查询原 OpenCode 尝试，不会重新创建或提交。' }; }
  }
  async cancelExecution(lookup: ExecutionLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    try {
      const connection = await this.connection();
      if (!this.matches(lookup, connection)) return { status: 'unknown' };
      const before = await this.snapshot(connection, lookup.binding!);
      if (before.status === 'cancelled') return { status: 'confirmed' };
      if (before.status !== 'running') return { status: 'unknown' };
      const accepted = await this.json(connection, `/session/${lookup.binding!.externalSessionID}/abort`, { method: 'POST' });
      if (accepted !== true) return { status: 'unknown' };
      // HTTP true and session idle do not prove the original submission was cancelled.
      const after = await this.snapshot(connection, lookup.binding!);
      return { status: after.status === 'cancelled' ? 'confirmed' : 'unknown' };
    } catch { return { status: 'unknown' }; }
  }

  private async connection(): Promise<OpenCodeConnection> {
    const connection = await this.options.getConnection();
    let url: URL;
    try { url = new URL(connection?.baseURL ?? ''); } catch { throw new ExecutionError('configuration', '受控 OpenCode 连接尚未就绪。', false); }
    if (!connection || connection.version !== '1.19.0' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !bounded(connection.authorization, 4096) || !connection.authorization.startsWith('Basic ') || !bounded(connection.runtimeID) || !bounded(connection.connectionGeneration) || !bounded(connection.configDigest) || !bounded(connection.directory, 4096) || !connection.directory.startsWith('/') || !bounded(connection.model.provider_id) || !bounded(connection.model.model_id) || connection.model.variant !== undefined) throw new ExecutionError('configuration', 'OpenCode 连接不符合已核验的本地版本与身份。', false);
    return structuredClone(connection);
  }
  private async current(expected: OpenCodeConnection): Promise<void> {
    let actual: OpenCodeConnection;
    try { actual = await this.connection(); } catch { throw new ExecutionError('configuration', '原 OpenCode 连接已失效，不会切换实例或重发。', true); }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ExecutionError('configuration', '原 OpenCode 连接已失效，不会切换实例或重发。', true);
  }
  private matches(lookup: ExecutionLookup, connection: OpenCodeConnection): boolean {
    const binding = lookup.binding;
    return lookup.driver.mode === 'external' && lookup.driver.configDigest === connection.configDigest && !!binding && binding.runtimeID === connection.runtimeID && binding.connectionGeneration === connection.connectionGeneration && nativeID(binding.externalSessionID, 'ses') && nativeID(binding.externalSubmissionID, 'msg');
  }
  private session(session: ObjectValue | undefined, connection: OpenCodeConnection, expectedID?: string): void {
    const rules = session?.permission;
    const rule = Array.isArray(rules) && rules.length === 1 ? object(rules[0]) : undefined;
    if (!session || !nativeID(session.id, 'ses') || expectedID && session.id !== expectedID || session.directory !== connection.directory || session.parentID !== undefined || !rule || rule.permission !== '*' || rule.pattern !== '*' || rule.action !== 'deny') throw protocol();
  }
  private duration(value: number | undefined, fallback: number, maximum: number): number {
    const duration = value ?? fallback;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > maximum) throw new ExecutionError('configuration', 'OpenCode 超时配置无效。', false);
    return duration;
  }
  private async json(connection: OpenCodeConnection, path: string, init: RequestInit = {}, signal?: AbortSignal, expectedStatus = 200): Promise<unknown> {
    await this.current(connection);
    const url = new URL(path, connection.baseURL); url.searchParams.set('directory', connection.directory);
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.duration(this.options.requestTimeoutMs, 10_000, 60_000));
    try {
      if (controller.signal.aborted) throw new ExecutionError('cancelled', '外部请求前已停止。', true);
      const response = await (this.options.fetch ?? globalThis.fetch)(url, { ...init, redirect: 'error', signal: controller.signal, headers: { Authorization: connection.authorization, Accept: 'application/json', 'Content-Type': 'application/json' } });
      if (response.status !== expectedStatus || response.redirected || response.url && new URL(response.url).origin !== url.origin) throw new ExecutionError('http', 'OpenCode 请求未获得预期回执。', true);
      if (expectedStatus === 204) return undefined;
      if (!response.headers.get('content-type')?.includes('application/json')) throw protocol();
      const bytes = await this.body(response, MAX_JSON);
      await this.current(connection);
      try { return JSON.parse(bytes); } catch { throw protocol(); }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  private async body(response: Response, maximum: number): Promise<string> {
    if (!response.body) throw protocol(); const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let text = ''; let count = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.length; if (count > maximum) throw protocol(); text += decoder.decode(chunk.value, { stream: true }); } return text + decoder.decode(); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private async snapshot(connection: OpenCodeConnection, binding: ExternalExecutionBinding, signal?: AbortSignal, awaitingAcceptedPrompt = false): Promise<ExternalObservation> {
    const sessionID = binding.externalSessionID;
    this.session(object(await this.json(connection, `/session/${sessionID}`, {}, signal)), connection, sessionID);
    const value = await this.json(connection, `/session/${sessionID}/message`, {}, signal);
    if (!Array.isArray(value) || value.length > 32) throw protocol();
    const messages = value.map(raw => { const entry = object(raw); const info = object(entry?.info); if (!entry || !info || info.sessionID !== sessionID || !Array.isArray(entry.parts) || entry.parts.length > 256) throw protocol(); return { info, parts: entry.parts }; });
    if (messages.some(entry => entry.parts.some(raw => object(raw)?.type === 'tool'))) throw new ExecutionError('tools-forbidden', '无工具尝试报告了工具动作，已拒绝继续执行。', true);
    const users = messages.filter(entry => entry.info.role === 'user');
    if (users.length === 0 && messages.length === 0 && awaitingAcceptedPrompt) return { binding: structuredClone(binding), output: '', permissionReceipts: [], status: 'running' };
    if (users.length !== 1 || users[0].info.id !== binding.externalSubmissionID) return { status: 'unverifiable', reason: '原提交消息不存在或外部会话上下文发生变化。' };
    const assistants = messages.filter(entry => entry.info.role === 'assistant');
    if (messages.length !== users.length + assistants.length || assistants.length > 1 || assistants.some(entry => entry.info.parentID !== binding.externalSubmissionID)) throw protocol();
    const base = { binding: structuredClone(binding), output: '', permissionReceipts: [] };
    if (!assistants.length) {
      const statuses = object(await this.json(connection, '/session/status', {}, signal));
      const status = object(statuses?.[sessionID]);
      return awaitingAcceptedPrompt || status && ['busy', 'retry'].includes(String(status.type)) ? { ...base, status: 'running' } : { status: 'unverifiable', reason: '原提交没有明确助手终结事实，idle 不是完成。' };
    }
    const { info, parts } = assistants[0]; let output = '';
    if (!nativeID(info.id, 'msg')) throw protocol();
    for (const raw of parts) {
      const part = object(raw); if (!part || part.sessionID !== sessionID || part.messageID !== info.id || !bounded(part.type)) throw protocol();
      if (part.type === 'text' && part.ignored !== true) { if (typeof part.text !== 'string') throw protocol(); output += part.text; }
      else if (!['reasoning', 'step-start', 'step-finish', 'snapshot', 'patch', 'text'].includes(part.type as string)) throw protocol();
    }
    if (Buffer.byteLength(output) > MAX_TEXT || !bounded(info.providerID) || !bounded(info.modelID)) throw protocol();
    const time = object(info.time);
    if (typeof time?.created !== 'number' || !Number.isFinite(time.created) || time.created <= 0 || time.completed !== undefined && (typeof time.completed !== 'number' || !Number.isFinite(time.completed) || time.completed < time.created)) throw protocol();
    const completed = typeof time.completed === 'number';
    const common = { ...base, output, observedModel: { provider_id: info.providerID, model_id: info.modelID } };
    const error = object(info.error);
    if (info.error !== undefined && (!error || !['ProviderAuthError', 'UnknownError', 'MessageOutputLengthError', 'MessageAbortedError', 'StructuredOutputError', 'ContextOverflowError', 'ContentFilterError', 'APIError'].includes(String(error.name)))) throw protocol();
    if (error && completed) return { ...common, status: error.name === 'MessageAbortedError' ? 'cancelled' : 'failed', reason: error.name === 'MessageAbortedError' ? '原 OpenCode 提交已明确中止。' : '原 OpenCode 提交返回明确错误。' };
    if (completed && info.finish === 'stop') return { ...common, status: 'finished', result: { summary: '无工具 OpenCode 回复已结束；没有工作区变更或执行产物。', artifacts: [], evidence: [] } };
    if (completed && ['length', 'content-filter'].includes(String(info.finish))) return { ...common, status: 'failed', reason: '原 OpenCode 回复未完整结束。' };
    if (info.finish === 'tool-calls') throw new ExecutionError('tools-forbidden', '无工具尝试返回了工具终结标记。', true);
    if (completed || info.finish !== undefined && !['stop', 'unknown'].includes(String(info.finish))) throw protocol();
    return { ...common, status: 'running' };
  }
  private async events(connection: OpenCodeConnection, sessionID: string, signal: AbortSignal, notify: (error?: unknown) => void): Promise<void> {
    await this.current(connection);
    const url = new URL('/event', connection.baseURL); url.searchParams.set('directory', connection.directory);
    const readinessController = new AbortController();
    const timer = setTimeout(() => readinessController.abort(), this.duration(this.options.requestTimeoutMs, 10_000, 60_000));
    const streamSignal = AbortSignal.any([signal, readinessController.signal]);
    const response = await (this.options.fetch ?? globalThis.fetch)(url, { headers: { Authorization: connection.authorization, Accept: 'text/event-stream' }, redirect: 'error', signal: streamSignal }).catch(error => { clearTimeout(timer); throw error; });
    if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== url.origin || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) { clearTimeout(timer); await response.body?.cancel().catch(() => undefined); throw protocol(); }
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); const seen = new Map<string, string>(); let buffer = ''; let bytes = 0; let connected = false;
    const stopReader = () => { void reader.cancel().catch(() => undefined); };
    streamSignal.addEventListener('abort', stopReader, { once: true }); if (streamSignal.aborted) stopReader();
    try {
      while (!signal.aborted) {
        const chunk = await reader.read(); if (chunk.done) throw new ExecutionError('incomplete', 'OpenCode 事件连接已关闭，原尝试需要核对。', true);
        bytes += chunk.value.length; if (bytes > MAX_JSON) throw protocol(); buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, end); const separator = /^\r?\n\r?\n/.exec(buffer.slice(end))![0]; buffer = buffer.slice(end + separator.length);
          const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!payload) continue;
          let event: ObjectValue | undefined; try { event = object(JSON.parse(payload)); } catch { throw protocol(); }
          if (!event || !bounded(event.id) || !bounded(event.type) || !object(event.properties)) throw protocol();
          const digest = createHash('sha256').update(payload).digest('hex'); const previous = seen.get(event.id);
          if (previous) { if (previous !== digest) throw protocol(); continue; }
          if (seen.size >= 4096) throw protocol(); seen.set(event.id, digest);
          if (event.type === 'server.connected') { if (connected) throw protocol(); connected = true; clearTimeout(timer); notify(); continue; }
          if (!connected || event.type === 'server.instance.disposed') throw protocol();
          const properties = object(event.properties)!;
          if (properties.sessionID !== sessionID) continue;
          if (event.type === 'permission.asked' || event.type === 'permission.v2.asked' || event.type === 'question.asked' || (String(event.type).startsWith('session.next.tool.')) || object(properties.part)?.type === 'tool') {
            const error = new ExecutionError('tools-forbidden', '无工具尝试报告了工具或许可请求，已拒绝继续执行。', true); notify(error);
            if (event.type === 'permission.asked' && nativeID(properties.id, 'per')) await this.json(connection, `/permission/${properties.id}/reply`, { method: 'POST', body: JSON.stringify({ reply: 'reject' }) }).catch(() => undefined);
            throw error;
          }
          if (event.type === 'message.updated' || event.type === 'message.part.updated' || event.type === 'message.part.delta' || event.type === 'session.status' || event.type === 'session.idle' || event.type === 'session.error') notify();
        }
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw protocol();
      }
    } finally { clearTimeout(timer); streamSignal.removeEventListener('abort', stopReader); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private async rejectUnexpected(connection: OpenCodeConnection, sessionID: string): Promise<void> {
    await this.json(connection, `/session/${sessionID}/abort`, { method: 'POST' }).catch(() => undefined);
  }
  private async pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, milliseconds); signal.addEventListener('abort', done, { once: true }); });
  }
}
