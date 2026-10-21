import type { AgentExecutionContext } from '../../shared/agent-execution';

/** UI-only adapter types. A supplies the canonical task reference and persists associations. */
export interface TaskChatScope { key: string; title: string; version: number; workItem?: { id: string; title: string } }
export type ResourceState<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; items: readonly T[] };
export interface TaskChatMaterial { id: string; title: string; sourceLabel: string; summary: string; available: boolean }
export interface TaskChatSession { id: string; title: string; sourceLabel: string; agentID?: string; execution?: AgentExecutionContext; unavailableReason?: string }
export interface TaskChatDraft { target: { kind: 'existing'; sessionID: string } | { kind: 'new' }; materialIDs: string[]; text: string }
export interface TaskChatHandoff {
  kind: 'discussion-draft'; taskKey: string; baseVersion: number; workItemID?: string;
  target: TaskChatDraft['target']; text: string;
  materials: Array<{ id: string; title: string; sourceLabel: string; summary: string }>;
}
export function prepareTaskChatHandoff(scope: TaskChatScope, draft: TaskChatDraft, sessions: ResourceState<TaskChatSession>, materials: ResourceState<TaskChatMaterial>): TaskChatHandoff {
  if (!scope.key || !Number.isInteger(scope.version) || scope.version < 1) throw new Error('任务版本不可用，请重新读取任务。');
  if (!draft.text.trim()) throw new Error('请填写要讨论的内容。');
  if (draft.target.kind === 'existing') {
    if (sessions.state !== 'ready') throw new Error('请先读取聊天列表。');
    const session = sessions.items.find(item => item.id === (draft.target.kind === 'existing' ? draft.target.sessionID : ''));
    if (!session || session.unavailableReason) throw new Error('所选聊天不可用，请重新选择。');
  }
  const selected = [...new Set(draft.materialIDs)];
  if (selected.length && materials.state !== 'ready') throw new Error('材料尚未读取成功，请重试或取消材料选择。');
  const payload = selected.map(id => {
    const material = materials.state === 'ready' ? materials.items.find(item => item.id === id) : undefined;
    if (!material?.available) throw new Error('所选材料已失效，请重新确认材料。');
    return { id: material.id, title: material.title, sourceLabel: material.sourceLabel, summary: material.summary };
  });
  return { kind: 'discussion-draft', taskKey: scope.key, baseVersion: scope.version, workItemID: scope.workItem?.id, target: { ...draft.target }, text: draft.text.trim(), materials: payload };
}
export interface TaskPlanProposal { id: string; taskKey: string; baseVersion: number; sourceLabel: string; reason: string; text: string }
export interface PendingTaskPlanDraft extends TaskPlanProposal { state: 'pending-confirmation' }
export function stageTaskPlanProposal(scope: TaskChatScope, proposal: TaskPlanProposal, text: string): PendingTaskPlanDraft {
  if (scope.key !== proposal.taskKey || scope.version !== proposal.baseVersion) throw new Error('任务版本已变化，请重新核对建议后再生成草稿。');
  if (!text.trim()) throw new Error('请填写候选修改，或拒绝这条建议。');
  return { ...proposal, text: text.trim(), state: 'pending-confirmation' };
}
