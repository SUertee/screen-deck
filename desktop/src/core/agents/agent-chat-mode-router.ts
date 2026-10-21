import type { AgentChatDriver, AgentChatRequest, AgentChatLookup, AgentChatExecutionEvent } from '../sessions/agent-chat-driver.js';
import { ExecutionError } from '../sessions/execution-driver.js';
/** Stable public Agent identity; each conversation selects exactly one execution profile. */
export class AgentChatModeRouter implements AgentChatDriver {
  readonly descriptor: AgentChatDriver['descriptor'];
  private sessions = new Map<string, { tools: boolean; driver: AgentChatDriver; requestID: string }>();
  constructor(private native: AgentChatDriver, private text: AgentChatDriver, private prepareText?: () => Promise<void>) { this.descriptor = native.descriptor; }
  getSource() { return this.native.getSource(); }
  sendTextTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal) { return this.sendTurn({ ...request, execution: undefined }, onEvent, signal); }
  async sendTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const tools = !!request.execution, old = this.sessions.get(request.sessionID);
    if (old && old.tools !== tools) throw new ExecutionError('configuration', '本聊天的工具模式已固定；请新建聊天后选择工作目录。', false);
    if (!tools) { try { await this.prepareText?.(); } catch (error) { throw new ExecutionError('configuration', error instanceof Error ? error.message : '纯聊天连接未能建立，请刷新 Agent 后重试。', false); } }
    const driver = tools ? this.native : this.text;
    this.sessions.set(request.sessionID, { tools, driver, requestID: request.clientRequestID });
    return driver.sendTurn(request, onEvent, signal);
  }
  replyPermission(lookup: AgentChatLookup, id: string, decision: 'allow' | 'deny') { return this.native.replyPermission?.(lookup, id, decision) ?? Promise.resolve({ status: 'unknown' as const }); }
  cancelTurn(lookup: AgentChatLookup) { const session = [...this.sessions.values()].find(value => value.requestID === lookup.clientRequestID); return session ? session.driver.cancelTurn(lookup) : Promise.resolve({ status: 'unknown' as const }); }
}
