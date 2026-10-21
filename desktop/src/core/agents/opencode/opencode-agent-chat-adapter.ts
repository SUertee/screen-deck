import { TEXT_AGENT_CAPABILITIES } from '../../../shared/agent-capabilities.js';
import { ExecutionError } from '../../sessions/execution-driver.js';
import type { AgentChatDriver, AgentChatLookup, AgentChatRequest, AgentChatExecutionEvent } from '../../sessions/agent-chat-driver.js';
import type { AgentChatReadySource } from '../../../shared/agent-chat.js';
import { OpenCodeAcpSessionClient, acpSameModel, type OpenCodeAcpSessionOptions } from './opencode-acp-session.js';

export type OpenCodeAgentChatAdapterOptions = OpenCodeAcpSessionOptions;
const AGENT_ID = 'opencode';
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 200 && !/[\x00-\x1f]/.test(value);

/** Native-context text chat, independent of Task and task execution approvals. */
export class OpenCodeAgentChatAdapter implements AgentChatDriver {
  readonly descriptor = Object.freeze({ agentID: AGENT_ID, name: 'OpenCode', protocol: 'acp' as const, capabilities: TEXT_AGENT_CAPABILITIES });
  private readonly sessions: OpenCodeAcpSessionClient;
  constructor(private readonly options: OpenCodeAgentChatAdapterOptions) { this.sessions = new OpenCodeAcpSessionClient(options); }
  getSource(): AgentChatReadySource | undefined {
    try {
      if (this.options.canStart && !this.options.canStart()) return undefined;
      const connection = this.sessions.getConnection();
      return { ...this.descriptor, state: 'ready', configDigest: connection.configDigest, model: { ...connection.model }, runtimeID: connection.runtimeID, connectionGeneration: connection.connectionGeneration };
    } catch { return undefined; }
  }
  async sendTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const source = this.getSource();
    if (!source || request.source.agentID !== AGENT_ID || request.source.configDigest !== source.configDigest || !acpSameModel(request.model, source.model) || !bounded(request.sessionID) || !bounded(request.turnID) || !bounded(request.clientRequestID)) throw new ExecutionError('configuration', 'Agent 来源或模型已失效，请检查连接或明确新建聊天。', false);
    await this.sessions.send({ ownerID: `agent:${request.sessionID}`, clientRequestID: request.clientRequestID, configDigest: request.source.configDigest, model: request.model, input: request.input, ...(request.binding ? { binding: request.binding } : {}), continuous: true }, onEvent, signal);
  }
  async cancelTurn(lookup: AgentChatLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    if (lookup.source.agentID !== AGENT_ID) return { status: 'unknown' };
    return this.sessions.cancel({ clientRequestID: lookup.clientRequestID, configDigest: lookup.source.configDigest, binding: lookup.binding });
  }
}
