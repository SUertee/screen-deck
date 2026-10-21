import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Circle, Clock3, FileText, RefreshCw, ShieldCheck, Square, X } from 'lucide-react';
import type { DesktopAPI } from '../shared/desktop-api';
import type { TaskDTO } from '../projects/types';
import type { AcceptanceRecord, ApprovalRequest, HarnessErrorCode, TaskSessionRecord, TaskTurnRecord, TaskTurnRef, TaskTurnState } from '../shared/task-execution';
import { Empty, formatDate, Markdown, Notice } from './components';
import './task-history.css';

type Review = Awaited<ReturnType<DesktopAPI['getWorkItemReview']>> & { acceptance?: AcceptanceRecord };
interface Props {
  api: DesktopAPI;
  task: Pick<TaskDTO, 'project_id' | 'task_id' | 'title'>;
  projectName?: string;
  sessionID: string;
  focusMessageID?: string;
  onSessionChange: (session: TaskSessionRecord) => void;
  onClose?: () => void;
}
const labels: Record<TaskTurnState, string> = { prepared: '尚未启动', submitting: '正在提交', running: '执行进行中', awaiting_permission: '等待工具许可', cancelling: '正在确认停止', finished: '执行结束', failed: '执行失败', cancelled: '已确认取消', unknown: '结果未知' };
const unresolvedPermission = (turn: TaskTurnRecord) => turn.execution.permissions.some(permission => permission.delivery === 'sending' || permission.delivery === 'unknown' || !permission.delivery && !['failed', 'cancelled'].includes(turn.state));
const unresolved = (turn: TaskTurnRecord) => !['finished', 'failed', 'cancelled'].includes(turn.state) || unresolvedPermission(turn);
const legacySimulation = (turn: TaskTurnRecord) => turn.execution.spec.driver.mode === 'simulation';
const legacyHistoryMessage = '模拟执行器已移除，这份记录仅保留历史。';
const turnRef = (session: TaskSessionRecord, turn: TaskTurnRecord): TaskTurnRef => ({ session: { format: 'task-v2', sessionID: session.conversation_id }, turnID: turn.turn_id });
const errorMessages: Record<HarnessErrorCode, string> = {
  'invalid-input': '本次输入无效，请检查工作项与执行范围。',
  conflict: '本地记录或执行状态已变化，请核对原记录。',
  'not-approved': '本次操作尚未取得有效授权，请核对授权记录。',
  unsupported: '这份记录的执行器不支持此操作。',
  persistence: '本地记录尚未保存，请重试本地保存后核对。',
  'execution-unknown': '执行结果尚未确认，请核对原尝试。',
};
const errorText = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  // contextBridge preserves a rejected plain DTO, but drops Error custom fields.
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.message === 'string' && value.message.trim()) return value.message;
    if (typeof value.code === 'string' && Object.prototype.hasOwnProperty.call(errorMessages, value.code)) return errorMessages[value.code as HarnessErrorCode];
  }
  return '操作未能确认，请核对本地记录后再继续。';
};
const validApproval = (request: ApprovalRequest, now: number) => !request.invalidation && Date.parse(request.expires_at) > now;
const mergeApprovals = (previous: ApprovalRequest[], incoming: ApprovalRequest[]) => incoming.map(request => {
  const existing = previous.find(value => value.id === request.id);
  // A read started before a human decision must not reopen the pending card.
  return existing && (existing.state !== 'pending' && request.state === 'pending' || existing.invalidation && !request.invalidation) ? existing : request;
});

export function TaskExecutionState({ state, acceptance }: { state: TaskTurnState; acceptance?: AcceptanceRecord['decision'] }) {
  const Icon = state === 'finished' ? Check : state === 'failed' || state === 'unknown' ? AlertCircle : state === 'cancelled' || state === 'cancelling' ? Square : state === 'awaiting_permission' ? ShieldCheck : Circle;
  return <span className={`state-label execution-state execution-state-${state}`}><Icon size={13} />{state === 'finished' && acceptance ? acceptance === 'accepted' ? '成果已接受' : '成果已拒绝' : labels[state]}</span>;
}

