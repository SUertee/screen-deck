import type { HistoryDiagnostic, ModelSelection, SessionRecord, SessionScope } from './types.js';

/** A distinct format. Never add these fields to chat-v1 or task-v2. */
export interface AgentChatSource { agentID: string; configDigest: string }
export interface AgentChatBinding { runtimeID: string; connectionGeneration: string; externalSessionID: string }
export interface AgentSessionRecord extends Omit<SessionRecord, 'binding'> {
  kind: 'electron_agent_chat';
  source: AgentChatSource;
  binding?: AgentChatBinding;
}
export interface AgentChatReadySource extends AgentChatSource {
  name: string;
  state: 'ready';
  runtimeID: string;
  connectionGeneration: string;
  model: ModelSelection;
}
export type AgentChatSourceInfo = AgentChatReadySource | { agentID: string; name: string; state: 'unavailable'; reason: 'stopped' | 'requires-restart' };
export interface AgentSessionListing { records: AgentSessionRecord[]; diagnostics: HistoryDiagnostic[] }
export interface AgentSendResult { status: 'notSubmitted' | 'accepted' | 'uncertain'; session: AgentSessionRecord; reason?: string }
export type AgentSessionEvent = { type: 'agent-session-updated'; session: AgentSessionRecord } | { type: 'agent-diagnostic'; sessionID?: string; message: string };
export interface AgentChatAPI {
  getAgentSources(): Promise<AgentChatSourceInfo[]>;
  createAgentSession(input: { title: string; agentID: string; scope?: SessionScope }): Promise<AgentSessionRecord>;
  loadAgentSession(sessionID: string): Promise<AgentSessionRecord | undefined>;
  sendAgentMessage(input: { sessionID: string; text: string }): Promise<AgentSendResult>;
  stopAgentGeneration(sessionID: string): Promise<void>;
  retryAgentPendingWrites(sessionID: string): Promise<void>;
}
