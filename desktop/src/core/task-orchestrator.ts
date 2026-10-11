import { randomUUID } from 'node:crypto';
import type { DecisionRecommendation, PlanWorkItem, PreviewPlan, PreviewPlanScope } from '../shared/types.js';
import { PreviewRecordStore } from './preview-record-store.js';
import { StorageError } from './private-storage.js';
import { isUUID, validateModel } from './session-schema.js';
import { DecisionEngine } from './decision-engine.js';

export function validatePreviewPlanScope(value: unknown): asserts value is PreviewPlanScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('invalid-plan-scope', '预览计划关联无效。');
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2 || !Object.keys(scope).every(key => ['project_id', 'task_id'].includes(key)) || typeof scope.project_id !== 'string' || !/^project-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(scope.project_id) || typeof scope.task_id !== 'string' || !/^task-\d{3,}$/.test(scope.task_id)) throw new StorageError('invalid-plan-scope', '预览计划项目或任务标识无效。');
}

function validate(value: unknown): PreviewPlan {
  const plan = value as PreviewPlan;
  if (!plan || plan.schema_version !== 1 || plan.kind !== 'electron_preview_plan' || !isUUID(plan.id) || typeof plan.title !== 'string' || !plan.title.trim() || Buffer.byteLength(plan.title) > 600 || !Number.isSafeInteger(plan.version) || plan.version < 1 || !Number.isFinite(Date.parse(plan.created_at)) || !Number.isFinite(Date.parse(plan.updated_at)) || !Array.isArray(plan.work_items) || plan.work_items.length > 1000 || Object.keys(plan).some(key => !['schema_version', 'kind', 'id', 'title', 'version', 'created_at', 'updated_at', 'scope', 'work_items'].includes(key))) throw new StorageError('invalid-plan', '预览计划无效。');
  if (plan.scope !== undefined) validatePreviewPlanScope(plan.scope);
  const ids = new Set<string>();
  for (const item of plan.work_items) {
    if (!isUUID(item.id) || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 600 || !['discussion', 'implementation', 'validation'].includes(item.kind) || !['human', 'chat', 'unassigned'].includes(item.assignee) || typeof item.expected_result !== 'string' || !item.expected_result.trim() || item.expected_result.length > 4096 || !['planned', 'completed'].includes(item.status) || !Array.isArray(item.dependencies) || Object.keys(item).some(key => !['id', 'title', 'kind', 'assignee', 'model', 'expected_result', 'dependencies', 'status'].includes(key))) throw new StorageError('invalid-plan', '预览工作项无效。');
    if (item.model !== undefined) { if (item.assignee !== 'chat') throw new StorageError('invalid-plan', '只有聊天工作项可以指定模型。'); validateModel(item.model); }
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

/** Saving or editing a plan has no execution dependency and cannot send a request. */
export class TaskOrchestrator {
  private readonly store: PreviewRecordStore<PreviewPlan>;
  constructor(previewRoot: string) { this.store = new PreviewRecordStore(previewRoot, 'preview-plans', validate); }
  async createPlan(title: string, workItems: PlanWorkItem[] = [], scope?: PreviewPlanScope): Promise<PreviewPlan> {
    const now = new Date().toISOString();
    return this.store.save({ schema_version: 1, kind: 'electron_preview_plan', id: randomUUID(), title: title.trim(), version: 1, created_at: now, updated_at: now, ...(scope !== undefined ? { scope: structuredClone(scope) } : {}), work_items: structuredClone(workItems) }, false);
  }
  loadPlan(id: string): Promise<PreviewPlan | undefined> { return this.store.load(id); }
  listPlans(): Promise<PreviewPlan[]> { return this.store.list(); }
  async savePlan(plan: PreviewPlan, expectedVersion: number): Promise<PreviewPlan> {
    validate(plan);
    const original = await this.store.load(plan.id);
    if (!original) throw new StorageError('missing-plan', '预览计划不存在。');
    if (original.version !== expectedVersion || plan.version !== expectedVersion) throw new StorageError('plan-conflict', '预览计划版本冲突。');
    if (original.created_at !== plan.created_at || original.kind !== plan.kind) throw new StorageError('invalid-plan', '预览计划身份不可更改。');
    if (original.scope?.project_id !== plan.scope?.project_id || original.scope?.task_id !== plan.scope?.task_id) throw new StorageError('plan-scope-changed', '预览计划关联不可添加、移除或更改；独立计划仍保持独立。');
    const updated = { ...structuredClone(plan), version: expectedVersion + 1, updated_at: new Date().toISOString() };
    return this.store.save(updated, true);
  }
  async recommendations(plan: PreviewPlan): Promise<Array<{ workItemID: string; recommendation: DecisionRecommendation }>> {
    validate(plan);
    const engine = new DecisionEngine();
    return Promise.all(plan.work_items.map(async workItem => ({ workItemID: workItem.id, recommendation: await engine.recommend({ planVersion: plan.version, workItem, risk: workItem.kind === 'discussion' ? 'low' : 'medium', capabilities: ['stateless-chat'] }) })));
  }
  async editPlan(id: string, expectedPlanVersion: number, changes: { title?: string; workItems?: PlanWorkItem[] }): Promise<PreviewPlan> {
    const plan = await this.store.load(id);
    if (!plan) throw new StorageError('missing-plan', '预览计划不存在。');
    if (plan.version !== expectedPlanVersion) throw new StorageError('plan-conflict', '预览计划版本冲突。');
    const updated = { ...plan, title: changes.title?.trim() ?? plan.title, work_items: structuredClone(changes.workItems ?? plan.work_items), version: plan.version + 1, updated_at: new Date().toISOString() };
    return this.store.save(updated, true);
  }
}
