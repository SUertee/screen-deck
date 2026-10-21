import React from 'react';
import { taskTitleFromGoal } from '../../shared/task-goal';
export interface TaskGoalFieldsProps {
  goal:string; onGoal(value:string):void; title:string; onTitle(value:string):void;
  conditions:string; onConditions(value:string):void; projectID:string; onProject(value:string):void;
  projects:readonly {id:string;name:string}[]; disabled:boolean; children?:React.ReactNode;
}
/** One required goal; optional metadata shares the same disclosure in every creation entry. */
export function TaskGoalFields(props:TaskGoalFieldsProps) {
  return <fieldset className="task-goal-fields" disabled={props.disabled}><legend className="visually-hidden">主任务</legend>
    <label className="task-goal-primary">想完成什么？<textarea data-autofocus aria-label="想完成什么？" rows={4} value={props.goal} maxLength={4000} placeholder="写下一个主任务，例如：把这份方案整理成可演示的版本" onChange={event=>props.onGoal(event.target.value)}/></label>
    <p className="task-goal-title-preview">任务名称：{props.title.trim()||taskTitleFromGoal(props.goal)||'填写目标后生成'}</p>
    <details className="task-goal-optional"><summary>补充信息（可选）</summary><div>
      <label>任务短标题<input aria-label="任务短标题" value={props.title} maxLength={150} placeholder="默认取目标第一行，可稍后修改" onChange={event=>props.onTitle(event.target.value)}/></label>
      <label>所属项目<select aria-label="主任务所属项目" value={props.projectID} onChange={event=>props.onProject(event.target.value)}><option value="">独立任务</option>{props.projectID&&!props.projects.some(p=>p.id===props.projectID)&&<option value={props.projectID}>原项目 · 尚未读取</option>}{props.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>完成条件（每行一项）<textarea aria-label="主任务完成条件" rows={2} value={props.conditions} maxLength={16000} placeholder="可以先不填，之后再补充" onChange={event=>props.onConditions(event.target.value)}/></label>
      {props.children}
    </div></details>
  </fieldset>;
}
