import { StorageError } from '../storage/private-storage.js';
import type { ProviderModelsResult } from '../../shared/desktop-api.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_MODEL_ID_BYTES = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Only locally created errors may cross the boundary; fetch/body exceptions are untrusted.
class ModelsRequestError extends StorageError {}

/** One bounded metadata request. Does not test chat or infer model capabilities. */
export async function listChatCompletionsModels(
  input: { baseURL: string; credential: string },
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<ProviderModelsResult> {
  let endpoint: URL;
  try {
    if (typeof input?.baseURL !== 'string' || Buffer.byteLength(input.baseURL) > 2048 || /[\s\p{Cc}]/u.test(input.baseURL)) throw new Error();
    endpoint = new URL(input.baseURL);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || input.baseURL.includes('?') || input.baseURL.includes('#')) throw new Error();
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/models`;
  } catch {
    throw new StorageError('provider-models-configuration', '模型列表地址须为不含凭据或查询参数的 HTTPS 地址。');
  }
  if (typeof input.credential !== 'string' || !input.credential.trim() || Buffer.byteLength(input.credential) > 8192 || /\p{Cc}/u.test(input.credential)) {
    throw new StorageError('provider-models-configuration', '请先填写有效的 API 密钥。');
  }
  const credential = input.credential;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new StorageError('provider-models-configuration', '模型列表请求超时设置无效。');
  }

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
  const releaseReader = () => {
    cancelReader();
    try { reader?.releaseLock(); } catch { /* A timed-out read may still be settling. */ }
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      cancelReader();
      reject(new ModelsRequestError('provider-models-timeout', '获取模型列表超时，请重试。'));
    }, timeoutMs);
  });
  const request = async (): Promise<ProviderModelsResult> => {
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.body) reader = response.body.getReader();
    if (controller.signal.aborted) {
      releaseReader();
      throw new ModelsRequestError('provider-models-timeout', '获取模型列表超时，请重试。');
    }
    if ([404, 405, 501].includes(response.status)) return { kind: 'unsupported' };
    if (!response.ok || response.redirected) {
      throw new ModelsRequestError('provider-models-http', `模型列表服务返回 HTTP ${response.status}，请检查连接设置。`);
    }
    if (!reader) throw new ModelsRequestError('provider-models-protocol', '模型列表服务未返回有效正文。');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = '';
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (controller.signal.aborted) throw new ModelsRequestError('provider-models-timeout', '获取模型列表超时，请重试。');
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ModelsRequestError('provider-models-too-large', '模型列表响应超过容量上限。');
      try { body += decoder.decode(next.value, { stream: true }); }
      catch { throw new ModelsRequestError('provider-models-protocol', '模型列表服务返回了无效 UTF-8 正文。'); }
    }
    try { body += decoder.decode(); }
    catch { throw new ModelsRequestError('provider-models-protocol', '模型列表服务返回了无效 UTF-8 正文。'); }
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { throw new ModelsRequestError('provider-models-protocol', '模型列表服务返回了无效 JSON。'); }
    const value = object(parsed);
    if (!value || !Array.isArray(value.data)) throw new ModelsRequestError('provider-models-protocol', '模型列表服务返回了不支持的格式。');
    if (value.data.length > MAX_MODELS) throw new ModelsRequestError('provider-models-too-large', '模型列表条目超过上限。');
    const modelIDs: string[] = [];
    const seen = new Set<string>();
    for (const item of value.data) {
      const id = object(item)?.id;
      if (typeof id !== 'string' || !id.trim() || Buffer.byteLength(id) > MAX_MODEL_ID_BYTES || /\p{Cc}/u.test(id) || id.includes(credential)) {
        throw new ModelsRequestError('provider-models-protocol', '模型列表含无效标识，已停止读取。');
      }
      if (!seen.has(id)) { seen.add(id); modelIDs.push(id); }
    }
    return { kind: 'available', modelIDs };
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (timedOut) throw new StorageError('provider-models-timeout', '获取模型列表超时，请重试。');
    if (error instanceof ModelsRequestError) throw error;
    throw new StorageError('provider-models-network', '获取模型列表未能完成，请检查连接后重试。');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    releaseReader();
  }
}
