export type TaskStatus = 'draft' | 'ready' | 'running' | 'awaiting_approval' | 'verifying' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface RecordReference { path: string; label: string }
export interface ProjectIdentity {
  schema_version: 2; kind: 'project'; project_id: string; name: string; created_at: string;
}
export interface LegacyProject {
  schema_version: 1; kind: 'project'; project_id: string; name: string; created_at: string;
  timezone: 'Asia/Shanghai'; mode: 'manual_pilot'; references: RecordReference[];
}
export interface ProjectHistory {
  schema_version: 1; kind: 'project_history'; project_id: string; source_root: string;
  created_at: string; project: LegacyProject; migration: { backup_path: string; migrated_at: string };
}
export interface ProjectTask {
  schema_version: 1; kind: 'task'; project_id: string; task_id: string; title: string; goal: string;
  status: TaskStatus; plan_version: number; assignee: 'human' | 'agent' | 'shared';
  created_at: string; updated_at: string; run_ids: string[];
  acceptance: Array<{ id: string; description: string; verification: 'not_checked' | 'verified' | 'failed'; requires_human: boolean }>;
  references: RecordReference[];
}
export interface ProjectRun {
  schema_version: 1; kind: 'run'; project_id: string; task_id: string; run_id: string; plan_version: number;
  status: RunStatus; started_at: string | null; ended_at: string | null; recorded_at: string;
  executor: { agent: string; model: string | null; effort: string | null; metadata_source: string };
  skills: string[]; summary: string; references: RecordReference[];
  git: { commit_status: 'none' | 'committed' | 'unknown'; commit_ids: string[]; push_status: 'not_pushed' | 'pushed' | 'unknown' };
}
export interface ProjectDTO extends ProjectIdentity { root_path: string; history_bound: boolean; readonly: true }
export interface TaskDTO extends ProjectTask { historical: true; is_live: false }
export interface RunDTO extends ProjectRun { historical: true; is_live: false }
export interface ArtifactReferenceDTO {
  reference_id: string; project_id: string; owner_kind: 'project' | 'task' | 'run'; owner_id: string;
  label: string; path: string; source: 'project' | 'private'; preview_type: 'text' | 'image' | 'unsupported';
}
export interface ProjectDiagnostic {
  code: string; severity: 'info' | 'warning' | 'error'; path: string; message: string;
}
export interface ProjectWorkspaceResult {
  status: 'ready' | 'empty' | 'error' | 'stale'; project: ProjectDTO | null;
  tasks: TaskDTO[]; runs: RunDTO[]; artifact_refs: ArtifactReferenceDTO[];
  diagnostics: ProjectDiagnostic[]; loaded_at: string | null; historical: true;
}
export interface ProjectReaderLimits {
  jsonBytes: number; tasks: number; runs: number; totalBytes: number; directoryEntries: number;
  textPreviewBytes: number; imagePreviewBytes: number;
}
export type ArtifactPreview =
  | { type: 'text'; reference_id: string; label: string; text: string; mime_type: 'text/plain'; byte_length: number }
  | { type: 'image'; reference_id: string; label: string; base64: string; mime_type: string; byte_length: number };
