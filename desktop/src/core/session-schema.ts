import type { ModelSelection, SessionRecord } from '../shared/types.js';
import { StorageError } from './private-storage.js';

export const SESSION_LIMITS = { fileBytes: 16 * 1024 * 1024, messageBytes: 1024 * 1024, turns: 1000, messages: 2000, sessions: 1000, directories: 4096, entries: 8192 } as const;
export const isUUID = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
function fail(): never { throw new StorageError('invalid-record', '聊天记录字段无效或不受支持，原文件未覆盖。'); }
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
};
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= max;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) >= 0;
const optional = (value: Record<string, unknown>, key: string): unknown => value[key] === null ? undefined : value[key];

export function validateModel(value: unknown): asserts value is ModelSelection {
  const model = obj(value); keys(model, ['provider_id', 'model_id'], ['variant']);
  if (!bounded(model.provider_id, 150) || !bounded(model.model_id, 200) || optional(model, 'variant') !== undefined && !bounded(model.variant, 100)) fail();
}

/** Reject unknown fields before encoding so credentials or future versions cannot be silently stripped. */
export function validateSession(value: unknown, persisted = false): asserts value is SessionRecord {
  const record = obj(value);
  keys(record, ['schema_version', 'conversation_id', 'title', 'scope', 'created_at', 'updated_at', 'revision', 'turns', 'messages'], ['binding']);
  if (record.schema_version !== 1) throw new StorageError('unsupported-version', '聊天记录版本不受支持，原文件未覆盖。');
  if (!isUUID(record.conversation_id) || !bounded(record.title, 600) || !(record.title as string).trim() || !date(record.created_at) || !date(record.updated_at) || !integer(record.revision) || persisted && record.revision === 0) fail();
  const scope = obj(record.scope);
  switch (scope.kind) {
    case 'local_chat': keys(scope, ['kind', 'local_chat_id']); if (!isUUID(scope.local_chat_id)) fail(); break;
    case 'local_task': keys(scope, ['kind', 'local_task_id']); if (!isUUID(scope.local_task_id)) fail(); break;
    case 'project': keys(scope, ['kind', 'project_id'], ['task_id']);
      if (typeof scope.project_id !== 'string' || !/^project-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(scope.project_id) || optional(scope, 'task_id') !== undefined && (typeof scope.task_id !== 'string' || !/^task-\d{3,}$/.test(scope.task_id))) fail(); break;
    default: fail();
  }
  if (optional(record, 'binding') !== undefined) {
    const binding = obj(record.binding); keys(binding, ['external_session_id', 'endpoint', 'directory', 'compatible_version', 'connection_generation']);
    let endpoint: URL;
    try { endpoint = new URL(String(binding.endpoint)); } catch { fail(); }
    if (!bounded(binding.external_session_id, 256) || !bounded(binding.compatible_version, 100) || !isUUID(binding.connection_generation) || !bounded(binding.directory, 4096) || !(binding.directory as string).startsWith('/') || /[\r\n]/.test(binding.directory as string) || (binding.directory as string).split('/').includes('..') || endpoint!.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint!.hostname) || !endpoint!.port || endpoint!.username || endpoint!.password || endpoint!.search || endpoint!.hash || !['', '/'].includes(endpoint!.pathname)) fail();
  }
  if (!Array.isArray(record.turns) || !Array.isArray(record.messages)) fail();
  if (record.turns.length > SESSION_LIMITS.turns || record.messages.length > SESSION_LIMITS.messages) throw new StorageError('too-large', '聊天记录超过容量上限。');
  const turnIDs = new Set<string>(); const requestIDs = new Set<string>(); const messageIDs = new Set<string>();
  for (const raw of record.turns) {
    const turn = obj(raw); keys(turn, ['turn_id', 'client_request_id', 'requested_model', 'state', 'created_at', 'updated_at', 'draft_revision'], ['observed_model', 'failure']);
    if (!isUUID(turn.turn_id) || turnIDs.has(turn.turn_id) || !isUUID(turn.client_request_id) || requestIDs.has(turn.client_request_id) || !integer(turn.draft_revision) || !date(turn.created_at) || !date(turn.updated_at) || !['prepared', 'submitting', 'streaming', 'finished', 'failed', 'cancelling', 'cancelled', 'unknown'].includes(String(turn.state))) fail();
    turnIDs.add(turn.turn_id); requestIDs.add(turn.client_request_id);
    validateModel(turn.requested_model); if (optional(turn, 'observed_model') !== undefined) validateModel(turn.observed_model);
    if (optional(turn, 'failure') !== undefined && (typeof turn.failure !== 'string' || Buffer.byteLength(turn.failure) > 4096)) fail();
  }
  const externalMessages = new Map<string, { turn: string; role: unknown; whole: boolean; parts: Set<string> }>();
  for (const raw of record.messages) {
    const message = obj(raw); keys(message, ['message_id', 'turn_id', 'role', 'text', 'created_at', 'updated_at'], ['external_message_id', 'external_part_id']);
    if (!isUUID(message.message_id) || messageIDs.has(message.message_id) || !isUUID(message.turn_id) || !turnIDs.has(message.turn_id) || !['user', 'assistant'].includes(String(message.role)) || typeof message.text !== 'string' || !date(message.created_at) || !date(message.updated_at)) fail();
    if (Buffer.byteLength(message.text as string) > SESSION_LIMITS.messageBytes) throw new StorageError('too-large', '单条消息超过容量上限。');
    messageIDs.add(message.message_id);
    const externalID = optional(message, 'external_message_id'); const partID = optional(message, 'external_part_id');
    if (externalID !== undefined && !bounded(externalID, 256) || partID !== undefined && (!bounded(partID, 256) || externalID === undefined)) fail();
    if (externalID !== undefined) {
      const existing = externalMessages.get(externalID as string);
      if (existing) {
        if (existing.turn !== message.turn_id || existing.role !== message.role || existing.whole || typeof partID !== 'string' || existing.parts.has(partID)) fail();
        existing.parts.add(partID);
      } else externalMessages.set(externalID as string, { turn: message.turn_id, role: message.role, whole: partID === undefined, parts: new Set(typeof partID === 'string' ? [partID] : []) });
    }
  }
}

export function decodeSession(bytes: Buffer): SessionRecord {
  if (bytes.length > SESSION_LIMITS.fileBytes) throw new StorageError('too-large', '聊天记录超过容量上限。');
  let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
  validateSession(value, true);
  // Swift's decodeIfPresent accepts null. Re-encoding known optional nulls omits them.
  const omitNull = (target: Record<string, unknown>, names: string[]) => { for (const name of names) if (target[name] === null) delete target[name]; };
  omitNull(value as unknown as Record<string, unknown>, ['binding']);
  omitNull(value.scope as unknown as Record<string, unknown>, ['task_id']);
  for (const turn of value.turns) {
    omitNull(turn as unknown as Record<string, unknown>, ['observed_model', 'failure']);
    omitNull(turn.requested_model as unknown as Record<string, unknown>, ['variant']);
    if (turn.observed_model) omitNull(turn.observed_model as unknown as Record<string, unknown>, ['variant']);
  }
  for (const message of value.messages) omitNull(message as unknown as Record<string, unknown>, ['external_message_id', 'external_part_id']);
  return value;
}
