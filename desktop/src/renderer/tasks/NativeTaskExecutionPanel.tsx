import React, { useEffect, useRef, useState } from 'react';
import type { PreviewPlan } from '../../shared/types';
import type { DesktopAPI } from '../../shared/desktop-api';
import type { AgentChatReadySource, AgentChatSourceInfo } from '../../shared/agent-chat';
import type { AgentExecutionContext, AgentExecutionRecord } from '../../shared/agent-execution';
import { permissionLabel } from '../../shared/agent-permissions';
import { AgentTurnTools, AgentWorkspaceControls } from '../AgentExecution';
import './native-task-execution.css';

/** UI adapter contracts only. Main must validate and persist through C's existing runtime. */
export type NativePanelTask = { kind: 'local'; planID: string } | { kind: 'project'; planID: string; projectID: string; taskID: string };
export interface NativePanelInput {
  task: NativePanelTask; planVersion: number; workItemID: string; clientRequestID: string;
  agentID: string; context: AgentExecutionContext;
  materials: Array<{ reference: string; digest: string; summary: string }>; text: string;
}
export interface NativePanelSelection {
  artifacts: string[];
  checks: Array<{ name: string; path: string } & ({ kind: 'utf8-contains' | 'sha256'; expected: string } | { kind: 'json-equals'; pointer: string[]; expected: unknown })>;
}
export interface NativePanelAttempt {
  id: string; input: NativePanelInput; inputDigest: string; prompt: string;
  source: AgentChatReadySource;
  status: 'preparing' | 'prepared' | 'dispatching' | 'finished' | 'failed' | 'cancelled' | 'unknown';
  sessionID?: string; turnID?: string;
  acceptance?: { decision: 'accepted' | 'rejected'; evidenceDigest: string; actor: string; comment: string };
}
export interface NativePanelApproval {
  id: string; attemptID: string; state: 'pending' | 'approved' | 'rejected'; expiresAt: string;
  consumed?: true; revoked?: true;
}
export interface NativePanelEvidence {
  attemptID: string; inputDigest: string; sessionID: string; turnID: string; digest: string; summary: string;
  native: AgentExecutionRecord;
  host?: { verifier: string; artifacts: Array<{ reference: string; sha256: string; bytes: number }>;
    checks: Array<{ name: string; outcome: 'passed' | 'failed' | 'unknown'; outputDigest: string }> };
}
export interface NativeTaskExecutionService {
  prepare(input: NativePanelInput, selection: NativePanelSelection): Promise<NativePanelAttempt>;
  list(task: NativePanelTask): Promise<NativePanelAttempt[]>;
  readSelection?(task: NativePanelTask, attemptID: string): Promise<NativePanelSelection>;
  requestApproval(task: NativePanelTask, attemptID: string): Promise<NativePanelApproval>;
  decideStart(task: NativePanelTask, approvalID: string, decision: 'approved' | 'rejected'): Promise<NativePanelApproval>;
  start(task: NativePanelTask, attemptID: string, approvalID: string): Promise<NativePanelAttempt>;
  refresh(task: NativePanelTask, attemptID: string): Promise<NativePanelAttempt>;
  stop(task: NativePanelTask, attemptID: string): Promise<void>;
  evidence(task: NativePanelTask, attemptID: string): Promise<NativePanelEvidence>;
  decideResult(task: NativePanelTask, attemptID: string, input: { evidenceDigest: string; decision: 'accepted' | 'rejected'; comment: string }): Promise<void>;
}
export interface NativeTaskExecutionPanelProps {
  disabled?: boolean;
  plan?: PreviewPlan; api: DesktopAPI; agents: readonly AgentChatSourceInfo[];
  service: NativeTaskExecutionService;
  /** Optional confirmed material projections from main. Never calculate provenance digests from labels. */
  materials?: readonly { id: string; title: string; reference: string; digest: string; summary: string }[];
}
const active = new Set<NativePanelAttempt['status']>(['preparing', 'prepared', 'dispatching', 'unknown']);
const statusLabels = { preparing: '准备状态待核对', prepared: '输入已冻结，尚未执行', dispatching: '已提交，等待原生结果', finished: 'Agent 报告结束', failed: '执行失败', cancelled: '已确认取消', unknown: '执行状态未知，禁止重发' };
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请核对原尝试。';
const relativeFile = (value: string) => !!value && !value.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
export function nativePanelSelection(rows: readonly { path: string; expected: string }[]): NativePanelSelection {
  if (!rows.length || rows.length > 32 || rows.some(row => !relativeFile(row.path.trim()) || !row.expected.trim() || row.expected.length > 8192)) throw new Error('请填写工作目录内的相对文件路径，以及需要包含的预期内容。');
  const artifacts = rows.map(row => row.path.trim());
  if (new Set(artifacts).size !== artifacts.length) throw new Error('产物路径不能重复。');
  return { artifacts, checks: rows.map((row, index) => ({ name: `内容检查 ${index + 1}`, path: artifacts[index], kind: 'utf8-contains', expected: row.expected })) };
}
export function nativePanelCanAccept(attempt: NativePanelAttempt, evidence: NativePanelEvidence | undefined): boolean {
  return !!evidence && attempt.status === 'finished' && !attempt.acceptance && evidence.attemptID === attempt.id && evidence.inputDigest === attempt.inputDigest && evidence.sessionID === attempt.sessionID && evidence.turnID === attempt.turnID && evidence.native.sessionID === attempt.sessionID && evidence.native.turnID === attempt.turnID && evidence.native.status === 'finished' && evidence.native.tools.every(tool => tool.status === 'completed') && evidence.native.approvals.every(item => item.state === 'decided' && item.decision === 'allow' && item.reply === 'queued') && !!evidence.host?.artifacts.length && !!evidence.host.checks.length && evidence.host.checks.every(check => check.outcome === 'passed');
}
export function NativeTaskExecutionPanel(props: NativeTaskExecutionPanelProps) {
  const plan = props.plan;
  if (!plan || !plan.id || !Number.isSafeInteger(plan.version) || plan.version < 1 || plan.scope) return <section className="native-task-execution" aria-label="原生工作项执行"><h3>原生工作项执行</h3><p>请先保存本地任务，再准备工作项执行。</p></section>;
  // Unmount on version/task change: late replies cannot replace another task's inputs or evidence.
  return <NativeExecutionBody key={`${plan.id}:${plan.version}`} {...props} plan={plan} />;
}
function NativeExecutionBody({ plan, api, agents, service, materials = [], disabled = false }: NativeTaskExecutionPanelProps & { plan: PreviewPlan }) {
  const task: NativePanelTask = { kind: 'local', planID: plan.id };
  const [itemID, setItemID] = useState(''), [agentID, setAgentID] = useState('');
  const [context, setContext] = useState<AgentExecutionContext>();
  const [text, setText] = useState(''), [materialIDs, setMaterialIDs] = useState<string[]>([]);
  const [rows, setRows] = useState([{ path: '', expected: '' }]);
  const [attempts, setAttempts] = useState<NativePanelAttempt[]>([]), [attemptID, setAttemptID] = useState('');
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [evidence, setEvidence] = useState<NativePanelEvidence>(), [comment, setComment] = useState('');
  const [selectionBusy, setSelectionBusy] = useState(false), [selectionError, setSelectionError] = useState(''), [selectionRetry, setSelectionRetry] = useState(0);
  const [frozenSelection, setFrozenSelection] = useState<{ attemptID: string; selection: NativePanelSelection }>();
  const [liveTurn, setLiveTurn] = useState<{sessionID:string;turnID:string}>();
  const [uncertain, setUncertain] = useState(false), [frozen, setFrozen] = useState(false);
  const gate = useRef(false), mounted = useRef(true);
  const item = plan.work_items.find(work => work.id === itemID);
  const source = agents.find(agent => agent.agentID === agentID && agent.state === 'ready');
  const attempt = attempts.find(value => value.id === attemptID);
  const blocked = attempts.some(value => active.has(value.status));
  const locked = disabled || !!busy || frozen || blocked || listState !== 'ready';
  const replace = (value: NativePanelAttempt) => {
    if (value.input.task.kind !== 'local' || value.input.task.planID !== task.planID) throw new Error('尝试不属于当前任务。');
    setAttempts(previous => [...previous.filter(a => a.id !== value.id), value]); setAttemptID(value.id); setEvidence(undefined);
  };
  const read = async () => {
    const listing = await service.list(task);
    if (listing.some(value => value.input.task.kind !== 'local' || value.input.task.planID !== task.planID)) throw new Error('尝试来源不匹配，已停止操作。');
    if (!mounted.current) return;
    setAttempts(listing); setAttemptID(previous => listing.some(value => value.id === previous) ? previous : listing.at(-1)?.id ?? ''); setListState('ready'); setEvidence(undefined);
  };
  useEffect(() => {
    mounted.current = true; let current = true;
    void service.list(task).then(listing => {
      if (!current) return;
      if (listing.some(value => value.input.task.kind !== 'local' || value.input.task.planID !== plan.id)) throw new Error('尝试来源不匹配。');
      setAttempts(listing); setAttemptID(listing.at(-1)?.id ?? ''); setListState('ready');
    }).catch(reason => { if (current) { setListState('error'); setError(message(reason)); } });
    return () => { current = false; mounted.current = false; };
  }, [service, plan.id]);
  useEffect(() => {
    let current = true;
    if (!attempt || attempt.status !== 'prepared' || frozenSelection?.attemptID === attempt.id) { setSelectionBusy(false); setSelectionError(''); return; }
    setFrozenSelection(undefined); setSelectionError('');
    if (!service.readSelection) { setSelectionBusy(false); setSelectionError('尚未接入原冻结文件规则读取，不能开始。可取消准备。'); return; }
    setSelectionBusy(true);
    void service.readSelection(task, attempt.id).then(value => {
      if (!current) return;
      if (!value || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 32 || value.artifacts.some(path => !relativeFile(path)) || new Set(value.artifacts).size !== value.artifacts.length || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 64 || value.checks.some(check => check.kind !== 'utf8-contains' || typeof check.expected !== 'string' || !check.expected.trim() || !check.name?.trim() || !value.artifacts.includes(check.path)) || new Set(value.checks.map(check => check.name)).size !== value.checks.length) throw new Error('冻结文件规则无效或此面板暂不支持该规则，不能开始。');
      setFrozenSelection({ attemptID: attempt.id, selection: structuredClone(value) });
    }).catch(reason => { if (current) setSelectionError(message(reason)); }).finally(() => { if (current) setSelectionBusy(false); });
    return () => { current = false; };
  }, [service, attempt?.id, attempt?.status, attempt?.inputDigest, selectionRetry]);
  useEffect(() => {
    let current = true; setLiveTurn(undefined);
    const sessionID = attempt?.sessionID;
    if (!sessionID) return;
    const observe = (record: Awaited<ReturnType<DesktopAPI['loadAgentSession']>>) => {
      if (!current || !record || record.conversation_id !== sessionID || record.turns.length !== 1 || record.source.agentID !== attempt.source.agentID || record.source.configDigest !== attempt.source.configDigest) return;
      setLiveTurn({ sessionID, turnID: record.turns[0].turn_id });
    };
    void api.loadAgentSession(sessionID).then(observe).catch(() => {});
    const unsubscribe = api.subscribe(event => { if (event.type === 'agent-session-updated') observe(event.session); });
    return () => { current = false; unsubscribe(); };
  }, [api, attempt?.sessionID, attempt?.inputDigest]);
  const run = async (label: string, action: () => Promise<void>, failureUncertain = false) => {
    if (gate.current) return;
    gate.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (reason) { if (mounted.current) { setError(message(reason)); if (failureUncertain) { setUncertain(true); setListState('error'); } } }
    finally { gate.current = false; if (mounted.current) setBusy(''); }
  };
  let selection: NativePanelSelection | undefined, issue = '';
  try { selection = nativePanelSelection(rows); } catch (reason) { issue = message(reason); }
  const eligible = !!item && item.assignee === 'agent' && item.agentID === agentID && item.status !== 'completed' && source?.state === 'ready' && source.capabilities.tools && source.capabilities.approvals;
  const prepare = () => void run('冻结输入', async () => {
    if (!eligible || !selection || !context || !text.trim() || locked || uncertain) return;
    const chosen = materialIDs.map(id => {
      const material = materials.find(value => value.id === id);
      if (!material || !/^[a-f0-9]{64}$/.test(material.digest)) throw new Error('材料来源指纹不可用，请重新确认。');
      return { reference: material.reference, digest: material.digest, summary: material.summary };
    });
    const input: NativePanelInput = { task, planVersion: plan.version, workItemID: item.id, clientRequestID: crypto.randomUUID(), agentID, context: structuredClone(context), materials: chosen, text: text.trim() };
    setFrozen(true);
    const result = await service.prepare(input, selection);
    if (mounted.current) { replace(result); setFrozenSelection({ attemptID: result.id, selection: structuredClone(selection) }); setNotice('输入已冻结，尚未发送。请核对摘要后决定开始。'); }
  }, true);
  const decideStart = (decision: 'approved' | 'rejected') => void run(decision === 'approved' ? '批准并开始' : '拒绝开始', async () => {
    if (disabled || !attempt || attempt.status !== 'prepared' || uncertain || selectionBusy || attempt.input.planVersion !== plan.version || frozenSelection?.attemptID !== attempt.id) return;
    const approval = await service.requestApproval(task, attempt.id);
    if (!mounted.current) return;
    if (approval.attemptID !== attempt.id || approval.revoked || approval.consumed || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now() || approval.state === 'rejected') throw new Error('开始确认已失效或被拒绝，请核对原尝试。');
    const decided = await service.decideStart(task, approval.id, decision);
    if (!mounted.current) return;
    if (decided.id !== approval.id || decided.attemptID !== attempt.id || decided.state !== decision || decided.revoked || decided.consumed) throw new Error('开始决定尚未确认，未提交执行。');
    if (decision === 'approved') {
      const result = await service.start(task, attempt.id, approval.id);
      if (mounted.current) replace(result);
    } else { setUncertain(true); setNotice('已拒绝开始。可取消这次已准备尝试，不会发送。'); }
  }, true);
  const collect = () => void run('读取宿主证据', async () => {
    if (!attempt || attempt.status !== 'finished') return;
    setEvidence(undefined);
    const result = await service.evidence(task, attempt.id);
    if (!mounted.current) return;
    if (result.attemptID !== attempt.id || result.inputDigest !== attempt.inputDigest || result.sessionID !== attempt.sessionID || result.turnID !== attempt.turnID) throw new Error('证据与原尝试绑定不匹配。');
    setEvidence(result);
  });
  const decideResult = (decision: 'accepted' | 'rejected') => void run('保存人工验收', async () => {
    if (!attempt || !evidence || attempt.acceptance || decision === 'accepted' && !nativePanelCanAccept(attempt, evidence)) return;
    await service.decideResult(task, attempt.id, { evidenceDigest: evidence.digest, decision, comment });
    if (mounted.current) { await read(); if (mounted.current) setNotice('人工验收已保存，人工完成勾选保持独立。'); }
  }, true);
  return <section className="native-task-execution" aria-label="原生工作项执行" aria-busy={!!busy}>
    <header><h3>原生工作项执行</h3><span>已保存版本 {plan.version}</span><button type="button" disabled={!!busy} onClick={() => void run('读取尝试', async () => { setListState('loading'); try { await read(); } catch (reason) { if (mounted.current) setListState('error'); throw reason; } })}>读取尝试</button></header>
    {listState === 'loading' && <p role="status">正在读取原尝试，暂不可开始。</p>}
    {listState === 'error' && <p>原尝试读取失败；重新读取成功前禁止准备和开始。</p>}
    <details className="native-task-form" open={!attempt}><summary>{attempt ? '执行范围表单（已冻结）' : '执行范围表单'}</summary><fieldset disabled={locked || uncertain}><legend>冻结执行范围</legend>
      <label>工作项<select aria-label="执行工作项" value={itemID} onChange={event => { const selected = plan.work_items.find(value => value.id === event.target.value); setItemID(event.target.value); setAgentID(selected?.agentID ?? ''); setContext(undefined); }}><option value="">请选择已分配工作项</option>{plan.work_items.map(work => <option key={work.id} value={work.id} disabled={work.assignee !== 'agent' || !work.agentID || work.status === 'completed'}>{work.title}{work.assignee !== 'agent' ? ' · 未分配给 Agent' : work.status === 'completed' ? ' · 人工已完成' : ''}</option>)}</select></label>
      <label>Agent<select aria-label="执行 Agent" value={agentID} onChange={event => { setAgentID(event.target.value); setContext(undefined); }}><option value="">请选择 Agent</option>{agents.map(agent => <option key={agent.agentID} value={agent.agentID} disabled={agent.state !== 'ready' || !agent.capabilities.tools || !agent.capabilities.approvals}>{agent.name}{agent.state !== 'ready' ? ' · 未连接' : ''}</option>)}</select></label>
      {agentID && <AgentWorkspaceControls projectID={plan.task?.project_id} key={agentID} api={api} agentID={agentID} selection={context} disabled={locked || uncertain} onChange={setContext} />}
      {!eligible && <p>工作项须已保存、分配给对应 Agent，且原生工具与审批已就绪。</p>}
      <label>本次执行说明<textarea aria-label="本次执行说明" rows={3} value={text} onChange={event => setText(event.target.value)} /></label>
      <div className="native-task-materials"><strong>明确带入的已确认材料</strong>{!materials.length ? <p>暂无可选的确认材料；不会自动附加任务历史。</p> : materials.map(material => <label key={material.id}><input type="checkbox" checked={materialIDs.includes(material.id)} onChange={event => setMaterialIDs(previous => event.target.checked ? [...previous, material.id] : previous.filter(value => value !== material.id))} /><span>{material.title}<small>{material.reference}</small><small>{material.summary}</small></span></label>)}</div>
      <strong>宿主文件内容检查</strong><p>填写相对路径与文件应包含的内容。此检查不运行测试命令，也不代表代码测试通过。</p>
      {rows.map((row, index) => <div className="native-task-expectation" key={index}><label>产物路径 {index + 1}<input aria-label={`产物路径 ${index + 1}`} placeholder="src/result.txt" value={row.path} onChange={event => setRows(previous => previous.map((value, position) => position === index ? { ...value, path: event.target.value } : value))} /></label><label>预期包含内容 {index + 1}<textarea aria-label={`预期包含内容 ${index + 1}`} rows={2} value={row.expected} onChange={event => setRows(previous => previous.map((value, position) => position === index ? { ...value, expected: event.target.value } : value))} /></label><button type="button" disabled={rows.length === 1} onClick={() => setRows(previous => previous.filter((_, position) => position !== index))}>移除产物 {index + 1}</button></div>)}
      <button type="button" disabled={rows.length >= 32} onClick={() => setRows(previous => [...previous, { path: '', expected: '' }])}>添加产物</button>
      <p>{issue}</p><button type="button" className="native-task-primary" disabled={!eligible || !selection || !context || !text.trim() || locked || uncertain} onClick={prepare}>冻结输入，不执行</button>
    </fieldset></details>
    {(frozen || uncertain || attempt && !active.has(attempt.status)) && <button type="button" disabled={!!busy || listState !== 'ready' || blocked} onClick={() => { setFrozen(false); setUncertain(false); setFrozenSelection(undefined); setEvidence(undefined); setAttemptID(''); setText(''); setContext(undefined); setMaterialIDs([]); setRows([{ path: '', expected: '' }]); setError(''); setNotice('新尝试草稿尚未准备或执行。'); }}>新建尝试草稿</button>}
    {!!attempts.length && <label>原尝试<select aria-label="原尝试" disabled={!!busy} value={attemptID} onChange={event => { setAttemptID(event.target.value); setEvidence(undefined); setComment(''); }} >{attempts.map(value => <option key={value.id} value={value.id}>{value.id.slice(0, 8)} · {statusLabels[value.status]}</option>)}</select></label>}
    {attempt && <div className="native-task-attempt"><strong>{statusLabels[attempt.status]}</strong><p>原版本 {attempt.input.planVersion} · {attempt.source.name} · {attempt.source.model.model_id}</p><p className="native-task-path">{attempt.input.context.workspace.path} · {permissionLabel(attempt.input.context.mode)}</p><p>{attempt.input.text.length > 240 ? `${attempt.input.text.slice(0, 240)}…（完整内容见冻结输入）` : attempt.input.text}</p><p>明确选择材料：{attempt.input.materials.length} 项</p><details><summary>冻结输入与指纹</summary><pre>{attempt.prompt}</pre><code>{attempt.inputDigest}</code></details>
      {frozenSelection?.attemptID === attempt.id ? <details open><summary>本次冻结的文件检查规则</summary>{frozenSelection.selection.checks.map(check => <p key={check.path}>{check.path}<br />应包含：<code>{typeof check.expected === 'string' ? check.expected : JSON.stringify(check.expected)}</code></p>)}</details> : attempt.status === 'prepared' && <div>{selectionBusy ? <p role="status">正在读取原冻结文件规则，禁止开始。</p> : <><p role="alert">{selectionError || '原文件检查规则尚未恢复，禁止开始。可取消原尝试后重新准备。'}</p>{service.readSelection && <button type="button" disabled={!!busy} onClick={() => setSelectionRetry(value => value + 1)}>重新读取冻结规则</button>}</>}</div>}
      {attempt.input.planVersion !== plan.version && <p>当前计划版本已变化，不能开始或接受旧尝试。</p>}
      <div className="native-task-actions"><button type="button" disabled={!!busy || listState !== 'ready'} onClick={() => void run('核对原尝试', async () => { const result = await service.refresh(task, attempt.id); if (mounted.current) { replace(result); setListState('ready'); } }, true)}>核对原尝试</button>
      {(attempt.status === 'prepared' || attempt.status === 'dispatching' || attempt.status === 'unknown') && <button type="button" disabled={!!busy} onClick={() => void run('请求停止', async () => { await service.stop(task, attempt.id); if (!mounted.current) return; setNotice('已请求停止，需核对原生结果后确认。'); const result = await service.refresh(task, attempt.id); if (mounted.current) replace(result); }, true)}>{attempt.status === 'prepared' ? '取消已准备尝试' : '请求停止'}</button>}
      {attempt.status === 'prepared' && <><button type="button" disabled={!!busy || uncertain || selectionBusy || listState !== 'ready' || attempt.input.planVersion !== plan.version || frozenSelection?.attemptID !== attempt.id} onClick={() => decideStart('rejected')}>拒绝开始</button><button type="button" className="native-task-primary" disabled={!!busy || uncertain || selectionBusy || listState !== 'ready' || attempt.input.planVersion !== plan.version || frozenSelection?.attemptID !== attempt.id} onClick={() => decideStart('approved')}>批准并开始这一次</button></>}
      {attempt.status === 'finished' && <button type="button" disabled={!!busy || listState !== 'ready'} onClick={collect}>读取宿主产物与检查</button>}</div>
      {attempt.sessionID && (attempt.turnID || liveTurn?.sessionID === attempt.sessionID && liveTurn.turnID) && <AgentTurnTools key={`${attempt.sessionID}:${attempt.turnID ?? liveTurn?.turnID}`} api={api} sessionID={attempt.sessionID} turnID={attempt.turnID ?? liveTurn!.turnID} />}
      {attempt.acceptance && <p>已人工{attempt.acceptance.decision === 'accepted' ? '接受' : '退回'} · {attempt.acceptance.actor} · {attempt.acceptance.comment}</p>}
      {evidence && <div className="native-task-evidence"><details><summary>Agent 结果摘要（Agent 报告）</summary><pre>{evidence.summary || '没有摘要'}</pre></details><strong>宿主文件证据</strong><p>证据指纹：<code>{evidence.digest}</code></p>{!evidence.host ? <p>宿主证据缺失，不能接受。</p> : <><p>读取器：{evidence.host.verifier}</p>{evidence.host.artifacts.map(artifact => <p key={artifact.reference}>{artifact.reference} · {artifact.bytes} 字节<br /><code>SHA-256 {artifact.sha256}</code></p>)}{evidence.host.checks.map(check => <p key={check.name}>{check.name} · {check.outcome === 'passed' ? '符合预期' : check.outcome === 'failed' ? '不符合预期' : '未知'}<br /><code>{check.outputDigest}</code></p>)}</>}
      <label>人工验收意见<textarea aria-label="人工验收意见" rows={2} disabled={!!busy || !!attempt.acceptance} value={comment} onChange={event => setComment(event.target.value)} /></label><div className="native-task-actions"><button type="button" disabled={!!busy || uncertain || listState !== 'ready' || !!attempt.acceptance} onClick={() => decideResult('rejected')}>退回成果</button><button type="button" disabled={disabled || !!busy || uncertain || listState !== 'ready' || attempt.input.planVersion !== plan.version || !nativePanelCanAccept(attempt, evidence)} onClick={() => decideResult('accepted')}>人工接受成果</button></div><p>内容检查符合预期与人工接受是两个事实；不会自动更改人工完成勾选。</p></div>}
    </div>}
    <p className="native-task-feedback" role={error ? 'alert' : 'status'}>{error || (busy ? `${busy}…` : notice || (uncertain ? '上次操作结果需核对，禁止自动重发。' : '准备、开始、原生工具批准与人工验收分别记录。'))}</p>
  </section>;
}
