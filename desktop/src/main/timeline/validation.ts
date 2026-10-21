import { payload, textInput, uuidInput } from '../ipc-validation.js';
import { StorageError } from '../../core/storage/private-storage.js';
import type { TimelineRef, TimelineQuery, TimelineSceneQuery } from '../../shared/timeline.js';
export function reference(input: unknown): TimelineRef {
  const v = payload(input,['source','id','projectID']); const id = textInput(v.id,100);
  if (!['model','agent','task-session','task','run','local-plan'].includes(String(v.source))) throw new StorageError('timeline-input','时间线来源无效。');
  if (['model','agent','task-session','local-plan'].includes(String(v.source))) uuidInput(id);
  else if (!(v.source === 'task' ? /^task-\d{3,}$/ : /^run-\d{8}-\d{3,}$/).test(id)) throw new StorageError('timeline-input','工作标识无效。');
  if (v.source === 'local-plan' && v.projectID !== undefined) throw new StorageError('timeline-input','本地任务不能伪造项目身份。');
  const projectID = v.projectID === undefined ? undefined : textInput(v.projectID,100);
  if ((projectID && !/^project-[0-9a-f-]{36}$/.test(projectID)) || ['task','run','task-session'].includes(String(v.source)) && !projectID) throw new StorageError('timeline-input','项目身份无效。');
  return { source:v.source as TimelineRef['source'],id,...(projectID ? {projectID} : {}) };
}
export function calendar(v: Record<string,unknown>) {
  const day = textInput(v.day,10),timeZone = textInput(v.timeZone,100);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day) throw new StorageError('timeline-input','日期无效。');
  try { new Intl.DateTimeFormat('en',{timeZone}).format(); } catch { throw new StorageError('timeline-input','时区无效。'); }
  if (v.allDates !== undefined && typeof v.allDates !== 'boolean') throw new StorageError('timeline-input','日期范围无效。');
  return { day,timeZone,allDates:v.allDates === true,...(v.query === undefined ? {} : {query:textInput(v.query,600).trim()}),...(v.snapshotID === undefined ? {} : {snapshotID:uuidInput(v.snapshotID)}),...(v.cursor === undefined ? {} : {cursor:textInput(v.cursor,400)}) };
}
export function queryInput(input:unknown):TimelineQuery {
  const v = payload(input,['day','timeZone','kind','projectID','query','allDates','snapshotID','cursor']);
  if (v.kind !== undefined && !['all','task','session'].includes(String(v.kind))) throw new StorageError('timeline-input','工作类型无效。');
  const projectID = v.projectID === undefined ? undefined : textInput(v.projectID,100);
  if (projectID && !/^project-[0-9a-f-]{36}$/.test(projectID)) throw new StorageError('timeline-input','项目身份无效。');
  return { ...calendar(v),kind:(v.kind as TimelineQuery['kind']) ?? 'all',...(projectID ? {projectID} : {}) };
}
export function sceneInput(input:unknown):TimelineSceneQuery {
  const v = payload(input,['day','timeZone','displayID','app','query','allDates','snapshotID','cursor']);
  if (v.displayID !== undefined && (!Number.isSafeInteger(v.displayID) || (v.displayID as number) <= 0)) throw new StorageError('timeline-input','显示器无效。');
  return { ...calendar(v),...(v.displayID === undefined ? {} : {displayID:v.displayID as number}),...(v.app === undefined ? {} : {app:textInput(v.app,200)}) };
}
