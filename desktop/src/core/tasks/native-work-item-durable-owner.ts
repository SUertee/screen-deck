import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApprovalService } from '../approvals/approval-service.js';
import type { ApprovalContext, PreviewPlan, PreviewPlanScope } from '../../shared/types.js';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../storage/private-storage.js';
import { canonicalDigest } from '../storage/execution-records.js';
import { isUUID } from '../sessions/session-schema.js';
import type { NativeTaskRef, NativeTaskTransaction, NativeWorkItemAttempt, NativeWorkItemOwner } from './native-work-item-contract.js';
import { nativeInvalid, nativeTaskKey, validateDurableAttempt, validateNativeJournal, type NativeStartApproval, type NativeTaskJournal } from './native-work-item-durable-schema.js';
const LIMIT = 2 * 1024 * 1024;
const activeStatuses = new Set(['preparing', 'prepared', 'dispatching', 'unknown']);
const queues = new Map<string, Promise<unknown>>();
/** Same project lock filename as TaskOrchestrator.taskGate. Local plans use a stable plan key. */
export function withNativeTaskGate<T>(root: string, task: NativeTaskRef, operation: () => Promise<T>): Promise<T> {
  const key = nativeTaskKey(task);
  const file = join(safeRoot(root), task.kind === 'local' ? `.plan-${task.planID}.lock` : `.task-${canonicalDigest(key)}.lock`);
  const prior = queues.get(file) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(() => withExclusiveLock(file, operation));
  queues.set(file, run); void run.finally(() => { if (queues.get(file) === run) queues.delete(file); }).catch(() => {}); return run;
}
export function nativePlanRef(plan: PreviewPlan): NativeTaskRef {
  return plan.scope ? { kind: 'project', projectID: plan.scope.project_id, taskID: plan.scope.task_id, planID: plan.id } : { kind: 'local', planID: plan.id };
}
export interface DurableNativeOwnerOptions {
  root: string;
  /** Read existing PreviewPlan store only, with A's v1/v2/v3 validator. No duplicate plan database. */
  loadPlan(id: string): Promise<PreviewPlan | undefined>;
  /** Production: TaskOrchestrator owns the gate; this callback returns no plan mutation. */
  transactPlan?<T>(id: string, operation: (current: PreviewPlan) => Promise<{ plan?: PreviewPlan; value: T }>): Promise<{ value: T; plan?: PreviewPlan }>;
  approvals: Pick<ApprovalService, 'recordDecision' | 'isApproved'>;
  evidenceSelectionDigest(attempt: NativeWorkItemAttempt): Promise<string>;
  verifyAcceptedDependency(attempt: NativeWorkItemAttempt): Promise<void>;
  assertOtherExecutionsIdle?(task: NativeTaskRef): Promise<void>;
  validateMaterials?(plan: PreviewPlan, attempt: NativeWorkItemAttempt): Promise<void>;
  onAttemptSaved?(attempt: NativeWorkItemAttempt): Promise<void>;
  now?: () => Date;
}
interface ActiveTransaction { task: NativeTaskRef; journal: NativeTaskJournal; observed?: Buffer; file: string; planDigest?: string; open: boolean; tx: NativeTaskTransaction }
/** Durable execution journal, not a task database. All plans stay in PreviewRecordStore. */
export class DurableNativeWorkItemOwner implements NativeWorkItemOwner {
  private root: string;
  private local = new AsyncLocalStorage<ActiveTransaction>();
  constructor(private options: DurableNativeOwnerOptions) { this.root = safeRoot(options.root); }
  async withTask<T>(task: NativeTaskRef, operation: (tx: NativeTaskTransaction) => Promise<T>): Promise<T> {
    const frozen = structuredClone(task), key = nativeTaskKey(frozen);
    if (this.local.getStore()) throw new StorageError('nested-task-lock', '任务事务不能嵌套。');
    const operationUnderGate = async () => {
      const file = this.file(frozen), observed = await readBytes(file, LIMIT);
      const journal: NativeTaskJournal = observed ? validateNativeJournal(JSON.parse(observed.toString()), key) : { schema_version: 1, kind: 'native_work_item_journal', key, revision: 1, attempts: [], approvals: [] };
      let active: ActiveTransaction;
      const assertOpen = () => { if (!active.open || this.local.getStore() !== active) throw new StorageError('transaction-closed', '任务事务已结束。'); };
      const tx: NativeTaskTransaction = {
        loadPlan: async () => {
          assertOpen();
          const plan = await this.options.loadPlan(frozen.planID);
          if (plan && canonicalDigest(nativeTaskKey(nativePlanRef(plan))) !== canonicalDigest(key)) nativeInvalid('计划来源与尝试不匹配。');
          if (plan) active.planDigest ??= canonicalDigest(plan);
          return plan && structuredClone(plan);
        },
        attempts: async () => { assertOpen(); return structuredClone(active.journal.attempts); },
        saveAttempt: async input => {
          assertOpen();
          const a = validateDurableAttempt(input);
          if (canonicalDigest(nativeTaskKey(a.input.task)) !== canonicalDigest(key)) nativeInvalid();
          if (active.planDigest) {
            const plan = await this.options.loadPlan(frozen.planID);
            if (!plan || canonicalDigest(plan) !== active.planDigest) throw new StorageError('plan-conflict', '尝试保存前计划已变化。');
          }
          const old = active.journal.attempts.find(v => v.id === a.id);
          if (!old) {
            if (this.options.assertOtherExecutionsIdle) await this.options.assertOtherExecutionsIdle(a.input.task);
            else if (a.input.task.kind === 'project') throw new StorageError('legacy-execution-unverified', '尚未配置旧执行互斥检查。');
            if (a.status !== 'preparing' || a.sessionID || a.acceptance || active.journal.attempts.some(v => v.input.clientRequestID === a.input.clientRequestID || activeStatuses.has(v.status))) nativeInvalid('任务有未解决或重复尝试。');
          } else this.assertTransition(old, a);
          const next = structuredClone(active.journal);
          const index = next.attempts.findIndex(v => v.id === a.id);
          if (index < 0) next.attempts.push(a); else next.attempts[index] = a;
          await this.persist(active, next);
          await this.options.onAttemptSaved?.(structuredClone(a));
        },
      };
      active = { task: frozen, file, observed, journal, tx, open: true };
      try { return await this.local.run(active, () => operation(tx)); } finally { active.open = false; }
    };
    if (this.options.transactPlan) return (await this.options.transactPlan(frozen.planID, async current => {
      if (canonicalDigest(nativeTaskKey(nativePlanRef(current))) !== canonicalDigest(key)) nativeInvalid('计划来源已变化。');
      return { value: await operationUnderGate() };
    })).value;
    return withNativeTaskGate(this.root, frozen, operationUnderGate);
  }
  async assertDependencies(tx: NativeTaskTransaction, plan: PreviewPlan, workItemID: string): Promise<void> {
    const item = plan.work_items.find(w => w.id === workItemID); if (!item) nativeInvalid();
    const attempts = await tx.attempts();
    for (const id of item!.dependencies) {
      const a = attempts.find(v => v.input.task.planID === plan.id && v.input.workItemID === id && v.planDigest === canonicalDigest(plan) && v.status === 'finished' && v.acceptance?.decision === 'accepted');
      if (!a) throw new StorageError('dependency-unaccepted', '依赖没有当前版本的真实验收结果。');
      await this.options.verifyAcceptedDependency(a);
    }
  }
  async requestStartApproval(task: NativeTaskRef, attemptID: string): Promise<NativeStartApproval> {
    return this.withTask(task, async tx => {
      const a = (await tx.attempts()).find(a => a.id === attemptID); if (!a || a.status !== 'prepared') nativeInvalid('尝试尚未准备就绪。');
      const active = this.local.getStore()!;
      const context = await this.approvalContext(a!); const targetDigest = canonicalDigest(context);
      const old = active.journal.approvals.find(r => r.attemptID === attemptID && r.targetDigest === targetDigest && !r.revoked && Date.parse(r.expiresAt) > this.now().getTime());
      if (old) return structuredClone(old);
      const now = this.now();
      const request: NativeStartApproval = { id: randomUUID(), attemptID, targetDigest, state: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString() };
      const next = structuredClone(active.journal); next.approvals.push(request); await this.persist(active, next); return request;
    });
  }
  async decideStartApproval(task: NativeTaskRef, requestID: string, choice: 'approved' | 'rejected', actor: string): Promise<NativeStartApproval> {
    return this.withTask(task, async tx => {
      const active = this.local.getStore()!, r = active.journal.approvals.find(r => r.id === requestID);
      if (!r || !['approved', 'rejected'].includes(choice) || r.revoked || r.consumed || Date.parse(r.expiresAt) <= this.now().getTime()) nativeInvalid('开始审批已失效。');
      if (r!.state !== 'pending') { if (r!.state !== choice) nativeInvalid('审批已有不同决定。'); return structuredClone(r!); }
      const a = (await tx.attempts()).find(a => a.id === r!.attemptID); if (!a || a.status !== 'prepared') nativeInvalid();
      const context = await this.approvalContext(a!); if (canonicalDigest(context) !== r!.targetDigest) nativeInvalid('审批目标已变化。');
      const decision = await this.options.approvals.recordDecision({ context, decision: choice, decidedBy: actor, expiresAt: r!.expiresAt });
      const next = structuredClone(active.journal), updated = next.approvals.find(v => v.id === r!.id)!;
      updated.state = choice; updated.decisionID = decision.id; await this.persist(active, next); return structuredClone(updated);
    });
  }
  async revokeStartApproval(task: NativeTaskRef, requestID: string): Promise<void> {
    await this.withTask(task, async () => { const active = this.local.getStore()!, next = structuredClone(active.journal), r = next.approvals.find(r => r.id === requestID); if (!r) nativeInvalid(); r!.revoked = true; await this.persist(active, next); });
  }
  async authorizeStart(a: NativeWorkItemAttempt, approvalID: string): Promise<void> {
    const active = this.local.getStore();
    if (!active || canonicalDigest(nativeTaskKey(a.input.task)) !== canonicalDigest(nativeTaskKey(active.task))) nativeInvalid('开始操作缺少任务事务。');
    if (this.options.assertOtherExecutionsIdle) await this.options.assertOtherExecutionsIdle(a.input.task);
    else if (a.input.task.kind === 'project') throw new StorageError('legacy-execution-unverified', '尚未配置旧执行互斥检查。');
    const r = active!.journal.approvals.find(r => r.id === approvalID && r.attemptID === a.id);
    const context = await this.approvalContext(a);
    if (!r || r.state !== 'approved' || !r.decisionID || r.revoked || r.consumed || Date.parse(r.expiresAt) <= this.now().getTime() || canonicalDigest(context) !== r.targetDigest || !await this.options.approvals.isApproved(r.decisionID, context, this.now())) throw new StorageError('approval-invalid', '当前尝试没有有效且未消费的开始批准。');
    if (this.options.validateMaterials) {
      const plan = await active!.tx.loadPlan(); if (!plan) nativeInvalid(); await this.options.validateMaterials(plan!, a);
    } else if (a.input.materials.length) throw new StorageError('materials-unverified', '尚未配置确认材料来源校验，未发送。');
    const next = structuredClone(active!.journal); next.approvals.find(v => v.id === r!.id)!.consumed = true; await this.persist(active!, next);
  }
  async assertIdle(plan: PreviewPlan): Promise<void> { await this.assertKeyIdle(nativeTaskKey(nativePlanRef(plan))); }
  async assertProjectIdle(scope: PreviewPlanScope): Promise<void> { await this.assertKeyIdle({ project_id: scope.project_id, task_id: scope.task_id }); }
  private async assertKeyIdle(key: ReturnType<typeof nativeTaskKey>): Promise<void> {
    const bytes = await readBytes(join(this.root, 'native-work-item-journals-v1', canonicalDigest(key) + '.json'), LIMIT);
    if (bytes && validateNativeJournal(JSON.parse(bytes.toString()), key).attempts.some(a => activeStatuses.has(a.status))) throw new StorageError('native-task-active', '任务有原生准备、活动或未知尝试；不能修改计划或开始其他执行。');
  }
  /** Isolated legacy gate; production mutations use TaskOrchestrator.transactPlan. */
  withPlanMutation<T>(plan: PreviewPlan, operation: () => Promise<T>): Promise<T> {
    if (this.options.transactPlan) throw new StorageError('nested-plan-mutation', '生产模式请直接通过TaskOrchestrator.transactPlan修改计划，不能嵌套savePlan。');
    return withNativeTaskGate(this.root, nativePlanRef(plan), async () => { await this.assertIdle(plan); return operation(); });
  }
  async isManagedSession(sessionID: string): Promise<boolean> {
    if (!isUUID(sessionID)) nativeInvalid();
    const directory = join(this.root, 'native-work-item-journals-v1'); if (!await checkDirectories(directory)) return false;
    const entries = await readdir(directory, { withFileTypes: true }); if (entries.length > 2000) nativeInvalid();
    let found = false;
    for (const entry of entries) {
      if (/^\..+\.tmp$/.test(entry.name) && entry.isFile()) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) nativeInvalid();
      const bytes = await readBytes(join(directory, entry.name), LIMIT); if (!bytes) nativeInvalid();
      const raw = JSON.parse(bytes!.toString()) as NativeTaskJournal;
      const j = validateNativeJournal(raw, raw.key);
      if (entry.name !== canonicalDigest(j.key) + '.json') nativeInvalid();
      if (j.attempts.some(a => a.sessionID === sessionID)) found = true;
    }
    return found;
  }
  private async approvalContext(a: NativeWorkItemAttempt): Promise<ApprovalContext> {
    return { action: 'native-work-item-start-v1', workspace: a.input.context.workspace.path, planID: a.input.task.planID, planVersion: a.input.planVersion, parameters: { attemptID: a.id, inputDigest: a.inputDigest, evidenceSelectionDigest: await this.options.evidenceSelectionDigest(a) } };
  }
  private file(task: NativeTaskRef): string { return join(this.root, 'native-work-item-journals-v1', canonicalDigest(nativeTaskKey(task)) + '.json'); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private async persist(active: ActiveTransaction, journal: NativeTaskJournal): Promise<void> {
    journal.revision = active.observed ? active.journal.revision + 1 : 1;
    validateNativeJournal(journal, nativeTaskKey(active.task));
    const bytes = Buffer.from(JSON.stringify(journal)); await atomicReplace(active.file, bytes, active.observed, LIMIT);
    active.observed = bytes; active.journal = structuredClone(journal);
  }
  private assertTransition(old: NativeWorkItemAttempt, next: NativeWorkItemAttempt): void {
    const frozen = (a: NativeWorkItemAttempt) => ({ id: a.id, input: a.input, planDigest: a.planDigest, prompt: a.prompt, inputDigest: a.inputDigest, source: a.source });
    if (canonicalDigest(frozen(old)) !== canonicalDigest(frozen(next))) nativeInvalid('尝试冻结身份不可修改。');
    for (const key of ['sessionID', 'turnID', 'clientRequestID'] as const) if (old[key] && old[key] !== next[key]) nativeInvalid('原生绑定不可替换。');
    const allowed: Record<NativeWorkItemAttempt['status'], string[]> = { preparing: ['preparing', 'prepared', 'failed', 'unknown'], prepared: ['prepared', 'dispatching', 'cancelled'], dispatching: ['dispatching', 'finished', 'failed', 'cancelled', 'unknown'], unknown: ['unknown', 'finished', 'failed', 'cancelled'], finished: ['finished'], failed: ['failed'], cancelled: ['cancelled'] };
    if (!allowed[old.status].includes(next.status) || old.acceptance && canonicalDigest(old.acceptance) !== canonicalDigest(next.acceptance ?? null)) nativeInvalid('尝试状态或验收不可回退。');
  }
}
