import React, { useEffect, useRef, useState } from 'react';
import type { PreviewPlan } from '../../shared/types';
import type { TaskPlanningAPI } from '../../shared/task-planning';
import type { GeneratedPlanDraft, PlanningCandidate, PlanningRequest } from '../../core/tasks/task-planning-contract';
import type { TaskSequentialView } from '../../core/tasks/task-sequential-queue';
import './task-planning.css';
const pendingRequestIDs = new Map<string, string>();
const keepRequest = (taskID: string, id: string) => { if (pendingRequestIDs.size >= 100 && !pendingRequestIDs.has(taskID)) pendingRequestIDs.delete(pendingRequestIDs.keys().next().value!); pendingRequestIDs.set(taskID, id); };
const queueLabels: Record<TaskSequentialView['phase'], string> = {
  'needs-preparation': '下一项可准备', 'needs-start': '等待该项开始批准', running: '当前项执行中', 'needs-tool-approval': '等待原生工具审批', 'needs-acceptance': '等待人工验收', 'waiting-human': '等待人工处理', complete: '本队列各项已验收', stopped: '队列已停止', 'paused-stale': '任务版本变化，队列暂停', 'paused-failed': '当前项失败，队列暂停', 'paused-cancelled': '当前项取消，队列暂停', 'paused-unknown': '原尝试未知，队列暂停', 'paused-rejected': '成果被退回，队列暂停', 'paused-evidence': '证据需要重新核对，队列暂停',
};
function candidateLabel(candidate: PlanningCandidate) { return candidate.kind === 'human' ? '人工处理' : `${candidate.source!.name} · ${candidate.source!.model.model_id}`; }
function recordFeedback(r: PlanningRequest) {
  if (r.status === 'unknown') return '本次请求结果未知，可能已产生调用费用。可查询原请求的本地记录；不会自动重发。';
  if (r.status === 'generating') return '本次请求已登记，正在生成草稿。确认完成前请保留此请求。';
  if (r.status === 'failed' && r.failure === 'not-submitted') return '规划未发送。请在“设置 → 模型服务”检查当前模型与密钥，再明确发起新请求。';
  if (r.status === 'failed') return '模型返回的计划未通过校验，任务保持原样。可明确发起一次新请求。';
  return '';
}
/** Component scope: inherits ScreenDeck's task workflow, no page shell, hero engine or motion. */
export function TaskPlanningPanel({ api, plan, disabled, onSaved, onConfigureModel, onOpenNative, onBusyChange, showGoal=true }: {
  api: TaskPlanningAPI; plan: PreviewPlan; disabled: boolean; onSaved?(plan: PreviewPlan): void;
  onBusyChange?(busy:boolean):void; showGoal?:boolean; onConfigureModel?(): void; onOpenNative?(workItemID?: string): void;
}) {
  const [catalog, setCatalog] = useState<PlanningCandidate[]>([]), [settings, setSettings] = useState<{ configured: boolean; modelID: string }>();
  const [records, setRecords] = useState<PlanningRequest[]>([]), [record, setRecord] = useState<PlanningRequest>(), [draft, setDraft] = useState<GeneratedPlanDraft>();
  const [choices, setChoices] = useState<Record<string, string>>({}), [materials, setMaterials] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0);
  const [requestID, setRequestID] = useState(''), [allowNew, setAllowNew] = useState(false), [queue, setQueue] = useState<TaskSequentialView>();
  useEffect(() => { onBusyChange?.(busy || loading); return () => onBusyChange?.(false); }, [busy, loading, onBusyChange]);
  const epoch = useRef(0), taskID = useRef(plan.id), working = useRef(false), queueRequest = useRef(''); taskID.current = plan.id;
  const install = (r: PlanningRequest | undefined) => {
    setRecord(r); setRequestID(r?.id ?? ''); setDraft(r?.confirmation?.draft ? structuredClone(r.confirmation.draft) : r?.draft ? structuredClone(r.draft) : undefined);
    setChoices(Object.fromEntries(r?.confirmation?.assignments ? r.confirmation.assignments.map(a => [a.stepKey, a.candidateID]) : (r?.draft?.steps ?? []).map(s => [s.key, s.preferredCandidateID]))); setConfirmed(false); setAllowNew(false);
    if (r) { keepRequest(plan.id, r.id); setRecords(previous => [r, ...previous.filter(v => v.id !== r.id)]); }
  };
  useEffect(() => {
    const generation = ++epoch.current; working.current = false; setLoading(true); setBusy(false); setError(''); setNotice(''); setSettings(undefined); setRecord(undefined); setDraft(undefined); setRequestID(''); setRecords([]); setCatalog([]); setChoices({}); setMaterials([]); setConfirmed(false); setAllowNew(false); setQueue(undefined); queueRequest.current = '';
    void Promise.all([api.getTaskPlanningStatus(), api.getTaskPlanningCandidates(), api.listTaskPlanDrafts({ taskID: plan.id })]).then(([status, candidates, history]) => {
      if (epoch.current !== generation) return; setSettings(status); setCatalog(candidates); setRecords(history); install(history[0]); if (!history.length) setRequestID(pendingRequestIDs.get(plan.id) ?? '');
    }).catch(() => { if (epoch.current === generation) setError('无法读取规划服务与原请求记录。请重新读取后再操作。'); }).finally(() => { if (epoch.current === generation) setLoading(false); });
    return () => { epoch.current++; };
  }, [api, plan.id, retry]);
  const run = async (operation: () => Promise<void>, message: string) => {
    if (working.current) return; const generation = epoch.current; working.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch { if (epoch.current === generation) setError(message); }
    finally { if (epoch.current === generation) { working.current = false; setBusy(false); } }
  };
  const stale = !!record && record.baseVersion !== plan.version && record.confirmation?.state !== 'saved';
  const blockedRequest = !!requestID && (!record || ['generating', 'unknown'].includes(record.status));
  const validDraft = !!draft?.steps.length && draft.steps.every(s => s.title.trim() && s.completion_conditions.length > 0 && s.completion_conditions.length <= 8 && s.completion_conditions.every(c => c.trim()) && s.candidateIDs.includes(choices[s.key]));
  const generationDisabled = loading || busy || disabled || !settings?.configured || (!allowNew && blockedRequest);
  const generate = () => void run(async () => {
    const id = crypto.randomUUID(), currentTask = plan.id, generation = epoch.current; keepRequest(currentTask, id); setRequestID(id); setRecord(undefined); setDraft(undefined); setChoices({}); setConfirmed(false); setAllowNew(false);
    const result = await api.generateTaskPlan({ taskID: currentTask, expectedVersion: plan.version, clientRequestID: id, selectedMaterialIDs: materials });
    if (taskID.current === currentTask && epoch.current === generation) install(result);
  }, '尚未取得本次规划结果。请查询原请求，核对本地记录后再决定是否另发新请求。');
  const query = () => void run(async () => {
    const id = requestID, currentTask = plan.id, generation = epoch.current;
    const result = await api.getTaskPlanDraft({ taskID: currentTask, requestID: id });
    if (taskID.current !== currentTask || epoch.current !== generation) return;
    if (result) { install(result); setNotice(result.status === 'unknown' ? '原请求的本地记录仍为未知，未重发。' : '已读取原请求记录。'); }
    else setError('没有找到原请求记录，结果尚未确认。请保留请求编号再核对。');
  }, '原请求读取失败，请稍后继续查询同一请求。');
  const save = () => void run(async () => {
    if (!record || !draft) return; const currentTask = plan.id, generation = epoch.current;
    const saved = await api.confirmTaskPlanDraft({ taskID: currentTask, requestID: record.id, expectedVersion: record.baseVersion, draftDigest: record.draftDigest!, assignments: draft.steps.map(s => ({ stepKey: s.key, candidateID: choices[s.key] })), editedDraft: draft });
    if (taskID.current !== currentTask || epoch.current !== generation) return;
    const read = await api.getTaskPlanDraft({ taskID: currentTask, requestID: record.id }); if (taskID.current !== currentTask || epoch.current !== generation) return; if (read) install(read); setNotice(`执行计划已保存为版本 ${saved.version}。`); onSaved?.(saved);
  }, '计划未确认保存或回执丢失。请查询原请求；任务或候选变化时须重新核对草稿。');
  const queueAction = (operation: () => Promise<TaskSequentialView>) => void run(async () => { const currentTask = plan.id, generation = epoch.current, result = await operation(); if (taskID.current === currentTask && epoch.current === generation) setQueue(result); }, '队列记录读取失败，请查询原队列后重试。');
  return <details className="task-content-section task-planning" open><summary>执行计划</summary><div className="task-planning-body" aria-busy={busy || loading}>
    {showGoal&&<p className="task-planning-goal"><strong>主目标</strong><span>{plan.task?.goal || plan.title}</span></p>}
    <p className="quiet-text">生成式模型负责拆解步骤。确认分工后保存；各项仍需开始批准和验收。</p>
    {disabled && <p role="status">请先保存当前任务内容。</p>}
    {loading ? <p role="status">正在读取规划服务与原请求记录…</p> : <>
      <p className="task-planning-model">规划模型：{settings?.configured ? settings.modelID : '尚未配置'}{catalog.filter(c => c.kind === 'agent').length > 0 && <span> · {catalog.filter(c => c.kind === 'agent').length} 个实际 Agent 连接</span>}</p>
      {settings && !settings.configured && <p className="task-planning-help">在“设置 → 模型服务”保存模型与密钥后，重新读取。{onConfigureModel && <button className="text-button" onClick={onConfigureModel}>打开模型服务设置</button>}</p>}
      <fieldset className="plain-fieldset task-planning-materials" disabled={busy || disabled || blockedRequest && !allowNew}><legend>本次发送的材料</legend>{(plan.task?.materials.length ?? 0) === 0 ? <p className="quiet-text">仅发送主目标与完成条件。</p> : plan.task!.materials.map(m => <label key={m.id}><input type="checkbox" checked={materials.includes(m.id)} onChange={e => setMaterials(e.target.checked ? [...materials, m.id] : materials.filter(id => id !== m.id))} />{m.title}<span>{m.source.label}</span></label>)}</fieldset>
      <div className="task-planning-actions"><button className="button small" disabled={generationDisabled} onClick={generate}>{busy && !draft ? '正在处理…' : allowNew || record ? '发起一次新规划' : '生成步骤草稿'}</button><button className="text-button" disabled={busy} onClick={() => setRetry(v => v + 1)}>重新读取</button></div>
    </>}
    {(requestID || record) && <div className="task-planning-request">
      {records.length > 1 && <label className="task-planning-field">规划记录<select aria-label="规划记录" disabled={busy} value={requestID} onChange={e => install(records.find(r => r.id === e.target.value))}>{!records.some(r => r.id === requestID) && <option value={requestID}>当前待核对请求</option>}{records.map(r => <option key={r.id} value={r.id}>v{r.baseVersion} · {r.status === 'draft' ? r.confirmation?.state === 'saved' ? '已保存' : '草稿' : r.status === 'unknown' ? '未知' : r.status === 'generating' ? '生成中' : '失败'} · {r.createdAt}</option>)}</select></label>}
      <p role="status">{record ? recordFeedback(record) : '尚未取得原请求结果，请保留编号并查询。'}</p>
      {record?.source && <p className="quiet-text">草稿来源：{record.observedModel?.model_id ?? record.source.requestedModel.model_id}</p>}
      <details><summary>原请求编号</summary><code>{requestID}</code></details>
      <button className="text-button" disabled={busy || !requestID} onClick={query}>查询原请求</button>{busy && requestID && !draft && <button className="text-button" onClick={() => { const id = requestID, generation = epoch.current; void api.cancelTaskPlanGeneration({ taskID: plan.id, requestID: id }).catch(() => { if (epoch.current === generation) setError('停止接收未确认，请继续核对原请求。'); }); }}>停止接收规划</button>}
      {blockedRequest && <label className="task-planning-new"><input type="checkbox" disabled={busy} checked={allowNew} onChange={e => setAllowNew(e.target.checked)} />我已核对原请求，另发一次新调用</label>}
    </div>}
    {draft && record && <section className="task-planning-draft" aria-label="步骤草稿"><header><strong>{draft.steps.length} 个步骤</strong><span>{record.confirmation?.state === 'saved' ? `已保存 · v${record.confirmation.savedVersion}` : `草稿 · 基于 v${record.baseVersion}`}</span></header>
      <ol>{draft.steps.map((step, index) => <li key={step.key}><div className="task-planning-step"><label className="task-planning-field">步骤 {index + 1}<input aria-label={`步骤 ${index + 1} 标题`} value={step.title} maxLength={600} disabled={busy || stale || record.confirmation?.state === 'saved'} onChange={e => { setDraft({ steps: draft.steps.map(s => s.key === step.key ? { ...s, title: e.target.value } : s) }); setConfirmed(false); }} /></label>
        <p className="task-planning-dependencies">{step.dependencies.length ? `依赖：${step.dependencies.map(id => draft.steps.find(s => s.key === id)?.title ?? id).join('、')}` : '依赖：无'}</p>
        <label className="task-planning-field">完成条件<textarea aria-label={`步骤 ${index + 1} 完成条件`} rows={Math.min(4, Math.max(2, step.completion_conditions.length))} value={step.completion_conditions.join('\n')} disabled={busy || stale || record.confirmation?.state === 'saved'} onChange={e => { setDraft({ steps: draft.steps.map(s => s.key === step.key ? { ...s, completion_conditions: e.target.value.split('\n') } : s) }); setConfirmed(false); }} /></label>
        <label className="task-planning-field">执行分工<select aria-label={`步骤 ${index + 1} 分工`} value={choices[step.key] ?? ''} disabled={busy || stale || record.confirmation?.state === 'saved'} onChange={e => { setChoices({ ...choices, [step.key]: e.target.value }); setConfirmed(false); }}>{step.candidateIDs.map(id => { const c = record.candidates.find(c => c.id === id); return c ? <option value={id} key={id}>{candidateLabel(c)}</option> : null; })}</select></label>
      </div></li>)}</ol>
      {stale && <p className="task-save-error" role="alert">任务已更新。此草稿保留供核对，不能覆盖当前版本。</p>}
      {record.confirmation?.state !== 'saved' && <><label className="task-planning-confirm"><input type="checkbox" disabled={busy || disabled || stale || !validDraft} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对步骤、依赖、完成条件和分工</label><button className="button small" disabled={busy || disabled || stale || !confirmed || !validDraft} onClick={save}>确认并保存执行计划</button></>}
    </section>}
    {record?.confirmation?.state === 'saved' && <section className="task-planning-queue" aria-label="逐项队列"><strong>按依赖逐项处理</strong><p>每项单独准备和授权，完成后查看证据并验收，再处理下一项。</p>{!queue ? <button className="button small ghost" disabled={busy || disabled || plan.version < record.confirmation.savedVersion!} onClick={() => { queueRequest.current ||= crypto.randomUUID(); queueAction(() => api.createTaskQueue({ taskID: plan.id, expectedVersion: plan.version, clientRequestID: queueRequest.current })); }}>建立逐项队列</button> : <>
      <p role="status">{queueLabels[queue.phase]} · {queue.completed}/{queue.total} 项已核对接受</p>
      {queue.workItemID && <p>当前项：{plan.work_items.find(i => i.id === queue.workItemID)?.title ?? '原版本工作项'}</p>}
      {queue.phase === 'stopped' && queue.unresolvedAttemptIDs.length > 0 && <p>队列已停止推进，原尝试仍需核对。</p>}
      <div className="task-planning-actions"><button className="text-button" disabled={busy} onClick={() => queueAction(() => api.inspectTaskQueue({ taskID: plan.id, queueID: queue.queue.id }))}>查询队列</button>{!['complete', 'stopped'].includes(queue.phase) && <button className="text-button" disabled={busy} onClick={() => queueAction(() => api.stopTaskQueue({ taskID: plan.id, queueID: queue.queue.id }))}>停止队列</button>}{onOpenNative && <button className="text-button" disabled={busy} onClick={() => onOpenNative(queue.workItemID)}>打开执行与验收</button>}</div>
    </>}</section>}
    {notice && <p className="task-planning-notice" role="status">{notice}</p>}
    <div className="task-planning-feedback" aria-live="polite">{error && <p className="task-save-error" role="alert">{error}</p>}</div>
  </div></details>;
}
