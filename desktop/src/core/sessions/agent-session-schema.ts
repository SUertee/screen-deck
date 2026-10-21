import type { AgentChatBinding, AgentChatSource, AgentSessionRecord } from '../../shared/agent-chat.js';
import { StorageError } from '../storage/private-storage.js';
import { isUUID, SESSION_LIMITS, validateSession } from './session-schema.js';

export const AGENT_CHAT_INPUT_BYTES = 256 * 1024;

const fail = (): never => { throw new StorageError('invalid-record', 'Agent 会话字段无效或不受支持，原文件未覆盖。'); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []): void => {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
};
const text = (value: unknown, bytes: number): value is string => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= bytes && !/[\u0000-\u001f\u007f]/.test(value);

export function validateAgentSource(value: unknown): asserts value is AgentChatSource {
  const source = object(value);
  exact(source, ['agentID', 'configDigest']);
  if (!text(source.agentID, 150) || !/^[a-z][a-z0-9-]*$/.test(source.agentID) || typeof source.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.configDigest)) fail();
}

export function validateAgentBinding(value: unknown): asserts value is AgentChatBinding {
  const binding = object(value);
  exact(binding, ['runtimeID', 'connectionGeneration', 'externalSessionID']);
  if (!isUUID(binding.runtimeID) || !isUUID(binding.connectionGeneration) || !text(binding.externalSessionID, 256)) fail();
}

/** New format, strict keys. Reusing common field validation does not reinterpret old JSON. */
export function validateAgentSession(value: unknown, persisted = false): asserts value is AgentSessionRecord {
  const record = object(value);
  exact(record, ['schema_version', 'kind', 'conversation_id', 'title', 'scope', 'source', 'created_at', 'updated_at', 'revision', 'turns', 'messages'], ['binding']);
  if (record.kind !== 'electron_agent_chat' || record.schema_version !== 1) throw new StorageError('unsupported-version', 'Agent 会话格式或版本不受支持，原文件未覆盖。');
  validateAgentSource(record.source);
  if (Object.hasOwn(record, 'binding')) validateAgentBinding(record.binding);
  const { kind: _kind, source: _source, binding: _binding, ...common } = record;
  validateSession(common, persisted);
  if (common.conversation_id !== common.conversation_id.toLowerCase()) fail();
  for (const turn of common.turns) {
    if (turn.observed_model === null || turn.failure === null || turn.requested_model.variant === null || turn.observed_model?.variant === null) fail();
    const messages = common.messages.filter(message => message.turn_id === turn.turn_id);
    if (messages.length !== 2 || messages.filter(message => message.role === 'user').length !== 1 || messages.filter(message => message.role === 'assistant').length !== 1) fail();
    if (!messages.find(message => message.role === 'user')!.text.trim()) fail();
    if (Buffer.byteLength(messages.find(message => message.role === 'user')!.text) > AGENT_CHAT_INPUT_BYTES) fail();
    if (messages.some(message => Object.hasOwn(message, 'external_message_id') || Object.hasOwn(message, 'external_part_id'))) fail();
    if (['streaming', 'finished'].includes(turn.state) && !record.binding) fail();
  }
  if (object(record.scope).task_id === null) fail();
}

export function decodeAgentSession(bytes: Buffer): AgentSessionRecord {
  if (bytes.length > SESSION_LIMITS.fileBytes) throw new StorageError('too-large', 'Agent 会话超过容量上限。');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
  validateAgentSession(value, true);
  return value;
}
