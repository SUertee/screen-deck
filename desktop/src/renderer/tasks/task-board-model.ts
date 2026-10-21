import type { PreviewPlan } from '../../shared/types';
import type { NativeWorkItemAttempt } from '../../core/tasks/native-work-item-contract';
import type { AgentExecutionRecord } from '../../shared/agent-execution';

export type TaskColumn = 'pending' | 'running' | 'attention' | 'completed';
export const taskColumns: Array<{ id: TaskColumn; label: string }> = [
  { id: 'pending', label: '待推进' }, { id: 'running', label: '执行中' },
  { id: 'attention', label: '等我处理' }, { id: 'completed', label: '已完成' },
];
export interface TaskExecutionSnapshot {
  state: 'loading' | 'ready' | 'error';
  attempts: NativeWorkItemAttempt[];
  executions: Record<string, AgentExecutionRecord | undefined>;
}
export interface TaskBoardStatus { column: TaskColumn; label: string; next: string }
/** Read-only projection. Manual progress never grants approval or accepts native results. */
export function taskBoardStatus(plan: PreviewPlan, snapshot?: TaskExecutionSnapshot): TaskBoardStatus {
  if (!snapshot || snapshot.state === 'loading') return { column: 'pending', label: '读取状态中', next: '正在核对执行记录' };
  if (snapshot.state === 'error') return { column: 'attention', label: '状态未确认', next: '执行记录读取失败，请重试' };
  const latest = new Map<string, NativeWorkItemAttempt>();
  for (const attempt of snapshot.attempts) if (plan.work_items.some(item => item.id === attempt.input.workItemID)) latest.set(attempt.input.workItemID, attempt);
  const attention: TaskBoardStatus[] = [], running: TaskBoardStatus[] = [];
  for (const attempt of latest.values()) {
    const execution = snapshot.executions[attempt.id];
    if (attempt.status === 'unknown' || execution?.status === 'unknown' || execution?.approvals.some(a => a.reply === 'unknown')) attention.push({ column: 'attention', label: '结果待核对', next: '核对原尝试，避免重复执行' });
    else if (execution?.approvals.some(a => a.state === 'pending' || a.reply === 'pending')) attention.push({ column: 'attention', label: '待审批', next: '查看 Agent 的操作请求' });
    else if (attempt.status === 'dispatching' && execution?.status === 'running') running.push({ column: 'running', label: 'Agent 执行中', next: `${attempt.source.name} 正在处理工作项` });
    else if (attempt.status === 'dispatching') attention.push({ column: 'attention', label: '执行待核对', next: '打开原尝试核对最新结果' });
    else if (attempt.status === 'preparing' || attempt.status === 'prepared') attention.push({ column: 'attention', label: attempt.status === 'prepared' ? '待确认开始' : '准备待核对', next: '查看冻结输入与执行范围' });
    else if (attempt.input.planVersion !== plan.version && attempt.status !== 'cancelled') attention.push({ column: 'attention', label: '旧版本结果', next: '任务已更新，请核对原版本记录' });
    else if (attempt.status === 'failed' || attempt.acceptance?.decision === 'rejected') attention.push({ column: 'attention', label: attempt.status === 'failed' ? '执行异常' : '需修改', next: '查看原因并决定下一步' });
    else if (attempt.status === 'finished' && !attempt.acceptance) attention.push({ column: 'attention', label: '待验收', next: '查看变更与检查结果' });
  }
  if (attention.length) return attention[0];
  if (running.length) return running[0];
  const agents = plan.work_items.filter(item => item.assignee === 'agent');
  const complete = plan.work_items.length > 0 && plan.work_items.every(item => {
    if (item.assignee !== 'agent') return item.status === 'completed';
    const attempt = latest.get(item.id);
    return attempt?.status === 'finished' && attempt.input.agentID === item.agentID && attempt.input.planVersion === plan.version && attempt.acceptance?.decision === 'accepted';
  });
  if (complete) return { column: 'completed', label: agents.length ? '已验收' : '人工完成', next: agents.length ? '当前版本的工作项已完成' : '已记录人工完成进度' };
  return { column: 'pending', label: '待推进', next: !plan.task?.goal.trim() ? '补充任务目标' : !plan.work_items.length ? '生成执行计划' : '继续推进工作项' };
}
