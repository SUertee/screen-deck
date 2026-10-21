import type { LocalState } from './local-state.js';
import { JevServiceError, validJevKey } from '../core/tasks/providers/jev-http-transport.js';
const KEY = 'typesafe-jev-private-credential-v1';
interface StoredJevKey { schema_version: 1; kind: 'typesafe_jev_credential'; apiKey: string | null }
const empty = (): StoredJevKey => ({ schema_version: 1, kind: 'typesafe_jev_credential', apiKey: null });
function parse(value: unknown): StoredJevKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JevServiceError('storage-failed');
  const r = value as StoredJevKey;
  if (Object.keys(r).length !== 3 || r.schema_version !== 1 || r.kind !== 'typesafe_jev_credential' || r.apiKey !== null && !validJevKey(r.apiKey)) throw new JevServiceError('storage-failed');
  return r;
}
/** Only trusted main owns this object. The LocalState namespace must NEVER be exposed via generic read IPC. */
export class JevSettingsStore {
  #local: Pick<LocalState, 'read' | 'write'>;
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #pendingSaves = 0;
  #writeUncertain = false;
  get generation(): number { return this.#generation; }
  constructor(local: Pick<LocalState, 'read' | 'write'>) { this.#local = local; }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#queue.catch(() => undefined).then(action);
    this.#queue = operation.catch(() => undefined); return operation;
  }
  publicSettings(): Promise<{ hasKey: boolean }> { return this.serial(async () => {
    if (this.#writeUncertain) throw new JevServiceError('storage-failed');
    return { hasKey: (await this.read()).apiKey !== null };
  }); }
  /** Explicit save/clear only; never verifies a key by making a paid request. */
  save(apiKey: string | null): Promise<{ hasKey: boolean }> {
    if (apiKey !== null && !validJevKey(apiKey)) return Promise.reject(new JevServiceError('invalid-input'));
    this.#pendingSaves++; this.#generation++; // Fail closed for any pending request, including a failed/uncertain write.
    return this.serial(async () => {
      try {
        await this.read(); // Preserve LocalState CAS and refuse corrupt/future records.
        try { await this.#local.write(KEY, { ...empty(), apiKey }); this.#writeUncertain = false; }
        catch { this.#writeUncertain = true; throw new JevServiceError('storage-failed'); }
        return { hasKey: apiKey !== null };
      } finally { this.#pendingSaves--; this.#generation++; }
    });
  }
  /** Main-only snapshot, must not be returned by IPC or logged. */
  snapshot(): Promise<{ apiKey: string | undefined; generation: number }> {
    return this.serial(async () => {
      if (this.#writeUncertain) throw new JevServiceError('storage-failed');
      const generation = this.#generation;
      if (this.#pendingSaves) throw new JevServiceError('settings-changed');
      const apiKey = (await this.read()).apiKey ?? undefined;
      if (generation !== this.#generation) throw new JevServiceError('settings-changed');
      return { apiKey, generation };
    });
  }
  private async read(): Promise<StoredJevKey> {
    try { return parse(await this.#local.read<unknown>(KEY, empty())); } catch { throw new JevServiceError('storage-failed'); }
  }
}
