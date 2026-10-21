import type { SessionRecord } from './types.js';
import type { AgentSessionRecord } from './agent-chat.js';

export interface ChatReference { source: 'model' | 'agent'; sessionID: string }
export interface ChatPreference { archived?: true; pinned?: true }
export interface ChatPreferences { revision: number; entries: Record<string, ChatPreference> }
export interface RenameChatInput { sessionID: string; title: string; expectedRevision: number }
export interface ChatManagementAPI {
  setChatArchived(input: ChatReference & { archived: boolean }): Promise<ChatPreferences>;
  setChatPinned(input: ChatReference & { pinned: boolean }): Promise<ChatPreferences>;
  renameSession(input: RenameChatInput): Promise<SessionRecord>;
  renameAgentSession(input: RenameChatInput): Promise<AgentSessionRecord>;
  copyText(text: string): Promise<void>;
}
