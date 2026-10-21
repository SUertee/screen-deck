import { autoApproveOpenCode } from '../permission-policy.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { NATIVE_AGENT_CAPABILITIES } from '../../../shared/agent-capabilities.js';
import type { AgentChatBinding } from '../../../shared/agent-chat.js';
import type { AgentChatDriver, AgentChatRequest, AgentChatLookup, AgentChatExecutionEvent } from '../../sessions/agent-chat-driver.js';
import { ExecutionError } from '../../sessions/execution-driver.js';
import type { OpenCodeAcpConnection } from './opencode-acp-connection.js';
import { NativePermissionRequests, nativeText, nativeToolKind } from '../native-tools.js';
interface NativeSession { connection: OpenCodeAcpConnection; binding: AgentChatBinding; executionKey: string; blocked: boolean; busy: boolean }
interface Attempt { session: NativeSession; request: AgentChatRequest; cancel?: () => Promise<boolean> }
/** Native tools use OpenCode's own permissions and I/O; this adapter does not provide ACP fs/terminal. */
export class OpenCodeNativeChatAdapter implements AgentChatDriver {
  readonly descriptor = Object.freeze({ agentID: 'opencode', name: 'OpenCode', protocol: 'acp' as const, capabilities: NATIVE_AGENT_CAPABILITIES });
  private sessions = new Map<string, NativeSession>();
  private attempts = new Map<string, Attempt>();
  private permissions = new NativePermissionRequests();
  constructor(private options: { getConnection(): OpenCodeAcpConnection | undefined; canStart?: () => boolean; cancelTimeoutMs?: number }) {}
  getSource() { const c = this.options.getConnection(); return c?.nativeTools && (!this.options.canStart || this.options.canStart()) ? { ...this.descriptor, state: 'ready' as const, configDigest: c.configDigest, runtimeID: c.runtimeID, connectionGeneration: c.connectionGeneration, model: { ...c.model } } : undefined; }
  async sendTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const c = this.options.getConnection(), ready = this.getSource();
    if (!c || !ready || !request.execution || !c.onPermission || request.source.agentID !== 'opencode' || request.source.configDigest !== c.configDigest || request.model.provider_id !== c.model.provider_id || request.model.model_id !== c.model.model_id || signal.aborted) throw new ExecutionError('configuration', 'OpenCode 原生工作区连接不可用。', false);
    const executionKey = JSON.stringify(request.execution ?? null);
    let session = this.sessions.get(request.sessionID);
    if (request.binding) {
      if (!session || session.executionKey !== executionKey || session.connection !== c || Object.entries(request.binding).some(([key, value]) => session!.binding[key as keyof AgentChatBinding] !== value)) throw new ExecutionError('configuration', 'OpenCode 原生绑定已失效，请新建聊天。', false);
    } else {
      if (session) throw new ExecutionError('configuration', '不能重新创建原 OpenCode 会话。', false);
      const created = await c.rpc.agent.request('session/new', { cwd: request.execution.workspace.path, mcpServers: [] });
      const binding = { runtimeID: c.runtimeID, connectionGeneration: c.connectionGeneration, externalSessionID: created.sessionId };
      session = { connection: c, binding, executionKey, blocked: false, busy: false }; this.sessions.set(request.sessionID, session);
      const configured = await c.rpc.agent.request('session/set_config_option', { sessionId: created.sessionId, configId: 'model', value: `${c.model.provider_id}/${c.model.model_id}` });
      const selected = configured.configOptions?.find(option => option.category === 'model');
      if (!selected || selected.type !== 'select' || selected.currentValue !== `${c.model.provider_id}/${c.model.model_id}`) { session.blocked = true; throw new ExecutionError('configuration', 'OpenCode 实际模型不匹配。', false); }
      try { await onEvent({ type: 'bound', binding }); } catch (error) { session.blocked = true; throw error; }
    }
    if (session.blocked || session.busy || this.options.getConnection() !== c || !this.getSource() || signal.aborted) throw new ExecutionError('configuration', 'OpenCode 原上下文不可继续。', false);
    const native = session; native.busy = true;
    let queue = Promise.resolve(), accepting = true, submitted = false, settled: string | undefined;
    let complete!: (value: string) => void; const outcome = new Promise<string>(resolve => { complete = resolve; });
    const finish = (value: string) => { if (!settled) { settled = value; complete(value); } };
    const lookup = (): AgentChatLookup => ({ clientRequestID: request.clientRequestID, source: request.source, binding: native.binding });
    const enqueue = (event: AgentChatExecutionEvent) => { const next = queue.then(() => onEvent(event)); queue = next; void next.catch(() => finish('unknown')); return next; };
    const attempt: Attempt = { session: native, request }; this.attempts.set(request.clientRequestID, attempt);
    const toolMetadata = new Map<string, { title: string; kind: import('../../../shared/agent-execution.js').AgentToolActivity['kind'] }>();
    const unsubscribe = c.subscribe(async event => {
      if (!accepting || settled || event.type !== 'session-update' || event.notification.sessionId !== native.binding.externalSessionID) return;
      const update = event.notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') { await enqueue({ type: 'text-delta', text: update.content.text }); return; }
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
      const data = update as unknown as Record<string, unknown>;
      const contents = Array.isArray(data.content) ? data.content : [];
      const output = contents.map(item => { const row = item as Record<string, unknown>; const content = row.content as Record<string, unknown> | undefined; return row.type === 'content' ? nativeText(content?.text, 32768) : row.type === 'diff' ? nativeText(JSON.stringify({ path: row.path, oldText: row.oldText, newText: row.newText }), 32768) : ''; }).join('\n');
      const toolID = nativeText(data.toolCallId, 256), old = toolMetadata.get(toolID);
      const title = nativeText(data.title, 1024) || old?.title || 'OpenCode 工具', kind = data.kind ? nativeToolKind(data.kind) : old?.kind ?? 'other'; toolMetadata.set(toolID, { title, kind });
      await enqueue({ type: 'tool', tool: { id: toolID, title, kind, status: data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'failed' : data.status === 'pending' ? 'pending' : 'running', ...(output ? { output } : {}) } });
    });
    const removePermission = c.onPermission((permission: RequestPermissionRequest): Promise<RequestPermissionResponse> | undefined => {
      if (permission.sessionId !== native.binding.externalSessionID || !accepting || settled) return undefined;
      return (async () => {
        const allow = permission.options.find(option => option.kind === 'allow_once'), deny = permission.options.find(option => option.kind === 'reject_once');
        const tool = permission.toolCall as unknown as Record<string, unknown>;
        const rawDetail = JSON.stringify(tool.rawInput ?? tool.locations ?? {});
        const automatic = await autoApproveOpenCode(request.execution!, tool);
        const allowed = await this.permissions.ask(lookup(), { toolID: nativeText(tool.toolCallId, 256), title: nativeText(tool.title, 1024) || 'OpenCode 操作需要批准', detail: nativeText(rawDetail, 16384), canAllow: !!allow && request.execution!.mode !== 'read-only' && Buffer.byteLength(rawDetail) <= 16384 }, enqueue, 600_000, automatic);
        return { outcome: allowed && allow ? { outcome: 'selected', optionId: allow.optionId } : deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
      })();
    });
    const closed = () => finish('unknown'); c.rpc.signal.addEventListener('abort', closed, { once: true });
    const abort = () => { this.permissions.cancel(lookup()); void attempt.cancel?.(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => finish('unknown'), 600_000);
    try {
      await enqueue({ type: 'submitted' });
      if (this.options.getConnection() !== c || !this.getSource() || signal.aborted) throw new ExecutionError('configuration', 'OpenCode 连接已变化，本轮未提交。', false);
      submitted = true;
      const prompt = c.rpc.agent.request('session/prompt', { sessionId: native.binding.externalSessionID, prompt: [{ type: 'text', text: request.input }] });
      void prompt.then(result => finish(result.stopReason === 'end_turn' ? 'finished' : result.stopReason === 'cancelled' ? 'cancelled' : 'failed'), () => finish('unknown'));
      attempt.cancel = async () => {
        this.permissions.cancel(lookup());
        try {
          await c.rpc.agent.notify('session/cancel', { sessionId: native.binding.externalSessionID });
          let timer!: ReturnType<typeof setTimeout>;
          const value = await Promise.race([outcome, new Promise<string>(resolve => { timer = setTimeout(() => resolve('unknown'), this.options.cancelTimeoutMs ?? 4000); })]); clearTimeout(timer);
          return value === 'cancelled';
        } catch { return false; }
      };
      const value = await outcome; accepting = false; await queue;
      if (value === 'unknown') throw new ExecutionError('incomplete', 'OpenCode 原生执行结果未知，未自动重发。', true);
      await onEvent({ type: 'settled', outcome: value as 'finished' | 'failed' | 'cancelled' });
    } catch (error) {
      native.blocked = true; accepting = false; try { await queue; } catch { /* Controller retains failed writes. */ }
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError('network', 'OpenCode 原生执行或记录未确认。', submitted);
    } finally {
      accepting = false; this.permissions.cancel(lookup()); clearTimeout(timeout); unsubscribe(); removePermission(); c.rpc.signal.removeEventListener('abort', closed); signal.removeEventListener('abort', abort); native.busy = false; this.attempts.delete(request.clientRequestID);
    }
  }
  replyPermission(lookup: AgentChatLookup, approvalID: string, decision: 'allow' | 'deny') { const current = this.getSource(); if (decision === 'allow' && (!current || current.configDigest !== lookup.source.configDigest || current.runtimeID !== lookup.binding?.runtimeID || current.connectionGeneration !== lookup.binding?.connectionGeneration)) return Promise.resolve({ status: 'unknown' as const }); return this.permissions.reply(lookup, approvalID, decision); }
  async cancelTurn(lookup: AgentChatLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    const attempt = this.attempts.get(lookup.clientRequestID);
    if (!attempt || lookup.source.configDigest !== attempt.request.source.configDigest || !lookup.binding || Object.entries(lookup.binding).some(([key, value]) => attempt.session.binding[key as keyof AgentChatBinding] !== value)) return { status: 'unknown' };
    return { status: await attempt.cancel?.() ? 'confirmed' : 'unknown' };
  }
}
