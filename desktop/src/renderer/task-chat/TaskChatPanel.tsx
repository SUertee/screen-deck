import React, { useId } from 'react';
import { AgentPermissionPicker } from '../AgentPermissionPicker';
import { permissionSummary } from '../../shared/agent-permissions';
import type { AgentNativeApproval } from '../../shared/agent-execution';
import { prepareTaskChatHandoff, stageTaskPlanProposal } from './task-chat-model';
import type { PendingTaskPlanDraft, ResourceState, TaskChatDraft, TaskChatHandoff, TaskChatMaterial, TaskChatScope, TaskChatSession, TaskPlanProposal } from './task-chat-model';
import './task-chat.css';

type Operation = { state: 'idle' | 'pending' | 'success' } | { state: 'error'; message: string };
export interface TaskChatPanelProps {
  scope?: TaskChatScope; sessions: ResourceState<TaskChatSession>; materials: ResourceState<TaskChatMaterial>;
  draft: TaskChatDraft; operation: Operation; linkedSessionID?: string;
  onChange(draft: TaskChatDraft): void; onPrepare(handoff: TaskChatHandoff): void;
  onRetrySessions(): void; onRetryMaterials(): void; onOpenSession(id: string): void;
  onUnlink?(): void; onOpenStandaloneChat(): void;
}
function ResourceNotice({ resource, empty, retry }: { resource: ResourceState<unknown>; empty: string; retry(): void }) {
  if (resource.state === 'loading') return <p role="status">正在读取…</p>;
  if (resource.state === 'error') return <div role="alert"><p>{resource.message}</p><button type="button" onClick={retry}>重新读取</button></div>;
  return resource.items.length ? null : <p>{empty}</p>;
}
/** No effects, IPC, model calls or persistence. Parent retains drafts per task key. */
export function TaskChatPanel(props: TaskChatPanelProps) {
  const { scope, draft, sessions, materials, operation } = props;
  const id = useId(), busy = operation.state === 'pending';
  if (!scope) return <section className="task-chat" aria-label="任务关联聊天"><h3>独立聊天</h3><p>无需关联任务也能聊天。</p><button type="button" onClick={props.onOpenStandaloneChat}>打开独立聊天</button></section>;
  let handoff: TaskChatHandoff | undefined, issue = '';
  try { handoff = prepareTaskChatHandoff(scope, draft, sessions, materials); } catch (error) { issue = error instanceof Error ? error.message : '请重新确认选择。'; }
  const selected = draft.target.kind === 'existing' && sessions.state === 'ready' ? sessions.items.find(item => draft.target.kind === 'existing' && item.id === draft.target.sessionID) : undefined;
  const linked = sessions.state === 'ready' ? sessions.items.find(item => item.id === props.linkedSessionID) : undefined;
  return <section className="task-chat" aria-label="任务关联聊天" aria-busy={busy}>
    <header><div><h3>关联聊天</h3><p>{scope.title} · 版本 {scope.version}{scope.workItem ? ` · ${scope.workItem.title}` : ''}</p></div><button type="button" onClick={props.onOpenStandaloneChat}>独立聊天</button></header>
    {props.linkedSessionID && <div className="task-chat-link"><span>已关联：{linked?.title ?? props.linkedSessionID}</span><button type="button" disabled={busy || !linked || !!linked.unavailableReason} onClick={() => props.onOpenSession(props.linkedSessionID!)}>打开聊天</button>{props.onUnlink && <button type="button" disabled={busy} onClick={props.onUnlink}>解除关联</button>}</div>}
    <fieldset disabled={busy}><legend>讨论位置</legend><div className="task-chat-targets">
      <label><input type="radio" name={`${id}-target`} checked={draft.target.kind === 'new'} onChange={() => props.onChange({ ...draft, target: { kind: 'new' } })} />新建讨论</label>
      <label><input type="radio" name={`${id}-target`} checked={draft.target.kind === 'existing'} onChange={() => props.onChange({ ...draft, target: { kind: 'existing', sessionID: '' } })} />选择已有聊天</label></div>
      {draft.target.kind === 'new' ? <p>先形成新聊天草稿，来源、目录与权限在新聊天中确认。</p> : <>
        <ResourceNotice resource={sessions} empty="没有可选择的聊天，可新建讨论。" retry={props.onRetrySessions} />
        {sessions.state === 'ready' && sessions.items.length > 0 && <label className="task-chat-field">已有聊天<select aria-label="已有聊天" value={draft.target.sessionID} onChange={event => props.onChange({ ...draft, target: { kind: 'existing', sessionID: event.target.value } })}><option value="">请选择聊天</option>{sessions.items.map(session => <option key={session.id} value={session.id} disabled={!!session.unavailableReason}>{session.title} · {session.sourceLabel}{session.unavailableReason ? ` · ${session.unavailableReason}` : ''}</option>)}</select></label>}
        {selected && <TaskChatExecutionContext session={selected} />}
      </>}
    </fieldset>
    <fieldset disabled={busy}><legend>带入材料 · {draft.materialIDs.length} 项</legend><p>仅带入勾选项的来源和摘要。打开或选择不会发送材料。</p>
      <ResourceNotice resource={materials} empty="任务暂无材料，可以直接讨论。" retry={props.onRetryMaterials} />
      {materials.state === 'ready' && materials.items.map(material => <label className="task-chat-material" key={material.id}><input type="checkbox" checked={draft.materialIDs.includes(material.id)} disabled={!material.available && !draft.materialIDs.includes(material.id)} onChange={event => props.onChange({ ...draft, materialIDs: event.target.checked ? [...draft.materialIDs, material.id] : draft.materialIDs.filter(value => value !== material.id) })} /><span><strong>{material.title}</strong><small>{material.sourceLabel}{!material.available && ' · 来源已失效，请取消选择'}</small><span>{material.summary || '暂无摘要'}</span></span></label>)}
      {draft.materialIDs.length > 0 && <button type="button" onClick={() => props.onChange({ ...draft, materialIDs: [] })}>清空材料选择</button>}
    </fieldset>
    <label className="task-chat-field" htmlFor={`${id}-text`}>讨论内容<textarea id={`${id}-text`} disabled={busy} rows={4} value={draft.text} placeholder="补充背景，或讨论这项工作的方案…" onChange={event => props.onChange({ ...draft, text: event.target.value })} /></label>
    <p className="task-chat-feedback" role={operation.state === 'error' ? 'alert' : 'status'}>{operation.state === 'error' ? operation.message : operation.state === 'success' ? '已放入聊天草稿；请在聊天中检查并发送。' : busy ? '正在准备草稿…' : issue || '只准备草稿；发送和执行仍需在聊天中明确操作。'}</p>
    <footer><button type="button" disabled={busy || !handoff} onClick={() => { if (handoff) props.onPrepare(handoff); }}>{busy ? '正在准备…' : '放入聊天草稿'}</button></footer>
  </section>;
}
export function TaskChatExecutionContext({ session }: { session: TaskChatSession }) {
  const execution = session.execution;
  return <div className="task-chat-context"><strong>{session.sourceLabel}</strong>{execution && session.agentID ? <><p className="task-chat-path">{execution.workspace.path}</p><AgentPermissionPicker value={execution.mode} disabled policy={permissionSummary(session.agentID, execution.mode)} onChange={() => {}} /><details><summary>权限说明</summary><p>{permissionSummary(session.agentID, execution.mode)}</p></details><p>目录与权限已固定，需要更换时新建聊天。</p></> : <p>{session.agentID ? '纯聊天，未绑定工作目录。' : '直接模型聊天，无本地工具权限。'}</p>}</div>;
}
/** Read-only projection of original requests. Decisions remain in AgentTurnTools. */
export function TaskChatApprovals({ sessionID, turnID, approvals, onOpenApproval }: { sessionID: string; turnID: string; approvals: ResourceState<AgentNativeApproval>; onOpenApproval(input: { sessionID: string; turnID: string; approvalID: string }): void }) {
  return <section className="task-chat" aria-label="任务聊天审批"><h3>原聊天审批</h3>{approvals.state === 'loading' ? <p role="status">正在读取审批…</p> : approvals.state === 'error' ? <p role="alert">{approvals.message}</p> : !approvals.items.length ? <p>暂无审批记录。</p> : approvals.items.map(approval => <div className="task-chat-approval" key={approval.id}><strong>{approval.title}</strong><pre>{approval.detail}</pre><p>{approval.state === 'expired' ? '申请已失效' : approval.state === 'decided' ? `${approval.decider === 'policy' ? '按模式处理' : '已人工决定'} · ${approval.decision === 'allow' ? '允许这一次' : approval.decision === 'deny' ? '拒绝' : '未记录决定'}` : approval.decider === 'policy' ? '正在按所选模式处理' : '等待在原聊天中确认'}{approval.reply === 'unknown' ? ' · 回复状态未确认' : approval.reply === 'pending' ? ' · 尚未交给 Agent' : approval.reply === 'queued' ? ' · 已交给原生协议处理' : ''}</p><button type="button" onClick={() => onOpenApproval({ sessionID, turnID, approvalID: approval.id })}>在原聊天查看</button></div>)}</section>;
}
export function TaskPlanProposalCard({ scope, proposal, text, operation, onChange, onStage, onReject }: { scope: TaskChatScope; proposal: TaskPlanProposal; text: string; operation: Operation; onChange(text: string): void; onStage(draft: PendingTaskPlanDraft): void; onReject(): void }) {
  const id = useId(); let staged: PendingTaskPlanDraft | undefined, issue = '';
  try { staged = stageTaskPlanProposal(scope, proposal, text); } catch (error) { issue = (error as Error).message; }
  return <section className="task-chat" aria-label="计划修改建议" aria-busy={operation.state === 'pending'}><h3>计划修改建议</h3><p>{proposal.sourceLabel} · 基于版本 {proposal.baseVersion}</p><p>{proposal.reason}</p><label className="task-chat-field" htmlFor={id}>候选修改<textarea id={id} rows={5} value={text} disabled={operation.state === 'pending'} onChange={event => onChange(event.target.value)} /></label><p role={issue || operation.state === 'error' ? 'alert' : 'status'}>{operation.state === 'error' ? operation.message : issue || (operation.state === 'pending' ? '正在生成待确认草稿…' : operation.state === 'success' ? '待确认草稿已生成，任务计划尚未修改。' : '仅生成待确认草稿，不保存计划或开始执行。')}</p><footer><button type="button" disabled={operation.state === 'pending'} onClick={onReject}>拒绝建议</button><button type="button" disabled={!staged || operation.state === 'pending'} onClick={() => { if (staged) onStage(staged); }}>生成待确认草稿</button></footer></section>;
}
