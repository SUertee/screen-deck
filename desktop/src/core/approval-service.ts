import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalContext, ApprovalDecision } from '../shared/types.js';
import { PreviewRecordStore } from './preview-record-store.js';
import { StorageError } from './private-storage.js';
import { isUUID } from './session-schema.js';
import type { ApprovalRequest, ApprovalTarget, TaskTurnRef } from '../shared/task-execution.js';
import { boundedString, canonicalDigest, exactObject, executionRecordID, ExecutionRecordStore, strictDate, validateTaskTurnRef } from './execution-records.js';

function targetKey(target: ApprovalTarget): unknown {
  return target.kind === 'execution' ? { kind: target.kind, turn: target.turn } : { kind: target.kind, turn: target.turn, externalRequestID: target.externalRequestID };
}
export function validateApprovalTarget(value: unknown): asserts value is ApprovalTarget {
  const target = exactObject(value, ['kind', 'turn'], ['specDigest', 'externalRequestID', 'actionDigest']);
  validateTaskTurnRef(target.turn);
  if (target.kind === 'execution') {
    exactObject(target, ['kind', 'turn', 'specDigest']);
    if (typeof target.specDigest !== 'string' || !/^[a-f0-9]{64}$/.test(target.specDigest)) throw new StorageError('invalid-approval', '启动审批范围摘要无效。');
  } else if (target.kind === 'tool') {
    exactObject(target, ['kind', 'turn', 'externalRequestID', 'actionDigest']);
    if (!boundedString(target.externalRequestID, 200) || typeof target.actionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(target.actionDigest)) throw new StorageError('invalid-approval', '工具审批范围无效。');
  } else throw new StorageError('invalid-approval', '审批目标无效。');
}
function validateExecutionApproval(value: unknown): ApprovalRequest {
  const record = exactObject(value, ['schema_version', 'kind', 'id', 'target', 'created_at', 'expires_at', 'state'], ['decided_by', 'decided_at', 'invalidation']);
  validateApprovalTarget(record.target);
  if (record.schema_version !== 1 || record.kind !== 'electron_execution_approval' || !isUUID(record.id) || record.id !== executionRecordID(targetKey(record.target)) || !strictDate(record.created_at) || !strictDate(record.expires_at) || Date.parse(record.expires_at) <= Date.parse(record.created_at)) throw new StorageError('invalid-approval', '执行审批记录无效。');
  if (record.state === 'pending') {
    if ('decided_by' in record || 'decided_at' in record) throw new StorageError('invalid-approval', '待审批记录不能带人工决定。');
  } else if (record.state === 'approved' || record.state === 'rejected') {
    if (!boundedString(record.decided_by, 200) || !strictDate(record.decided_at) || Date.parse(record.decided_at) < Date.parse(record.created_at)) throw new StorageError('invalid-approval', '审批人工决定无效。');
  } else throw new StorageError('invalid-approval', '审批状态无效。');
  if (record.invalidation !== undefined) {
    const invalidation = exactObject(record.invalidation, ['invalidated_at', 'reason']);
    if (!strictDate(invalidation.invalidated_at) || !boundedString(invalidation.reason, 4096)) throw new StorageError('invalid-approval', '审批失效事实无效。');
  }
  return record as unknown as ApprovalRequest;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => {
    if (/api[_-]?key|token|secret|authorization|password/i.test(key)) throw new StorageError('secret-forbidden', '审批参数不能保存凭据。');
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`;
  }).join(',')}}`;
  throw new StorageError('invalid-context', '审批参数必须为有限 JSON 值。');
}
function digest(context: ApprovalContext): string {
  if (!context || typeof context.action !== 'string' || !context.action.trim() || typeof context.workspace !== 'string' || !context.workspace.startsWith('/') || context.workspace === '/' || context.workspace.split('/').includes('..') || /[\r\n\0]/.test(context.workspace) || !isUUID(context.planID) || !Number.isSafeInteger(context.planVersion) || context.planVersion < 1 || !context.parameters || typeof context.parameters !== 'object' || Array.isArray(context.parameters) || Object.keys(context).some(key => !['action', 'parameters', 'workspace', 'planID', 'planVersion'].includes(key))) throw new StorageError('invalid-context', '审批范围无效。');
  const encoded = canonical(context);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new StorageError('too-large', '审批范围超过容量上限。');
  return createHash('sha256').update(encoded).digest('hex');
}
function validate(value: unknown): ApprovalDecision {
  const decision = value as ApprovalDecision;
  if (!decision || decision.schema_version !== 1 || decision.kind !== 'electron_preview_approval' || !isUUID(decision.id) || !['approved', 'rejected'].includes(decision.decision) || typeof decision.decided_by !== 'string' || !decision.decided_by.trim() || decision.decided_by.length > 200 || !Number.isFinite(Date.parse(decision.decided_at)) || decision.expires_at !== undefined && !Number.isFinite(Date.parse(decision.expires_at)) || decision.context_digest !== digest(decision.context) || Object.keys(decision).some(key => !['schema_version', 'kind', 'id', 'context_digest', 'context', 'decision', 'decided_by', 'decided_at', 'expires_at'].includes(key))) throw new StorageError('invalid-approval', '人工决定记录无效。');
  return decision;
}

/** Records explicit human decisions; recommendations are never accepted as approval. */
export class ApprovalService {
  private readonly store: PreviewRecordStore<ApprovalDecision>;
  private readonly executionStore: ExecutionRecordStore<ApprovalRequest>;
  private readonly invalidated = new Set<string>();
  constructor(previewRoot: string, private readonly executionOptions: { now?: () => Date; actor?: () => string } = {}) {
    this.store = new PreviewRecordStore(previewRoot, 'preview-approvals', validate);
    this.executionStore = new ExecutionRecordStore(previewRoot, 'execution-approvals-v1', validateExecutionApproval);
  }
  async recordDecision(input: { context: ApprovalContext; decision: 'approved' | 'rejected'; decidedBy: string; expiresAt?: string }): Promise<ApprovalDecision> {
    const now = new Date().toISOString();
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(now)) throw new StorageError('invalid-expiry', '审批有效期必须在决定时间之后。');
    return this.store.save({ schema_version: 1, kind: 'electron_preview_approval', id: randomUUID(), context_digest: digest(input.context), context: structuredClone(input.context), decision: input.decision, decided_by: input.decidedBy, decided_at: now, ...(input.expiresAt ? { expires_at: input.expiresAt } : {}) }, false);
  }
  listDecisions(): Promise<ApprovalDecision[]> { return this.store.list(); }
  async isApproved(id: string, context: ApprovalContext, now = new Date()): Promise<boolean> {
    const decision = await this.store.load(id);
    return decision !== undefined && decision.decision === 'approved' && decision.context_digest === digest(context) && (!decision.expires_at || Date.parse(decision.expires_at) > now.getTime());
  }
  /** New Turn-specific requests do not consume permission or invoke a driver. */
  async request(target: ApprovalTarget): Promise<ApprovalRequest> {
    validateApprovalTarget(target);
    const id = executionRecordID(targetKey(target));
    return this.executionStore.update(id, current => {
      if (current) {
        if (canonicalDigest(current.target) !== canonicalDigest(target)) throw new StorageError('approval-conflict', '同一审批目标的范围已改变。');
        return current;
      }
      const now = this.now();
      return { schema_version: 1, kind: 'electron_execution_approval', id, target: structuredClone(target), state: 'pending', created_at: now.toISOString(), expires_at: new Date(now.getTime() + 15 * 60 * 1000).toISOString() };
    });
  }
  loadExecutionApproval(id: string): Promise<ApprovalRequest | undefined> { return this.executionStore.load(id); }
  async listExecutionApprovals(turn: TaskTurnRef): Promise<ApprovalRequest[]> {
    validateTaskTurnRef(turn); const key = canonicalDigest(turn);
    return (await this.executionStore.list()).filter(record => canonicalDigest(record.target.turn) === key);
  }
  async decide(requestID: string, choice: 'approve' | 'reject', actor = this.executionOptions.actor?.() ?? 'local-user'): Promise<ApprovalRequest> {
    if (!['approve', 'reject'].includes(choice) || !boundedString(actor, 200)) throw new StorageError('invalid-approval', '人工审批输入无效。');
    return this.executionStore.update(requestID, current => {
      if (!current) throw new StorageError('missing-approval', '审批申请不存在。');
      const state = choice === 'approve' ? 'approved' : 'rejected';
      if (current.state !== 'pending') {
        if (current.state !== state) throw new StorageError('approval-conflict', '审批已有相反的人工决定。');
        return current;
      }
      if (current.invalidation || Date.parse(current.expires_at) <= this.now().getTime()) throw new StorageError('approval-invalid', '审批范围已失效或过期，请重新请求。');
      return { ...current, state, decided_by: actor, decided_at: this.now().toISOString() };
    });
  }
  async invalidate(requestID: string, reason: string): Promise<ApprovalRequest> {
    if (!boundedString(reason, 4096)) throw new StorageError('invalid-approval', '审批失效原因无效。');
    // Even an uncertain write cannot be used as permission in this process.
    this.invalidated.add(requestID);
    return this.executionStore.update(requestID, current => {
      if (!current) throw new StorageError('missing-approval', '审批申请不存在。');
      return current.invalidation ? current : { ...current, invalidation: { invalidated_at: this.now().toISOString(), reason } };
    });
  }
  async invalidateTurn(turn: TaskTurnRef, reason: string): Promise<void> {
    for (const request of await this.listExecutionApprovals(turn)) await this.invalidate(request.id, reason);
  }
  async assertValid(id: string, target: ApprovalTarget, now = this.now()): Promise<ApprovalRequest> {
    const approval = await this.loadExecutionApproval(id);
    if (!approval) throw new StorageError('not-approved', '执行尚未获批。');
    this.assertCurrent(approval, target, now); return approval;
  }
  /** Final synchronous check immediately before a driver call; caller holds the task gate. */
  assertCurrent(approval: ApprovalRequest, target: ApprovalTarget, now = this.now()): void {
    validateApprovalTarget(target);
    if (approval.state !== 'approved' || approval.invalidation || this.invalidated.has(approval.id) || Date.parse(approval.expires_at) <= now.getTime() || canonicalDigest(approval.target) !== canonicalDigest(target)) throw new StorageError('not-approved', '审批未通过、已过期或与原范围不符。');
  }
  private now(): Date { return this.executionOptions.now?.() ?? new Date(); }
}
