import type { SessionRecord } from '../shared/types';
import type { AgentSessionRecord } from '../shared/agent-chat';
import type { ChatPreferences, ChatReference } from '../shared/chat-management';

export type ChatRecord = SessionRecord | AgentSessionRecord;
export const isAgentChat = (record: ChatRecord): record is AgentSessionRecord => 'kind' in record && record.kind === 'electron_agent_chat';
export const chatReference = (record: ChatRecord): ChatReference => ({ source: isAgentChat(record) ? 'agent' : 'model', sessionID: record.conversation_id });
export const chatKey = (record: ChatRecord) => `${isAgentChat(record) ? 'agent' : 'model'}:${record.conversation_id}`;
export const chatPreference = (record: ChatRecord, preferences: ChatPreferences) => preferences.entries[chatKey(record)] ?? {};
const activeChat = (record: ChatRecord) => ['prepared', 'submitting', 'streaming', 'cancelling'].includes(record.turns.at(-1)?.state ?? '');
export function orderedChats(records: ChatRecord[], preferences: ChatPreferences, archived = false): ChatRecord[] {
  return records.filter(record => !!chatPreference(record, preferences).archived === archived || !archived && activeChat(record)).sort((a, b) => Number(activeChat(b)) - Number(activeChat(a)) || Number(!!chatPreference(b, preferences).pinned) - Number(!!chatPreference(a, preferences).pinned) || b.updated_at.localeCompare(a.updated_at) || chatKey(a).localeCompare(chatKey(b)));
}
export interface ChatMatch { record: ChatRecord; snippet: string; messageID?: string; archived: boolean }
/** Search only the records already loaded by the bounded history reader. */
export function searchChats(records: ChatRecord[], preferences: ChatPreferences, query: string, source: 'all' | 'model' | 'agent', includeArchived: boolean): ChatMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return records.filter(record => (source === 'all' || chatReference(record).source === source) && (includeArchived || !chatPreference(record, preferences).archived)).flatMap(record => {
    const message = record.messages.find(value => value.text.toLowerCase().includes(needle));
    if (!record.title.toLowerCase().includes(needle) && !message) return [];
    const body = message?.text ?? record.messages.at(-1)?.text ?? '';
    const position = Math.max(0, body.toLowerCase().indexOf(needle));
    const start = Math.max(0, position - 45), end = Math.min(body.length, Math.max(position + needle.length + 85, start + 150));
    return [{ record, snippet: (start ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : ''), ...(message ? { messageID: message.message_id } : {}), archived: !!chatPreference(record, preferences).archived }];
  });
}
