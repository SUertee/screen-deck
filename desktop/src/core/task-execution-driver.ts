import type { ExecutionCapabilities } from './execution-driver.js';
import type { TaskExecutionRequest, TaskEventEnvelope, ExecutionLookup, ExternalObservation } from '../shared/task-execution.js';

export interface TaskExecutionDriver {
  readonly capabilities: ExecutionCapabilities;
  readonly taskCapabilities: Readonly<{ reconcile: boolean; confirmedCancel: boolean; permissionReply: boolean; enforcedToolScope: boolean }>;
  executeTask(request: TaskExecutionRequest, onEvent: (event: TaskEventEnvelope) => Promise<void>, signal: AbortSignal): Promise<void>;
  inspectExecution(lookup: ExecutionLookup): Promise<ExternalObservation>;
  cancelExecution(lookup: ExecutionLookup): Promise<{ status: 'confirmed' | 'unknown' }>;
  replyPermission(input: { lookup: ExecutionLookup; externalRequestID: string; actionDigest: string; choice: 'allowOnce' | 'deny' }): Promise<{ status: 'accepted' | 'rejected' | 'unknown' }>;
}
