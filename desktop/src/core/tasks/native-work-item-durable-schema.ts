import { isUUID, validateModel } from '../sessions/session-schema.js';
import { validateAgentSource, validateAgentBinding } from '../sessions/agent-session-schema.js';
import { boundedString, canonicalDigest, exactObject, strictDate } from '../storage/execution-records.js';
import { StorageError } from '../storage/private-storage.js';
import { validateNativeInput } from './native-work-item-bridge.js';
import type { NativeTaskRef, NativeWorkItemAttempt } from './native-work-item-contract.js';
export const nativeInvalid = (message = '原生工作项记录无效。'): never => { throw new StorageError('native-record-invalid', message); };
export const digestString = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function nativeTaskKey(task: NativeTaskRef): { project_id: string; task_id: string } | { local_plan_id: string } {
  const v = exactObject(task, task?.kind === 'local' ? ['kind', 'planID'] : ['kind', 'planID', 'projectID', 'taskID']);
  if (!isUUID(v.planID) || v.planID !== v.planID.toLowerCase()) nativeInvalid();
  if (v.kind === 'local') return { local_plan_id: v.planID as string };
  if (v.kind !== 'project' || !boundedString(v.projectID, 200) || !boundedString(v.taskID, 200)) nativeInvalid();
  return { project_id: v.projectID as string, task_id: v.taskID as string };
}
export function validateDurableAttempt(value: unknown): NativeWorkItemAttempt {
  const v = exactObject(value, ['id', 'input', 'planDigest', 'prompt', 'inputDigest', 'source', 'status'], ['sessionID', 'turnID', 'clientRequestID', 'acceptance']);
  const a = v as unknown as NativeWorkItemAttempt; validateNativeInput(a.input); nativeTaskKey(a.input.task);
  if (!isUUID(a.id) || !digestString(a.planDigest) || !boundedString(a.prompt, 256 * 1024) || !digestString(a.inputDigest) || !['preparing', 'prepared', 'dispatching', 'finished', 'failed', 'cancelled', 'unknown'].includes(a.status)) nativeInvalid();
  const s = exactObject(a.source, ['agentID', 'configDigest', 'runtimeID', 'connectionGeneration', 'name', 'protocol', 'capabilities', 'state', 'model']);
  validateAgentSource({ agentID: s.agentID, configDigest: s.configDigest });
  validateAgentBinding({ runtimeID: s.runtimeID, connectionGeneration: s.connectionGeneration, externalSessionID: 'validate' }); validateModel(s.model);
  if (s.agentID !== a.input.agentID || s.state !== 'ready' || !boundedString(s.name, 150) || !['acp', 'native'].includes(String(s.protocol))) nativeInvalid();
  const c = exactObject(s.capabilities, ['streaming', 'nativeContext', 'interrupt', 'resume', 'tools', 'approvals', 'modelSelection']);
  if (Object.values(c).some(v => typeof v !== 'boolean') || !c.tools || !c.approvals) nativeInvalid();
  for (const id of [a.sessionID, a.turnID, a.clientRequestID]) if (id !== undefined && !isUUID(id)) nativeInvalid();
  if (!!a.turnID !== !!a.clientRequestID || a.turnID && !a.sessionID || ['prepared', 'dispatching', 'finished'].includes(a.status) && !a.sessionID || a.status === 'finished' && !a.turnID) nativeInvalid();
  if (a.inputDigest !== canonicalDigest({ input: a.input, source: a.source, planDigest: a.planDigest, prompt: a.prompt })) nativeInvalid('冻结输入指纹不匹配。');
  if ('acceptance' in v) {
    const r = exactObject(a.acceptance, ['decision', 'evidenceDigest', 'actor', 'comment']);
    if (!['accepted', 'rejected'].includes(String(r.decision)) || !digestString(r.evidenceDigest) || !boundedString(r.actor, 200) || typeof r.comment !== 'string' || Buffer.byteLength(r.comment) > 8192 || r.decision === 'accepted' && a.status !== 'finished') nativeInvalid();
  }
  return structuredClone(a);
}
export interface NativeStartApproval {
  id: string; attemptID: string; targetDigest: string; state: 'pending' | 'approved' | 'rejected';
  createdAt: string; expiresAt: string; decisionID?: string; consumed?: true; revoked?: true;
}
export interface NativeTaskJournal {
  schema_version: 1; kind: 'native_work_item_journal'; key: ReturnType<typeof nativeTaskKey>;
  revision: number; attempts: NativeWorkItemAttempt[]; approvals: NativeStartApproval[];
}
export function validateNativeJournal(value: unknown, key: ReturnType<typeof nativeTaskKey>): NativeTaskJournal {
  const v = exactObject(value, ['schema_version', 'kind', 'key', 'revision', 'attempts', 'approvals']);
  if (v.schema_version !== 1 || v.kind !== 'native_work_item_journal' || canonicalDigest(v.key) !== canonicalDigest(key) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || !Array.isArray(v.attempts) || v.attempts.length > 256 || !Array.isArray(v.approvals) || v.approvals.length > 512) nativeInvalid();
  const k = exactObject(v.key, 'local_plan_id' in (v.key as object) ? ['local_plan_id'] : ['project_id', 'task_id']);
  if ('local_plan_id' in k ? !isUUID(k.local_plan_id) : !boundedString(k.project_id, 200) || !boundedString(k.task_id, 200)) nativeInvalid();
  const j = v as unknown as NativeTaskJournal;
  for (const a of j.attempts) { validateDurableAttempt(a); if (canonicalDigest(nativeTaskKey(a.input.task)) !== canonicalDigest(key)) nativeInvalid(); }
  for (const r of j.approvals) {
    exactObject(r, ['id', 'attemptID', 'targetDigest', 'state', 'createdAt', 'expiresAt'], ['decisionID', 'consumed', 'revoked']);
    if (!isUUID(r.id) || !j.attempts.some(a => a.id === r.attemptID) || !digestString(r.targetDigest) || !['pending', 'approved', 'rejected'].includes(r.state) || !strictDate(r.createdAt) || !strictDate(r.expiresAt) || r.expiresAt <= r.createdAt || r.decisionID !== undefined && !isUUID(r.decisionID) || (r.state === 'pending') !== !r.decisionID || r.consumed !== undefined && (r.consumed !== true || r.state !== 'approved') || r.revoked !== undefined && r.revoked !== true) nativeInvalid();
  }
  if (new Set(j.attempts.map(a => a.id)).size !== j.attempts.length || new Set(j.attempts.map(a => a.input.clientRequestID)).size !== j.attempts.length || new Set(j.approvals.map(a => a.id)).size !== j.approvals.length || new Set(j.attempts.flatMap(a => a.sessionID ? [a.sessionID] : [])).size !== j.attempts.filter(a => a.sessionID).length) nativeInvalid();
  return structuredClone(j);
}
