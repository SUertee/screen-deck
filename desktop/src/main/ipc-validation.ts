import { StorageError } from '../core/storage/private-storage.js';

export function payload(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new StorageError('ipc-input', '请求参数无效。');
  return value as Record<string, unknown>;
}
export function textInput(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || value.includes('\0')) throw new StorageError('ipc-input', '文字参数无效或超过容量限制。');
  return value;
}
export function uuidInput(value: unknown): string {
  const id = textInput(value, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new StorageError('ipc-input', '会话标识无效。');
  return id;
}
export function isTrustedURL(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'screendeck-app:' && url.hostname === 'workbench' && url.pathname === '/index.html' && !url.username && !url.password && !url.port; } catch { return false; }
}
