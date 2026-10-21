import type { ClientConnection, SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { ModelSelection } from '../../../shared/types.js';

/** Main-process private ACP connection; never crosses IPC or enters history. */
export type OpenCodeAcpEvent =
  | { type: 'session-update'; notification: SessionNotification }
  | { type: 'forbidden-permission'; request: RequestPermissionRequest };
export interface OpenCodeAcpConnection {
  readonly runtimeID: string;
  readonly connectionGeneration: string;
  readonly directory: string;
  readonly version: string;
  readonly configDigest: string;
  readonly model: ModelSelection;
  readonly rpc: ClientConnection;
  nativeTools?: boolean;
  onPermission?(handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | undefined): () => void;
  subscribe(listener: (event: OpenCodeAcpEvent) => Promise<void>): () => void;
}
