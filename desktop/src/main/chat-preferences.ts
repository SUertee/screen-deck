import type { ChatPreference, ChatPreferences, ChatReference } from '../shared/chat-management.js';
import { StorageError } from '../core/storage/private-storage.js';
import { payload, uuidInput } from './ipc-validation.js';
import type { LocalState } from './local-state.js';

const KEY = 'chat-preferences';
const LIMIT = 2000;
interface StoredPreferences extends ChatPreferences { schema_version: 1; kind: 'chat_preferences' }
const empty = (): StoredPreferences => ({ schema_version: 1, kind: 'chat_preferences', revision: 0, entries: {} });
function validate(value: unknown): StoredPreferences {
  const record = payload(value, ['schema_version', 'kind', 'revision', 'entries']);
  if (record.schema_version !== 1 || record.kind !== 'chat_preferences' || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || !record.entries || typeof record.entries !== 'object' || Array.isArray(record.entries) || Object.keys(record.entries).length > LIMIT) throw new StorageError('state-invalid', '聊天偏好记录无效，原记录未覆盖。');
  for (const [key, item] of Object.entries(record.entries)) {
    if (!/^(model|agent):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key)) throw new StorageError('state-invalid', '聊天偏好身份无效，原记录未覆盖。');
    const flags = payload(item, ['archived', 'pinned']);
    if (!Object.keys(flags).length || Object.values(flags).some(flag => flag !== true)) throw new StorageError('state-invalid', '聊天偏好状态无效，原记录未覆盖。');
  }
  return record as unknown as StoredPreferences;
}
const publicValue = ({ revision, entries }: StoredPreferences): ChatPreferences => structuredClone({ revision, entries });

/** Owns bounded display preferences only; never writes Session or Turn history. */
export class ChatPreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly local: Pick<LocalState, 'read' | 'write'>) {}
  load(): Promise<ChatPreferences> {
    const operation = this.queue.catch(() => undefined).then(() => this.read()).then(publicValue);
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  setArchived(ref: ChatReference, value: boolean, check: () => void): Promise<ChatPreferences> { return this.patch(ref, 'archived', value, check); }
  setPinned(ref: ChatReference, value: boolean, check: () => void): Promise<ChatPreferences> { return this.patch(ref, 'pinned', value, check); }
  private read(): Promise<StoredPreferences> { return this.local.read<unknown>(KEY, empty()).then(validate); }
  private patch(ref: ChatReference, field: keyof ChatPreference, value: boolean, check: () => void): Promise<ChatPreferences> {
    if (!['model', 'agent'].includes(ref.source) || typeof value !== 'boolean') throw new StorageError('ipc-input', '聊天偏好参数无效。');
    const key = `${ref.source}:${uuidInput(ref.sessionID)}`;
    const operation = this.queue.catch(() => undefined).then(async () => {
      check();
      const current = await this.read();
      check();
      const previous = current.entries[key];
      if (!!previous?.[field] === value) return publicValue(current);
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new StorageError('state-limit', '聊天偏好修订达到上限。');
      const next = structuredClone(current);
      const flags = { ...previous };
      if (value) flags[field] = true; else delete flags[field];
      if (Object.keys(flags).length) next.entries[key] = flags; else delete next.entries[key];
      if (Object.keys(next.entries).length > LIMIT) throw new StorageError('state-limit', '聊天偏好项数达到上限。');
      next.revision++;
      await this.local.write(KEY, validate(next));
      return publicValue(next);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
