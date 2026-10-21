import { taskResultDigest } from '../sessions/task-session-schema.js';
import { createHash } from 'node:crypto';
import type { SessionRecord, PreviewPlan } from '../../shared/types.js';
import type { AgentSessionRecord } from '../../shared/agent-chat.js';
import type { TaskSessionRecord, AcceptanceRecord } from '../../shared/task-execution.js';
import type { ProjectWorkspaceResult } from '../../projects/types.js';
import { timelineRefKey, type TimelineEvent, type TimelineRef, type TimelineSource } from '../../shared/timeline.js';
export interface TimelineSources { plans?: PreviewPlan[]; sessions: SessionRecord[]; agents: AgentSessionRecord[]; taskSessions: TaskSessionRecord[]; projects: ProjectWorkspaceResult[]; acceptances: AcceptanceRecord[]; archived?: string[] }
const millis = (s: string | null) => s ? Date.parse(s) : NaN;
const validTime = (s: string | null | undefined): s is string => !!s && Number.isFinite(Date.parse(s));
export const dayAt = (time: string | number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
};
export function dayBounds(day: string, timeZone: string): [number, number] {
  // Lower-bound the actual local calendar date: supports 23/25-hour days without fixed UTC offsets.
  const nominal = Date.parse(day + 'T00:00:00Z');
  const boundary = (target: string) => { let lo = nominal - 2 * 86400000, hi = nominal + 3 * 86400000; while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dayAt(mid, timeZone) < target) lo = mid + 1; else hi = mid; } return lo; };
  const next = new Date(nominal + 86400000).toISOString().slice(0,10);
  const start = boundary(day), end = boundary(next);
  if (dayAt(start, timeZone) !== day) throw new Error('Invalid local date');
  return [start,end];
}
export function overlaps(event: TimelineEvent, start: number, end: number) {
  if (!event.startedAt) return false;
  const a = millis(event.startedAt), b = Math.max(a, millis(event.endedAt) || a);
  return a < end && b >= start;
}
const clip = (s: string, limit = 240) => s.length > limit ? s.slice(0, limit) + '…' : s;
export function matchSnippet(text: string, query = '') { const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()); const start = Math.max(0,at - 60); return (start ? '…' : '') + clip(text.slice(start)); }
export function timelineFingerprint(events: TimelineEvent[]) { return createHash('sha256').update(JSON.stringify(events)).digest('hex'); }

