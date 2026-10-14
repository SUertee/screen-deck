import type { ModelSelection, TurnRecord, SessionRecord, HistoryDiagnostic } from './types.js';

export type UUID = string;
export type Digest = string; // main 计算的 SHA-256 十六进制摘要
export type SessionRef = { format: 'chat-v1' | 'task-v2'; sessionID: UUID };
export type TaskSessionRef = { format: 'task-v2'; sessionID: UUID };
export interface TurnRef { session: SessionRef; turnID: UUID }
export interface TaskTurnRef { session: TaskSessionRef; turnID: UUID }
export interface WorkItemRef {
  planID: UUID;
  planVersion: number;
  workItemID: UUID;
}
export interface MaterialRef {
  referenceID: string;
  contentDigest: Digest;
}
export interface WorkspaceRef {
  workspaceID: UUID;
  bindingDigest: Digest;
}
export interface DriverRef {
  driverID: string;
  configDigest: Digest;
  mode: 'simulation' | 'external';
}

export type ToolPolicy =
  | { kind: 'none' }
  | {
      kind: 'restricted';
      readRoots: string[];   // workspace 相对目录
      writeRoots: string[];
      commands: Array<{ argv: string[]; cwd: string }>; // 精确参数数组
    };
export type ToolAction =
  | { kind: 'file-read'; path: string }
  | { kind: 'file-write'; path: string; content: string }
  | { kind: 'command'; argv: string[]; cwd: string };
export interface ExecutionSpec {
  work: WorkItemRef;
  title: string;
  kind: 'discussion' | 'implementation' | 'validation';
  expectedResult: string;
  dependencies: Array<{ workItemID: UUID; acceptanceID: UUID }>;
  inputMessageID: UUID; // 指向同 Session 中已保存的本次 user 消息
  materials: MaterialRef[];
  workspace: WorkspaceRef;
  driver: DriverRef;
  tools: ToolPolicy;
}
export interface ExternalExecutionBinding {
  runtimeID: string;
  connectionGeneration: string;
  externalSessionID: string;
  externalSubmissionID?: string;
}
export interface ExecutionResult {
  summary: string;
  artifacts: MaterialRef[];
  evidence: MaterialRef[];
}
export type TaskTurnState =
  | 'prepared' | 'submitting' | 'running' | 'awaiting_permission'
  | 'cancelling' | 'finished' | 'failed' | 'cancelled' | 'unknown';
export interface PermissionExchange {
  externalRequestID: string;
  action: ToolAction;
  actionDigest: Digest;
  approvalID?: UUID;
  delivery?: 'sending' | 'accepted' | 'rejected' | 'unknown';
}
export interface EventReceipt { eventID: string; sequence: number; digest: Digest }
export interface TaskTurnRecord extends Omit<TurnRecord, 'state'> {
  state: TaskTurnState;
  execution: {
    spec: ExecutionSpec;
    specDigest: Digest;
    authorizationID?: UUID; // 仅在取得启动权的同一次 CAS 中填入
    external?: ExternalExecutionBinding;
    eventReceipts: EventReceipt[];
    permissions: PermissionExchange[];
    result?: ExecutionResult;
  };
}
export interface TaskSessionRecord extends Omit<SessionRecord, 'schema_version' | 'scope' | 'binding' | 'turns'> {
  schema_version: 2;
  kind: 'electron_task_session';
  scope: { kind: 'project'; project_id: string; task_id: string };
  turns: TaskTurnRecord[];
}

export type ApprovalTarget =
  | { kind: 'execution'; turn: TaskTurnRef; specDigest: Digest }
  | { kind: 'tool'; turn: TaskTurnRef; externalRequestID: string; actionDigest: Digest };
export type ApprovalRequest = {
  schema_version: 1;
  kind: 'electron_execution_approval';
  id: UUID;
  target: ApprovalTarget;
  created_at: string;
  expires_at: string;
  invalidation?: { invalidated_at: string; reason: string };
} & (
  | { state: 'pending' }
  | { state: 'approved' | 'rejected'; decided_by: string; decided_at: string }
);
export interface AuthorizationInput {
  planID: UUID;
  expectedPlanVersion: number;
  workItemID: UUID;
  session: TaskSessionRef;
  clientRequestID: UUID;
  text: string;
  materialIDs: string[];
  workspaceID: UUID;
  driverID: string;
  model: ModelSelection;
  tools: ToolPolicy;
}
export interface PreparedAuthorization { turn: TaskTurnRef; request: ApprovalRequest }
export interface StartReceipt {
  turn: TaskTurnRef;
  status: 'started' | 'already-started' | 'not-started' | 'unknown';
}

