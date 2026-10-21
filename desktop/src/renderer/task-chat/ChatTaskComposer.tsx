import { TaskGoalFields } from '../tasks/TaskGoalFields';
import React, { useEffect, useRef, useState } from 'react';
import type { ChatTaskAPI, ChatTaskReference, ChatTaskSource, CreateChatTaskInput } from '../../shared/chat-task';
import type { PreviewPlan } from '../../shared/types';
import { Modal } from '../components';
import './chat-task-composer.css';
const unfinished = new Map<string, CreateChatTaskInput>();
const keyFor = (ref: ChatTaskReference) => `${ref.source}:${ref.sessionID}:${ref.messageID}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '保存失败，请重试同一任务。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
/** Only explicitly reviewed text enters a formal Task. No create-on-open or model invocation. */
export function ChatTaskComposer({ api, reference, projects = [], onCreated, onClose }: {
  api: ChatTaskAPI; projects?:readonly{id:string;name:string}[]; reference: ChatTaskReference; onCreated(plan: PreviewPlan): void; onClose(): void;
}) {
  const remembered = unfinished.get(keyFor(reference));
  const [source, setSource] = useState<ChatTaskSource>(), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  const [title, setTitle] = useState(remembered?.title ?? ''), [goal, setGoal] = useState(remembered?.goal ?? ''), [conditions, setConditions] = useState(remembered?.completionConditions?.join('\n') ?? '');
  const [projectID,setProjectID]=useState(remembered?.projectID??'');
  const [include, setInclude] = useState(remembered?.excerpt !== undefined), [excerpt, setExcerpt] = useState(remembered?.excerpt ?? '');
  const [frozen, setFrozen] = useState<CreateChatTaskInput | undefined>(remembered), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const gate = useRef(false), alive = useRef(true);
  useEffect(() => {
    let current = true; alive.current = true; setLoading(true); setError('');
    void api.getChatTaskSource(reference).then(value => {
      if (!current) return;
      setSource(value);
      setExcerpt(previous => previous || value.text.slice(0,8000));
    }).catch(reason => { if (current) setError(errorText(reason)); }).finally(()=>{if(current)setLoading(false)});
    return () => { current = false; alive.current = false; };
  }, [api, reference.source, reference.sessionID, reference.messageID, retry]);
  const completion = conditions.split('\n').map(line=>line.trim()).filter(Boolean);
  const byteLength = (value: string) => new TextEncoder().encode(value).length;
  const valid = !!source && byteLength(title) <= 600 && !!goal.trim() && byteLength(goal) <= 16384 && completion.length <= 100 && completion.every(value=>byteLength(value)<=4096) && (!include || !!excerpt.trim() && source.text.includes(excerpt));
  const save = async () => {
    if (gate.current || !frozen && (!valid || loading || !source)) return;
    gate.current = true; setBusy(true); setError('');
    const input: CreateChatTaskInput = frozen ?? { requestID: crypto.randomUUID(), source: { ...reference, digest: source!.digest }, goal: goal.trim(), ...(title.trim()?{title:title.trim()}:{}), ...(completion.length?{completionConditions:completion}:{}), ...(projectID?{projectID}:{}), ...(include ? { excerpt } : {}) };
    unfinished.set(keyFor(reference),input); setFrozen(input);
    try {
      const plan = await api.createTaskFromChat(input);
      if (!alive.current) return;
      unfinished.delete(keyFor(reference)); onCreated(plan);
    } catch (reason) { if (alive.current) {
      setError(errorText(reason));
      if (reason && typeof reason === 'object' && 'safeToEdit' in reason && reason.safeToEdit === true) {
        unfinished.delete(keyFor(reference)); setFrozen(undefined);
        if ('code' in reason && ['chat-task-source','chat-task-busy','chat-task-message','chat-task-changed'].includes(String(reason.code))) setSource(undefined);
      }
    } }
    finally { gate.current = false; if (alive.current) setBusy(false); }
  };
  const close = () => { if (!gate.current) onClose(); };
  return <Modal title="从消息创建任务" onClose={close} className="chat-task-composer"><div className="modal-body">
    <p>保存到任务列表，并关联原聊天。这里只保存任务，不发送消息或开始 Agent。</p>
    {loading && <p role="status">正在核对已保存的原消息…</p>}
    {source && <details><summary>{source.sessionTitle} · {source.role === 'user' ? '用户消息' : '回复'} · 原消息</summary><pre>{source.text}</pre><small>Session {source.sessionID}<br />Message {source.messageID}</small></details>}
    {!source && !loading && <button type="button" disabled={busy} onClick={()=>setRetry(value=>value+1)}>重新读取原消息</button>}
    <TaskGoalFields goal={goal}onGoal={setGoal}title={title}onTitle={setTitle}conditions={conditions}onConditions={setConditions}projectID={projectID}onProject={setProjectID}projects={projects}disabled={loading||busy||!!frozen||!source}>
      <label className="chat-task-excerpt-toggle"><input type="checkbox" checked={include} onChange={event=>setInclude(event.target.checked)} /><span>带入这条消息的摘录</span></label>
      {include && <label>确认摘录<textarea aria-label="聊天任务摘录" rows={3} value={excerpt} maxLength={8000} onChange={event=>setExcerpt(event.target.value)} /><small>只保留源消息中的连续原文，其他聊天内容不会附加。</small></label>}
      {include && source && !source.text.includes(excerpt) && <p role="alert">摘录与原消息不一致，请粘贴原文中的连续片段。</p>}
    </TaskGoalFields>
    <p role={error ? 'alert' : 'status'} className="chat-task-feedback">{error || (frozen ? '本次创建标识已固定；重试会返回同一任务，不会再建一个。' : '先保存主任务，步骤和完成条件可以之后补充。')}</p>
    <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="button" className="chat-task-save" disabled={busy || (!frozen && (!valid || loading))} onClick={()=>void save()}>{busy ? '正在保存…' : frozen ? '重试保存同一任务' : '保存主任务'}</button></footer>
  </div></Modal>;
}
