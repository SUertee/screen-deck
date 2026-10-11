import path from 'node:path';
import * as TOML from '@iarna/toml';
import { atomicReplace, checkDirectories, readBytes, StorageError, withExclusiveLock } from '../core/private-storage.js';
import type { ProviderSettings, SettingsInput } from '../shared/desktop-api.js';

export interface CredentialCipher {
  available(): boolean | Promise<boolean>;
  encrypt(value: string): Buffer | Promise<Buffer>;
  decrypt(value: Buffer): string | Promise<string>;
}
export interface ProviderRequestSnapshot {
  readonly endpoint: string;
  readonly modelID: string;
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

/** Main-process only: public preferences and encrypted credential are separate files. */
export class ProviderSettingsStore {
  private preferences: { baseURL: string; modelID: string } = { ...DEFAULT_PROVIDER };
  private credential: string | undefined;
  private storage: ProviderSettings['credentialStorage'] = 'none';
  private queue: Promise<unknown> = Promise.resolve();
  private observedConfig: Buffer | undefined;
  private observedKey: Buffer | undefined;
  private boundBaseURL: string | undefined;
  readonly diagnostics: string[] = [];
  constructor(private readonly root: string, private readonly cipher: CredentialCipher) {}

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
    const encrypted = await readBytes(path.join(this.root, 'credential.bin'), 16_384);
    this.observedKey = encrypted;
    // Startup must not touch the OS keychain. The first request loads the saved key.
    if (encrypted?.length) this.storage = 'locked';
  }

  publicSettings(): ProviderSettings { return { ...this.preferences, hasKey: !!this.credential, credentialStorage: this.storage }; }
  snapshot(): ProviderRequestSnapshot {
    return Object.freeze({ endpoint: `${this.preferences.baseURL}/chat/completions`, modelID: this.preferences.modelID, credential: this.credential });
  }

  ensureCredential(): Promise<ProviderSettings> {
    return this.enqueue(async () => {
      await this.loadCredential();
      return this.publicSettings();
    });
  }

  /** Capture the destination and key before the queue permits a later settings save. */
  prepareRequest(beforeLoading?: () => Promise<void>): Promise<ProviderRequestSnapshot> {
    return this.enqueue(async () => {
      // The caller owns validation; reserve its settings order before asynchronous checks.
      await beforeLoading?.();
      await this.loadCredential();
      return this.snapshot();
    });
  }

  save(input: SettingsInput): Promise<ProviderSettings> {
    return this.enqueue(async () => {
      const preferences = validateProvider(input.baseURL, input.modelID);
      if (typeof input.rememberKey !== 'boolean' || input.forgetKey !== undefined && typeof input.forgetKey !== 'boolean') throw new StorageError('settings-invalid', '凭据保存选择无效。');
      if (input.apiKey !== undefined && input.apiKey !== '') this.validateKey(input.apiKey);
      const destinationChanged = preferences.baseURL !== this.preferences.baseURL;
      // Never silently forward a stored key to a newly edited origin/path.
      const credential = input.forgetKey ? undefined : input.apiKey?.trim() || (destinationChanged ? undefined : this.credential);
      const preserveLocked = this.storage === 'locked' && this.boundBaseURL === preferences.baseURL && !destinationChanged && !input.forgetKey && !input.apiKey?.trim() && input.rememberKey;
      let encrypted: Buffer = preserveLocked ? this.observedKey! : Buffer.alloc(0);
      if (!preserveLocked && credential && input.rememberKey) {
        await this.assertUnchanged();
        let available: boolean;
        try { available = await this.cipher.available(); }
        catch { throw new StorageError('credential-save', '系统未能安全保存密钥，请检查系统授权后重试；原加密文件未修改。'); }
        await this.assertUnchanged();
        if (available) {
          try {
            encrypted = await this.cipher.encrypt(JSON.stringify({ baseURL: preferences.baseURL, key: credential }));
            if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error();
          } catch { throw new StorageError('credential-save', '系统未能安全保存密钥，请检查系统授权后重试；原加密文件未修改。'); }
          await this.assertUnchanged();
          if (encrypted.length > 16_384) throw new StorageError('too-large', '待保存记录超过容量上限，原文件未覆盖。');
        }
      }
      try { await withExclusiveLock(path.join(this.root, 'settings.lock'), async () => {
        const configPath = path.join(this.root, 'provider.toml');
        const keyPath = path.join(this.root, 'credential.bin');
        await this.assertUnchanged();
        // Write credential first, then the endpoint it belongs to. No plaintext temporary file.
        await atomicReplace(keyPath, encrypted, this.observedKey, 16_384);
        this.observedKey = encrypted;
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
        throw error;
      }
      this.preferences = preferences; this.boundBaseURL = preferences.baseURL; this.credential = credential;
      this.storage = preserveLocked ? 'locked' : credential ? encrypted.length ? 'encrypted' : 'memory' : 'none';
      return this.publicSettings();
    });
  }

  flush(): Promise<unknown> { return this.queue; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async loadCredential(): Promise<void> {
    if (this.credential) return;
    if (this.storage !== 'locked' || !this.observedKey?.length || !this.boundBaseURL || this.boundBaseURL !== this.preferences.baseURL) throw new StorageError('credential-locked', '已存密钥与有效配置无法关联，请重新填写地址与密钥。');
    await this.assertUnchanged();
    let available: boolean;
    try { available = await this.cipher.available(); }
    catch { throw this.credentialLoadError(); }
    await this.assertUnchanged();
    if (!available) throw this.credentialLoadError();
    let key: string;
    try {
      const envelope = JSON.parse(await this.cipher.decrypt(Buffer.from(this.observedKey)));
      if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object' || Object.keys(envelope).length !== 2 || envelope.baseURL !== this.boundBaseURL || typeof envelope.key !== 'string') throw new Error();
      this.validateKey(envelope.key); key = envelope.key;
    } catch { throw this.credentialLoadError(); }
    // Awaiting the system keychain allows external edits; retain the observed baseline.
    await this.assertUnchanged();
    this.credential = key; this.storage = 'encrypted';
  }

  private credentialLoadError(): StorageError {
    return new StorageError('credential-locked', '系统未能读取已存密钥。请检查系统授权，或重新填写密钥；原加密文件未修改。');
  }

  private async assertUnchanged(): Promise<void> {
    const equal = (actual: Buffer | undefined, observed: Buffer | undefined) => actual === undefined ? observed === undefined : observed !== undefined && actual.equals(observed);
    if (!equal(await readBytes(path.join(this.root, 'provider.toml'), 8192), this.observedConfig) || !equal(await readBytes(path.join(this.root, 'credential.bin'), 16_384), this.observedKey)) throw new StorageError('settings-conflict', '连接配置被外部修改，请重新打开应用后检查；未覆盖已有设置。');
  }

  private validateKey(value: string): void {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192 || /[\r\n\0]/.test(value)) throw new StorageError('settings-invalid', 'API Key 格式无效。');
  }
}
