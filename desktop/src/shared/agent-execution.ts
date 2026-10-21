import type { AgentChatBinding, AgentChatSource } from './agent-chat.js';
export type AgentPermissionMode = 'confirm-changes' | 'auto-edit' | 'full-access' | 'read-only' | 'ask';
export interface AgentWorkspace { id: string; path: string; label: string }
export interface AgentExecutionSelection { workspaceID: string; mode: AgentPermissionMode }
export interface AgentExecutionContext { workspace: AgentWorkspace; mode: AgentPermissionMode }
export interface AgentToolActivity {
  id: string; title: string; kind: 'read' | 'write' | 'command' | 'other';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  detail?: string; output?: string; truncated?: boolean;
}
export interface AgentNativeApproval {
  id: string; toolID: string; title: string; detail: string; canAllow: boolean;
  state: 'pending' | 'decided' | 'expired'; decision?: 'allow' | 'deny'; decider?: 'user' | 'policy'; reply?: 'pending' | 'queued' | 'unknown';
}
export interface AgentExecutionRecord {
  schema_version: 1; sessionID: string; turnID: string; clientRequestID: string;
  source: AgentChatSource; context: AgentExecutionContext; binding?: AgentChatBinding;
  status: 'running' | 'finished' | 'failed' | 'cancelled' | 'unknown';
  tools: AgentToolActivity[]; approvals: AgentNativeApproval[];
}
export type AgentNativeEvent = { type: 'tool'; tool: AgentToolActivity; appendOutput?: boolean }
  | { type: 'permission'; autoApprove?: boolean; approval: Omit<AgentNativeApproval, 'state' | 'decision' | 'reply'> };
export interface AgentExecutionAPI {
  chooseProjectWorkspace(projectID: string): Promise<AgentWorkspace>;
  chooseAgentWorkspace(): Promise<AgentWorkspace | undefined>;
  getAgentExecutionContext(sessionID: string): Promise<AgentExecutionContext | undefined>;
  getAgentExecution(input: { sessionID: string; turnID: string }): Promise<AgentExecutionRecord | undefined>;
  decideAgentPermission(input: { sessionID: string; turnID: string; approvalID: string; decision: 'allow' | 'deny' }): Promise<void>;
}
