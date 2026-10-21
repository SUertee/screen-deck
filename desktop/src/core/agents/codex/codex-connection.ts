import type { ModelSelection } from '../../../shared/types.js';
/** Narrow, versioned subset of Codex app-server 0.133.0 JSON-RPC. Native handles stay in main. */
export interface CodexNotification { method: string; params: Record<string, unknown> }
export interface CodexConnection {
  runtimeID: string; connectionGeneration: string; configDigest: string;
  ownedWriteRoots?: readonly string[];
  directory: string; model: ModelSelection;
  request(method: string, params: unknown): Promise<unknown>;
  onServerRequest?(handler: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined): () => void;
  subscribe(listener: (event: CodexNotification) => void): () => void;
}
export function codexObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex 协议响应无效。');
  return value as Record<string, unknown>;
}
export function codexID(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)) throw new Error('Codex 协议标识无效。');
  return value;
}
