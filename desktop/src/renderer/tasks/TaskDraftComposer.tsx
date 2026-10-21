import React,{useRef,useState}from'react';
import type{ChatTaskAPI}from'../../shared/chat-task';
import type{TaskGoalDraftInput}from'../../shared/task-goal';
import type{PreviewPlan}from'../../shared/types';
import{Modal}from'../components';
import{TaskGoalFields}from'./TaskGoalFields';
import'../task-chat/chat-task-composer.css';
const pendingDrafts=new Map<string,TaskGoalDraftInput>();
export function TaskDraftComposer({api,projects=[],defaultProjectID='',onCreated,onClose}:{api:Pick<ChatTaskAPI,'createTaskDraft'>;projects?:readonly{id:string;name:string}[];defaultProjectID?:string;onCreated(plan:PreviewPlan):void;onClose():void}){
 const key=defaultProjectID||'independent',remembered=pendingDrafts.get(key);
 const[goal,setGoal]=useState(remembered?.goal??''),[title,setTitle]=useState(remembered?.title??''),[conditions,setConditions]=useState(remembered?.completionConditions?.join('\n')??''),[projectID,setProjectID]=useState(remembered?.projectID??defaultProjectID);
 const[frozen,setFrozen]=useState<TaskGoalDraftInput|undefined>(remembered),[busy,setBusy]=useState(false),[error,setError]=useState('');const gate=useRef(false);
 const completion=conditions.split('\n').map(v=>v.trim()).filter(Boolean),bytes=(text:string)=>new TextEncoder().encode(text).length;
 const valid=!!goal.trim()&&bytes(goal)<=16384&&bytes(title)<=600&&completion.length<=100&&completion.every(v=>bytes(v)<=4096);
 const close=()=>{if(!gate.current)onClose()};
 const save=async()=>{if(gate.current||!frozen&&!valid)return;gate.current=true;setBusy(true);setError('');
 const input=frozen??{requestID:crypto.randomUUID(),goal:goal.trim(),...(title.trim()?{title:title.trim()}:{}),...(completion.length?{completionConditions:completion}:{}),...(projectID?{projectID}: {})};setFrozen(input);pendingDrafts.set(key,input);
 try{const plan=await api.createTaskDraft(input);pendingDrafts.delete(key);onCreated(plan)}catch(reason){setError(reason instanceof Error?reason.message:reason&&typeof reason==='object'&&'message'in reason?String(reason.message):'保存失败，请重试同一任务。');if(reason&&typeof reason==='object'&&'safeToEdit'in reason&&reason.safeToEdit===true){setFrozen(undefined);pendingDrafts.delete(key)}}finally{gate.current=false;setBusy(false)}};
 return <Modal title="新建主任务" onClose={close} className="chat-task-composer"><div className="modal-body"><p>先保存主任务，步骤、分工和完成条件可以之后再补充。</p><TaskGoalFields goal={goal}onGoal={setGoal}title={title}onTitle={setTitle}conditions={conditions}onConditions={setConditions}projectID={projectID}onProject={setProjectID}projects={projects}disabled={busy||!!frozen}/><p className="chat-task-feedback"role={error?'alert':'status'}>{error||(frozen?'重试会返回同一任务。':'保存只建立草稿任务，不会生成计划或开始执行。')}</p><footer><button type="button"disabled={busy}onClick={close}>取消</button><button type="button"className="chat-task-save"disabled={busy||!frozen&&!valid}onClick={()=>void save()}>{busy?'正在保存…':frozen?'重试保存同一任务':'保存主任务'}</button></footer></div></Modal>
}
