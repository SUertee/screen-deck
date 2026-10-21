import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { codexObject, type CodexNotification } from '../core/agents/codex/codex-connection.js';
const MAX_LINE = 2 * 1024 * 1024;
/** Newline JSON-RPC, no shell or raw protocol/error logging. Native server requests require an explicit handler; unclaimed requests are rejected. */
export class CodexRPC {
  private sequence = 0;
  private buffer = '';
  private closed = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private serverHandlers = new Set<(method: string, params: Record<string, unknown>) => Promise<unknown> | undefined>();
  onServerRequest = (handler: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined): (() => void) => { this.serverHandlers.add(handler); return () => { this.serverHandlers.delete(handler); }; };
  private listeners = new Set<(event: CodexNotification) => void>();
  constructor(private child: ChildProcessWithoutNullStreams, private changed: () => void, private timeout = 15_000) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE) { this.close(); return; }
        try { this.receive(codexObject(JSON.parse(line))); } catch { this.close(); return; }
      }
      if (Buffer.byteLength(this.buffer) > MAX_LINE) this.close();
    });
    child.stderr.resume(); // Native stderr can include provider bodies or authentication details.
    child.on('error', () => this.close()); child.on('exit', () => this.close());
    child.stdin.on('error', () => this.close());
  }
  subscribe = (listener: (event: CodexNotification) => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭。'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Codex 请求过多，请稍后重试。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时，结果尚未确认。')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch { this.close(); }
    });
  }
  async shutdown(): Promise<void> {
    this.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex 连接中断，结果尚未确认。')); }
    this.pending.clear(); this.buffer = '';
    for (const listener of this.listeners) { try { listener({ method: 'screendeck/disconnected', params: {} }); } catch { /* Other listeners still receive closure. */ } }
    this.listeners.clear(); this.serverHandlers.clear(); this.child.kill(); this.changed();
  }
  private write(value: unknown): void {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex 连接已关闭。');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private receive(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        const params = codexObject(message.params);
        for (const handler of this.serverHandlers) {
          const answer = handler(message.method, params);
          if (answer) {
            void answer.then(result => { if (!this.closed) this.write({ id: message.id, result }); }, () => { if (!this.closed) this.write({ id: message.id, error: { code: -32603, message: 'ScreenDeck could not complete this request.' } }); }).catch(() => this.close());
            return;
          }
        }
        this.write({ id: message.id, error: { code: -32601, message: 'ScreenDeck does not support this server request.' } });
        for (const listener of this.listeners) listener({ method: 'screendeck/unsupported-request', params: {} });
      } else {
        const params = message.params === undefined ? {} : codexObject(message.params);
        for (const listener of this.listeners) listener({ method: message.method, params });
      }
      return;
    }
    if (typeof message.id !== 'number') throw new Error('Invalid RPC response');
    const entry = this.pending.get(message.id); if (!entry) return;
    this.pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error !== undefined) entry.reject(new Error('Codex 拒绝了请求，请检查登录、配额或连接状态。'));
    else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
    else entry.reject(new Error('Codex 协议响应不完整。'));
  }
}