export function projectTimeline(sources: TimelineSources, timeZone: string, query = ''): TimelineEvent[] {
  const result: TimelineEvent[] = []; const needle = query.trim().toLocaleLowerCase();
  const projects = new Map(sources.projects.filter(p => p.project).map(p => [p.project!.project_id,p]));
  const scopeInfo = (projectID?: string, taskID?: string) => ({ ...(projectID ? { projectID, projectName: projects.get(projectID)?.project?.name ?? '项目来源不可用' } : {}), ...(taskID ? { taskID } : {}) });
  for (const [source, records] of [['model',sources.sessions],['agent',sources.agents],['task-session',sources.taskSessions]] as const) for (const record of records) {
    const scope = record.scope.kind === 'project' ? record.scope : undefined;
    const ref: TimelineRef = { source, id: record.conversation_id, ...(scope ? { projectID: scope.project_id } : {}) };
    const task = scope?.task_id ? projects.get(scope.project_id)?.tasks.find(t => t.task_id === scope.task_id) : undefined;
    const taskRecord = source === 'task-session';
    const archived = sources.archived?.includes(`${source === 'model' ? 'model' : 'agent'}:${record.conversation_id}`) ? ' · 已归档' : '';
    const sourceLabel = (source === 'agent' ? `Session · ${(record as AgentSessionRecord).source.agentID}` : source === 'model' ? 'Session · 模型聊天' : '任务执行会话') + archived;
    let group: TimelineEvent | undefined;
    const matches = new Set<string>();
    for (const turn of [...record.turns].sort((a,b) => millis(a.created_at)-millis(b.created_at) || a.turn_id.localeCompare(b.turn_id))) {
      if (!validTime(turn.created_at)) continue;
      const messages = record.messages.filter(m => m.turn_id === turn.turn_id);
      const hit = needle ? messages.find(m => m.text.toLocaleLowerCase().includes(needle)) : undefined;
      const message = hit ?? messages.find(m => m.role === 'user') ?? messages[0];
      const times = [turn.created_at,...messages.flatMap(m => [m.created_at,m.updated_at])].filter(validTime).sort((a,b) => millis(a)-millis(b));
      const observedEnd = times.at(-1)!;
      const sameDay = group?.startedAt && dayAt(group.startedAt,timeZone) === dayAt(turn.created_at,timeZone);
      if (!group || taskRecord || !sameDay || millis(turn.created_at) - millis(group.endedAt) > 15*60000) {
        group = { id: `${timelineRefKey(ref)}:${turn.turn_id}`, ref, kind: taskRecord ? 'task' : 'session', title: taskRecord && task ? task.title : record.title,
          sourceLabel: taskRecord && (turn as TaskSessionRecord['turns'][number]).execution.spec.driver.mode === 'simulation' ? '历史模拟会话（只读）' : sourceLabel, startedAt: turn.created_at, endedAt: observedEnd, recordedAt: record.updated_at,
          ...scopeInfo(scope?.project_id, scope?.task_id), status: turn.state, snippet: message ? matchSnippet(message.text,query) : '', messageID: message?.message_id,
          items: [], itemCount: 0, related: scope?.task_id ? [{ ref: { source: 'task', projectID: scope.project_id, id: scope.task_id }, label: task?.title ?? scope.task_id }] : [] };
        result.push(group);
      }
      group.endedAt = millis(observedEnd) > millis(group.endedAt) ? observedEnd : group.endedAt;
      group.status = turn.state;
      group.itemCount++;
      if (group.items.length < 200) group.items.push({ id: turn.turn_id,time: turn.created_at,updatedAt: turn.updated_at,state: turn.state,snippet: clip(message?.text ?? ''),messageID: message?.message_id });
      if (hit) { matches.add(group.id); group.messageID = hit.message_id; group.snippet = matchSnippet(hit.text,query); }
      if (taskRecord) {
        const acceptance = sources.acceptances.filter(a => a.turn.session.sessionID === record.conversation_id && a.turn.turnID === turn.turn_id && (() => { try { return a.resultDigest === taskResultDigest(turn as TaskSessionRecord['turns'][number],record as TaskSessionRecord); } catch { return false; } })()).sort((a,b) => b.decided_at.localeCompare(a.decided_at))[0];
        if (turn.state === 'finished') group.status = acceptance?.decision === 'accepted' ? 'accepted' : acceptance?.decision === 'rejected' ? 'review-rejected' : 'awaiting_review';
        if (acceptance) {
          const item = { id: acceptance.id,time: acceptance.decided_at,updatedAt: acceptance.decided_at,state: acceptance.decision,snippet: acceptance.comment ?? '人工验收记录' };
          group.items.push(item);
          const review: TimelineEvent = { ...group,id:`${timelineRefKey(ref)}:review:${acceptance.id}`,title:`${group.title} · 成果验收`,sourceLabel:'人工成果验收',startedAt:acceptance.decided_at,endedAt:null,recordedAt:acceptance.decided_at,status:acceptance.decision === 'accepted' ? 'accepted' : 'review-rejected',snippet:matchSnippet(item.snippet,query),items:[item],itemCount:1 };
          result.push(review);
          if (!needle || `${review.title}\n${item.snippet}`.toLocaleLowerCase().includes(needle)) matches.add(review.id);
        }
      }
    }
    if (needle) for (let i=result.length-1;i>=0;i--) if (timelineRefKey(result[i].ref) === timelineRefKey(ref) && !matches.has(result[i].id) && !`${result[i].title}\n${result[i].taskID ?? ''}`.toLocaleLowerCase().includes(needle)) result.splice(i,1);
  }
  for (const workspace of sources.projects) {
    const project = workspace.project; if (!project) continue;
    for (const task of workspace.tasks) {
      const ref: TimelineRef = { source:'task', id:task.task_id, projectID:project.project_id };
      if (!needle || `${task.title}\n${task.goal}\n${task.task_id}`.toLocaleLowerCase().includes(needle)) result.push({ id:timelineRefKey(ref),ref,kind:'task',title:task.title,sourceLabel:'任务创建 · 当前状态快照',startedAt:validTime(task.created_at)?task.created_at:null,endedAt:null,recordedAt:task.updated_at,...scopeInfo(project.project_id,task.task_id),status:task.status,snippet:matchSnippet(task.goal,query),items:[],itemCount:0,related:[] });
    }
    for (const run of workspace.runs) {
      const ref: TimelineRef = { source:'run', id:run.run_id, projectID:project.project_id };
      const title = workspace.tasks.find(t => t.task_id === run.task_id)?.title ?? run.task_id;
      if (needle && !`${title}\n${run.summary}\n${run.run_id}`.toLocaleLowerCase().includes(needle)) continue;
      // No exact cross-format attempt mapping exists; do not deduplicate by title or timestamp.
      result.push({ id:timelineRefKey(ref),ref,kind:'task',title,sourceLabel:`历史执行 · ${run.executor.agent}`,startedAt:validTime(run.started_at)?run.started_at:null,endedAt:validTime(run.ended_at)?run.ended_at:null,recordedAt:run.recorded_at,...scopeInfo(project.project_id,run.task_id),status:run.status,snippet:matchSnippet(run.summary,query),items:[],itemCount:0,related:[{ref:{source:'task',id:run.task_id,projectID:project.project_id},label:title}] });
    }
  }
  for (const plan of sources.plans ?? []) {
    if (plan.scope) continue; // Project records keep their original source identity.
    const ref: TimelineRef = { source: 'local-plan', id: plan.id };
    const text = [plan.title, plan.task?.goal ?? '', ...(plan.task?.completion_conditions ?? []), ...(plan.task?.materials ?? []).map(m => m.title + '\n' + m.summary)].join('\n');
    if (needle && !text.toLocaleLowerCase().includes(needle)) continue;
    const done = plan.work_items.filter(w => w.status === 'completed').length;
    result.push({ id: `${timelineRefKey(ref)}:created`, ref, kind: 'task', title: plan.title, sourceLabel: '本地任务 · 当前状态快照',
      startedAt: validTime(plan.created_at) ? plan.created_at : null, endedAt: null, recordedAt: plan.updated_at,
      status: plan.work_items.length > 0 && done === plan.work_items.length ? 'manual-completed' : 'planned', snippet: matchSnippet(text, query),
      items: [], itemCount: 0, related: (plan.task?.chat_refs ?? []).map(chat => ({ ref: { source: chat.source, id: chat.sessionID }, label: '关联讨论' })) });
  }
  return result.sort((a,b) => (Number.isFinite(millis(b.startedAt))?millis(b.startedAt):-Infinity)-(Number.isFinite(millis(a.startedAt))?millis(a.startedAt):-Infinity) || a.id.localeCompare(b.id));
}
