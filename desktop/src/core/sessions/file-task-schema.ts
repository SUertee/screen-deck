import { exactObject, boundedString, canonicalDigest, strictDate } from '../storage/execution-records.js';
import { StorageError } from '../storage/private-storage.js';
import { isUUID } from './session-schema.js';
import { validateDigest, validateFileTarget, validateIdentity, type FileWriteTarget, type FsIdentity, type HostWriteIntent } from '../tools/write.js';
import type { PreviewPlanScope } from '../../shared/types.js';
export interface FileTurnRef { session: { format: 'task-v3'; sessionID: string }; turnID: string }
export type ArtifactRole = 'baseline' | 'replacement' | 'proposal' | 'result' | 'diff';
export interface FileMaterialRef { role: ArtifactRole; contentDigest: string }
export interface FileApprovalTarget { turn: FileTurnRef; toolRequestID: string; actionDigest: string }
export interface FileApproval {
  schema_version: 2; kind: 'host_file_approval'; id: string; target: FileApprovalTarget;
  state: 'pending' | 'approved' | 'rejected'; created_at: string; expires_at: string;
  decided_at?: string; decided_by?: string; invalidation?: { invalidated_at: string; reason: string };
}
export interface FileFrozenSpec {
  workspaceID: string; target: FileWriteTarget; baseline: FileMaterialRef; replacement: FileMaterialRef;
  proposal: { assistantMessageID: string; text: FileMaterialRef };
}
export interface FileTaskTurn {
  id: string; clientRequestID: string; created_at: string; spec: FileFrozenSpec;
  actionDigest: string; toolRequestID: string; state: 'review' | 'sending' | 'finished' | 'failed' | 'cancelled' | 'unknown';
  approvalID?: string; intent?: HostWriteIntent;
  receipt?: { status: 'applied'; observedIdentity: FsIdentity; result: FileMaterialRef; diff: FileMaterialRef }
    | { status: 'not-applied' | 'unknown'; reason: string };
  resultDigest?: string;
}
export interface FileTaskSession {
  schema_version: 3; format: 'task-v3'; id: string; title: string;
  scope: PreviewPlanScope; created_at: string; revision: number; turn?: FileTaskTurn;
}
const invalid = (): never => { throw new StorageError('invalid-file-record', '文件执行记录无效。'); };
export function validateFileRef(value: unknown): asserts value is FileTurnRef {
  const ref = exactObject(value, ['session', 'turnID']); const session = exactObject(ref.session, ['format', 'sessionID']);
  if (session.format !== 'task-v3' || !isUUID(session.sessionID) || !isUUID(ref.turnID)) invalid();
}
export function validateFileScope(value: unknown): asserts value is PreviewPlanScope {
  const scope = exactObject(value, ['project_id', 'task_id']);
  if (typeof scope.project_id !== 'string' || !/^project-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(scope.project_id) || typeof scope.task_id !== 'string' || !/^task-\d{3,}$/.test(scope.task_id)) invalid();
}
export function validateFileApprovalTarget(value: unknown): asserts value is FileApprovalTarget {
  const v = exactObject(value, ['turn', 'toolRequestID', 'actionDigest']); validateFileRef(v.turn); validateDigest(v.actionDigest);
  if (!isUUID(v.toolRequestID)) invalid();
}
function material(value: unknown, role: ArtifactRole): void {
  const v = exactObject(value, ['role', 'contentDigest']); if (v.role !== role) invalid(); validateDigest(v.contentDigest);
}
export const fileTurnRef = (s: FileTaskSession): FileTurnRef => { if (!s.turn) return invalid(); return { session: { format: 'task-v3', sessionID: s.id }, turnID: s.turn.id }; };
export const fileActionDigest = (ref: FileTurnRef, scope: PreviewPlanScope, spec: FileFrozenSpec): string => canonicalDigest({ ref, scope, spec });
export const fileResultDigest = (ref: FileTurnRef, turn: FileTaskTurn): string => canonicalDigest({ ref, actionDigest: turn.actionDigest, receipt: turn.receipt });
export const fileUnresolved = (s: FileTaskSession): boolean => !!s.turn && ['review', 'sending', 'unknown'].includes(s.turn.state);
export function validateFileSession(value: unknown): FileTaskSession {
  const s = exactObject(value, ['schema_version', 'format', 'id', 'title', 'scope', 'created_at', 'revision'], ['turn']);
  validateFileScope(s.scope);
  if (s.schema_version !== 3 || s.format !== 'task-v3' || !isUUID(s.id) || !boundedString(s.title, 600) || !strictDate(s.created_at) || !Number.isSafeInteger(s.revision) || (s.revision as number) < 0) invalid();
  if (s.turn !== undefined) {
    const t = exactObject(s.turn, ['id', 'clientRequestID', 'created_at', 'spec', 'actionDigest', 'toolRequestID', 'state'], ['approvalID', 'intent', 'receipt', 'resultDigest']);
    if (!isUUID(t.id) || !isUUID(t.clientRequestID) || !isUUID(t.toolRequestID) || !strictDate(t.created_at) || !['review', 'sending', 'finished', 'failed', 'cancelled', 'unknown'].includes(String(t.state))) invalid();
    const spec = exactObject(t.spec, ['workspaceID', 'target', 'baseline', 'replacement', 'proposal']);
    if (!isUUID(spec.workspaceID)) invalid(); validateFileTarget(spec.target as FileWriteTarget);
    material(spec.baseline, 'baseline'); material(spec.replacement, 'replacement');
    const proof = exactObject(spec.proposal, ['assistantMessageID', 'text']); if (!isUUID(proof.assistantMessageID)) invalid(); material(proof.text, 'proposal');
    if ((spec.baseline as FileMaterialRef).contentDigest !== (spec.target as FileWriteTarget).expectedBaseDigest || (spec.baseline as FileMaterialRef).contentDigest === (spec.replacement as FileMaterialRef).contentDigest) invalid();
    const ref = { session: { format: 'task-v3', sessionID: s.id }, turnID: t.id } as FileTurnRef;
    if (t.actionDigest !== fileActionDigest(ref, s.scope as unknown as PreviewPlanScope, spec as unknown as FileFrozenSpec)) invalid();
    if (t.approvalID !== undefined && !isUUID(t.approvalID)) invalid();
    if (t.intent !== undefined) { const i = exactObject(t.intent, ['stagedName', 'stagedIdentity']); validateIdentity(i.stagedIdentity); if (typeof i.stagedName !== 'string' || !/^\.sd-[0-9a-f-]{36}\.tmp$/.test(i.stagedName)) invalid(); }
    if (t.receipt !== undefined) {
      const r = t.receipt as Record<string, unknown>;
      if (r.status === 'applied') { exactObject(r, ['status', 'observedIdentity', 'result', 'diff']); validateIdentity(r.observedIdentity); material(r.result, 'result'); material(r.diff, 'diff'); if (!t.intent || !t.approvalID || t.state !== 'finished' || (r.result as FileMaterialRef).contentDigest !== (spec.replacement as FileMaterialRef).contentDigest || canonicalDigest(r.observedIdentity) !== canonicalDigest((t.intent as HostWriteIntent).stagedIdentity)) invalid(); }
      else { exactObject(r, ['status', 'reason']); if (!['not-applied', 'unknown'].includes(String(r.status)) || !boundedString(r.reason, 4096)) invalid(); }
    }
    if (t.state === 'review' && (t.approvalID || t.intent || t.receipt || t.resultDigest)) invalid();
    if (t.state === 'sending' && (!t.approvalID || t.receipt || t.resultDigest)) invalid();
    if (t.state === 'finished' && ((t.receipt as { status?: string })?.status !== 'applied' || t.resultDigest !== fileResultDigest(ref, t as unknown as FileTaskTurn))) invalid();
    if (t.state !== 'finished' && t.resultDigest !== undefined) invalid();
    if (t.state === 'unknown' && (t.receipt as { status?: string })?.status !== 'unknown') invalid();
    if (['failed', 'cancelled'].includes(String(t.state)) && (t.receipt as { status?: string })?.status !== 'not-applied') invalid();
  }
  return value as FileTaskSession;
}
