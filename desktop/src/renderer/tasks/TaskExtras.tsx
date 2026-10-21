import { TaskPlanningPanel } from './TaskPlanningPanel';
import { TaskKnowledge } from './TaskKnowledge';
import React, { useEffect, useMemo, useState, useRef } from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import type { PreviewPlan } from '../../shared/types';
import type { AgentChatSourceInfo } from '../../shared/agent-chat';
import { NativeTaskExecutionPanel, type NativeTaskExecutionService, type NativePanelSelection } from './NativeTaskExecutionPanel';
import { TaskHandoffs } from './TaskHandoffs';
import { TaskJevAdvice } from './TaskJevAdvice';
export function TaskExtras({api,plan,agents,disabled,onConfigureJev,jevSettingsRevision,onConfigureModel}:{api:DesktopAPI;plan:PreviewPlan;agents:AgentChatSourceInfo[];disabled:boolean;onConfigureJev?:()=>void;jevSettingsRevision?:number;onConfigureModel?:()=>void}) {
  const nativeDetails=useRef<HTMLDetailsElement>(null);
  const [materials,setMaterials]=useState<Awaited<ReturnType<DesktopAPI['nativeMaterials']>>>(),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{let current=true;setMaterials(undefined);setError('');void api.nativeMaterials(plan.id).then(value=>{if(current)setMaterials(value);}).catch(()=>{if(current)setError('无法读取已保存材料，请重试。');});return()=>{current=false;};},[api,plan.id,plan.version,retry]);
  const service=useMemo<NativeTaskExecutionService>(()=>({
    prepare:(input,selection)=>api.nativePrepare({input,selection}),list:task=>api.nativeList(task),
    requestApproval:(task,attemptID)=>api.nativeRequestApproval({task,attemptID}),
    decideStart:(task,approvalID,decision)=>api.nativeDecideStart({task,approvalID,decision}),
    start:(task,attemptID,approvalID)=>api.nativeStart({task,attemptID,approvalID}),
    refresh:(task,attemptID)=>api.nativeRefresh({task,attemptID}),stop:(task,attemptID)=>api.nativeStop({task,attemptID}),
    evidence:(task,attemptID)=>api.nativeEvidence({task,attemptID}),
    decideResult:(task,attemptID,input)=>api.nativeDecideResult({task,attemptID,...input}),
    readSelection:async(task,attemptID)=>{const selected=await api.nativeReadSelection({task,attemptID});if(selected.checks.some(c=>c.kind!=='utf8-contains'))throw new Error('此面板暂不支持原冻结规则的类型，可取消准备。');return selected as NativePanelSelection;},
  }),[api]);
  return <><TaskPlanningPanel api={api} plan={plan} disabled={disabled} showGoal={false} onConfigureModel={onConfigureModel} onOpenNative={()=>{const panel=nativeDetails.current;if(panel){panel.open=true;panel.scrollIntoView({block:'start',behavior:'auto'});panel.querySelector('summary')?.focus();}}}/><TaskKnowledge key={plan.id} api={api} plan={plan} disabled={disabled}/><TaskHandoffs api={api} plan={plan} disabled={disabled}/><TaskJevAdvice api={api} plan={plan} disabled={disabled} onConfigureJev={onConfigureJev} jevSettingsRevision={jevSettingsRevision}/><details ref={nativeDetails} className="task-content-section task-native-section"><summary>Agent 执行与验收</summary>{disabled&&<p className="quiet-text">保存当前任务后可准备、开始或接受成果；原尝试仍可核对和停止。</p>}{error&&<p className="task-save-error" role="alert">{error}<button className="text-button" onClick={()=>setRetry(v=>v+1)}>重新读取材料</button></p>}<NativeTaskExecutionPanel plan={plan} api={api} agents={agents} service={service} disabled={disabled||!materials} materials={materials}/></details></>;
}
