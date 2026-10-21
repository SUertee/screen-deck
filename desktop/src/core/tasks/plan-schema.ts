import type { PreviewPlan, PreviewPlanScope } from '../../shared/types.js';
import { isUUID, validateModel } from '../sessions/session-schema.js';
import { StorageError } from '../storage/private-storage.js';

export interface CreatePreviewPlanOptions { schemaVersion?: 1 | 2 | 3 }

export function validatePreviewPlanScope(value: unknown): asserts value is PreviewPlanScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('invalid-plan-scope', '预览计划关联无效。');
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2 || !Object.keys(scope).every(key => ['project_id', 'task_id'].includes(key)) || typeof scope.project_id !== 'string' || !/^project-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(scope.project_id) || typeof scope.task_id !== 'string' || !/^task-\d{3,}$/.test(scope.task_id)) throw new StorageError('invalid-plan-scope', '预览计划项目或任务标识无效。');
}

/** All formats share one store; reading or validating never upgrades stored bytes. */
export function validatePreviewPlan(value: unknown): PreviewPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('invalid-plan', '预览计划无效。');
  const plan = value as PreviewPlan;
  if (![1, 2, 3].includes(plan.schema_version) || plan.kind !== 'electron_preview_plan' || !isUUID(plan.id) || typeof plan.title !== 'string' || !plan.title.trim() || Buffer.byteLength(plan.title) > 600 || !Number.isSafeInteger(plan.version) || plan.version < 1 || !Number.isFinite(Date.parse(plan.created_at)) || !Number.isFinite(Date.parse(plan.updated_at)) || !Array.isArray(plan.work_items) || plan.work_items.length > 1000 || Object.keys(plan).some(key => !['schema_version', 'kind', 'id', 'title', 'version', 'created_at', 'updated_at', 'scope', 'work_items', ...(plan.schema_version === 3 ? ['task'] : [])].includes(key))) throw new StorageError('invalid-plan', '预览计划无效。');
  if (plan.scope !== undefined) validatePreviewPlanScope(plan.scope);
  if (plan.schema_version === 3) { validateTaskContent(plan.task); if (plan.task?.creation_receipt && plan.task.creation_receipt.requestID !== plan.id) throw new StorageError('invalid-task-receipt','任务创建回执必须属于原任务。'); if (plan.task?.chat_origin && plan.task.chat_origin.requestID !== plan.id) throw new StorageError('invalid-chat-origin','聊天创建回执必须属于原任务。'); }
  const v2 = plan.schema_version >= 2;
  const fields = ['id', 'title', 'kind', 'assignee', 'model', 'expected_result', 'dependencies', 'status', ...(v2 ? ['agentID'] : [])];
  const assignees = v2 ? ['human', 'chat', 'unassigned', 'agent'] : ['human', 'chat', 'unassigned'];
  const ids = new Set<string>();
  for (const item of plan.work_items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !isUUID(item.id) || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 600 || !['discussion', 'implementation', 'validation'].includes(item.kind) || !assignees.includes(item.assignee) || typeof item.expected_result !== 'string' || !v2 && !item.expected_result.trim() || item.expected_result.length > 4096 || !['planned', 'completed'].includes(item.status) || !Array.isArray(item.dependencies) || Object.keys(item).some(key => !fields.includes(key))) throw new StorageError('invalid-plan', '预览工作项无效。');
    if (item.assignee === 'agent') {
      if (!v2 || typeof item.agentID !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(item.agentID)) throw new StorageError('invalid-plan', 'Agent 分工需要有效的 Agent 标识。');
    } else if (item.agentID !== undefined) throw new StorageError('invalid-plan', '只有 Agent 工作项可以指定 Agent。');
    if (item.model !== undefined) {
      if (item.assignee !== 'chat' && item.assignee !== 'agent') throw new StorageError('invalid-plan', '只有聊天或 Agent 工作项可以指定模型。');
      validateModel(item.model);
    }
    if (item.assignee === 'chat' && (item.kind !== 'discussion' || !item.model)) throw new StorageError('invalid-plan', '聊天分派仅支持指定模型的讨论工作项。');
    ids.add(item.id);
  }
  const byID = new Map(plan.work_items.map(item => [item.id, item]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new StorageError('dependency-cycle', '工作项依赖包含循环。');
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byID.get(id)!;
    if (new Set(item.dependencies).size !== item.dependencies.length) throw new StorageError('invalid-plan', '工作项依赖重复。');
    for (const dependency of item.dependencies) { if (!ids.has(dependency)) throw new StorageError('invalid-plan', '工作项依赖不存在。'); visit(dependency); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return plan;
}

/** Bounded, explicit summaries only. References are labels, never implicit filesystem access. */
function validateTaskContent(value: unknown): void {
  const object = (v: unknown, fields: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) throw new StorageError('invalid-task-content', '任务内容格式无效。');
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max: number) => typeof v === 'string' && Buffer.byteLength(v) <= max;
  const t = object(value, ['goal', 'completion_conditions', 'materials', 'chat_refs', 'context_receipts', 'project_id', 'chat_origin', 'creation_receipt']);
  if (!text(t.goal, 16384) || !Array.isArray(t.completion_conditions) || t.completion_conditions.length > 100 || t.completion_conditions.some(v => !text(v, 4096) || !v.trim()) || !Array.isArray(t.materials) || t.materials.length > 100 || !Array.isArray(t.chat_refs) || t.chat_refs.length > 100) throw new StorageError('invalid-task-content', '任务目标、完成条件或材料无效。');
  if (t.project_id !== undefined && (typeof t.project_id !== 'string' || !/^project-[a-f0-9-]{36}$/.test(t.project_id))) throw new StorageError('invalid-task-content', '任务项目归属无效。');
  if (t.creation_receipt !== undefined) { const receipt = object(t.creation_receipt,['requestID','requestDigest']); if (!isUUID(receipt.requestID) || typeof receipt.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.requestDigest)) throw new StorageError('invalid-task-receipt','任务创建回执无效。'); }
  if (t.chat_origin !== undefined) {
    const origin = object(t.chat_origin, ['requestID','requestDigest','source','sessionID','messageID','turnID','messageDigest']);
    if (!isUUID(origin.requestID) || !isUUID(origin.sessionID) || !isUUID(origin.messageID) || !isUUID(origin.turnID) || !['model','agent'].includes(String(origin.source)) || ![origin.requestDigest,origin.messageDigest].every(v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v))) throw new StorageError('invalid-chat-origin','任务聊天来源无效。');
  }
  const ids = new Set<string>(); const confirmations = new Set<string>();
  for (const value of t.materials) {
    const m = object(value, ['id', 'title', 'summary', 'source', 'confirmation_id', 'screen_clues']);
    const s = object(m.source, ['kind', 'reference', 'label']);
    if (!isUUID(m.id) || ids.has(m.id) || !text(m.title, 600) || !String(m.title).trim() || !text(m.summary, 32768) || !['note', 'screen'].includes(String(s.kind)) || !text(s.reference, 2048) || !text(s.label, 600) || m.confirmation_id !== undefined && (!isUUID(m.confirmation_id) || confirmations.has(m.confirmation_id))) throw new StorageError('invalid-task-content', '任务材料或来源无效。');
    if (m.screen_clues !== undefined) {
      if (s.kind !== 'screen' || !Array.isArray(m.screen_clues) || m.screen_clues.length < 1 || m.screen_clues.length > 32) throw new StorageError('invalid-task-content', '屏幕来源列表无效。');
      const frameIDs = new Set<string>();
      for (const value of m.screen_clues) {
        const clue = object(value, ['source', 'note', 'excerpt']);
        const source = object(clue.source, ['kind', 'frameID', 'capturedAt', 'appName', 'bundleID', 'displayID', 'width', 'height']);
        if (source.kind !== 'screen-frame' || typeof source.frameID !== 'string' || !/^\d{13}-[0-9a-f-]{36}$/.test(source.frameID) || frameIDs.has(source.frameID) || !text(source.capturedAt, 100) || !Number.isFinite(Date.parse(String(source.capturedAt))) || !text(source.appName, 600) || !text(source.bundleID, 600) || ![source.displayID, source.width, source.height].every(v => Number.isSafeInteger(v) && Number(v) > 0) || !text(clue.note, 4000)) throw new StorageError('invalid-task-content', '屏幕来源字段无效。');
        frameIDs.add(source.frameID);
        if (clue.excerpt !== undefined) { const excerpt = object(clue.excerpt, ['kind', 'text']); if (excerpt.kind !== 'user-reviewed' || !text(excerpt.text, 8000)) throw new StorageError('invalid-task-content', '屏幕摘录无效。'); }
      }
    }
    ids.add(m.id); if (typeof m.confirmation_id === 'string') confirmations.add(m.confirmation_id);
  }
  if (t.context_receipts !== undefined) {
    if (!Array.isArray(t.context_receipts) || t.context_receipts.length > 1000) throw new StorageError('invalid-task-content', '上下文确认记录无效。');
    const receiptIDs = new Set<string>();
    for (const value of t.context_receipts) {
      const receipt = object(value, ['confirmationID', 'requestDigest', 'materialID', 'savedVersion']);
      if (!isUUID(receipt.confirmationID) || receiptIDs.has(receipt.confirmationID) || !isUUID(receipt.materialID) || typeof receipt.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.requestDigest) || !Number.isSafeInteger(receipt.savedVersion) || Number(receipt.savedVersion) < 2) throw new StorageError('invalid-task-content', '上下文回执无效。');
      receiptIDs.add(receipt.confirmationID);
    }
  }
  const chats = new Set<string>();
  for (const value of t.chat_refs) {
    const c = object(value, ['source', 'sessionID']); const key = `${c.source}:${c.sessionID}`;
    if (!['model', 'agent'].includes(String(c.source)) || !isUUID(c.sessionID) || chats.has(key)) throw new StorageError('invalid-task-content', '关联聊天无效。');
    chats.add(key);
  }
}
