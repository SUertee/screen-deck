import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTaskChatHandoff, stageTaskPlanProposal } from '../../src/renderer/task-chat/task-chat-model';
import type { ResourceState, TaskChatDraft, TaskChatMaterial, TaskChatSession } from '../../src/renderer/task-chat/task-chat-model';
const scope = { key: 'local:plan-a', title: '合成任务', version: 3 };
const sessions: ResourceState<TaskChatSession> = { state: 'ready', items: [{ id: 'chat-a', title: '普通聊天', sourceLabel: '直接模型' }] };
const materials: ResourceState<TaskChatMaterial> = { state: 'ready', items: [{ id: 'm-a', title: '摘要', sourceLabel: '手动确认', summary: '明确选定摘要', available: true }, { id: 'm-b', title: '不带入', sourceLabel: '文件', summary: '未选正文', available: true }] };
const draft: TaskChatDraft = { target: { kind: 'existing', sessionID: 'chat-a' }, text: '  讨论方案  ', materialIDs: ['m-a'] };
test('handoff freezes only explicitly selected material summaries and discussion intent', () => {
  const result = prepareTaskChatHandoff({ ...scope, workItem: { id: 'step-a', title: '工作项' } }, draft, sessions, materials);
  assert.equal(result.kind, 'discussion-draft'); assert.equal(result.baseVersion, 3); assert.equal(result.workItemID, 'step-a');
  assert.deepEqual(result.materials.map(item => item.id), ['m-a']); assert.equal(result.text, '讨论方案');
  if (draft.target.kind === 'existing') { draft.target.sessionID = 'later'; assert.equal(result.target.kind === 'existing' && result.target.sessionID, 'chat-a'); draft.target.sessionID = 'chat-a'; }
  assert.equal('execution' in result, false); assert.equal('send' in result, false);
});
test('new discussion works without selected materials or readable existing chat list', () => {
  const result = prepareTaskChatHandoff(scope, { target: { kind: 'new' }, materialIDs: [], text: '讨论' }, { state: 'error', message: '不可读' }, { state: 'loading' });
  assert.deepEqual(result.materials, []); assert.equal(result.target.kind, 'new');
});
test('missing, unavailable or unreadable session blocks handoff', () => {
  for (const listing of [{ state: 'loading' }, { state: 'error', message: '读取失败' }, { state: 'ready', items: [] }, { state: 'ready', items: [{ id: 'chat-a', title: '聊天', sourceLabel: 'Agent', unavailableReason: '已归档' }] }] as ResourceState<TaskChatSession>[]) assert.throws(() => prepareTaskChatHandoff(scope, draft, listing, materials));
});
test('unreadable, missing or invalid selected materials block handoff rather than disappearing', () => {
  for (const listing of [{ state: 'loading' }, { state: 'error', message: '读取失败' }, { state: 'ready', items: [] }, { state: 'ready', items: [{ id: 'm-a', title: '摘要', sourceLabel: '文件', summary: '旧摘要', available: false }] }] as ResourceState<TaskChatMaterial>[]) assert.throws(() => prepareTaskChatHandoff(scope, draft, sessions, listing));
  const result = prepareTaskChatHandoff(scope, { ...draft, materialIDs: ['m-a', 'm-a'] }, sessions, materials); assert.equal(result.materials.length, 1);
});
test('empty input and invalid task versions cannot produce handoff', () => {
  assert.throws(() => prepareTaskChatHandoff(scope, { ...draft, text: ' \n ' }, sessions, materials));
  for (const version of [0, -1, 1.5, NaN]) assert.throws(() => prepareTaskChatHandoff({ ...scope, version }, draft, sessions, materials));
});
const proposal = { id: 'proposal-a', taskKey: scope.key, baseVersion: scope.version, sourceLabel: '聊天消息 2', reason: '补充验收', text: '候选修改' };
test('plan suggestion retains provenance and only becomes pending confirmation', () => {
  const result = stageTaskPlanProposal(scope, proposal, '  用户编辑后的候选  ');
  assert.equal(result.state, 'pending-confirmation'); assert.equal(result.text, '用户编辑后的候选'); assert.equal(result.sourceLabel, proposal.sourceLabel); assert.equal(result.baseVersion, 3); assert.equal(proposal.text, '候选修改');
});
test('plan suggestions reject wrong task, changed version and empty edits', () => {
  assert.throws(() => stageTaskPlanProposal({ ...scope, key: 'project:other' }, proposal, '候选'));
  assert.throws(() => stageTaskPlanProposal({ ...scope, version: 4 }, proposal, '候选'));
  assert.throws(() => stageTaskPlanProposal(scope, proposal, ' '));
});
