import React, { useEffect, useState } from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import type { PreviewPlan } from '../../shared/types';
import type { AgentChatSourceInfo } from '../../shared/agent-chat';
import type { ChatRecord } from '../chat-history';
import { chatKey, isAgentChat } from '../chat-history';
import { TaskChatPanel } from '../task-chat/TaskChatPanel';
import type { TaskChatDraft, TaskChatHandoff, TaskChatSession } from '../task-chat/task-chat-model';

const draftMemory = new Map<string, TaskChatDraft>();
export function TaskDiscussion({ plan, api, records, sources, onPrepare, onOpenSession, onUnlink, onStandalone }: {
  plan: PreviewPlan; api: DesktopAPI; records: ChatRecord[]; sources: AgentChatSourceInfo[];
  onPrepare(handoff: TaskChatHandoff): Promise<void>; onOpenSession(id: string): void;
  onUnlink(id: string): Promise<void>; onStandalone(): void;
}) {
  const [draft, setDraft] = useState<TaskChatDraft>(() => draftMemory.get(plan.id) ?? { target: { kind: 'new' }, materialIDs: [], text: '' });
  const [operation, setOperation] = useState<{ state: 'idle' | 'pending' | 'success' } | { state: 'error'; message: string }>({ state: 'idle' });
  const [contexts, setContexts] = useState<Record<string, TaskChatSession['execution']>>({});
  const [contextError, setContextError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (draft.target.kind !== 'existing') return;
    const record = records.find(r => chatKey(r) === (draft.target.kind === 'existing' ? draft.target.sessionID : ''));
    if (!record || !isAgentChat(record)) return;
    setContextError('');
    void api.getAgentExecutionContext(record.conversation_id).then(context => { if (active) setContexts(previous => ({ ...previous, [chatKey(record)]: context })); }).catch(() => { if (active) setContextError('聊天权限读取失败，请重新读取。'); });
    return () => { active = false; };
  }, [api, draft.target, records, retry]);
  const sessions: TaskChatSession[] = records.map(record => ({ id: chatKey(record), title: record.title, sourceLabel: isAgentChat(record) ? sources.find(s => s.agentID === record.source.agentID)?.name ?? record.source.agentID : '直接模型', ...(isAgentChat(record) ? { agentID: record.source.agentID, execution: contexts[chatKey(record)] } : {}), ...(['unknown','prepared','running','streaming','cancelling','awaiting_approval'].includes(record.turns.at(-1)?.state ?? '') ? { unavailableReason: '当前会话正在处理或需核对状态' } : {}) }));
  const run = async (work: () => Promise<void>) => { if (operation.state === 'pending') return; setOperation({ state: 'pending' }); try { await work(); setOperation({ state: 'success' }); } catch (error) { setOperation({ state: 'error', message: error instanceof Error ? error.message : '操作失败，请重试。' }); } };
  const selectedRecord = draft.target.kind === 'existing' ? records.find(record => chatKey(record) === (draft.target.kind === 'existing' ? draft.target.sessionID : '')) : undefined;
  const readingContext = !!selectedRecord && isAgentChat(selectedRecord) && !Object.hasOwn(contexts, chatKey(selectedRecord));
  return <details className="task-content-section"><summary>关联与继续讨论</summary><TaskChatPanel scope={{ key: `local:${plan.id}`, title: plan.title, version: plan.version }} sessions={readingContext && !contextError ? { state: 'loading' } : contextError ? { state: 'error', message: contextError } : { state: 'ready', items: sessions }} materials={{ state: 'ready', items: (plan.task?.materials ?? []).map(m => ({ id: m.id, title: m.title, summary: m.summary, sourceLabel: m.source.label, available: true })) }} draft={draft} operation={operation} onChange={value => { draftMemory.set(plan.id, value); setDraft(value); setOperation({ state: 'idle' }); }} onPrepare={handoff => void run(() => onPrepare(handoff))} onRetrySessions={() => setRetry(v => v + 1)} onRetryMaterials={() => {}} onOpenSession={onOpenSession} onOpenStandaloneChat={onStandalone} />{(plan.task?.chat_refs ?? []).length > 0 && <section className="task-content-section"><h2>关联记录</h2>{plan.task!.chat_refs.map(ref => { const id = `${ref.source}:${ref.sessionID}`, record = records.find(r => chatKey(r) === id); return <div className="task-step-options" key={id}><button className="text-button" disabled={!record} onClick={() => onOpenSession(id)}>{record?.title ?? '聊天暂不可读'}</button><button className="icon-button" aria-label={`解除关联：${record?.title ?? ref.sessionID}`} disabled={operation.state === 'pending'} onClick={() => void run(() => onUnlink(id))}>×</button></div>; })}</section>}</details>;
}
