import { permissionSummary } from '../shared/agent-permissions';
import React, { useEffect, useRef, useState } from 'react';
import { Check, FileText, Folder, LoaderCircle, ShieldCheck, Terminal, Wrench, X } from 'lucide-react';
import type { DesktopAPI } from '../shared/desktop-api';
import type { AgentExecutionContext, AgentExecutionRecord } from '../shared/agent-execution';
import { AgentPermissionPicker } from './AgentPermissionPicker';
import './agent-execution.css';
const errorText = (value: unknown) => (value instanceof Error ? value.message : '操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export function AgentWorkspaceControls({ api, agentID, sessionID, selection, disabled, onChange, projectID }: { projectID?: string; api: DesktopAPI; agentID: string; sessionID?: string; selection?: AgentExecutionContext; disabled: boolean; onChange(value: AgentExecutionContext | undefined): void }) {
  const [saved, setSaved] = useState<AgentExecutionContext | undefined>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const mounted = useRef(true), pending = useRef(false);
  useEffect(() => { let current = true; mounted.current = true; setError(''); setSaved(undefined); if (sessionID) { setBusy(true); void api.getAgentExecutionContext(sessionID).then(value => { if (current) setSaved(value); }).catch(value => { if (current) setError(errorText(value)); }).finally(() => { if (current) setBusy(false); }); } return () => { current = false; mounted.current = false; }; }, [api, sessionID, agentID]);
  const context = sessionID ? saved : selection, currentMode = context?.mode ?? 'confirm-changes';
  const policy = permissionSummary(agentID, currentMode);
  return <div className="agent-workspace-controls">
    <button type="button" className="agent-workspace-button" title={context?.workspace.path ?? (sessionID ? '本会话仅聊天；需要本地工具时新建聊天并选择目录。' : '可选：选择目录后使用本地工具。不选择也能聊天。')} disabled={disabled || busy || !!sessionID} onClick={() => { if (pending.current) return; pending.current = true; setBusy(true); setError(''); void api.chooseAgentWorkspace().then(workspace => { if (workspace && mounted.current) onChange({ workspace, mode: currentMode }); }).catch(value => { if (mounted.current) setError(errorText(value)); }).finally(() => { pending.current = false; if (mounted.current) setBusy(false); }); }}>{busy ? <LoaderCircle size={14} /> : <Folder size={14} />}<span>{context?.workspace.label ?? (sessionID ? '纯聊天' : '选择工作目录')}</span></button>
    {projectID && !sessionID && <button type="button" className="text-button" disabled={disabled||busy} onClick={()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');void api.chooseProjectWorkspace(projectID).then(workspace=>{if(mounted.current)onChange({workspace,mode:currentMode});}).catch(e=>{if(mounted.current)setError(errorText(e));}).finally(()=>{pending.current=false;if(mounted.current)setBusy(false);});}}>使用项目目录</button>}
    {context && !sessionID && <button type="button" className="icon-button" title="移除目录，改为纯聊天" aria-label="移除工作目录" disabled={disabled || busy} onClick={() => onChange(undefined)}><X size={13} /></button>}
    {context && <AgentPermissionPicker value={currentMode} disabled={disabled || busy || !!sessionID} policy={policy} onChange={next => { onChange({ ...context, mode: next }); }} />}
    {error && <span className="agent-control-error" role="alert">{error}</span>}
  </div>;
}
const statuses = { pending: '待执行', running: '进行中', completed: '完成', failed: '失败', unknown: '未确认' };
export function AgentTurnTools({ api, sessionID, turnID }: { api: DesktopAPI; sessionID: string; turnID: string }) {
  const [record, setRecord] = useState<AgentExecutionRecord>(), [error, setError] = useState(''), [busyID, setBusyID] = useState(''); const pending = useRef(false);
  useEffect(() => { let current = true, seenEvent = false;
    const unsubscribe = api.subscribe(event => { if (event.type === 'agent-execution-updated' && event.execution.sessionID === sessionID && event.execution.turnID === turnID) { seenEvent = true; setRecord(event.execution); } });
    void api.getAgentExecution({ sessionID, turnID }).then(value => { if (current && !seenEvent) setRecord(value); }).catch(value => { if (current) setError(errorText(value)); });
    return () => { current = false; unsubscribe(); };
  }, [api, sessionID, turnID]);
  const decide = async (approvalID: string, decision: 'allow' | 'deny') => { if (pending.current) return; pending.current = true; setBusyID(approvalID); setError(''); try { await api.decideAgentPermission({ sessionID, turnID, approvalID, decision }); } catch (value) { setError(errorText(value)); } finally { pending.current = false; setBusyID(''); } };
  if (!record?.tools.length && !record?.approvals.length && !error) return null;
  return <section className="agent-turn-tools" aria-label="Agent 工具与审批">
    {record?.tools.map(tool => { const Icon = tool.kind === 'command' ? Terminal : tool.kind === 'read' || tool.kind === 'write' ? FileText : Wrench; return <details key={tool.id} className="agent-tool-row" open={tool.status === 'failed' ? true : undefined} data-state={tool.status}><summary><Icon size={14} aria-hidden="true" /><span className="agent-tool-title">{tool.title}</span><span className="agent-tool-status">{statuses[tool.status]}</span></summary>{tool.detail && <pre>{tool.detail}</pre>}{tool.output && <pre>{tool.output}</pre>}{tool.truncated && <span className="agent-tool-note">输出较长，仅显示部分内容</span>}<span className="agent-tool-note">Agent 报告的结果</span></details>; })}
    {record?.approvals.map(approval => <div className="agent-approval" key={approval.id} data-state={approval.state} role={approval.state === 'pending' ? 'status' : undefined}><div className="agent-approval-title"><ShieldCheck size={15} /><strong>{approval.title}</strong></div>{approval.detail && <pre>{approval.detail}</pre>}{approval.state === 'pending' && approval.decider === 'policy' ? <span className="agent-tool-note">正在按所选模式处理</span> : approval.state === 'pending' ? <div className="agent-approval-actions"><button type="button" disabled={!!busyID} className="button small ghost" onClick={() => void decide(approval.id, 'deny')}><X size={13} />拒绝</button>{approval.canAllow && <button type="button" disabled={!!busyID} className="button small primary" onClick={() => void decide(approval.id, 'allow')}>{busyID === approval.id ? <LoaderCircle size={13} /> : <Check size={13} />}批准这一次</button>}</div> : <span className="agent-tool-note">{approval.state === 'expired' ? '申请已失效' : approval.decision === 'allow' ? approval.decider === 'policy' ? '按模式自动批准' : '已批准这一次' : approval.decider === 'policy' ? '只读策略已拒绝' : '已拒绝'}{approval.reply === 'unknown' ? ' · 回复状态未确认' : approval.reply === 'queued' ? ' · 已交给原生协议处理' : approval.reply === 'pending' ? ' · 尚未交给 Agent' : ''}</span>}</div>)}
    {error && <p className="agent-control-error" role="alert">{error}</p>}
  </section>;
}
