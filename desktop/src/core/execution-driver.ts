import type { ModelSelection } from '../shared/types.js';

export interface ExecutionRequest {
  clientRequestID: string;
  model: ModelSelection;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
export type ExecutionEvent =
  | { type: 'submitted' }
  | { type: 'text-delta'; text: string }
  | { type: 'observed-model'; model: ModelSelection }
  | { type: 'completed' };

/** Stateless chat needs no invented external session, permissions, or remote abort. */
export interface ExecutionDriver {
  readonly capabilities: Readonly<{ chat: boolean; tools: boolean; remoteSessions: boolean; remoteAbort: boolean }>;
  execute(request: ExecutionRequest, onEvent: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
}

export type ExecutionErrorCode = 'configuration' | 'cancelled' | 'timeout' | 'http' | 'protocol' | 'incomplete' | 'tools-forbidden' | 'network';
export class ExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, message: string, readonly attempted: boolean) {
    super(message);
    this.name = 'ExecutionError';
  }
}
