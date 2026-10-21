import { autoApproveCodexChange } from '../permission-policy.js';
import { codexPermissionPolicy } from '../../../shared/agent-permissions.js';
import { NativePermissionRequests, nativeText, nativeToolKind } from '../native-tools.js';
import { NATIVE_AGENT_CAPABILITIES, TEXT_AGENT_CAPABILITIES } from '../../../shared/agent-capabilities.js';
import type { AgentChatReadySource, AgentChatBinding } from '../../../shared/agent-chat.js';
import type { AgentChatDriver, AgentChatRequest, AgentChatLookup, AgentChatExecutionEvent } from '../../sessions/agent-chat-driver.js';
import { ExecutionError } from '../../sessions/execution-driver.js';
import { codexObject, codexID, type CodexConnection, type CodexNotification } from './codex-connection.js';
interface NativeSession { connection: CodexConnection; binding: AgentChatBinding; executionKey: string; blocked: boolean; busy: boolean }
interface Attempt { native: NativeSession; turnID?: string; outcome: Promise<string>; started: Promise<void>; settled?: string }
/** One ScreenDeck conversation → one live Codex thread. No replay, resume or default-agent fallback. */
export class CodexAgentChatAdapter implements AgentChatDriver {
  readonly descriptor = Object.freeze({ agentID: 'codex', name: 'Codex', protocol: 'native' as const, capabilities: TEXT_AGENT_CAPABILITIES });
  private permissions = new NativePermissionRequests();
  private sessions = new Map<string, NativeSession>();
  private attempts = new Map<string, Attempt>();
  constructor(private options: { getConnection(): CodexConnection | undefined; turnTimeoutMs?: number; cancelTimeoutMs?: number; nativeTools?: boolean }) { if (options.nativeTools) this.descriptor = Object.freeze({ ...this.descriptor, capabilities: NATIVE_AGENT_CAPABILITIES }); }
  getSource(): AgentChatReadySource | undefined {
    const c = this.options.getConnection();
    return c ? { ...this.descriptor, state: 'ready', configDigest: c.configDigest, runtimeID: c.runtimeID, connectionGeneration: c.connectionGeneration, model: { ...c.model } } : undefined;
  }
  async sendTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const c = this.options.getConnection();
    const valid = () => this.options.getConnection() === c && c && request.source.agentID === 'codex' && request.source.configDigest === c.configDigest && request.model.provider_id === c.model.provider_id && request.model.model_id === c.model.model_id && !request.model.variant;
    if (!c || !valid() || signal.aborted || this.attempts.has(request.clientRequestID)) throw new ExecutionError('configuration', 'Codex 来源已失效，请检查连接或新建聊天。', false);
    const executionKey = JSON.stringify(request.execution ?? null);
    const policy = codexPermissionPolicy(request.execution?.mode);
    let native = this.sessions.get(request.sessionID);
    if (request.binding) {
      if (!native || native.executionKey !== executionKey || native.connection !== c || native.binding.runtimeID !== request.binding.runtimeID || native.binding.connectionGeneration !== request.binding.connectionGeneration || native.binding.externalSessionID !== request.binding.externalSessionID) throw new ExecutionError('configuration', '原 Codex 线程不可用，请明确新建聊天。', false);
    } else {
      if (native) throw new ExecutionError('configuration', 'Codex 原线程缺少绑定，不能自动重建。', false);
      let started: Record<string, unknown>;
      try { started = codexObject(await c.request('thread/start', { cwd: request.execution?.workspace.path ?? c.directory, model: c.model.model_id, approvalPolicy: policy.approval, sandbox: policy.sandbox, ephemeral: true })); }
      catch { throw new ExecutionError('configuration', 'Codex 线程未能建立，请检查登录。', false); }
      if (started.model !== c.model.model_id || started.modelProvider !== c.model.provider_id || started.approvalPolicy !== (policy.approval) || (codexObject(started.sandbox).type !== policy.type || (policy.type !== 'dangerFullAccess' && codexObject(started.sandbox).networkAccess !== false))) throw new ExecutionError('configuration', 'Codex 实际模型或执行边界不匹配。', false);
      if (request.execution && (started.cwd !== request.execution.workspace.path || policy.type === 'workspaceWrite' && (!Array.isArray(codexObject(started.sandbox).writableRoots) || (codexObject(started.sandbox).writableRoots as unknown[]).some(root => typeof root !== 'string' || !(c.ownedWriteRoots ?? []).includes(root)) || codexObject(started.sandbox).excludeSlashTmp !== true || codexObject(started.sandbox).excludeTmpdirEnvVar !== true))) throw new ExecutionError('configuration', 'Codex 实际工作目录或额外写入范围不匹配。', false);
      const binding = { runtimeID: c.runtimeID, connectionGeneration: c.connectionGeneration, externalSessionID: codexID(codexObject(started.thread).id) };
      native = { connection: c, binding, executionKey, blocked: false, busy: false }; this.sessions.set(request.sessionID, native);
      try { await onEvent({ type: 'bound', binding }); }
      catch { native.blocked = true; throw new ExecutionError('configuration', 'Codex 线程绑定未能保存，本轮未发送。', false); }
    }
    if (!valid() || native.blocked || native.busy || signal.aborted) throw new ExecutionError('configuration', 'Codex 原线程正在运行或状态不明。', false);
    native.busy = true;
    const session = native; let attempted = false, accepting = true, queue = Promise.resolve();
    let complete!: (value: string) => void;
    const outcome = new Promise<string>(resolve => { complete = resolve; });
    let releaseStarted!: () => void; const started = new Promise<void>(resolve => { releaseStarted = resolve; });
    const attempt: Attempt = { native, outcome, started }; this.attempts.set(request.clientRequestID, attempt);
    const finish = (value: string) => { if (attempt.settled) return; attempt.settled = value; complete(value); };
    const enqueue = (event: AgentChatExecutionEvent) => { queue = queue.then(() => onEvent(event)); void queue.catch(() => finish('unknown')); };
    const lookup = (): AgentChatLookup => ({ clientRequestID: request.clientRequestID, source: request.source, binding: session.binding });
    const fileChanges = new Map<string, unknown>();
    const itemDetails = new Map<string, string>(), completeDetails = new Set<string>();
    const early: CodexNotification[] = [];
    const handle = (event: CodexNotification) => {
      if (!accepting || attempt.settled) return;
      if (event.method === 'screendeck/disconnected' || event.method === 'screendeck/unsupported-request' || event.method === 'account/updated') { finish('unknown'); return; }
      const p = event.params;
      if (p.threadId !== session.binding.externalSessionID) return;
      if (!attempt.turnID) { if (early.length >= 1024) finish('unknown'); else early.push(event); return; }
      const turn = event.method === 'turn/completed' ? codexObject(p.turn) : undefined;
      if ((turn ? turn.id : p.turnId) !== attempt.turnID) return;
      if (event.method === 'item/agentMessage/delta') {
        if (typeof p.delta !== 'string') { finish('unknown'); return; }
        enqueue({ type: 'text-delta', text: p.delta });
      } else if (event.method === 'item/started' || event.method === 'item/completed') {
        const item = codexObject(p.item);
        if (request.execution && ['commandExecution', 'fileChange', 'mcpToolCall', 'imageView', 'webSearch', 'dynamicToolCall'].includes(String(item.type))) {
          const kind = nativeToolKind(item.type);
          const fullDetail = item.type === 'fileChange' ? JSON.stringify(item.changes ?? []) : String(item.command ?? item.path ?? item.tool ?? '');
          const detail = nativeText(fullDetail, 16384);
          if (item.type === 'fileChange') fileChanges.set(codexID(item.id), item.changes);
          itemDetails.set(codexID(item.id), detail); if (fullDetail && Buffer.byteLength(fullDetail) <= 16384) completeDetails.add(codexID(item.id)); else completeDetails.delete(codexID(item.id));
          enqueue({ type: 'tool', tool: { id: codexID(item.id), title: kind === 'command' ? '执行命令' : kind === 'write' ? '修改文件' : item.type === 'imageView' ? '读取图片' : '原生工具', kind, status: event.method === 'item/started' ? 'running' : ['failed', 'declined'].includes(String(item.status)) || typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' : 'completed', detail, ...(item.aggregatedOutput ? { output: nativeText(item.aggregatedOutput, 32768), truncated: Buffer.byteLength(String(item.aggregatedOutput)) > 32768 } : {}) } });
          return;
        }
        if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(String(item.type))) finish('unknown');
      } else if (request.execution && event.method === 'item/commandExecution/outputDelta') {
        enqueue({ type: 'tool', tool: { id: codexID(p.itemId), title: '执行命令', kind: 'command', status: 'running', output: nativeText(p.delta, 32768), ...(Buffer.byteLength(String(p.delta ?? '')) > 32768 ? { truncated: true } : {}) }, appendOutput: true });
      } else if (turn) finish(turn.status === 'completed' ? 'finished' : turn.status === 'interrupted' ? 'cancelled' : turn.status === 'failed' ? 'failed' : 'unknown');
    };
    const unsubscribe = c.subscribe(handle);
    const removeRequests = request.execution && c.onServerRequest ? c.onServerRequest((method, params) => {
      if (params.threadId !== session.binding.externalSessionID || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return undefined;
      return (async () => {
        await attempt.started;
        if (!accepting || attempt.settled || params.turnId !== attempt.turnID) return { decision: 'cancel' };
        const command = method === 'item/commandExecution/requestApproval';
        const rawDetail = [command ? params.command : itemDetails.get(String(params.itemId)), params.cwd, params.reason, params.grantRoot ? '请求扩大目录权限；本版不提供持久目录授权。' : ''].filter(Boolean).join('\n');
        const canAllow = request.execution!.mode !== 'read-only' && !params.grantRoot && (command ? typeof params.command === 'string' && !!params.command.trim() : completeDetails.has(String(params.itemId))) && Buffer.byteLength(rawDetail) <= 16384;
        const automatic = !command && canAllow && await autoApproveCodexChange(request.execution!, fileChanges.get(String(params.itemId)));
        const allowed = await this.permissions.ask(lookup(), { toolID: codexID(params.itemId), title: command ? '执行命令需要批准' : '修改文件需要批准', detail: nativeText(rawDetail, 16384), canAllow }, event => { enqueue(event); return queue; }, 600_000, automatic);
        return { decision: allowed ? 'accept' : 'decline' };
      })();
    }) : undefined;
    const timeout = setTimeout(() => finish('unknown'), this.options.turnTimeoutMs ?? 300_000);
    const abort = () => { void this.cancelTurn({ clientRequestID: request.clientRequestID, source: request.source, binding: native.binding }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await onEvent({ type: 'submitted' });
      if (!valid() || signal.aborted) throw new ExecutionError('configuration', 'Codex 连接已变化，本轮未发送。', false);
      attempted = true;
      const response = codexObject(await c.request('turn/start', { threadId: native.binding.externalSessionID, model: c.model.model_id, input: [{ type: 'text', text: request.input, text_elements: [] }] }));
      attempt.turnID = codexID(codexObject(response.turn).id); releaseStarted();
      for (const event of early) handle(event); early.length = 0;
      if (signal.aborted) abort();
      const result = await outcome;
      accepting = false; await queue;
      if (result === 'unknown') { session.blocked = true; throw new ExecutionError('incomplete', 'Codex 本轮结果尚未确认，未自动重发。', true); }
      await onEvent({ type: 'settled', outcome: result as 'finished' | 'failed' | 'cancelled', ...(result === 'failed' ? { reason: 'Codex 本轮执行失败，请检查账户配额或网络。' } : {}) });
    } catch (error) {
      accepting = false; if (attempted) session.blocked = true;
      try { await queue; } catch { /* Caller handles local write failure. */ }
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError('network', 'Codex 连接或记录未确认，请先检查状态。', attempted);
    } finally {
      accepting = false; releaseStarted(); this.permissions.cancel(lookup()); removeRequests?.(); unsubscribe(); clearTimeout(timeout); signal.removeEventListener('abort', abort); native.busy = false;
      if (attempt.settled !== 'cancelled') this.attempts.delete(request.clientRequestID);
      // Retain only the bounded latest cancellation receipt per live conversation.
      for (const [id, value] of this.attempts) if (id !== request.clientRequestID && value.native === native && value.settled) this.attempts.delete(id);
    }
  }
  replyPermission(lookup: AgentChatLookup, approvalID: string, decision: 'allow' | 'deny') { const current = this.getSource(); if (decision === 'allow' && (!current || current.configDigest !== lookup.source.configDigest || current.runtimeID !== lookup.binding?.runtimeID || current.connectionGeneration !== lookup.binding?.connectionGeneration)) return Promise.resolve({ status: 'unknown' as const }); return this.permissions.reply(lookup, approvalID, decision); }
  async cancelTurn(lookup: AgentChatLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    this.permissions.cancel(lookup);
    const attempt = this.attempts.get(lookup.clientRequestID);
    if (!attempt || lookup.source.agentID !== 'codex' || lookup.source.configDigest !== attempt.native.connection.configDigest || !lookup.binding || Object.entries(attempt.native.binding).some(([key, value]) => lookup.binding![key as keyof AgentChatBinding] !== value)) return { status: 'unknown' };
    if (attempt.settled === 'cancelled') return { status: 'confirmed' };
    if (!attempt.turnID && !attempt.settled) {
      let timer!: ReturnType<typeof setTimeout>;
      await Promise.race([attempt.started, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.cancelTimeoutMs ?? 4000); })]); clearTimeout(timer);
    }
    if (attempt.settled === 'cancelled') return { status: 'confirmed' };
    if (!attempt.turnID || attempt.settled) return { status: 'unknown' };
    try {
      await attempt.native.connection.request('turn/interrupt', { threadId: attempt.native.binding.externalSessionID, turnId: attempt.turnID });
      let timer!: ReturnType<typeof setTimeout>;
      const result = await Promise.race([attempt.outcome, new Promise<string>(resolve => { timer = setTimeout(() => resolve('unknown'), this.options.cancelTimeoutMs ?? 4000); })]);
      clearTimeout(timer); return { status: result === 'cancelled' ? 'confirmed' : 'unknown' };
    } catch { return { status: 'unknown' }; }
  }
}
