import type { PreviewPlan } from '../../shared/types.js';
import { boundedString, canonicalDigest, exactObject } from '../storage/execution-records.js';
import { StorageError } from '../storage/private-storage.js';
import type { NativeTaskRef, NativeWorkItemAttempt, NativeWorkItemInput } from './native-work-item-contract.js';
interface ConfirmedMaterial { id: string; title: string; summary: string; source: { kind: 'note' | 'screen'; reference: string; label: string }; confirmation_id?: string }
/** Structural boundary matches A's v3 TaskReference, without redefining shared DTOs. */
export function nativeReferenceForPlan(reference: { kind: 'local'; planID: string } | { kind: 'project'; projectID: string; taskID: string }, plan: PreviewPlan): NativeTaskRef {
  if (reference.kind === 'local' ? plan.scope || plan.id !== reference.planID : plan.scope?.project_id !== reference.projectID || plan.scope?.task_id !== reference.taskID) throw new StorageError('task-source-mismatch', '所选计划与任务引用不匹配。');
  return reference.kind === 'local' ? { ...reference } : { ...reference, planID: plan.id };
}
const reference = (m: ConfirmedMaterial) => m.source.reference || `task-material:${m.id}`;
function materials(plan: PreviewPlan): ConfirmedMaterial[] {
  const v3 = plan as unknown as { schema_version: number; task?: { materials: ConfirmedMaterial[] } };
  if (v3.schema_version !== 3) return [];
  if (!v3.task || !Array.isArray(v3.task.materials)) throw new StorageError('invalid-material', 'v3材料记录无效。');
  return v3.task.materials;
}
/** Explicit IDs only. The digest includes title, summary, source and any confirmation identity. */
export function selectNativeTaskMaterials(plan: PreviewPlan, selectedIDs: string[]): NativeWorkItemInput['materials'] {
  if (!Array.isArray(selectedIDs) || selectedIDs.length > 32 || new Set(selectedIDs).size !== selectedIDs.length) throw new StorageError('invalid-material', '材料选择无效。');
  return selectedIDs.map(id => {
    const m = materials(plan).find(m => m.id === id);
    if (!m) throw new StorageError('invalid-material', '所选材料已不存在。');
    exactObject(m, ['id', 'title', 'summary', 'source'], ['confirmation_id', 'screen_clues']); exactObject(m.source, ['kind', 'reference', 'label']);
    if (!boundedString(m.summary, 32768) || !boundedString(m.title, 1024) || !(typeof m.source.reference === 'string' && m.source.reference.length <= 2048) || !boundedString(m.source.label, 1024) || !['note', 'screen'].includes(m.source.kind) || m.source.kind === 'screen' && !boundedString(m.confirmation_id, 200)) throw new StorageError('material-unconfirmed', '材料来源无效或屏幕材料尚无确认标识。');
    return { reference: reference(m), digest: canonicalDigest(m), summary: m.summary };
  });
}
export async function validateNativeTaskMaterials(plan: PreviewPlan, attempt: NativeWorkItemAttempt): Promise<void> {
  if (!attempt.input.materials.length) return;
  const all = materials(plan);
  for (const selected of attempt.input.materials) {
    const matches = all.filter(m => reference(m) === selected.reference && canonicalDigest(m) === selected.digest);
    if (matches.length !== 1 || canonicalDigest(selectNativeTaskMaterials(plan, [matches[0].id])[0]) !== canonicalDigest(selected)) throw new StorageError('material-changed', '材料摘要或确认来源已变化，未发送。');
  }
}
