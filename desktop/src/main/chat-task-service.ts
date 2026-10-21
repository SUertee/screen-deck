import { taskTitleFromGoal, type TaskGoalDraftInput } from '../shared/task-goal';
import { randomUUID } from 'node:crypto';
import type { SessionManager } from '../core/sessions/session-manager';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator';
import { canonicalDigest } from '../core/storage/execution-records';
import { StorageError } from '../core/storage/private-storage';
import { payload, textInput, uuidInput } from './ipc-validation';
import type { ChatTaskReference, ChatTaskSource, CreateChatTaskInput } from '../shared/chat-task';
import type { PreviewPlan } from '../shared/types';

function reference(value: unknown, digest = false): ChatTaskReference {
  const v = payload(value, ['source', 'sessionID', 'messageID', ...(digest ? ['digest'] : [])]);
  if (!['model', 'agent'].includes(String(v.source))) throw new StorageError('chat-task-source', '聊天来源无效。');
  uuidInput(v.sessionID); uuidInput(v.messageID);
  if (digest && (typeof v.digest !== 'string' || !/^[a-f0-9]{64}$/.test(v.digest))) throw new StorageError('chat-task-source', '消息来源指纹无效。');
  return { source: v.source as ChatTaskReference['source'], sessionID: v.sessionID as string, messageID: v.messageID as string };
}
function fields(value: unknown, chat: boolean): TaskGoalDraftInput & Partial<CreateChatTaskInput> {
  const allowed = ['requestID','title','goal','completionConditions','projectID', ...(chat ? ['source','excerpt'] : [])];
  const v = payload(value,allowed); uuidInput(v.requestID); textInput(v.goal,16384);
  if (!(v.goal as string).trim()) throw new StorageError('chat-task-input','请写下想完成什么。');
  if (v.title !== undefined) textInput(v.title,600);
  if (v.completionConditions !== undefined && (!Array.isArray(v.completionConditions) || v.completionConditions.length>100)) throw new StorageError('chat-task-input','完成条件无效。');
  for (const c of (v.completionConditions ?? []) as unknown[]) if (!textInput(c,4096).trim()) throw new StorageError('chat-task-input','完成条件不能包含空项。');
  if (v.projectID !== undefined && (typeof v.projectID!=='string' || !/^project-[a-f0-9-]{36}$/.test(v.projectID))) throw new StorageError('chat-task-input','项目归属无效。');
  if (chat) { reference(v.source,true); if (v.excerpt !== undefined && !textInput(v.excerpt,32768).trim()) throw new StorageError('chat-task-input','请填写明确的原文摘录，或取消带入。'); }
  return structuredClone(v) as unknown as TaskGoalDraftInput & Partial<CreateChatTaskInput>;
}
function taskFields(input: TaskGoalDraftInput) {
  return { title: input.title?.trim() || taskTitleFromGoal(input.goal), goal: input.goal.trim(), completion_conditions: (input.completionConditions ?? []).map(value=>value.trim()), ...(input.projectID ? {project_id:input.projectID}: {}) };
}
/** Local saved-message reads only. No source mutation, capture, model call or execution. */
export class ChatTaskService {
  constructor(private manager: Pick<SessionManager, 'isSessionBusy'|'isAgentSessionBusy'|'loadSession'|'loadAgentSession'>,
    private tasks: Pick<TaskOrchestrator,'loadPlan'|'createTaskFromChat'|'createTaskDraft'>, private publish: (plan: PreviewPlan) => void) {}
  async source(value: unknown): Promise<ChatTaskSource> {
    const ref = reference(value), busy = () => ref.source === 'agent' ? this.manager.isAgentSessionBusy(ref.sessionID) : this.manager.isSessionBusy(ref.sessionID);
    if (busy()) throw new StorageError('chat-task-busy','聊天正在处理或有未保存事实，请结束并保存后重试。');
    const session = ref.source === 'agent' ? await this.manager.loadAgentSession(ref.sessionID) : await this.manager.loadSession(ref.sessionID);
    if (busy() || !session || session.conversation_id !== ref.sessionID) throw new StorageError('chat-task-source','原聊天不可读取。');
    const message = session.messages.find(m => m.message_id === ref.messageID), turn = message && session.turns.find(t => t.turn_id === message.turn_id);
    if (!message || !turn || turn.state !== 'finished' || !['user','assistant'].includes(message.role) || !message.text.trim()) throw new StorageError('chat-task-message','请选择已完成并保存的用户消息或回复。');
    const identity = { ...ref, turnID: message.turn_id, role: message.role, text: message.text };
    return { ...identity, role: message.role as 'user'|'assistant', sessionTitle: session.title, digest: canonicalDigest(identity) };
  }
  async draft(value: unknown): Promise<PreviewPlan> {
    const input = fields(value,false), requestDigest=canonicalDigest(input), content=taskFields(input);
    const previous=await this.tasks.loadPlan(input.requestID);
    if(previous) { if(previous.task?.creation_receipt?.requestDigest!==requestDigest) throw new StorageError('chat-task-replay','相同创建标识不能用于不同内容。'); this.publish(previous); return previous; }
    const {title,...task}=content;
    const plan=await this.tasks.createTaskDraft({id:input.requestID,title,task:{...task,materials:[],chat_refs:[],creation_receipt:{requestID:input.requestID,requestDigest}}});
    this.publish(plan); return plan;
  }
  async create(value: unknown): Promise<PreviewPlan> {
    const input = fields(value,true) as CreateChatTaskInput, requestDigest = canonicalDigest(input);
    const previous = await this.tasks.loadPlan(input.requestID);
    if (previous) {
      if (previous.task?.chat_origin?.requestID !== input.requestID || previous.task.chat_origin.requestDigest !== requestDigest) throw new StorageError('chat-task-replay','相同创建标识不能用于不同内容。');
      this.publish(previous); return previous;
    }
    const saved = await this.source(reference(input.source,true));
    if (saved.digest !== input.source.digest) throw new StorageError('chat-task-changed','原消息内容已变化，请重新读取后确认。');
    if (input.excerpt !== undefined && !saved.text.includes(input.excerpt)) throw new StorageError('chat-task-excerpt','摘录必须是原消息中的连续原文片段。');
    const {title,...content}=taskFields(input);
    const plan = await this.tasks.createTaskFromChat({ id: input.requestID, title, task: {
      ...content, creation_receipt:{requestID:input.requestID,requestDigest},
      chat_refs: [{ source: saved.source, sessionID: saved.sessionID }],
      chat_origin: { requestID: input.requestID, requestDigest, source: saved.source, sessionID: saved.sessionID, messageID: saved.messageID, turnID: saved.turnID, messageDigest: saved.digest },
      materials: input.excerpt === undefined ? [] : [{ id: randomUUID(), title: '聊天原文摘录', summary: input.excerpt, source: { kind: 'note', reference: `chat-message:${saved.source}:${saved.sessionID}:${saved.messageID}`, label: `${saved.role === 'user' ? '用户消息' : '回复'} · ${saved.sessionTitle}`.slice(0,180) } }],
    } });
    this.publish(plan); return plan;
  }
}
