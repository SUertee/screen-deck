import { ExecutionError, type ExecutionDriver, type ExecutionEvent, type ExecutionRequest } from './execution-driver.js';

export interface ChatCompletionsOptions {
  endpoint: string;
  credential: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  stream?: boolean;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const containsToolCall = (value: unknown, depth = 0): boolean => {
  if (depth > 64) throw new ExecutionError('protocol', '模型响应嵌套超过上限。', true);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => containsToolCall(item, depth + 1));
  return Object.entries(value).some(([key, item]) => key === 'tool_calls' || key === 'function_call' || containsToolCall(item, depth + 1));
};

/** A single HTTP attempt. Secrets and provider response bodies never enter errors. */
export class ChatCompletionsAdapter implements ExecutionDriver {
  readonly capabilities = Object.freeze({ chat: true, tools: false, remoteSessions: false, remoteAbort: false });
  constructor(private readonly options: ChatCompletionsOptions) {}

  async execute(request: ExecutionRequest, onEvent: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    let endpoint: URL;
    try { endpoint = new URL(this.options.endpoint); }
    catch { throw new ExecutionError('configuration', '模型地址无效。', false); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search ||
      (endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) {
      throw new ExecutionError('configuration', '模型地址必须使用 HTTPS；本机测试可使用 HTTP。', false);
    }
    if (request.model.variant !== undefined) throw new ExecutionError('configuration', '此聊天接口尚未支持模型 variant。', false);
    const controller = new AbortController();
    let attempted = false;
    let timedOut = false;
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      signal.removeEventListener('abort', cancel);
      throw new ExecutionError('configuration', '模型超时设置无效。', false);
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      let credential: string | undefined;
      try { credential = await this.options.credential(); }
      catch { throw new ExecutionError('configuration', '无法取得本次调用凭据。', false); }
      if (credential !== undefined && (!credential.trim() || /[\r\n\0]/.test(credential))) {
        throw new ExecutionError('configuration', '本次调用凭据无效。', false);
      }
      if (controller.signal.aborted) throw new ExecutionError(timedOut ? 'timeout' : 'cancelled', timedOut ? '模型请求超时。' : '已取消本地请求。', false);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
      if (credential) headers.Authorization = `Bearer ${credential}`;
      attempted = true;
      const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST', headers, signal: controller.signal, redirect: 'error',
        body: JSON.stringify({ model: request.model.model_id, messages: request.messages, stream: this.options.stream ?? true, n: 1 }),
      });
      if (!response.ok) throw new ExecutionError('http', `模型服务返回 HTTP ${response.status}。`, true);
      await onEvent({ type: 'submitted' });
      if (!response.body) throw new ExecutionError('protocol', '模型服务未返回正文。', true);
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let responseBytes = 0;
      let textBytes = 0;
      let observedModel: string | undefined;
      const emitModel = async (model: unknown) => {
        if (model === undefined) return;
        if (typeof model !== 'string' || !model || model.includes('\0') || Buffer.byteLength(model) > 200) {
          throw new ExecutionError('protocol', '模型服务返回了无效模型标识。', true);
        }
        if (observedModel && observedModel !== model) throw new ExecutionError('protocol', '回复中的模型标识发生变化，已停止接收。', true);
        if (!observedModel) {
          observedModel = model;
          await onEvent({ type: 'observed-model', model: { provider_id: request.model.provider_id, model_id: model } });
        }
      };
      const emitText = async (value: unknown) => {
        if (value === undefined || value === null) return;
        if (typeof value !== 'string') throw new ExecutionError('protocol', '模型服务返回了不支持的正文格式。', true);
        textBytes += Buffer.byteLength(value);
        if (textBytes > MAX_TEXT_BYTES) throw new ExecutionError('protocol', '模型回复超过单条消息容量上限。', true);
        if (value) await onEvent({ type: 'text-delta', text: value });
      };
      const checkTools = (value: Record<string, unknown> | undefined, finishReason?: unknown) => {
        if ((value && (value.tool_calls !== undefined || value.function_call !== undefined)) || finishReason === 'tool_calls' || finishReason === 'function_call') {
          throw new ExecutionError('tools-forbidden', '无工具聊天收到工具调用，已拒绝并取消本地接收。', true);
        }
      };
      const parse = (value: string) => {
        try {
          const parsed: unknown = JSON.parse(value);
          if (containsToolCall(parsed)) throw new ExecutionError('tools-forbidden', '无工具聊天收到工具调用，已拒绝并取消本地接收。', true);
          return object(parsed);
        }
        catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError('protocol', '模型服务返回了无效 JSON。', true); }
      };
      const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (controller.signal.aborted) throw new ExecutionError(timedOut ? 'timeout' : 'cancelled', timedOut ? '模型请求超时。' : '已取消本地请求；未确认远端停止。', attempted);
        const next = await reader!.read();
        if (controller.signal.aborted) throw new ExecutionError(timedOut ? 'timeout' : 'cancelled', timedOut ? '模型请求超时。' : '已取消本地请求；未确认远端停止。', attempted);
        if (!next.done) {
          responseBytes += next.value.byteLength;
          if (responseBytes > MAX_RESPONSE_BYTES) throw new ExecutionError('protocol', '模型响应超过容量上限。', true);
        }
        return next;
      };
      if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        let buffer = '';
        let data: string[] = [];
        let done = false;
        let finished = false;
        const dispatch = async () => {
          if (!data.length) return;
          const payload = data.join('\n'); data = [];
          if (payload === '[DONE]') {
            if (!finished) throw new ExecutionError('incomplete', '模型流结束但未确认回复完成。', true);
            done = true; return;
          }
          const chunk = parse(payload);
          if (!chunk || chunk.error !== undefined || !Array.isArray(chunk.choices) || chunk.choices.length > 1) throw new ExecutionError('protocol', '模型流返回了不支持的事件。', true);
          await emitModel(chunk.model);
          for (const raw of chunk.choices) {
            const choice = object(raw);
            if (!choice || (choice.index !== undefined && choice.index !== 0)) throw new ExecutionError('protocol', '模型流返回了额外候选回复。', true);
            const delta = object(choice.delta);
            checkTools(delta, choice.finish_reason); checkTools(object(choice.message), choice.finish_reason);
            if (finished && delta?.content) throw new ExecutionError('protocol', '模型流在完成之后继续返回正文。', true);
            await emitText(delta?.content);
            if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
              if (!['stop', 'length', 'content_filter'].includes(String(choice.finish_reason))) throw new ExecutionError('protocol', '模型流返回了未知结束原因。', true);
              finished = true;
            }
          }
        };
        while (!done) {
          const next = await read();
          buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
          let newline: number;
          while (!done && (newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
            if (!line) await dispatch();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (next.done) {
            if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
            await dispatch();
            if (!done && !finished) throw new ExecutionError('incomplete', '模型流中断，回复完成情况未知。', true);
            break;
          }
        }
      } else if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        let body = '';
        while (true) { const next = await read(); if (next.done) break; body += decoder.decode(next.value, { stream: true }); }
        body += decoder.decode();
        const value = parse(body);
        if (!value || value.error !== undefined || !Array.isArray(value.choices) || value.choices.length !== 1) throw new ExecutionError('protocol', '模型服务返回了不支持的回复。', true);
        const choice = object(value.choices[0]); const message = object(choice?.message);
        if (!choice || !message || message.role !== 'assistant') throw new ExecutionError('protocol', '模型服务未返回助手消息。', true);
        checkTools(message, choice.finish_reason);
        if (!['stop', 'length', 'content_filter'].includes(String(choice.finish_reason))) throw new ExecutionError('protocol', '模型服务未确认回复结束。', true);
        await emitModel(value.model); await emitText(message.content);
      } else throw new ExecutionError('protocol', '模型服务返回了不支持的响应类型。', true);
      if (controller.signal.aborted) throw new ExecutionError(timedOut ? 'timeout' : 'cancelled', timedOut ? '模型请求超时。' : '已取消本地请求；未确认远端停止。', attempted);
      await onEvent({ type: 'completed' });
    } catch (error) {
      controller.abort();
      if (error instanceof ExecutionError) throw error;
      if (controller.signal.aborted && (timedOut || signal.aborted)) {
        throw new ExecutionError(timedOut ? 'timeout' : 'cancelled', timedOut ? '模型请求超时，未自动重试。' : '已取消本地请求；未确认远端停止。', attempted);
      }
      throw new ExecutionError('network', '模型请求未能完成，未自动重试。', attempted);
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', cancelReader);
      if (reader) { try { await reader.cancel(); } catch { /* Abort may already have closed the reader. */ } reader.releaseLock(); }
    }
  }
}
