import { JEV_ENDPOINT } from './jev-decision-provider.js';

export type JevFailureCode = 'invalid-input' | 'not-configured' | 'storage-failed' | 'settings-changed' | 'budget-unconfirmed' | 'cancelled' | 'timeout' | 'network' | 'authentication' | 'rate-limited' | 'overloaded' | 'request-rejected' | 'http-error' | 'invalid-response' | 'response-too-large' | 'stale-draft';
export class JevServiceError extends Error {
  constructor(readonly code: JevFailureCode, readonly delivery: 'not-sent' | 'unknown' | 'received' = 'not-sent', readonly status?: number) {
    super(`Jev: ${code}`); this.name = 'JevServiceError';
  }
}
export interface JevHttpRequest { model: string; state: unknown; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> }
export interface JevRequestTransport {
  readonly provenance: 'typesafe-api' | 'test-fixture';
  systemOne(request: JevHttpRequest, options: { signal?: AbortSignal }): Promise<unknown>;
}
export const validJevKey = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
interface HttpOptions { timeoutMs?: number; maxResponseBytes?: number; /** Tests only, never a renderer setting. */ testOnly?: { endpoint: string; fetch?: typeof fetch } }

/** One POST to the official service. No SDK retries, redirects, fallback or account discovery. */
export class JevHttpTransport implements JevRequestTransport {
  readonly provenance: JevRequestTransport['provenance'];
  readonly endpoint: string;
  #key: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetcher: typeof fetch;
  constructor(apiKey: string, options: HttpOptions = {}) {
    if (!validJevKey(apiKey)) throw new JevServiceError('invalid-input');
    this.#key = apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxResponseBytes ?? 128 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 1024 * 1024) throw new JevServiceError('invalid-input');
    this.endpoint = JEV_ENDPOINT; this.provenance = 'typesafe-api'; this.fetcher = fetch;
    if (options.testOnly) {
      let url: URL;
      try { url = new URL(options.testOnly.endpoint); } catch { throw new JevServiceError('invalid-input'); }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1/systemone' || url.search || url.hash || url.username || url.password) throw new JevServiceError('invalid-input');
      this.endpoint = url.href; this.fetcher = options.testOnly.fetch ?? fetch; this.provenance = 'test-fixture';
    }
  }
  async systemOne(request: JevHttpRequest, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    let body: string;
    try {
      const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
      const exact = (v: unknown, names: string[]) => plain(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
      if (!exact(request, ['model', 'state', 'questions']) || !/^jev-[a-zA-Z0-9.-]{1,96}$/.test(request.model) || !exact(request.questions, ['assignee'])) throw new Error();
      const question = request.questions.assignee;
      if (!exact(question, ['type', 'instructions', 'criteria']) || question.type !== 'choice' || typeof question.instructions !== 'string' || !question.instructions.trim() || !plain(question.criteria)) throw new Error();
      const criteria = Object.entries(question.criteria);
      if (criteria.length < 2 || criteria.length > 32 || criteria.some(([id, description]) => !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id) || typeof description !== 'string' || !description.trim() || description.length > 1200)) throw new Error();
      const jsonValue = (value: unknown, depth: number): void => {
        if (depth > 12) throw new Error();
        if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
        if (Array.isArray(value)) { if (value.length > 1000 || Object.keys(value).length !== value.length) throw new Error(); for (const child of value) jsonValue(child, depth + 1); return; }
        if (plain(value)) { for (const child of Object.values(value)) jsonValue(child, depth + 1); return; }
        throw new Error();
      };
      jsonValue(request.state, 0); body = JSON.stringify(request);
    } catch { throw new JevServiceError('invalid-input'); }
    if (!body || Buffer.byteLength(body) > 128 * 1024) throw new JevServiceError('invalid-input');
    if (options.signal?.aborted) throw new JevServiceError('cancelled');
    const controller = new AbortController(); let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        const stop = (code: 'timeout' | 'cancelled') => { controller.abort(); reject(new JevServiceError(code, sent ? 'unknown' : 'not-sent')); };
        abort = () => stop('cancelled'); options.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => stop('timeout'), this.timeoutMs);
      });
      const operation = async () => {
        if (controller.signal.aborted) throw new JevServiceError('cancelled');
        sent = true;
        const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body, redirect: 'error', signal: controller.signal });
        if (!response.ok) {
          // Never read, log, parse, or return arbitrary provider error bodies.
          void response.body?.cancel().catch(() => undefined);
          const status = response.status;
          const code: JevFailureCode = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate-limited' : status === 529 ? 'overloaded' : [400, 413, 415, 422].includes(status) ? 'request-rejected' : 'http-error';
          throw new JevServiceError(code, 'received', status);
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { void response.body?.cancel().catch(() => undefined); throw new JevServiceError('invalid-response', 'received'); }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > this.maxBytes)) { void response.body?.cancel().catch(() => undefined); throw new JevServiceError('response-too-large', 'received'); }
        if (!response.body) throw new JevServiceError('invalid-response', 'received');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            total += part.value.byteLength;
            if (total > this.maxBytes) { void reader.cancel().catch(() => undefined); throw new JevServiceError('response-too-large', 'received'); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          // Block any echoed credential even if the JSON otherwise looks valid.
          if (text.includes(this.#key)) throw new Error('credential-echo');
          const parsed: unknown = JSON.parse(text);
          if (JSON.stringify(parsed).includes(this.#key)) throw new Error('credential-echo');
          return parsed;
        } catch { throw new JevServiceError('invalid-response', 'received'); }
      };
      return await Promise.race([interrupted, Promise.resolve().then(operation)]);
    } catch (error) {
      if (error instanceof JevServiceError) throw error;
      throw new JevServiceError('network', sent ? 'unknown' : 'not-sent');
    } finally {
      clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
