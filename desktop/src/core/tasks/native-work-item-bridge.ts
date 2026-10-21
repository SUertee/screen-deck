import type { NativeWorkItemDispatchGuard } from './native-work-item-dispatch-guard.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { SessionManager } from '../sessions/session-manager.js';
import type { AgentExecutionController } from '../agents/agent-execution-controller.js';
import type { AgentChatDriverResolver } from '../sessions/agent-chat-driver.js';
import type { PreviewPlan } from '../../shared/types.js';
import { StorageError } from '../storage/private-storage.js';
import { boundedString, canonicalDigest, exactObject } from '../storage/execution-records.js';
import { isUUID } from '../sessions/session-schema.js';
import { isStoredPermissionMode } from '../../shared/agent-permissions.js';
import type { NativeTaskRef, NativeTaskTransaction, NativeWorkItemAttempt, NativeWorkItemInput, NativeWorkItemOwner } from './native-work-item-contract.js';

export interface NativeWorkItemServices {
  handoffContext?(plan: PreviewPlan): Promise<string>;
  dispatch: NativeWorkItemDispatchGuard;
  sessions: Pick<SessionManager, 'createAgentSession' | 'loadAgentSession' | 'sendAgentMessage' | 'stopAgentGeneration' | 'isAgentSessionBusy'>;
  execution: Pick<AgentExecutionController, 'configure' | 'context' | 'read'>;
  drivers: Pick<AgentChatDriverResolver, 'getSource'>;
}
export const sameNative = (a: unknown, b: unknown): boolean => canonicalDigest(a) === canonicalDigest(b);
const fail = (message: string): never => { throw new StorageError('native-work-item-invalid', message); };
export function validateNativeInput(input: NativeWorkItemInput): void {
  exactObject(input, ['task', 'planVersion', 'workItemID', 'clientRequestID', 'agentID', 'context', 'materials', 'text']);
  const task = exactObject(input.task, input.task?.kind === 'local' ? ['kind', 'planID'] : ['kind', 'planID', 'projectID', 'taskID']);
  if (!['local', 'project'].includes(String(task.kind)) || !isUUID(task.planID) || task.kind === 'project' && (!boundedString(task.projectID, 200) || !boundedString(task.taskID, 200))) fail('任务引用无效。');
  if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 1 || !isUUID(input.workItemID) || !isUUID(input.clientRequestID) || !boundedString(input.agentID, 200) || !boundedString(input.text, 128 * 1024) || input.text.trimStart().startsWith('/')) fail('工作项输入无效。');
  exactObject(input.context, ['workspace', 'mode']); exactObject(input.context.workspace, ['id', 'path', 'label']);
  if (!isUUID(input.context.workspace.id) || !boundedString(input.context.workspace.path, 4096) || !isAbsolute(input.context.workspace.path) || !boundedString(input.context.workspace.label, 1024) || !isStoredPermissionMode(input.context.mode)) fail('工作目录或权限无效。');
  if (!Array.isArray(input.materials) || input.materials.length > 32) fail('材料选择无效。');
  for (const m of input.materials) {
    exactObject(m, ['reference', 'digest', 'summary']);
    if (!boundedString(m.reference, 4096) || !/^[a-f0-9]{64}$/.test(m.digest) || !boundedString(m.summary, 8192)) fail('材料来源或摘要无效。');
  }
  if (new Set(input.materials.map(m => m.reference)).size !== input.materials.length) fail('材料引用重复。');
  canonicalDigest(input);
}
export async function nativeAttempt(tx: NativeTaskTransaction, id: string): Promise<NativeWorkItemAttempt> {
  if (!isUUID(id)) fail('尝试标识无效。');
  const attempt = (await tx.attempts()).find(a => a.id === id);
  if (!attempt) fail('原工作项尝试不存在。');
  validateNativeInput(attempt!.input);
  if (!sameNative(attempt!.inputDigest, canonicalDigest({ input: attempt!.input, source: attempt!.source, planDigest: attempt!.planDigest, prompt: attempt!.prompt }))) fail('冻结输入指纹不匹配。');
  return structuredClone(attempt!);
}
function assertPlan(plan: PreviewPlan | undefined, input: NativeWorkItemInput): PreviewPlan {
  if (!plan || plan.id !== input.task.planID || plan.version !== input.planVersion) fail('计划版本已变化。');
  if (input.task.kind === 'local' ? !!plan!.scope : plan!.scope?.project_id !== input.task.projectID || plan!.scope?.task_id !== input.task.taskID) fail('任务来源不匹配。');
  const item = plan!.work_items.find(w => w.id === input.workItemID);
  if (!item || item.status === 'completed' || item.assignee !== 'agent' || item.agentID !== input.agentID) fail('工作项未分配给所选 Agent 或已完成。');
  return plan!;
}
/** Only delegates native execution. Never implements filesystem or command tools. */
export class NativeWorkItemBridge {
  constructor(private owner: NativeWorkItemOwner, private services: NativeWorkItemServices) {}
  async prepare(input: NativeWorkItemInput): Promise<NativeWorkItemAttempt> {
    validateNativeInput(input); const frozen = structuredClone(input);
    return this.owner.withTask(frozen.task, async tx => {
      const attempts = await tx.attempts();
      const existing = attempts.find(a => a.input.clientRequestID === frozen.clientRequestID);
      if (existing) {
        if (!sameNative(existing.input, frozen)) fail('同一请求不能更改输入。');
        return nativeAttempt(tx, existing.id); // Unknown/crash states never create or send again.
      }
      if (attempts.some(a => ['preparing', 'prepared', 'dispatching', 'unknown'].includes(a.status))) fail('任务有未解决的原生尝试。');
      const plan = assertPlan(await tx.loadPlan(), frozen);
      await this.owner.assertDependencies(tx, plan, frozen.workItemID);
      const source = this.ready(frozen.agentID);
      const item = plan.work_items.find(w => w.id === frozen.workItemID)!;
      if (item.model && !sameNative(item.model, source.model)) fail('计划模型与原生连接不匹配。');
      const detail = plan as unknown as { schema_version: number; task?: { goal: string; completion_conditions: string[] } };
      const taskContext = detail.schema_version === 3 && detail.task ? `任务目标：${detail.task.goal}\n任务完成条件：\n${detail.task.completion_conditions.join('\n')}\n` : '';
      const handoff = await this.services.handoffContext?.(plan) ?? '';
      const prompt = `${taskContext}${handoff}任务：${plan.title}\n工作项：${item.title}\n完成条件：${item.expected_result}\n用户输入：\n${frozen.text}\n选择的材料：\n${frozen.materials.map(m => `${m.reference} [sha256:${m.digest}]\n${m.summary}`).join('\n')}`;
      if (Buffer.byteLength(prompt) > 256 * 1024) fail('冻结输入超过容量上限。');
      const planDigest = canonicalDigest(plan);
      const attempt: NativeWorkItemAttempt = { id: randomUUID(), input: frozen, planDigest, prompt, inputDigest: canonicalDigest({ input: frozen, source, planDigest, prompt }), source: structuredClone(source), status: 'preparing' };
      // Durable intent before any session allocation; an interrupted preparation is never replayed.
      await tx.saveAttempt(attempt);
      const endPreparation = this.services.dispatch.beginPreparation();
      try {
        const session = await this.services.sessions.createAgentSession({ title: item.title, agentID: frozen.agentID });
        attempt.sessionID = session.conversation_id;
        await tx.saveAttempt(attempt);
        if (!sameNative(session.source, { agentID: source.agentID, configDigest: source.configDigest })) fail('Agent 来源已变化。');
        await this.services.execution.configure(session.conversation_id, session.source, { workspaceID: frozen.context.workspace.id, mode: frozen.context.mode });
        if (!sameNative(await this.services.execution.context(session.conversation_id), frozen.context)) fail('工作目录已变化。');
        attempt.status = 'prepared'; await tx.saveAttempt(attempt);
      } catch (error) { attempt.status = 'failed'; await tx.saveAttempt(attempt); throw error; }
      finally { endPreparation(); }
      return structuredClone(attempt);
    });
  }
  async start(task: NativeTaskRef, attemptID: string, approvalID: string, onDispatch?: (attempt: NativeWorkItemAttempt) => void): Promise<NativeWorkItemAttempt> {
    let shouldSend = false;
    const attempt = await this.owner.withTask(task, async tx => {
      const a = await nativeAttempt(tx, attemptID);
      if (!sameNative(a.input.task, task)) fail('尝试来源不匹配。');
      if (a.status !== 'prepared') return a;
      const plan = assertPlan(await tx.loadPlan(), a.input);
      if (canonicalDigest(plan) !== a.planDigest) fail('冻结计划已变化。');
      await this.owner.assertDependencies(tx, plan, a.input.workItemID);
      if (!sameNative(this.ready(a.input.agentID), a.source)) fail('Agent 连接或模型已变化。');
      const session = a.sessionID && await this.services.sessions.loadAgentSession(a.sessionID);
      if (!session || session.turns.length || session.binding || !sameNative(session.source, { agentID: a.source.agentID, configDigest: a.source.configDigest }) || !sameNative(await this.services.execution.context(a.sessionID!), a.input.context)) fail('原生会话或执行范围已变化。');
      await this.owner.authorizeStart(structuredClone(a), approvalID);
      a.status = 'dispatching'; await tx.saveAttempt(a); shouldSend = true;
      return a;
    });
    // Only the caller that durably reserved this dispatch may send.
    if (!shouldSend) return attempt;
    this.services.dispatch.arm(attempt);
    onDispatch?.(structuredClone(attempt));
    try { await this.services.sessions.sendAgentMessage({ sessionID: attempt.sessionID!, text: attempt.prompt }); }
    catch { /* Recover facts from SessionManager; an error alone cannot prove no submission. */ }
    finally { this.services.dispatch.revoke(attempt.sessionID!); }
    return this.refresh(task, attemptID);
  }
  async refresh(task: NativeTaskRef, attemptID: string): Promise<NativeWorkItemAttempt> {
    return this.owner.withTask(task, async tx => {
      const a = await nativeAttempt(tx, attemptID);
      if (!sameNative(a.input.task, task)) fail('尝试来源不匹配。');
      if (a.status === 'preparing') { a.status = 'unknown'; await tx.saveAttempt(a); return a; }
      if (!['dispatching', 'unknown'].includes(a.status)) return a;
      const session = a.sessionID && await this.services.sessions.loadAgentSession(a.sessionID);
      const turn = session && session.turns.length === 1 ? session.turns[0] : undefined;
      if (!turn || !session || a.turnID && a.turnID !== turn.turn_id || !sameNative(session.source, { agentID: a.source.agentID, configDigest: a.source.configDigest }) || session.messages.filter(m => m.role === 'user').length !== 1 || session.messages.find(m => m.role === 'user')?.text !== a.prompt) a.status = 'unknown';
      else {
        a.turnID = turn.turn_id; a.clientRequestID = turn.client_request_id;
        a.status = ['finished', 'failed', 'cancelled'].includes(turn.state) ? turn.state as 'finished' | 'failed' | 'cancelled' : this.services.sessions.isAgentSessionBusy(a.sessionID!) ? 'dispatching' : 'unknown';
      }
      await tx.saveAttempt(a); return structuredClone(a);
    });
  }
  async stop(task: NativeTaskRef, attemptID: string): Promise<void> {
    const a = await this.owner.withTask(task, tx => nativeAttempt(tx, attemptID));
    if (!sameNative(a.input.task, task)) fail('尝试来源不匹配。');
    if (a.status === 'prepared') {
      await this.owner.withTask(task, async tx => { const current = await nativeAttempt(tx, attemptID); if (current.status !== 'prepared') fail('尝试已开始，请重新读取后停止。'); current.status = 'cancelled'; await tx.saveAttempt(current); });
      return;
    }
    if (a.status !== 'dispatching' || !a.sessionID) fail('此尝试没有可取消的活动轮次。');
    await this.services.sessions.stopAgentGeneration(a.sessionID!);
    await this.refresh(task, attemptID);
  }
  private ready(agentID: string) {
    const source = this.services.drivers.getSource(agentID);
    if (!source || source.agentID !== agentID || !source.capabilities.tools || !source.capabilities.approvals) fail('原生工具 Agent 尚未就绪。');
    return structuredClone(source!);
  }
}
