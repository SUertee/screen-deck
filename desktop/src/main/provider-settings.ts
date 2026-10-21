import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as TOML from '@iarna/toml';
import { atomicReplace, checkDirectories, readBytes, StorageError, withExclusiveLock } from '../core/storage/private-storage.js';
import type { LLMProviderConfig, ProviderSettings, SettingsInput } from '../shared/desktop-api.js';

export interface ProviderRequestSnapshot extends Readonly<LLMProviderConfig> {
  readonly credential: string | undefined;
}
export const DEFAULT_PROVIDER = Object.freeze({ baseURL: 'https://token-api.yicloud.com/v1', modelID: 'GLM-5.3-Flash' });

export function validateProvider(baseURL: unknown, modelID: unknown): { baseURL: string; modelID: string } {
  if (typeof baseURL !== 'string' || baseURL.length > 2048 || typeof modelID !== 'string' || !modelID.trim() || Buffer.byteLength(modelID) > 200 || /[\x00-\x1f]/.test(modelID)) throw new StorageError('settings-invalid', '模型地址或名称无效。');
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new StorageError('settings-invalid', '请输入有效的 HTTPS 模型地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new StorageError('settings-invalid', '模型地址须为 HTTPS，不能包含凭据或查询参数。');
  return { baseURL: url.href.replace(/\/+$/, ''), modelID: modelID.trim() };
}

/** Main-process only: public preferences and the plaintext credential are separate private files. */
export class ProviderSettingsStore {
  private settingsGeneration = randomUUID();
  get generation(): string { return this.settingsGeneration; }
  private preferences: LLMProviderConfig = { ...DEFAULT_PROVIDER };
  private credential: string | undefined;
  private storage: ProviderSettings['credentialStorage'] = 'none';
  private queue: Promise<unknown> = Promise.resolve();
  private observedConfig: Buffer | undefined;
  private observedKey: Buffer | undefined;
  private boundBaseURL: string | undefined;
  readonly diagnostics: string[] = [];
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await checkDirectories(this.root, true);
    const config = await readBytes(path.join(this.root, 'provider.toml'), 8192);
    this.observedConfig = config;
    if (config) {
      try {
        const value = TOML.parse(config.toString('utf8'));
        if (value.schema_version !== 1 || Object.keys(value).some(key => !['schema_version', 'base_url', 'model_id'].includes(key))) throw new Error();
        this.preferences = validateProvider(value.base_url, value.model_id);
        this.boundBaseURL = this.preferences.baseURL;
      } catch { this.diagnostics.push('预览模型配置无效，已使用默认地址；原文件未覆盖。'); }
    }
    this.observedKey = await readBytes(path.join(this.root, 'credential.json'), 16_384);
    if (this.observedKey?.length) {
      try {
        const record = JSON.parse(this.observedKey.toString('utf8'));
        if (record !== null) {
          if (!record || Array.isArray(record) || typeof record !== 'object' || Object.keys(record).length !== 3 || record.schema_version !== 1 || record.base_url !== this.boundBaseURL || typeof record.api_key !== 'string') throw new Error();
          this.validateKey(record.api_key);
          this.credential = record.api_key;
          this.storage = 'file';
        }
      } catch { this.diagnostics.push('已保存密钥的格式或地址关联无效，请重新填写并保存；原文件未修改。'); }
    }
    // Old ciphertext is never read, decrypted, migrated or deleted.
    if (this.observedKey === undefined) {
      try {
        await lstat(path.join(this.root, 'credential.bin'));
        this.diagnostics.push('旧版密钥未导入，请在模型服务中重新填写并保存。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnostics.push('无法检查旧版密钥记录，请重新填写并保存密钥。');
      }
    }
  }

  publicSettings(): ProviderSettings { return { ...this.preferences, hasKey: !!this.credential, credentialStorage: this.storage }; }
  snapshot(): ProviderRequestSnapshot {
    return Object.freeze({ baseURL: this.preferences.baseURL, modelID: this.preferences.modelID, credential: this.credential });
  }

  /** Capture the destination and key before the queue permits a later settings save. */
  prepareRequest(beforeSnapshot?: () => Promise<void>): Promise<ProviderRequestSnapshot> {
    return this.enqueue(async () => {
      // The caller owns validation; reserve its settings order before asynchronous checks.
      await beforeSnapshot?.();
      await this.assertUnchanged();
      if (!this.credential) throw new StorageError('credential-missing', '请先在设置中填写并保存 API 密钥。');
      return this.snapshot();
    });
  }

  /** Explicit connection checks may use a draft destination/key without saving it. */
  previewRequest(input: { baseURL: string; apiKey?: string }): Promise<ProviderRequestSnapshot> {
    return this.enqueue(async () => {
      const preferences = validateProvider(input.baseURL, this.preferences.modelID);
      if (input.apiKey !== undefined && input.apiKey !== '') this.validateKey(input.apiKey);
      await this.assertUnchanged();
      const credential = input.apiKey?.trim() || (preferences.baseURL === this.preferences.baseURL ? this.credential : undefined);
      if (!credential) throw new StorageError('credential-missing', '请填写该服务的 API 密钥后重试。');
      return Object.freeze({ ...preferences, credential });
    });
  }

  save(input: SettingsInput, expectedGeneration?: string): Promise<ProviderSettings> {
    return this.enqueue(async () => {
      if (expectedGeneration !== undefined && expectedGeneration !== this.settingsGeneration) throw new StorageError('settings-changed', '模型连接已变更，请重新选择或校验。');
      const preferences = validateProvider(input.baseURL, input.modelID);
      if (input.rememberKey !== undefined && typeof input.rememberKey !== 'boolean' || input.forgetKey !== undefined && typeof input.forgetKey !== 'boolean') throw new StorageError('settings-invalid', '凭据保存选择无效。');
      if (input.apiKey !== undefined && input.apiKey !== '') this.validateKey(input.apiKey);
      const rememberKey = input.rememberKey !== false;
      const destinationChanged = preferences.baseURL !== this.preferences.baseURL;
      // Never silently forward a stored key to a newly edited origin/path.
      const credential = input.forgetKey ? undefined : input.apiKey?.trim() || (destinationChanged ? undefined : this.credential);
      const bytes = Buffer.from(JSON.stringify(credential && rememberKey ? { schema_version: 1, base_url: preferences.baseURL, api_key: credential } : null) + '\n');
      if (bytes.length > 16_384) throw new StorageError('too-large', '待保存记录超过容量上限，原文件未覆盖。');
      try { await withExclusiveLock(path.join(this.root, 'settings.lock'), async () => {
        const configPath = path.join(this.root, 'provider.toml');
        const keyPath = path.join(this.root, 'credential.json');
        await this.assertUnchanged();
        // Each replacement is owner-only (0600). A null record explicitly removes persistence.
        await atomicReplace(keyPath, bytes, this.observedKey, 16_384);
        this.observedKey = bytes;
        try {
          const bytes = Buffer.from(TOML.stringify({ schema_version: 1, base_url: preferences.baseURL, model_id: preferences.modelID }));
          await atomicReplace(configPath, bytes, this.observedConfig, 8192);
          this.observedConfig = bytes;
        } catch (error) {
          // Fail closed: mismatched preference/credential files cannot be used in this process.
          this.credential = undefined; this.storage = 'none'; this.boundBaseURL = undefined;
          throw new StorageError('settings-write', '设置未完整保存，请重新保存地址和凭据。');
        }
      }); } catch (error) {
        // Include uncertain credential writes and lock-release failure, not just config writes.
        this.credential = undefined; this.storage = 'none'; this.boundBaseURL = undefined;
        this.settingsGeneration = randomUUID();
        throw error;
      }
      this.preferences = preferences; this.boundBaseURL = preferences.baseURL; this.credential = credential;
      this.settingsGeneration = randomUUID();
      this.storage = credential ? rememberKey ? 'file' : 'memory' : 'none';
      this.diagnostics.length = 0;
      return this.publicSettings();
    });
  }

  flush(): Promise<unknown> { return this.queue; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async assertUnchanged(): Promise<void> {
    const equal = (actual: Buffer | undefined, observed: Buffer | undefined) => actual === undefined ? observed === undefined : observed !== undefined && actual.equals(observed);
    if (!equal(await readBytes(path.join(this.root, 'provider.toml'), 8192), this.observedConfig) || !equal(await readBytes(path.join(this.root, 'credential.json'), 16_384), this.observedKey)) throw new StorageError('settings-conflict', '连接配置被外部修改，请重新打开应用后检查；未覆盖已有设置。');
  }

  private validateKey(value: string): void {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192 || /[\r\n\0]/.test(value)) throw new StorageError('settings-invalid', 'API Key 格式无效。');
  }
}
