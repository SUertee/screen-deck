import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalContext, ApprovalDecision } from '../shared/types.js';
import { PreviewRecordStore } from './preview-record-store.js';
import { StorageError } from './private-storage.js';
import { isUUID } from './session-schema.js';

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
  constructor(previewRoot: string) { this.store = new PreviewRecordStore(previewRoot, 'preview-approvals', validate); }
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
}
