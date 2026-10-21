import type { AgentChatSourceInfo } from '../../shared/agent-chat';
import type { ModelSelection, PlanWorkItem, PreviewPlan } from '../../shared/types';

export interface DeckAssignment {
  assignee: 'unassigned' | 'human' | 'agent' | 'chat';
  agentID?: string;
  model?: ModelSelection;
}

export const assignmentKey = (value: DeckAssignment) => JSON.stringify([
  value.assignee, value.agentID ?? '', value.model?.provider_id ?? '',
  value.model?.model_id ?? '', value.model?.variant ?? '',
]);

export function itemAssignment(item: PlanWorkItem): DeckAssignment {
  if (item.assignee === 'human') return { assignee: 'human' };
  if (item.assignee === 'agent') return { assignee: 'agent', agentID: item.agentID, ...(item.model ? { model: { ...item.model } } : {}) };
  if (item.assignee === 'chat') return { assignee: 'chat', ...(item.model ? { model: { ...item.model } } : {}) };
  return { assignee: 'unassigned' };
}

export function assignItem(item: PlanWorkItem, value: DeckAssignment): PlanWorkItem {
  const { agentID: _agentID, model: _model, ...rest } = item;
  return { ...rest, ...value };
}

export function assignmentLabel(value: DeckAssignment, sources: AgentChatSourceInfo[]): string {
  if (value.assignee === 'human') return '我';
  if (value.assignee === 'unassigned') return '未分配';
  const name = value.assignee === 'chat' ? '模型聊天' : sources.find(source => source.agentID === value.agentID)?.name ?? value.agentID ?? 'Agent';
  return `${name} · ${value.model?.model_id ?? '跟随设置'}`;
}

export function availableAssignments(sources: AgentChatSourceInfo[]): DeckAssignment[] {
  return sources.map(source => ({
    assignee: 'agent', agentID: source.agentID,
    ...(source.state === 'ready' ? { model: { ...source.model } } : {}),
  }));
}

export function planProgress(plan: PreviewPlan) {
  const total = plan.work_items.length;
  const done = plan.work_items.filter(item => item.status === 'completed').length;
  return { total, done, completed: total > 0 && done === total };
}

export function mergePlans(current: PreviewPlan[], incoming: PreviewPlan[]): PreviewPlan[] {
  const merged = new Map(current.map(plan => [plan.id, plan]));
  for (const plan of incoming) {
    const previous = merged.get(plan.id);
    if (!previous || previous.version < plan.version) merged.set(plan.id, plan);
  }
  return [...merged.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}

export const deckError = (value: unknown): string => value instanceof Error ? value.message
  : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message
    : '保存未完成，输入已保留，请重试。';
