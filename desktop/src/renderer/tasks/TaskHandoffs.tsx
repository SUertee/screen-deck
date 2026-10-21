import React,{useEffect,useRef,useState} from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import type { PreviewPlan } from '../../shared/types';
import type { TaskHandoff } from '../../shared/task-handoffs';
export function TaskHandoffs({api,plan,disabled}:{api:DesktopAPI;plan:PreviewPlan;disabled:boolean}) {
  const [records,setRecords]=useState<TaskHandoff[]>([]),[summary,setSummary]=useState(''),[next,setNext]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[notice,setNotice]=useState('');
  const gate=useRef(false),mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{let alive=true;setError('');void api.taskHandoffs(plan.id).then(value=>{if(alive)setRecords(value);}).catch(()=>{if(alive)setError('交接记录读取失败，请重试。');});return()=>{alive=false;};},[api,plan.id,revision]);
  useEffect(()=>api.subscribe(event=>{if(event.type==='task-handoffs-updated')setRevision(v=>v+1);}),[api]);
  const run=async(action:()=>Promise<void>)=>{if(gate.current)return;gate.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(mounted.current)setError((e instanceof Error?e.message:'操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''));}finally{gate.current=false;if(mounted.current)setBusy(false);}};
  return <details className="task-content-section task-handoffs"><summary>交接记录 <span>{records.length}</span></summary><div className="task-handoff-body">
    {error&&<p role="alert" className="task-save-error">{error}<button className="text-button" onClick={()=>setRevision(v=>v+1)}>重新读取</button></p>}
    <label className="task-field">交接摘要<textarea aria-label="交接摘要" rows={3} value={summary} disabled={busy} onChange={e=>setSummary(e.target.value)} placeholder="已完成、已验证的内容，以及当前阻塞"/></label>
    <label className="task-field">下一步<textarea aria-label="交接下一步" rows={2} value={next} disabled={busy} onChange={e=>setNext(e.target.value)} placeholder="下一个 Agent 应继续做什么？"/></label>
    <div className="task-handoff-actions"><button className="button small" disabled={disabled||busy||!summary.trim()} onClick={()=>void run(async()=>{await api.saveTaskHandoff({planID:plan.id,expectedVersion:plan.version,summary,next});if(mounted.current){setSummary('');setNext('');setRevision(v=>v+1);setNotice('交接已保存');}})}>保存交接</button><button className="button small ghost" disabled={busy||!records.length} onClick={()=>void run(async()=>{const result=await api.exportTaskHandoffs(plan.id);if(result.saved&&mounted.current)setNotice('交接日志已导出');})}>导出 AGENTLOG.md</button></div>
    {notice&&<p role="status">{notice}</p>}
    {records.slice(0,10).map(record=><article className="task-handoff-entry" key={record.id}><header><strong>{record.source==='manual'?'人工交接':record.state}</strong><span>v{record.planVersion}{record.planVersion!==plan.version?' · 原版本':''}</span></header><p>{record.summary}</p>{record.next&&<p>下一步：{record.next}</p>}<time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time></article>)}
  </div></details>;
}
