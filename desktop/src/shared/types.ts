import type { TaskCreationReceipt } from './task-goal';
import type { ChatTaskOrigin } from './chat-task';
/** Persisted session DTOs retain the existing Swift JSON v1 contract. */
export interface ModelSelection {
  provider_id: string;
  model_id: string;
  variant?: string;
}

export type SessionScope =
  | { kind: 'local_chat'; local_chat_id: string }
  | { kind: 'local_task'; local_task_id: string }
  | { kind: 'project'; project_id: string; task_id?: string };

export type TurnState = 'prepared' | 'submitting' | 'streaming' | 'finished' | 'failed' | 'cancelling' | 'cancelled' | 'unknown';
export interface TurnRecord {
  turn_id: string;
  client_request_id: string;
  requested_model: ModelSelection;
  observed_model?: ModelSelection;
  state: TurnState;
  created_at: string;
  updated_at: string;
  draft_revision: number;
  failure?: string;
}
export interface MessageRecord {
  message_id: string;
  turn_id: string;
  role: 'user' | 'assistant';
  text: string;
  external_message_id?: string;
  external_part_id?: string;
  created_at: string;
  updated_at: string;
}
export interface RuntimeSessionBinding {
  external_session_id: string;
  endpoint: string;
  directory: string;
  compatible_version: string;
  connection_generation: string;
}
export interface SessionRecord {
  schema_version: 1;
  conversation_id: string;
  title: string;
  scope: SessionScope;
  created_at: string;
  updated_at: string;
  revision: number;
  binding?: RuntimeSessionBinding;
  turns: TurnRecord[];
  messages: MessageRecord[];
}
export interface HistoryDiagnostic { filename: string; reason: string }
export interface SessionListing { records: SessionRecord[]; diagnostics: HistoryDiagnostic[] }
export interface SendMessageInput { sessionID: string; text: string; model: ModelSelection }
export interface SendResult {
  status: 'notSubmitted' | 'accepted' | 'uncertain';
  session: SessionRecord;
  reason?: string;
}
export type SessionEvent =
  | { type: 'session-updated'; session: SessionRecord }
  | { type: 'diagnostic'; sessionID?: string; message: string };

/** Plans are a separate preview format, not the existing task/run v1 records. */
export interface PlanWorkItem {
  id: string;
  title: string;
  kind: 'discussion' | 'implementation' | 'validation';
  assignee: 'human' | 'chat' | 'unassigned' | 'agent';
  /** v2 planning metadata only. It never starts or grants permission to an Agent. */
  agentID?: string;
  /** For an Agent, omission means following its actual connection when later selected. */
  model?: ModelSelection;
  expected_result: string;
  dependencies: string[];
  status: 'planned' | 'completed';
}
export interface PreviewPlanScope {
  project_id: string;
  task_id: string;
}
/** Stable navigation identity; project task IDs are never treated as local plan IDs. */
export type TaskReference = { kind: 'local'; planID: string } | { kind: 'project'; projectID: string; taskID: string };
export interface TaskScreenSource {
  kind: 'screen-frame'; frameID: string; capturedAt: string; appName: string; bundleID: string;
  displayID: number; width: number; height: number;
}
export interface TaskContextReceipt {
  confirmationID: string; requestDigest: string; materialID: string; savedVersion: number;
}
export interface TaskMaterial {
  id: string; title: string; summary: string;
  source: { kind: 'note' | 'screen'; reference: string; label: string };
  confirmation_id?: string;
  screen_clues?: Array<{ source: TaskScreenSource; note: string; excerpt?: { kind: 'user-reviewed'; text: string } }>;
}
export interface TaskContent {
  chat_origin?: ChatTaskOrigin;
  creation_receipt?: TaskCreationReceipt;
  project_id?: string;
  goal: string; completion_conditions: string[]; materials: TaskMaterial[];
  context_receipts?: TaskContextReceipt[];
  chat_refs: Array<{ source: 'model' | 'agent'; sessionID: string }>;
}
export interface PreviewPlan {
  /** Reads retain the original schema; explicit v3 saves add task content. */
  schema_version: 1 | 2 | 3;
  kind: 'electron_preview_plan';
  id: string;
  title: string;
  version: number;
  created_at: string;
  updated_at: string;
  /** An immutable association only; it grants no execution or source-write permission. */
  scope?: PreviewPlanScope;
  task?: TaskContent;
  work_items: PlanWorkItem[];
}
export interface DecisionContext {
  planVersion: number;
  workItem: PlanWorkItem;
  risk: 'low' | 'medium' | 'high';
  budgetAvailable?: boolean;
  capabilities: string[];
}
export interface DecisionRecommendation { candidate: 'human' | 'chat'; reasons: string[]; advisory: true }
export interface ApprovalContext {
  action: string;
  parameters: Record<string, unknown>;
  workspace: string;
  planID: string;
  planVersion: number;
}
export interface ApprovalDecision {
  schema_version: 1;
  kind: 'electron_preview_approval';
  id: string;
  context_digest: string;
  context: ApprovalContext;
  decision: 'approved' | 'rejected';
  decided_by: string;
  decided_at: string;
  expires_at?: string;
}