export interface TaskExecutionAPI {
  getTaskExecutionOptions(input: { projectID: string; taskID: string }): Promise<TaskExecutionOptions>;
  retryTaskPendingWrites(ref: TaskSessionRef): Promise<void>;
  createTaskSession(input: { title: string; projectID: string; taskID: string }): Promise<TaskSessionRecord>;
  listTaskSessions(input: { projectID: string; taskID: string }): Promise<{ records: TaskSessionRecord[]; diagnostics: HistoryDiagnostic[] }>;
  loadTaskSession(ref: TaskSessionRef): Promise<TaskSessionRecord | undefined>;
  listExecutionApprovals(turn: TaskTurnRef): Promise<ApprovalRequest[]>;
  getWorkItemReview(turn: TaskTurnRef): Promise<{ turn: TaskTurnRef; resultDigest: Digest; result: ExecutionResult; acceptance?: AcceptanceRecord }>;
  onTaskSessionEvent(listener: (event: TaskSessionEvent) => void): () => void;
  requestExecutionAuthorization(input: AuthorizationInput): Promise<PreparedAuthorization>;
  decideApproval(input: { requestID: UUID; choice: 'approve' | 'reject' }): Promise<ApprovalRequest>;
  startExecution(input: { turn: TaskTurnRef; approvalID: UUID }): Promise<StartReceipt>;
  cancelExecution(turn: TaskTurnRef): Promise<TaskTurnRecord>;
  replyToolPermission(input: { turn: TaskTurnRef; approvalID: UUID }): Promise<PermissionExchange>;
  reconcileExecution(turn: TaskTurnRef): Promise<TaskTurnRecord>;
  reviewWorkItem(input: { turn: TaskTurnRef; resultDigest: Digest; choice: 'accept' | 'reject'; comment?: string }): Promise<AcceptanceRecord>;
}
export type TaskSessionEvent =
  | { type: 'task-session-updated'; session: TaskSessionRecord }
  | { type: 'diagnostic'; session?: TaskSessionRef; message: string };
export type HarnessErrorCode =
  | 'invalid-input' | 'conflict' | 'not-approved'
  | 'unsupported' | 'persistence' | 'execution-unknown';
export interface AcceptanceRecord {
  schema_version: 1;
  kind: 'electron_execution_acceptance';
  id: UUID;
  turn: TaskTurnRef;
  resultDigest: Digest;
  decision: 'accepted' | 'rejected';
  decided_by: string;
  decided_at: string;
  comment?: string;
}
export type TaskExecutionEvent =
  | { type: 'bound'; binding: ExternalExecutionBinding }
  | { type: 'submitted'; externalSubmissionID?: string }
  | { type: 'text-delta'; text: string }
  | { type: 'observed-model'; model: ModelSelection }
  | { type: 'permission-request'; externalRequestID: string; action: ToolAction }
  | { type: 'settled'; outcome: 'finished'; result: ExecutionResult }
  | { type: 'settled'; outcome: 'failed' | 'cancelled'; result?: ExecutionResult; reason?: string };
export interface TaskEventEnvelope { eventID: string; sequence: number; event: TaskExecutionEvent }
export interface TaskExecutionRequest {
  turn: TaskTurnRef;
  clientRequestID: UUID;
  spec: ExecutionSpec;
  model: ModelSelection; // 从原 Turn 投影，不再落盘一份
  input: string; // main 从冻结的 Message 解析，不在外部另立本地历史
  resolved: { // main 私有的本次调用材料，不跨 IPC、不持久化
    workspaceRoot: string;
    materials: Array<{ reference: MaterialRef; bytes: Uint8Array }>;
  };
}
export interface ExecutionLookup {
  clientRequestID: UUID;
  driver: DriverRef;
  workspace: WorkspaceRef;
  binding?: ExternalExecutionBinding;
}
export type ExternalObservation =
  | { status: 'unverifiable'; reason: string }
  | ({
      binding: ExternalExecutionBinding;
      output: string; // 该次尝试的完整 assistant 正文，替换归并，不当 delta 追加
      observedModel?: ModelSelection;
      permissionReceipts: Array<{
        externalRequestID: string; actionDigest: Digest;
        choice: 'allowOnce' | 'deny'; status: 'accepted' | 'rejected';
      }>;
    } & (
      | { status: 'running' }
      | { status: 'awaiting_permission'; pending: { externalRequestID: string; action: ToolAction } }
      | { status: 'finished'; result: ExecutionResult }
      | { status: 'failed' | 'cancelled'; result?: ExecutionResult; reason?: string }
    ));
// ExecutionDriver 的 execute 和普通聊天请求／事件契约保持原样。

export interface TaskExecutionOptions { workspace: WorkspaceRef; drivers: DriverRef[]; model: ModelSelection }
