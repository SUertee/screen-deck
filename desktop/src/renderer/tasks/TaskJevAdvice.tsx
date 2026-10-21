import React, { useEffect, useRef, useState } from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import type { PreviewPlan } from '../../shared/types';
import { jevFeedback } from './jev-feedback';

export function TaskJevAdvice({ api, plan, disabled, onConfigureJev, jevSettingsRevision = 0, onBusyChange }: {api:DesktopAPI;plan:PreviewPlan;disabled:boolean;onConfigureJev?:()=>void;jevSettingsRevision?:number;onBusyChange?(busy:boolean):void}) {
  const [settingsRefresh,setSettingsRefresh] = useState(0);
  const [settings,setSettings] = useState<{hasKey:boolean;model:string}>();
  const locked = useRef(false), generation = useRef(0);
  const [itemID,setItemID] = useState(''), [materialIDs,setMaterialIDs] = useState<string[]>([]);
  const [ticket,setTicket] = useState<Awaited<ReturnType<DesktopAPI['previewJevAdvice']>>>();
  const [advice,setAdvice] = useState<Awaited<ReturnType<DesktopAPI['requestJevAdvice']>>>();
  const [candidate,setCandidate] = useState(''), [budget,setBudget] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy,onBusyChange]);
  useEffect(() => { generation.current++;setTicket(undefined);setAdvice(undefined);setBudget(false);setError('');setItemID('');setMaterialIDs([]); },[plan.id]);
  useEffect(()=>{generation.current++;let current=true;void api.getJevSettings().then(s=>{if(current){setSettings(s);setTicket(undefined);setAdvice(undefined);setBudget(false);}}).catch(e=>{if(current)setError(jevFeedback(e).message);});return()=>{current=false;};},[api,jevSettingsRevision,settingsRefresh]);
  const run = async (work:()=>Promise<void>) => { if(locked.current)return;locked.current=true;setBusy(true);setError('');const current=generation.current;try{await work();}catch(e){if(current!==generation.current)return;const feedback=jevFeedback(e);setError(feedback.message);}finally{locked.current=false;setBusy(false);} };
  const stale = ticket && (ticket.preview.base.planID !== plan.id || ticket.preview.base.baseVersion !== plan.version);
  return <details className="task-content-section task-jev" onToggle={e=>{if(e.currentTarget.open)setSettingsRefresh(value=>value+1);}}><summary>获取分工建议</summary>
    <div className="task-jev-body"><p>Jev 比较分工候选。发送前请核对内容并确认本次费用。</p>
    {settings && (!settings.hasKey||!settings.model) && <p role="status">尚未配置 Jev，请前往“Agent 设置 → 任务分工判断 / Jev”。</p>}
    {onConfigureJev && <button type="button" className="button small ghost" disabled={busy} onClick={onConfigureJev}>{settings?.hasKey&&settings.model?'Jev 设置':'配置 Jev'}</button>}
    <fieldset className="plain-fieldset" disabled={busy||disabled}><label className="task-field">待判断的工作项<select aria-label="Jev 工作项" value={itemID} onChange={e=>{setItemID(e.target.value);setTicket(undefined);setAdvice(undefined);setBudget(false);}}><option value="">选择工作项</option>{plan.work_items.filter(i=>i.status==='planned').map(i=><option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
    {(plan.task?.materials.length??0)>0&&<div className="task-jev-materials"><span>带入的材料</span>{plan.task!.materials.map(m=><label key={m.id}><input type="checkbox" checked={materialIDs.includes(m.id)} onChange={e=>{setMaterialIDs(e.target.checked?[...materialIDs,m.id]:materialIDs.filter(id=>id!==m.id));setTicket(undefined);setAdvice(undefined);setBudget(false);}}/>{m.title}</label>)}</div>}
    <button className="button small" disabled={busy||!settings?.hasKey||!settings.model||!itemID} onClick={()=>void run(async()=>{const current=generation.current;const result=await api.previewJevAdvice({planID:plan.id,workItemID:itemID,materialIDs});if(current!==generation.current)return;setTicket(result);setAdvice(undefined);setBudget(false);})}>预览发送内容</button>
    {ticket&&<div className="task-jev-preview"><strong>发送给 TypeSafe 的内容</strong><pre>{JSON.stringify(ticket.preview.request,null,2)}</pre><p>候选：{ticket.preview.candidates.map(c=>c.label).join('、')}</p><label><input type="checkbox" checked={budget} onChange={e=>setBudget(e.target.checked)}/>确认发送以上内容并产生本次调用费用</label><button className="button small" disabled={!budget||!!stale||!!advice} onClick={()=>void run(async()=>{const current=generation.current;try{const result=await api.requestJevAdvice({id:ticket.id,budgetConfirmed:true});if(current!==generation.current)return;setAdvice(result);setCandidate(result.advice.candidateChanges[0]?.candidate.id??'');}catch(e){setTicket(undefined);setAdvice(undefined);throw e;}finally{setBudget(false);}})}>发送给 Jev</button></div>}
    {advice&&<div className="task-jev-result"><strong>建议：{advice.advice.candidateChanges[0]?.candidate.label}</strong>{advice.advice.reasons.map((reason,i)=><p key={i}>{reason}</p>)}<p>以下说明由应用根据判断结果整理；Jev 返回候选选择与概率。</p><label className="task-field">确认分工<select aria-label="确认 Jev 分工" value={candidate} onChange={e=>setCandidate(e.target.value)}>{ticket?.preview.candidates.map(c=><option value={c.id} key={c.id}>{c.label}</option>)}</select></label><div className="task-step-options"><button className="button small ghost" onClick={()=>{setAdvice(undefined);setTicket(undefined);}}>不采用</button><button className="button small" disabled={!!stale||!candidate} onClick={()=>void run(async()=>{await api.applyJevAdvice({id:advice.id,candidateID:candidate});setAdvice(undefined);setTicket(undefined);})}>确认并保存分工</button></div></div>}
    </fieldset>{disabled&&<p>保存当前任务后可获取建议。</p>}{stale&&<p role="status">任务已更新，请重新预览。</p>}{error&&<div><p className="task-save-error" role="alert">{error}</p><button type="button" className="button small ghost" onClick={()=>{setTicket(undefined);setAdvice(undefined);setBudget(false);setError('');}}>准备新的发送预览</button></div>}</div>
  </details>;
}
