import type { AgentExecutionContext, AgentNativeEvent } from '../../shared/agent-execution.js';
import type { AgentDescriptor } from '../../shared/agent-capabilities.js';
import type { ModelSelection } from '../../shared/types.js';
import type { AgentChatBinding, AgentChatReadySource, AgentChatSource } from '../../shared/agent-chat.js';

export interface AgentChatRequest {
  sessionID: string;
  turnID: string;
  clientRequestID: string;
  source: AgentChatSource;
  binding?: AgentChatBinding;
  model: ModelSelection;
  input: string;
  execution?: AgentExecutionContext;
}
export interface AgentChatLookup { clientRequestID: string; source: AgentChatSource; binding?: AgentChatBinding }
export type AgentChatExecutionEvent = AgentNativeEvent
  | { type: 'bound'; binding: AgentChatBinding }
  | { type: 'submitted' }
  | { type: 'text-delta'; text: string }
  | { type: 'observed-model'; model: ModelSelection }
  | { type: 'settled'; outcome: 'finished' | 'failed' | 'cancelled'; reason?: string };
/** Native-context chat. Only the current input is sent, never assembled history. */
export interface AgentChatDriver {
  readonly descriptor: Readonly<AgentDescriptor>;
  getSource(): AgentChatReadySource | undefined;
  /** Settle only after all delivered event callbacks finish, including on disconnect. */
  sendTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
  /** Explicit tool-disabled path; optional so missing context cannot silently use native tools. */
  sendTextTurn?: AgentChatDriver['sendTurn'];
  replyPermission?(lookup: AgentChatLookup, approvalID: string, decision: 'allow' | 'deny'): Promise<{ status: 'queued' | 'unknown' }>;
  cancelTurn(lookup: AgentChatLookup): Promise<{ status: 'confirmed' | 'unknown' }>;
}

/** Callers select by immutable Agent identity, never by a default/fallback driver. */
export interface AgentChatDriverResolver {
  resolve(agentID: string): AgentChatDriver | undefined;
  getSource(agentID: string): AgentChatReadySource | undefined;
}
