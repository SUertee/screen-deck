import type { ModelSelection } from '../shared/types.js';
import type { AgentChatBinding, AgentChatReadySource, AgentChatSource } from '../shared/agent-chat.js';

export interface AgentChatRequest {
  sessionID: string;
  turnID: string;
  clientRequestID: string;
  source: AgentChatSource;
  binding?: AgentChatBinding;
  model: ModelSelection;
  input: string;
}
export interface AgentChatLookup { clientRequestID: string; source: AgentChatSource; binding?: AgentChatBinding }
export type AgentChatExecutionEvent =
  | { type: 'bound'; binding: AgentChatBinding }
  | { type: 'submitted' }
  | { type: 'text-delta'; text: string }
  | { type: 'observed-model'; model: ModelSelection }
  | { type: 'settled'; outcome: 'finished' | 'failed' | 'cancelled'; reason?: string };
/** Native-context chat. Only the current input is sent, never assembled history. */
export interface AgentChatDriver {
  getSource(): AgentChatReadySource | undefined;
  sendTurn(request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
  cancelTurn(lookup: AgentChatLookup): Promise<{ status: 'confirmed' | 'unknown' }>;
}
