import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../storage/private-storage.js';
import { canonicalDigest, exactObject, executionRecordID } from '../storage/execution-records.js';
import { isUUID } from '../sessions/session-schema.js';
import type { AgentExecutionController } from '../agents/agent-execution-controller.js';
import type { NativeWorkItemRuntime } from './native-work-item-runtime.js';
import type { NativeTaskRef, NativeWorkItemAttempt, NativeWorkItemInput } from './native-work-item-contract.js';
import type { NativeEvidenceSelection } from './native-work-item-host-verifier.js';
import type { PlanningPlans } from './task-planning-contract.js';
import { nativePlanRef } from './native-work-item-durable-owner.js';
import { nativeTaskKey, digestString } from './native-work-item-durable-schema.js';
import { planningFail } from './task-planning-schema.js';
import { validatePreviewPlan } from './plan-schema.js';
interface QueueEntry { workItemID: string; clientRequestID: string; attemptID?: string }
export interface TaskSequentialQueue {
  schema_version: 1; id: string; task: NativeTaskRef; planVersion: number; planDigest: string;
  revision: number; stopped: boolean; entries: QueueEntry[];
}
export type SequentialQueuePhase = 'needs-preparation' | 'needs-start' | 'running' | 'needs-tool-approval' | 'needs-acceptance' | 'waiting-human' | 'complete' | 'stopped' | 'paused-stale' | 'paused-failed' | 'paused-cancelled' | 'paused-unknown' | 'paused-rejected' | 'paused-evidence';
export interface TaskSequentialView { queue: TaskSequentialQueue; phase: SequentialQueuePhase; workItemID?: string; attemptID?: string; completed: number; total: number; automaticExecution: false; unresolvedAttemptIDs: string[] }
export interface QueueSetup { context: NativeWorkItemInput['context']; materials: NativeWorkItemInput['materials']; text: string; selection: NativeEvidenceSelection }
const LIMIT = 128 * 1024;
/** One explicit next action at a time. This service never approves, accepts, retries or loops a model. */
export class TaskSequentialQueueService {
  private root: string;
  constructor(private options: { root: string; plans: PlanningPlans; runtime: NativeWorkItemRuntime; execution: Pick<AgentExecutionController, 'read'> }) { this.root = safeRoot(options.root); }
  async create(input: { taskID: string; expectedVersion: number; clientRequestID: string }): Promise<TaskSequentialView> {
    exactObject(input, ['taskID', 'expectedVersion', 'clientRequestID']); this.ids(input.taskID, input.clientRequestID);
    return this.lock(input.taskID, async () => {
      const existing = await this.load(input.taskID, input.clientRequestID);
      if (existing) { if (existing.planVersion !== input.expectedVersion) planningFail('同一队列请求不能换版本。'); return this.view(existing); }
      const result = await this.options.plans.transactPlan(input.taskID, async plan => {
        validatePreviewPlan(plan);
        if (plan.version !== input.expectedVersion || !plan.work_items.length || plan.work_items.length > 32) planningFail('队列须绑定当前版本的1至32个工作项。');
        const q: TaskSequentialQueue = { schema_version: 1, id: input.clientRequestID, task: nativePlanRef(plan), planVersion: plan.version, planDigest: canonicalDigest(plan), revision: 1, stopped: false, entries: plan.work_items.map(w => ({ workItemID: w.id, clientRequestID: executionRecordID({ queueID: input.clientRequestID, workItemID: w.id }) })) };
        await this.save(q); return { value: q };
      });
      return this.view(result.value);
    });
  }
  inspect(taskID: string, queueID: string): Promise<TaskSequentialView> { return this.lock(taskID, async () => this.view(await this.required(taskID, queueID))); }
  async prepareNext(taskID: string, queueID: string, setup: QueueSetup): Promise<TaskSequentialView> {
    exactObject(setup, ['context', 'materials', 'text', 'selection']); const frozen = structuredClone(setup);
    return this.lock(taskID, async () => {
      const q = await this.required(taskID, queueID), before = await this.view(q);
      if (before.phase !== 'needs-preparation' || !before.workItemID) return before;
      const plan = await this.options.plans.loadPlan(taskID), item = plan?.work_items.find(w => w.id === before.workItemID);
      if (!item || item.assignee !== 'agent' || !item.agentID) planningFail('下一项没有可执行的Agent分工。');
      const entry = q.entries.find(e => e.workItemID === item!.id)!;
      const attempt = await this.options.runtime.prepare({ task: q.task, planVersion: q.planVersion, workItemID: item!.id, clientRequestID: entry.clientRequestID, agentID: item!.agentID!, context: frozen.context, materials: frozen.materials, text: frozen.text }, frozen.selection);
      entry.attemptID = attempt.id; await this.save(q); return this.view(q);
    });
  }
  async startNext(taskID: string, queueID: string, approvalID: string): Promise<TaskSequentialView> {
    if (!isUUID(approvalID)) planningFail('必须提供该工作项的开始审批。');
    return this.lock(taskID, async () => {
      const q = await this.required(taskID, queueID), view = await this.view(q);
      if (view.phase !== 'needs-start' || !view.attemptID) return view;
      // Native owner checks the original attempt's approval, expiry, context, model and dependencies.
      await this.options.runtime.begin(q.task, view.attemptID, approvalID);
      return this.view(q);
    });
  }
  async stop(taskID: string, queueID: string): Promise<TaskSequentialView> {
    return this.lock(taskID, async () => {
      const q = await this.required(taskID, queueID); q.stopped = true; await this.save(q);
      const attempts = (await this.snapshot(q)).attempts;
      for (const entry of q.entries) {
        const a = entry.attemptID ? attempts.find(a => a.id === entry.attemptID) : attempts.filter(a => a.planDigest === q.planDigest && a.input.workItemID === entry.workItemID).at(-1);
        if (a && !entry.attemptID) { entry.attemptID = a.id; await this.save(q); }
        if (a && ['prepared', 'dispatching'].includes(a.status)) await this.options.runtime.bridge.stop(q.task, a.id);
      }
      return this.view(q);
    });
  }
  async reconcile(taskID: string, queueID: string): Promise<TaskSequentialView> {
    return this.lock(taskID, async () => {
      const q = await this.required(taskID, queueID), snapshot = await this.snapshot(q);
      for (const entry of q.entries) {
        const a = snapshot.attempts.find(a => a.id === entry.attemptID);
        if (a && ['dispatching', 'unknown', 'preparing'].includes(a.status) && (!a.sessionID || !this.options.runtime.sessions.isAgentSessionBusy(a.sessionID))) await this.options.runtime.bridge.refresh(q.task, a.id);
      }
      return this.view(q);
    });
  }
  private async snapshot(q: TaskSequentialQueue) {
    return this.options.runtime.owner.withTask(q.task, async tx => ({ plan: await tx.loadPlan(), attempts: await tx.attempts() }));
  }
  private async view(q: TaskSequentialQueue): Promise<TaskSequentialView> {
    const snapshot = await this.snapshot(q), result = (phase: SequentialQueuePhase, completed = 0, workItemID?: string, attemptID?: string): TaskSequentialView => ({ queue: structuredClone(q), phase, completed, total: q.entries.length, automaticExecution: false, unresolvedAttemptIDs: snapshot.attempts.filter(a => a.planDigest === q.planDigest && ['preparing', 'dispatching', 'unknown'].includes(a.status)).map(a => a.id), ...(workItemID ? { workItemID } : {}), ...(attemptID ? { attemptID } : {}) });
    if (q.stopped) return result('stopped');
    if (!snapshot.plan || snapshot.plan.version !== q.planVersion || canonicalDigest(snapshot.plan) !== q.planDigest) return result('paused-stale');
    const attempts = snapshot.attempts.filter(a => a.input.task.planID === q.task.planID && a.input.planVersion === q.planVersion && a.planDigest === q.planDigest);
    // Recover a preparation whose native write succeeded before the queue link was saved; never resend.
    let linked = false;
    for (const entry of q.entries) {
      if (!entry.attemptID) { const a = attempts.filter(a => a.input.workItemID === entry.workItemID).at(-1); if (a) { entry.attemptID = a.id; linked = true; } }
    }
    if (linked) await this.save(q);
    const accepted = new Set<string>();
    for (const entry of q.entries) {
      const a = attempts.find(a => a.id === entry.attemptID);
      if (!a) continue;
      if (a.acceptance?.decision === 'accepted') {
        try {
          if (a.status !== 'finished') return result('paused-evidence', accepted.size, entry.workItemID, a.id);
          const evidence = await this.options.runtime.evidence.collectAttempt(a);
          if (!evidence.host || evidence.digest !== a.acceptance.evidenceDigest) return result('paused-evidence', accepted.size, entry.workItemID, a.id);
          await this.options.runtime.host.verify(a, evidence.host); accepted.add(entry.workItemID);
        } catch { return result('paused-evidence', accepted.size, entry.workItemID, a.id); }
      } else if (a.acceptance?.decision === 'rejected') return result('paused-rejected', accepted.size, entry.workItemID, a.id);
      else if (a.status === 'failed') return result('paused-failed', accepted.size, entry.workItemID, a.id);
      else if (a.status === 'cancelled') return result('paused-cancelled', accepted.size, entry.workItemID, a.id);
      else if (a.status === 'unknown') return result('paused-unknown', accepted.size, entry.workItemID, a.id);
      else if (a.status === 'finished') return result('needs-acceptance', accepted.size, entry.workItemID, a.id);
      else if (a.status === 'prepared') return result('needs-start', accepted.size, entry.workItemID, a.id);
      else {
        if (!a.sessionID || !this.options.runtime.sessions.isAgentSessionBusy(a.sessionID)) return result('paused-unknown', accepted.size, entry.workItemID, a.id);
        const session = await this.options.runtime.sessions.loadAgentSession(a.sessionID), turn = session?.turns.at(-1);
        try {
          const execution = turn && await this.options.execution.read(a.sessionID, turn.turn_id);
          return result(execution?.approvals.some(p => p.state === 'pending') ? 'needs-tool-approval' : 'running', accepted.size, entry.workItemID, a.id);
        } catch (error) {
          if (error instanceof StorageError && error.code === 'revision-changed') return result('running', accepted.size, entry.workItemID, a.id);
          throw error;
        }
      }
    }
    if (accepted.size === q.entries.length) return result('complete', accepted.size);
    const next = snapshot.plan.work_items.find(w => !accepted.has(w.id) && w.dependencies.every(id => accepted.has(id)));
    if (!next) return result('paused-evidence', accepted.size);
    return result(next.assignee === 'agent' ? 'needs-preparation' : 'waiting-human', accepted.size, next.id);
  }
  private lock<T>(taskID: string, operation: () => Promise<T>): Promise<T> {
    if (!isUUID(taskID)) planningFail('任务标识无效。'); return withExclusiveLock(join(this.root, `.sequential-task-${taskID}.lock`), operation);
  }
  private ids(taskID: string, queueID: string) { if (!isUUID(taskID) || !isUUID(queueID)) planningFail('队列标识无效。'); }
  private file(taskID: string, queueID: string) { this.ids(taskID, queueID); return join(this.root, 'tasks', taskID, 'sequential-queues', queueID + '.json'); }
  private validate(value: unknown, taskID: string, id: string): TaskSequentialQueue {
    const v = exactObject(value, ['schema_version', 'id', 'task', 'planVersion', 'planDigest', 'revision', 'stopped', 'entries']), q = v as unknown as TaskSequentialQueue; nativeTaskKey(q.task);
    if (q.schema_version !== 1 || q.id !== id || q.task.planID !== taskID || !Number.isSafeInteger(q.planVersion) || q.planVersion < 1 || !Number.isSafeInteger(q.revision) || q.revision < 1 || !digestString(q.planDigest) || typeof q.stopped !== 'boolean' || !Array.isArray(q.entries) || !q.entries.length || q.entries.length > 32) planningFail('队列记录无效。');
    for (const e of q.entries) { exactObject(e, ['workItemID', 'clientRequestID'], ['attemptID']); if (!isUUID(e.workItemID) || !isUUID(e.clientRequestID) || e.attemptID !== undefined && !isUUID(e.attemptID) || e.clientRequestID !== executionRecordID({ queueID: q.id, workItemID: e.workItemID })) planningFail('队列工作项绑定无效。'); }
    if (new Set(q.entries.map(e => e.workItemID)).size !== q.entries.length) planningFail('队列工作项重复。'); return structuredClone(q);
  }
  private async load(taskID: string, queueID: string) { const bytes = await readBytes(this.file(taskID, queueID), LIMIT); return bytes ? this.validate(JSON.parse(bytes.toString()), taskID, queueID) : undefined; }
  private async required(taskID: string, queueID: string) { const q = await this.load(taskID, queueID); if (!q) planningFail('原队列不存在。'); return q!; }
  private async save(q: TaskSequentialQueue) {
    this.validate(q, q.task.planID, q.id); const file = this.file(q.task.planID, q.id), old = await readBytes(file, LIMIT);
    if (old) {
      const prior = this.validate(JSON.parse(old.toString()), q.task.planID, q.id);
      if (prior.planDigest !== q.planDigest || prior.planVersion !== q.planVersion || canonicalDigest(prior.task) !== canonicalDigest(q.task) || prior.stopped && !q.stopped || canonicalDigest(prior.entries.map(e => ({ workItemID: e.workItemID, clientRequestID: e.clientRequestID }))) !== canonicalDigest(q.entries.map(e => ({ workItemID: e.workItemID, clientRequestID: e.clientRequestID }))) || prior.entries.some((e, i) => e.attemptID && e.attemptID !== q.entries[i].attemptID)) planningFail('队列身份或尝试绑定不可覆盖。');
      q.revision = prior.revision + 1;
    } else {
      const dir = join(this.root, 'tasks', q.task.planID, 'sequential-queues'); await checkDirectories(dir, true); if ((await readdir(dir)).length >= 32) planningFail('该任务队列已达上限。');
    }
    await atomicReplace(file, Buffer.from(JSON.stringify(q)), old, LIMIT);
  }
}
