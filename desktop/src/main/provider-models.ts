import { listChatCompletionsModels } from '../core/providers/chat-completions-models.js';
import { StorageError } from '../core/storage/private-storage.js';
import type { ProviderModelCatalog, ProviderModelsResult, ProviderSettings } from '../shared/desktop-api.js';
import { ProviderSettingsStore, validateProvider, type ProviderRequestSnapshot } from './provider-settings.js';
import type { LocalState } from './local-state.js';

const KEY = 'provider-models';
const sameSnapshot = (a: ProviderRequestSnapshot, b: ProviderRequestSnapshot) => a.baseURL === b.baseURL && a.modelID === b.modelID && a.credential === b.credential;
const stale = () => new StorageError('provider-models-stale', '模型连接已变化，请重新获取模型列表。');
const cacheError = () => new StorageError('provider-models-cache', '本地模型列表无法读取，请重新校验连接；原记录未自动覆盖。');

function modelIDs(value: unknown, credential?: string): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !id || id.trim() !== id || Buffer.byteLength(id) > 200 || /\p{Cc}/u.test(id) || credential && id.includes(credential)) || new Set(value).size !== value.length) throw cacheError();
  return [...value];
}

interface PendingCatalog extends ProviderModelCatalog { credential: string; generation: string }
interface ProviderModelsOptions {
  listModels?: (input: { baseURL: string; credential: string }) => Promise<ProviderModelsResult>;
}

/** Coordinates explicit metadata checks and saved suggestions; it never sends a chat prompt. */
export class ProviderModelsService {
  private readonly query: NonNullable<ProviderModelsOptions['listModels']>;
  private pending?: PendingCatalog;
  private querySerial = 0;
  private cacheQueue: Promise<unknown> = Promise.resolve();
  private suppressStoredCache = false;
  readonly diagnostics: string[] = [];

  constructor(private readonly settings: ProviderSettingsStore, private readonly local: LocalState, options: ProviderModelsOptions = {}) {
    this.query = options.listModels ?? listChatCompletionsModels;
  }

  get(): Promise<ProviderModelCatalog> {
    const generation = this.settings.generation;
    const current = this.settings.snapshot();
    return this.enqueue(async () => {
      this.assertCurrent(generation);
      if (this.suppressStoredCache) return { baseURL: current.baseURL, modelIDs: [] };
      const cached = await this.readCache(current.credential);
      this.assertCurrent(generation);
      return cached?.baseURL === current.baseURL ? cached : { baseURL: current.baseURL, modelIDs: [] };
    });
  }

  async list(input: { baseURL: string; apiKey?: string }): Promise<ProviderModelsResult> {
    const serial = ++this.querySerial;
    this.pending = undefined;
    const generation = this.settings.generation;
    const snapshot = await this.settings.previewRequest(input);
    this.assertCurrent(generation, serial);
    if (!snapshot.credential) throw new StorageError('credential-missing', '请填写该服务的 API 密钥后重试。');
    let result: ProviderModelsResult;
    try { result = await this.query({ baseURL: snapshot.baseURL, credential: snapshot.credential }); }
    catch {
      this.assertCurrent(generation, serial);
      throw new StorageError('provider-models-query', '获取模型列表未能完成，请检查地址与密钥后重试。');
    }
    this.assertCurrent(generation, serial);
    if (!result || typeof result !== 'object') throw new StorageError('provider-models-query', '模型列表返回格式无效，请重新校验连接。');
    if (result.kind === 'unsupported') return { kind: 'unsupported' };
    if (result.kind !== 'available') throw new StorageError('provider-models-query', '模型列表返回格式无效，请重新校验连接。');
    let ids: string[];
    try { ids = modelIDs(result.modelIDs, snapshot.credential); }
    catch { throw new StorageError('provider-models-query', '模型列表返回格式无效，请重新校验连接。'); }
    this.pending = { baseURL: snapshot.baseURL, credential: snapshot.credential, generation, modelIDs: ids };
    return { kind: 'available', modelIDs: [...ids] };
  }

  /** Called only after Store.save succeeds; cache failure must not turn that save into a failure. */
  afterSave(previous: ProviderRequestSnapshot, current: ProviderRequestSnapshot, previousGeneration: string): Promise<void> {
    const candidate = this.pending?.generation === previousGeneration ? this.pending : undefined;
    if (candidate) this.pending = undefined;
    const generation = this.settings.generation;
    return this.enqueue(async () => {
      if (generation !== this.settings.generation || !sameSnapshot(current, this.settings.snapshot())) return;
      const wasSuppressed = this.suppressStoredCache;
      this.suppressStoredCache = true;
      try {
        const matched = candidate?.baseURL === current.baseURL && candidate.credential === current.credential;
        let cached: ProviderModelCatalog | undefined;
        try { cached = await this.readCache(current.credential); }
        catch (error) {
          // An explicit successful check/save may replace a malformed cache at its observed CAS baseline.
          if (!matched) throw error;
        }
        this.assertCurrent(generation);
        const connectionChanged = previous.baseURL !== current.baseURL || previous.credential !== current.credential;
        const next: ProviderModelCatalog = matched ? { baseURL: current.baseURL, modelIDs: [...candidate.modelIDs] }
          : !connectionChanged && !wasSuppressed && cached?.baseURL === current.baseURL ? cached
            : { baseURL: current.baseURL, modelIDs: [] };
        if (!cached || cached.baseURL !== next.baseURL || JSON.stringify(cached.modelIDs) !== JSON.stringify(next.modelIDs)) await this.local.write(KEY, next);
        this.assertCurrent(generation);
        this.suppressStoredCache = false;
        this.diagnostics.length = 0;
      } catch {
        this.diagnostics.splice(0, this.diagnostics.length, '连接设置已保存，但本地模型列表未能更新；当前不使用旧列表，请重新校验连接。');
      }
    });
  }

  async select(modelID: string): Promise<ProviderSettings> {
    const generation = this.settings.generation;
    const previous = this.settings.snapshot();
    if (typeof modelID !== 'string' || !modelID || modelID.trim() !== modelID || Buffer.byteLength(modelID) > 200 || /\p{Cc}/u.test(modelID)) throw new StorageError('provider-models-selection', '请选择当前模型或已保存列表中的模型。');
    if (modelID !== previous.modelID) {
      const cached = await this.get();
      if (!cached.modelIDs.includes(modelID)) throw new StorageError('provider-models-selection', '请选择当前模型或已保存列表中的模型。');
    }
    this.assertCurrent(generation);
    const result = await this.settings.save({ baseURL: previous.baseURL, modelID, rememberKey: true }, generation);
    await this.afterSave(previous, this.settings.snapshot(), generation);
    return result;
  }

  private async readCache(credential?: string): Promise<ProviderModelCatalog | undefined> {
    try {
      const value = await this.local.read<unknown>(KEY, undefined);
      if (value === undefined) return undefined;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !('baseURL' in value) || !('modelIDs' in value)) throw cacheError();
      const baseURL = validateProvider(value.baseURL, this.settings.publicSettings().modelID).baseURL;
      if (value.baseURL !== baseURL) throw cacheError();
      return { baseURL, modelIDs: modelIDs(value.modelIDs, credential) };
    } catch { throw cacheError(); }
  }

  private assertCurrent(generation: string, serial?: number): void {
    if (generation !== this.settings.generation || serial !== undefined && serial !== this.querySerial) throw stale();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cacheQueue.then(operation);
    this.cacheQueue = result.catch(() => undefined);
    return result;
  }
}
