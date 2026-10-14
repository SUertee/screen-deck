import { randomUUID } from 'node:crypto';
import type { TaskExecutionRequest, TaskEventEnvelope, ExecutionLookup, ExternalObservation, ToolAction, ExternalExecutionBinding } from '../shared/task-execution.js';
import { ExecutionError } from './execution-driver.js';
import type { TaskExecutionDriver } from './task-execution-driver.js';
import { taskDigest } from './task-session-schema.js';

interface Attempt {
  binding: ExternalExecutionBinding;
  status: 'running' | 'awaiting_permission' | 'finished' | 'failed' | 'cancelled';
  output: string;
  pending?: { externalRequestID: string; action: ToolAction };
  receipts: Array<{ externalRequestID: string; actionDigest: string; choice: 'allowOnce' | 'deny'; status: 'accepted' | 'rejected' }>;
  release?: (choice: 'allowOnce' | 'deny' | 'cancel') => void;
  scenario: string;
}
/** In-memory simulation only: no filesystem writes, child processes, tools, or network. */
export class FakeTaskExecutionDriver implements TaskExecutionDriver {
  readonly capabilities = Object.freeze({ chat: false, tools: true, remoteSessions: true, remoteAbort: true });
  readonly taskCapabilities = Object.freeze({ reconcile: true, confirmedCancel: true, permissionReply: true, enforcedToolScope: true });
  readonly counts = { created: 0, submitted: 0, permissions: 0 };
  private readonly runtimeID = randomUUID();
  private readonly attempts = new Map<string, Attempt>();
  constructor(private readonly options: { stepDelayMs?: number } = {}) {}
  async executeTask(request: TaskExecutionRequest, onEvent: (event: TaskEventEnvelope) => Promise<void>, signal: AbortSignal): Promise<void> {
    if (request.spec.driver.mode !== 'simulation' || !['simulation-success', 'simulation-failure', 'simulation-unknown'].includes(request.spec.driver.driverID)) throw new ExecutionError('configuration', '只允许登记的模拟执行器。', false);
    if (this.attempts.has(request.clientRequestID)) throw new ExecutionError('protocol', '模拟器拒绝重复提交。', true);
    const attempt: Attempt = { binding: { runtimeID: this.runtimeID, connectionGeneration: this.runtimeID, externalSessionID: randomUUID() }, status: 'running', output: '', receipts: [], scenario: request.spec.driver.driverID };
    this.attempts.set(request.clientRequestID, attempt); this.counts.created += 1;
    let sequence = 0;
    const emit = async (event: TaskEventEnvelope['event']) => { if (signal.aborted) throw new ExecutionError('cancelled', '已停止本地模拟接收。', true); const number = ++sequence; await onEvent({ eventID: `${request.turn.turnID}:${number}`, sequence: number, event }); };
    const pause = async () => { await new Promise<void>(resolve => setTimeout(resolve, this.options.stepDelayMs ?? 200)); if (signal.aborted) throw new ExecutionError('cancelled', '已停止本地模拟接收。', true); };
    await emit({ type: 'bound', binding: structuredClone(attempt.binding) }); await pause();
    attempt.binding.externalSubmissionID = randomUUID(); this.counts.submitted += 1;
    await emit({ type: 'submitted', externalSubmissionID: attempt.binding.externalSubmissionID }); await pause();
    attempt.output = '模拟执行：未调用模型、未修改文件、未执行命令。';
    await emit({ type: 'text-delta', text: attempt.output });
    if (request.spec.tools.kind === 'restricted') {
      const pending = { externalRequestID: randomUUID(), action: { kind: 'file-write', path: 'simulation/result.txt', content: '这是模拟结果；文件不会被实际写入。' } as ToolAction };
      attempt.pending = pending; attempt.status = 'awaiting_permission';
      const decision = new Promise<'allowOnce' | 'deny' | 'cancel'>(resolve => { attempt.release = resolve; });
      await emit({ type: 'permission-request', ...pending });
      const choice = await Promise.race([decision, new Promise<never>((_, reject) => { if (signal.aborted) reject(new ExecutionError('cancelled', '停止本地模拟接收。', true)); else signal.addEventListener('abort', () => reject(new ExecutionError('cancelled', '停止本地模拟接收。', true)), { once: true }); })]);
      if (choice === 'deny' || choice === 'cancel') { attempt.status = 'cancelled'; delete attempt.pending; await emit({ type: 'settled', outcome: 'cancelled', reason: '模拟许可被拒绝或模拟执行已取消。' }); return; }
    }
    await pause();
    if (attempt.scenario === 'simulation-unknown') throw new ExecutionError('network', '模拟结果未知；不会重发。', true);
    if (attempt.scenario === 'simulation-failure') { attempt.status = 'failed'; await emit({ type: 'settled', outcome: 'failed', reason: '模拟的明确失败。' }); return; }
    attempt.status = 'finished';
    await emit({ type: 'settled', outcome: 'finished', result: { summary: '模拟执行已完成，未产生真实工作区变更。', artifacts: [], evidence: [] } });
  }
  async inspectExecution(lookup: ExecutionLookup): Promise<ExternalObservation> {
    const attempt = this.find(lookup);
    if (!attempt || attempt.scenario === 'simulation-unknown') return { status: 'unverifiable', reason: '该模拟实例无法确认原执行。' };
    const base = { binding: structuredClone(attempt.binding), output: attempt.output, permissionReceipts: structuredClone(attempt.receipts) };
    if (attempt.status === 'awaiting_permission' && attempt.pending) return { ...base, status: 'awaiting_permission', pending: structuredClone(attempt.pending) };
    if (attempt.status === 'finished') return { ...base, status: 'finished', result: { summary: '模拟执行已完成，未产生真实工作区变更。', artifacts: [], evidence: [] } };
    return { ...base, status: attempt.status === 'awaiting_permission' ? 'running' : attempt.status };
  }
  async cancelExecution(lookup: ExecutionLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    const attempt = this.find(lookup); if (!attempt) return { status: 'unknown' };
    if (attempt.status !== 'finished' && attempt.status !== 'failed') { attempt.status = 'cancelled'; delete attempt.pending; attempt.release?.('cancel'); }
    return { status: attempt.status === 'cancelled' ? 'confirmed' : 'unknown' };
  }
  async replyPermission(input: { lookup: ExecutionLookup; externalRequestID: string; actionDigest: string; choice: 'allowOnce' | 'deny' }): Promise<{ status: 'accepted' | 'rejected' | 'unknown' }> {
    const attempt = this.find(input.lookup); const pending = attempt?.pending;
    if (!attempt || !pending || pending.externalRequestID !== input.externalRequestID || taskDigest(pending.action) !== input.actionDigest || attempt.receipts.length) return { status: 'rejected' };
    this.counts.permissions += 1; attempt.receipts.push({ externalRequestID: input.externalRequestID, actionDigest: input.actionDigest, choice: input.choice, status: 'accepted' });
    delete attempt.pending; attempt.status = input.choice === 'deny' ? 'cancelled' : 'running'; attempt.release?.(input.choice);
    return { status: 'accepted' };
  }
  private find(lookup: ExecutionLookup): Attempt | undefined {
    const attempt = this.attempts.get(lookup.clientRequestID); const binding = lookup.binding;
    if (!attempt || !binding || binding.runtimeID !== attempt.binding.runtimeID || binding.connectionGeneration !== attempt.binding.connectionGeneration || binding.externalSessionID !== attempt.binding.externalSessionID || binding.externalSubmissionID !== undefined && binding.externalSubmissionID !== attempt.binding.externalSubmissionID) return undefined;
    return attempt;
  }
}
