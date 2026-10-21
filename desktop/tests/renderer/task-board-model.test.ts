import test from 'node:test';
import assert from 'node:assert/strict';
import { taskBoardStatus, type TaskExecutionSnapshot } from '../../src/renderer/tasks/task-board-model';
import type { PreviewPlan } from '../../src/shared/types';
import type { NativeWorkItemAttempt } from '../../src/core/tasks/native-work-item-contract';
import type { AgentExecutionRecord } from '../../src/shared/agent-execution';
const plan = (agent = true): PreviewPlan => ({ schema_version: 3, kind: 'electron_preview_plan', id: 'plan', title: '任务', version: 2, created_at: '', updated_at: '', task: { goal: '修复问题', completion_conditions: ['检查变更'], materials: [], chat_refs: [] }, work_items: [{ id: 'step', title: '修复', kind: 'implementation', assignee: agent ? 'agent' : 'human', ...(agent ? { agentID: 'codex' } : {}), status: 'completed', expected_result: '', dependencies: [] }] });
const attempt = (status: NativeWorkItemAttempt['status'], version = 2, decision?: 'accepted' | 'rejected') => ({ id: 'attempt', status, input: { workItemID: 'step', planVersion: version, agentID: 'codex' }, source: { name: 'Codex' }, ...(decision ? { acceptance: { decision } } : {}) }) as NativeWorkItemAttempt;
const ready = (attempts: NativeWorkItemAttempt[] = [], execution?: Partial<AgentExecutionRecord>): TaskExecutionSnapshot => ({ state: 'ready', attempts, executions: execution ? { attempt: { approvals: [], ...execution } as unknown as AgentExecutionRecord } : {} });
test('manual checkbox cannot complete an Agent item or accept a native result', () => {
  assert.equal(taskBoardStatus(plan(), ready()).column, 'pending');
  assert.equal(taskBoardStatus(plan(), ready([attempt('finished')])).label, '待验收');
  assert.equal(taskBoardStatus(plan(false), ready()).label, '人工完成');
});
test('only current-version accepted Agent results complete the task', () => {
  assert.equal(taskBoardStatus(plan(), ready([attempt('finished', 2, 'accepted')])).label, '已验收');
  assert.equal(taskBoardStatus(plan(), ready([attempt('finished', 1, 'accepted')])).label, '旧版本结果');
  const wrong = attempt('finished', 2, 'accepted'); wrong.input.agentID = 'opencode';
  assert.notEqual(taskBoardStatus(plan(), ready([wrong])).column, 'completed');
});
test('pending native permission takes priority over running state', () => {
  assert.equal(taskBoardStatus(plan(), ready([attempt('dispatching')], { status: 'running' })).column, 'running');
  const approval = { state: 'pending', reply: 'pending' } as AgentExecutionRecord['approvals'][number];
  assert.equal(taskBoardStatus(plan(), ready([attempt('dispatching')], { status: 'running', approvals: [approval] })).label, '待审批');
  assert.equal(taskBoardStatus(plan(), ready([attempt('dispatching')], { status: 'finished' })).label, '执行待核对');
});
test('read failure and unknown execution never look complete or idle', () => {
  assert.equal(taskBoardStatus(plan(), { state: 'error', attempts: [], executions: {} }).column, 'attention');
  assert.equal(taskBoardStatus(plan(), ready([attempt('unknown')])).label, '结果待核对');
  assert.equal(taskBoardStatus(plan(), ready([attempt('failed')])).label, '执行异常');
  assert.equal(taskBoardStatus(plan(), ready([attempt('finished', 2, 'rejected')])).label, '需修改');
});
test('latest attempt supersedes older acceptance and preparation never means execution', () => {
  assert.equal(taskBoardStatus(plan(), ready([attempt('finished', 2, 'accepted'), attempt('prepared')])).label, '待确认开始');
  assert.notEqual(taskBoardStatus(plan(), ready([attempt('preparing')])).column, 'running');
  assert.equal(taskBoardStatus(plan(), ready([attempt('cancelled')])).column, 'pending');
});
test('mixed manual and Agent work needs both human progress and accepted results', () => {
  const mixed = plan(); mixed.work_items.push({ ...plan(false).work_items[0], id: 'human', status: 'planned' });
  assert.equal(taskBoardStatus(mixed, ready([attempt('finished', 2, 'accepted')])).column, 'pending');
  mixed.work_items[1].status = 'completed';
  assert.equal(taskBoardStatus(mixed, ready([attempt('finished', 2, 'accepted')])).column, 'completed');
});