/** Task-v2 execution cards embedded in chat; chat-v1 history stays separate. */
export function TaskExecutionHistory({ api, task, projectName, sessionID, focusMessageID, onSessionChange, onClose }: Props) {
  const [record, setRecord] = useState<TaskSessionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [stopping, setStopping] = useState('');
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest[]>>({});
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [readEpoch, setReadEpoch] = useState(0);
  const identity = `${task.project_id}:${task.task_id}:${sessionID}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const notifyRef = useRef(onSessionChange); notifyRef.current = onSessionChange;
  const recordRef = useRef<TaskSessionRecord | null>(null);
  const mounted = useRef(true);
  const pendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const content = useRef<HTMLElement>(null);
  const selected = record?.conversation_id === sessionID && record.scope.project_id === task.project_id && record.scope.task_id === task.task_id ? record : undefined;
  useEffect(() => {
    if (!focusMessageID || !selected) return;
    const frame = requestAnimationFrame(() => {
      const node = [...(content.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(element => element.dataset.messageId === focusMessageID);
      node?.scrollIntoView({ block: 'center' }); node?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMessageID, selected?.revision]);
  const readonlyHistory = !!selected?.turns.some(legacySimulation);
  const current = (source = identity) => mounted.current && source === identityRef.current;
  const receive = (incoming: TaskSessionRecord, source = identity) => {
    if (!current(source) || incoming.conversation_id !== sessionID || incoming.scope.project_id !== task.project_id || incoming.scope.task_id !== task.task_id) return;
    const previous = recordRef.current;
    if (previous?.conversation_id === incoming.conversation_id && previous.revision > incoming.revision) return;
    recordRef.current = incoming;
    setRecord(incoming); notifyRef.current(incoming);
  };
  const requireSession = () => {
    const latest = recordRef.current;
    if (!current() || latest?.conversation_id !== sessionID || latest.scope.project_id !== task.project_id || latest.scope.task_id !== task.task_id) throw new Error('显示的记录已变化，请重新读取原记录。');
    return latest;
  };
  const requireVisible = (target: TaskTurnRef) => {
    const latest = requireSession();
    if (target.session.sessionID !== sessionID || !latest.turns.some(turn => turn.turn_id === target.turnID)) throw new Error('轮次不属于当前显示的记录。');
  };
  const requireMutable = (target: TaskTurnRef) => {
    requireVisible(target);
    if (requireSession().turns.some(legacySimulation)) throw new Error(legacyHistoryMessage);
  };
  const reload = async (source = identity) => {
    if (!current(source)) return;
    const incoming = await api.loadTaskSession({ format: 'task-v2', sessionID });
    if (!current(source)) return;
    if (!incoming) { recordRef.current = null; setRecord(null); setNotice('这条执行记录不存在。'); return; }
    if (incoming.scope.project_id !== task.project_id || incoming.scope.task_id !== task.task_id) throw new Error('记录不属于当前项目任务。');
    receive(incoming, source); setReadEpoch(value => value + 1);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    recordRef.current = null;
    setRecord(null); setApprovals({}); setReviews({}); setComments({}); setNotice(''); setLoading(true);
    const unsubscribe = api.onTaskSessionEvent(event => {
      if (!active || !current(identity)) return;
      if (event.type === 'task-session-updated') receive(event.session, identity);
      else if (!event.session || event.session.sessionID === sessionID) setNotice(event.message);
    });
    void reload(identity).catch(error => { if (active && current(identity)) setNotice(`记录读取失败：${errorText(error)}`); }).finally(() => { if (active && current(identity)) setLoading(false); });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [api, identity]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    for (const turn of selected.turns) {
      void api.listExecutionApprovals(turnRef(selected, turn)).then(value => { if (active && current(identity)) setApprovals(previous => ({ ...previous, [turn.turn_id]: mergeApprovals(previous[turn.turn_id] ?? [], value) })); }).catch(error => { if (active && current(identity)) setNotice(`授权记录读取失败：${errorText(error)} 可以重新读取记录，决定不会自动投递。`); });
      if (turn.state === 'finished') void api.getWorkItemReview(turnRef(selected, turn)).then(value => { if (active && current(identity)) setReviews(previous => ({ ...previous, [turn.turn_id]: { ...value, acceptance: value.acceptance ?? (previous[turn.turn_id]?.resultDigest === value.resultDigest ? previous[turn.turn_id]?.acceptance : undefined) } })); }).catch(error => { if (active && current(identity)) setNotice(`成果尚不能验收：${errorText(error)}`); });
    }
    return () => { active = false; };
  }, [api, identity, selected?.revision, readEpoch]);
  const action = async (label: string, operation: () => Promise<void>) => {
    if (pendingRef.current || !current()) return;
    const source = identity;
    const focusedCard = document.activeElement?.closest<HTMLElement>('[data-pending-target]');
    const focusTarget = focusedCard?.id;
    const focusOwned = focusedCard?.contains(document.activeElement) ?? false;
    pendingRef.current = true; setPending(label); setNotice('');
    try { await operation(); }
    catch (error) { if (current(source)) setNotice(`${errorText(error)} 原记录已保留；没有自动重发。`); }
    finally {
      pendingRef.current = false;
      if (mounted.current) setPending('');
      if (current(source) && focusOwned && focusTarget) requestAnimationFrame(() => {
        if (!current(source) || document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected && !document.activeElement.matches(':disabled')) return;
        const card = content.current?.querySelector<HTMLElement>(`[id="${focusTarget}"]`);
        const target = card?.querySelector<HTMLElement>('button:not(:disabled)') ?? card ?? content.current?.querySelector<HTMLElement>('.execution-stop:not(:disabled)');
        target?.focus({ preventScroll: true });
      });
    }
  };
  const decide = (request: ApprovalRequest, choice: 'approve' | 'reject') => action(`decide:${request.id}`, async () => {
    requireMutable(request.target.turn);
    const turn = requireSession().turns.find(value => value.turn_id === request.target.turn.turnID)!;
    if (request.target.kind !== 'tool' && (turn.execution.spec.driver.mode !== 'external' || turn.execution.spec.tools.kind !== 'none' || turn.state !== 'prepared')) throw new Error('历史模拟准备记录不能从这里批准或启动。');
    const saved = await api.decideApproval({ requestID: request.id, choice });
    if (!current()) return;
    setApprovals(previous => ({ ...previous, [request.target.turn.turnID]: (previous[request.target.turn.turnID] ?? []).map(value => value.id === saved.id ? saved : value) }));
    await reload();
  });
  const start = (session: TaskSessionRecord, turn: TaskTurnRecord, request: ApprovalRequest) => action(`start:${turn.turn_id}`, async () => {
    const ref = turnRef(session, turn); requireMutable(ref);
    if (turn.execution.spec.driver.mode !== 'external' || turn.execution.spec.tools.kind !== 'none') throw new Error('此入口只启动已批准的无工具外部执行。');
    await api.startExecution({ turn: ref, approvalID: request.id }); await reload();
  });
  const cancel = async (session: TaskSessionRecord, turn: TaskTurnRecord) => {
    if (stoppingRef.current || !current()) return;
    const source = identity;
    stoppingRef.current = true; setStopping(turn.turn_id);
    try { const ref = turnRef(session, turn); requireMutable(ref); await api.cancelExecution(ref); await reload(source); }
    catch (error) { if (current(source)) setNotice(`停止尚未确认：${errorText(error)} 请核对原尝试。`); }
    finally { stoppingRef.current = false; if (mounted.current) setStopping(''); }
  };
  const reply = (session: TaskSessionRecord, turn: TaskTurnRecord, request: ApprovalRequest) => action(`reply:${request.id}`, async () => {
    const ref = turnRef(session, turn); requireMutable(ref);
    await api.replyToolPermission({ turn: ref, approvalID: request.id }); await reload();
  });
  const review = (session: TaskSessionRecord, turn: TaskTurnRecord, value: Review, choice: 'accept' | 'reject') => action(`review:${turn.turn_id}`, async () => {
    const ref = turnRef(session, turn); requireMutable(ref);
    const acceptance = await api.reviewWorkItem({ turn: ref, resultDigest: value.resultDigest, choice, ...(comments[turn.turn_id]?.trim() ? { comment: comments[turn.turn_id].trim() } : {}) });
    if (current()) setReviews(previous => ({ ...previous, [turn.turn_id]: { ...value, acceptance } }));
  });
  const activeTurn = selected?.turns.findLast(unresolved);
  const pendingItems: Array<{ target: string; stage: string }> = [];
  let pendingComplete = true;
  for (const turn of selected?.turns ?? []) {
    if (readonlyHistory) continue;
    const permissions = turn.execution.permissions;
    const needsInspection = ['unknown', 'cancelling'].includes(turn.state) || ['finished', 'failed', 'cancelled'].includes(turn.state) && unresolvedPermission(turn);
    if (needsInspection) {
      const index = permissions.findIndex(permission => permission.delivery === 'sending' || permission.delivery === 'unknown' || !permission.delivery && turn.state === 'finished');
      pendingItems.push({ target: index >= 0 ? `permission-${turn.turn_id}-${index}` : turn.state === 'unknown' ? `unknown-${turn.turn_id}` : `control-${turn.turn_id}`, stage: '待核对' });
      continue;
    }
    if (turn.state === 'prepared') {
      const request = approvals[turn.turn_id]?.find(value => value.target.kind === 'execution');
      pendingItems.push({ target: `approval-${turn.turn_id}`, stage: turn.execution.spec.driver.mode === 'external' && request && validApproval(request, now) ? request.state === 'pending' ? '待执行授权' : request.state === 'approved' ? '待开始' : '待取消准备' : '待取消准备' });
    } else if (turn.state === 'awaiting_permission') {
      const index = permissions.findIndex(permission => !permission.delivery);
      if (index >= 0) {
        const permission = permissions[index];
        const request = approvals[turn.turn_id]?.find(value => value.target.kind === 'tool' && value.target.externalRequestID === permission.externalRequestID);
        if (!request) { pendingComplete = false; continue; }
        pendingItems.push({ target: `permission-${turn.turn_id}-${index}`, stage: !validApproval(request, now) ? '待结束并核对' : request.state === 'pending' ? '待工具决定' : '待工具投递' });
      }
    } else if (turn.state === 'finished') {
      const review = reviews[turn.turn_id];
      if (!review) { pendingComplete = false; continue; }
      if (!review.acceptance) pendingItems.push({ target: `review-${turn.turn_id}`, stage: '待人工验收' });
    }
  }
  const locatePending = () => {
    const target = pendingItems[0] && content.current?.querySelector<HTMLElement>(`[id="${pendingItems[0].target}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.focus({ preventScroll: true });
  };

  const displayToolApproval = (request: ApprovalRequest | undefined, turn: TaskTurnRecord) => {
    if (readonlyHistory) return <p className="execution-feedback" role="status">原许可决定与投递状态仅供查看，不再决定或投递。</p>;
    if (!request) return <p className="execution-feedback" role="status">正在读取许可记录。可重新读取，不会自动投递。</p>;
    const valid = validApproval(request, now);
    return <>
      <p className="execution-feedback" role="status">{request.invalidation ? `许可已失效：${request.invalidation.reason}` : !valid ? '本次许可已过期，不能投递。请停止并核对原尝试；不会复用该工具请求。' : request.state === 'pending' ? '等待你的决定。允许后仍需单独投递本次许可。' : request.state === 'approved' ? '你已允许这一次，尚未向执行端投递许可。' : '你已拒绝，尚未向执行端投递拒绝回应。'}<span className="execution-expiry">有效至 {formatDate(request.expires_at)}</span></p>
      {request.state === 'pending' && valid && turn.state === 'awaiting_permission' && <div className="execution-actions"><button className="button primary execution-action" disabled={!!pending} aria-busy={pending === `decide:${request.id}`} onClick={() => void decide(request, 'approve')}>{pending === `decide:${request.id}` ? '保存决定…' : '允许这一次'}</button><button className="button execution-action" disabled={!!pending} onClick={() => void decide(request, 'reject')}>拒绝</button></div>}
    </>;
  };

  const external = selected?.turns.some(turn => turn.execution.spec.driver.mode === 'external');
  return <section className="task-execution-history" ref={content} aria-label={external ? '执行记录' : '试运行历史记录'}>
    <header className="task-history-heading"><div><FileText size={15} /><strong>{external ? '执行记录' : '试运行记录'}</strong><span className="task-history-title">{task.title}</span></div><div>{selected && !readonlyHistory && activeTurn && !['cancelling', 'finished', 'failed', 'cancelled'].includes(activeTurn.state) && <button className="button small execution-action execution-stop" disabled={!!stopping} aria-busy={!!stopping} onClick={() => void cancel(selected, activeTurn)}><Square size={12} />{stopping ? '确认停止…' : activeTurn.state === 'prepared' ? '取消本次准备' : external ? '停止这次执行' : '停止这次试运行'}</button>}{onClose && <button className="icon-button" aria-label="关闭试运行记录" onClick={onClose}><X size={15} /></button>}</div></header>
    <p className="task-history-source">{readonlyHistory ? legacyHistoryMessage : external ? '仅发送本次输入；未附加项目材料，未启用工具。' : '独立保存的历史记录，不属于当前模型聊天。'}</p>
    {selected && !readonlyHistory && <div className="execution-pending-summary task-history-pending" data-pending-count={pendingComplete ? pendingItems.length : 'unknown'} aria-live="polite"><span>{pendingComplete ? `这份记录待你处理 ${pendingItems.length}` : '读取审核记录…'}</span>{pendingItems.length > 0 && <span className="execution-pending-stages">{[...new Set(pendingItems.map(item => item.stage))].join(' · ')}</span>}<button className="button small execution-action execution-locate" disabled={!pendingItems.length || !!pending} onClick={locatePending}>定位待处理</button></div>}
    {notice && <div className="execution-error"><Notice onDismiss={() => setNotice('')}>{notice}</Notice></div>}
    <div className="execution-actions task-history-recovery"><button className="button small ghost execution-action" disabled={!!pending || loading} onClick={() => void action('reload', async () => { await reload(); })}><RefreshCw size={12} />{pending === 'reload' ? '读取中…' : '重新读取记录'}</button>{selected && !readonlyHistory && <button className="button small ghost execution-action" disabled={!!pending} onClick={() => void action('save', async () => { if (requireSession().turns.some(legacySimulation)) throw new Error(legacyHistoryMessage); await api.retryTaskPendingWrites({ format: 'task-v2', sessionID: selected.conversation_id }); await reload(); if (current()) setNotice('本地事实已保存；请求没有重发。'); })}>{pending === 'save' ? '保存中…' : '重试本地保存'}</button>}</div>
    {loading ? <div className="loading-lines" aria-label="正在读取试运行记录"><div /><div /><div /></div> : selected ? <>
          {selected.turns.map(turn => {
            const ref = turnRef(selected, turn);
            const spec = turn.execution.spec;
            const simulation = spec.driver.mode === 'simulation';
            const requests = approvals[turn.turn_id] ?? [];
            const authorization = requests.find(request => request.target.kind === 'execution');
            const value = reviews[turn.turn_id];
            const user = selected.messages.find(message => message.turn_id === turn.turn_id && message.role === 'user');
            const output = selected.messages.filter(message => message.turn_id === turn.turn_id && message.role === 'assistant').map(message => message.text).join('\n');
            const elapsed = Math.max(0, Math.floor(((!readonlyHistory && unresolved(turn) ? now : Date.parse(turn.updated_at)) - Date.parse(turn.created_at)) / 1000));
            return <article className="execution-attempt" key={turn.turn_id} data-state={turn.state} aria-label={`历史工作项：${spec.title}`}>
              {user && <div className="message user task-history-input" data-message-id={user.message_id} tabIndex={-1}><div className="message-header"><strong>{simulation ? '试运行输入（历史记录）' : '执行输入（历史记录）'}</strong><time>{formatDate(user.created_at)}</time></div><div className="message-body">{user.text}</div></div>}
              <div className="execution-step-header" id={`control-${turn.turn_id}`} data-pending-target="" tabIndex={-1}><FileText size={16} /><strong>{spec.title}</strong>{simulation && <span className="simulation-badge">模拟</span>}<TaskExecutionState state={turn.state} acceptance={value?.acceptance?.decision} /></div>
              <div className="execution-receipt"><span>{simulation ? '模拟试运行' : '外部执行记录'} · 计划 v{spec.work.planVersion}</span><span>请求 {turn.requested_model.provider_id}/{turn.requested_model.model_id}{turn.requested_model.variant ? ` · ${turn.requested_model.variant}` : ''}{turn.observed_model ? ` · 响应 ${turn.observed_model.provider_id}/${turn.observed_model.model_id}` : ''}</span><span><Clock3 size={11} />{elapsed} 秒</span><time>{formatDate(turn.created_at)}</time></div>
              <details className="execution-scope"><summary>查看本次冻结范围</summary><dl><dt>工作区</dt><dd>{projectName ?? '原绑定项目'} · 计划 v{spec.work.planVersion}</dd><dt>预期结果</dt><dd>{spec.expectedResult}</dd><dt>材料</dt><dd>{spec.materials.length ? `${spec.materials.length} 项明确材料` : '只使用上述输入，没有附加项目材料'}</dd><dt>执行器</dt><dd>{spec.driver.driverID}{simulation && ' · 模拟，不调用模型'}</dd><dt>工具范围</dt><dd>{spec.tools.kind === 'none' ? '无工具' : `${simulation ? '仅模拟 · ' : ''}读取 ${spec.tools.readRoots.join(', ')}；写入 ${spec.tools.writeRoots.join(', ')}；命令 ${spec.tools.commands.length} 项`}</dd></dl></details>
              {turn.state === 'prepared' && <section className="execution-card execution-approval" id={`approval-${turn.turn_id}`} data-pending-target="" tabIndex={-1} aria-label={simulation ? '尚未启动的试运行' : '执行授权'}><div className="execution-card-title"><ShieldCheck size={16} /><h3>{simulation ? '尚未启动的试运行' : '执行授权'}</h3>{simulation && <span className="simulation-badge">模拟</span>}</div><p>{readonlyHistory ? '这份准备记录仅供查看已保存的输入与冻结范围。' : '仅发送以上输入；不读取项目文件，不调用工具。批准后仍需单独开始。'}</p>{!simulation && authorization && <p className="execution-feedback" role="status">{authorization.invalidation ? `授权已失效：${authorization.invalidation.reason}` : !validApproval(authorization, now) ? '授权已过期，请取消准备后重新申请。' : authorization.state === 'approved' ? '批准已保存，尚未发送。' : authorization.state === 'rejected' ? '你已拒绝这次执行。' : '等待你的决定。'}<span className="execution-expiry">有效至 {formatDate(authorization.expires_at)}</span></p>}{!readonlyHistory && !simulation && authorization && validApproval(authorization, now) && spec.tools.kind === 'none' && <div className="execution-actions">{authorization.state === 'pending' ? <><button className="button primary execution-action" disabled={!!pending} onClick={() => void decide(authorization, 'approve')}>批准这次执行</button><button className="button execution-action" disabled={!!pending} onClick={() => void decide(authorization, 'reject')}>拒绝</button></> : authorization.state === 'approved' ? <button className="button primary execution-action" disabled={!!pending} onClick={() => void start(selected, turn, authorization)}>{pending === `start:${turn.turn_id}` ? '正在提交…' : '开始这次执行'}</button> : null}</div>}{authorization && <p className="execution-authorization-receipt">原范围决定：{authorization.state === 'approved' ? '已批准' : authorization.state === 'rejected' ? '已拒绝' : '未决定'}{authorization.state !== 'pending' && ` · ${formatDate(authorization.decided_at)}`}{authorization.invalidation && ` · 已失效：${authorization.invalidation.reason}`}</p>}{!readonlyHistory && <div className="execution-actions"><button className="button small execution-action" disabled={!!stopping} aria-busy={stopping === turn.turn_id} onClick={() => void cancel(selected, turn)}>{stopping === turn.turn_id ? '确认取消…' : '取消准备'}</button></div>}</section>}
              {turn.state !== 'prepared' && authorization && authorization.state !== 'pending' && <p className="execution-authorization-receipt"><ShieldCheck size={13} /><span>{authorization.state === 'approved' ? '你已批准本次范围' : '你已拒绝本次范围'} · {formatDate(authorization.decided_at)}{authorization.invalidation && ` · ${authorization.invalidation.reason}`}</span></p>}
              {output && <section className="execution-output" data-message-id={selected.messages.find(message => message.turn_id === turn.turn_id && message.role === 'assistant')?.message_id} tabIndex={-1} aria-label={simulation ? '试运行输出' : '执行输出'}><div className="message-header"><strong>{simulation ? '试运行输出' : '执行输出'}</strong>{simulation && <span className="simulation-badge">模拟</span>}</div><Markdown text={output} /></section>}
              {turn.execution.permissions.map((permission, permissionIndex) => {
                const request = requests.find(candidate => candidate.target.kind === 'tool' && candidate.target.externalRequestID === permission.externalRequestID);
                const canReply = !readonlyHistory && !!request && request.state !== 'pending' && validApproval(request, now) && !permission.delivery && turn.state === 'awaiting_permission';
                const closedBeforeDelivery = !permission.delivery && ['failed', 'cancelled'].includes(turn.state);
                const terminalUnresolved = turn.state === 'finished' && !permission.delivery;
                const contentPreview = permission.action.kind === 'file-write' ? [...permission.action.content].slice(0, 80).join('') : undefined;
                return <section className="execution-card execution-permission" id={`permission-${turn.turn_id}-${permissionIndex}`} data-pending-target="" tabIndex={-1} aria-label="具体工具许可" key={permission.externalRequestID}><div className="execution-card-title"><ShieldCheck size={16} /><h3>{closedBeforeDelivery ? '本次工具许可已关闭' : permission.delivery ? '本次工具许可回应记录' : terminalUnresolved ? '本次工具许可尚未核对' : permission.action.kind === 'file-write' ? '写入文件' : permission.action.kind === 'file-read' ? '读取文件' : '运行命令'}</h3>{simulation && <span className="simulation-badge">模拟</span>}</div><p>{readonlyHistory ? '这是已保存的工具许可记录，不再决定或投递。' : closedBeforeDelivery ? '本次许可未投递，执行已终止。不会补发允许或拒绝回应。' : terminalUnresolved ? '执行已结束，但这次许可尚无确认记录。先核对原尝试，暂不能验收或提交新的尝试。' : permission.delivery ? '这份记录只针对下面的完整参数，不能再次投递。' : ['unknown', 'cancelling'].includes(turn.state) ? '这次许可尚无投递记录；执行状态待核对。' : '执行器已暂停。这次许可只对下面的完整参数有效。'}</p><code className="execution-tool-path">{permission.action.kind === 'command' ? permission.action.cwd : permission.action.path}</code>{contentPreview !== undefined && <p className="execution-tool-summary">内容摘要：{contentPreview}{permission.action.kind === 'file-write' && [...permission.action.content].length > 80 ? '…（展开查看全文）' : ''}</p>}<p className="execution-tool-stage">{closedBeforeDelivery ? '许可已关闭' : terminalUnresolved || ['unknown', 'cancelling'].includes(turn.state) && !permission.delivery ? '待核对' : permission.delivery ? permission.delivery === 'accepted' ? '回应已被接受' : '回应待核对' : request && !validApproval(request, now) ? '许可已过期或失效 · 待核对' : request?.state === 'approved' ? '已允许这一次 · 待工具投递' : request?.state === 'rejected' ? '已拒绝 · 待工具投递' : '待工具决定'}</p>{request && request.state !== 'pending' && <p className="execution-decision-receipt">人工决定：{request.state === 'approved' ? '允许这一次' : '拒绝'} · {formatDate(request.decided_at)}</p>}<details><summary>查看动作与准确内容</summary><pre>{JSON.stringify(permission.action, null, 2)}</pre></details>{permission.delivery ? <p className="execution-feedback" role="status">{permission.delivery === 'accepted' ? '执行端已接受本次许可回应；这不代表工具已执行或成功。' : permission.delivery === 'sending' || permission.delivery === 'unknown' ? '许可回应结果未知。请核对原请求，不重复发送允许。' : '执行端拒收了回应。请核对原请求。'}</p> : !closedBeforeDelivery && !terminalUnresolved && <>{displayToolApproval(request, turn)}{canReply && <div className="execution-actions"><button className="button primary execution-action" disabled={!!pending} aria-busy={pending === `reply:${request!.id}`} onClick={() => void reply(selected, turn, request!)}>{pending === `reply:${request!.id}` ? '投递中…' : request!.state === 'approved' ? '发送本次许可' : '发送拒绝回应'}</button></div>}</>}</section>;
              })}
              {turn.failure && <div className="execution-error"><Notice>{turn.failure}</Notice></div>}
              {turn.state === 'unknown' && <section className="execution-card execution-unknown" id={`unknown-${turn.turn_id}`} data-pending-target="" tabIndex={-1}><div className="execution-card-title"><AlertCircle size={16} /><h3>原尝试的结果尚未确认</h3></div><p>{readonlyHistory ? '未知状态保持原样，不会重跑或自动解释为完成、失败或取消。' : '未知结果不能当作失败重跑，也不能验收。核对只查询原目标。'}</p></section>}
              {!readonlyHistory && (['unknown', 'cancelling'].includes(turn.state) || ['finished', 'failed', 'cancelled'].includes(turn.state) && unresolvedPermission(turn)) && <div className="execution-actions"><button className="button execution-action" disabled={!!pending} aria-busy={pending === `inspect:${turn.turn_id}`} onClick={() => void action(`inspect:${turn.turn_id}`, async () => { requireMutable(ref); await api.reconcileExecution(ref); await reload(); })}><RefreshCw size={13} />{pending === `inspect:${turn.turn_id}` ? '核对中…' : '核对原尝试'}</button></div>}
              {turn.state === 'finished' && <section className="execution-card execution-review" id={`review-${turn.turn_id}`} data-pending-target="" tabIndex={-1} data-decision={value?.acceptance?.decision ?? 'pending'} aria-label="成果验收"><div className="execution-card-title"><Check size={16} /><h3>{value?.acceptance ? value.acceptance.decision === 'accepted' ? simulation ? '你已接受这份模拟成果' : '你已接受这份文本成果' : simulation ? '你已拒绝这份模拟成果' : '你已拒绝这份文本成果' : readonlyHistory ? '成果记录（只读历史）' : '执行结束，等待成果验收'}</h3></div><p>{value?.result.summary ?? turn.execution.result?.summary ?? '正在核验成果清单。'}</p>{value && <><details className="execution-evidence"><summary>查看成果与证据引用</summary><pre>{JSON.stringify({ artifacts: value.result.artifacts, evidence: value.result.evidence }, null, 2)}</pre></details>{value.acceptance ? <p className="execution-feedback" role="status">{formatDate(value.acceptance.decided_at)} · 仅针对本次成果版本，原任务记录没有改写。{value.acceptance.comment && <span>{value.acceptance.comment}</span>}</p> : !readonlyHistory && <><div className="field"><label htmlFor={`review-comment-${turn.turn_id}`}>验收意见（可选）</label><textarea id={`review-comment-${turn.turn_id}`} value={comments[turn.turn_id] ?? ''} onChange={event => setComments(previous => ({ ...previous, [turn.turn_id]: event.target.value }))} rows={2} maxLength={4096} /></div><div className="execution-actions"><button className="button primary execution-action" disabled={!!pending || unresolvedPermission(turn)} aria-busy={pending === `review:${turn.turn_id}`} onClick={() => void review(selected, turn, value, 'accept')}>接受本次成果</button><button className="button execution-action" disabled={!!pending || unresolvedPermission(turn)} onClick={() => void review(selected, turn, value, 'reject')}>拒绝本次成果</button></div></>}</>}<p className="field-help">{readonlyHistory ? '仅展示原成果与既有验收记录，不再新增验收。未决状态保持原样。' : unresolvedPermission(turn) ? '许可仍未核对，暂不能验收本次成果。' : '仅接受本次文本成果，不代表工具或编码完成，原任务未改。'}</p></section>}
              {['failed', 'cancelled'].includes(turn.state) && <p className="execution-feedback">{unresolvedPermission(turn) ? '执行已终止，但许可回应仍待核对。新的尝试仍被阻止；不会重发回应。' : '本次已收口；不会复用本次决定。'}</p>}
            </article>;
          })}
      {!selected.turns.length && <Empty title="这份记录没有试运行轮次">没有开始新的尝试。</Empty>}
    </> : <Empty title="没有可显示的试运行记录">请在右侧选择明确的历史记录；这里不会新建或开始执行。</Empty>}
  </section>;
}
