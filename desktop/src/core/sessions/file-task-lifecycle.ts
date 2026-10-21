import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalService } from '../approvals/approval-service.js';
import { ExecutionArtifactStore } from '../storage/execution-artifact-store.js';
import { ExecutionRecordStore, canonicalDigest, exactObject } from '../storage/execution-records.js';
import { checkDirectories, safeRoot, StorageError, withExclusiveLock } from '../storage/private-storage.js';
import { FileWriteTool, fileDigest, identityOf, inspectFileTarget, syncFileDirectory, validateLeaf, validateTextBytes, type FileWriteEffect } from '../tools/write.js';
import { fileActionDigest, fileResultDigest, fileTurnRef, fileUnresolved, validateFileRef, validateFileScope, validateFileSession, type FileApprovalTarget, type FileTaskSession, type FileTurnRef } from './file-task-schema.js';
import { TaskSessionHistoryStore } from './task-session-history-store.js';
import { isUUID } from './session-schema.js';
import type { PreviewPlanScope } from '../../shared/types.js';

export interface FileTaskOptions {
  previewRoot: string; approvals: ApprovalService; tool?: FileWriteTool; now?: () => Date;
  /** Trusted main proof about this exact writer, never renderer input or PID/mtime inference. */
  confirmWriterStopped?: (ref: FileTurnRef) => Promise<boolean>;
}
export async function assertFileTaskIdle(root: string, scope: PreviewPlanScope): Promise<void> {
  validateFileScope(scope);
  const records = await new ExecutionRecordStore(root, 'task-sessions-v3', validateFileSession).list();
  if (records.some(s => canonicalDigest(s.scope) === canonicalDigest(scope) && fileUnresolved(s))) throw new StorageError('conflict', '同一任务有未决文件执行。');
}
export async function assertLegacyFileTaskIdle(root: string, scope: PreviewPlanScope): Promise<void> {
  validateFileScope(scope);
    const old = await new TaskSessionHistoryStore(root).list();
    if (old.diagnostics.length || old.records.some(s => canonicalDigest({ project_id: s.scope.project_id, task_id: s.scope.task_id }) === canonicalDigest(scope) && s.turns.some(t => !['finished', 'failed', 'cancelled'].includes(t.state) || t.execution.permissions.some(p => p.delivery === 'sending' || p.delivery === 'unknown' || !p.delivery && !['failed', 'cancelled'].includes(t.state))))) throw new StorageError('conflict', '同一任务有未决旧格式记录。');
}
function strictProposal(text: string): Buffer {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw new StorageError('invalid-proposal', '文件提案无效。');
  // A deliberately narrow JSON grammar: exactly two literal keys, either order, no duplicates.
  const string = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const first = new RegExp('^\\s*\\{\\s*"schema_version"\\s*:\\s*1\\s*,\\s*"content"\\s*:\\s*(' + string + ')\\s*\\}\\s*$');
  const second = new RegExp('^\\s*\\{\\s*"content"\\s*:\\s*(' + string + ')\\s*,\\s*"schema_version"\\s*:\\s*1\\s*\\}\\s*$');
  const match = first.exec(text) ?? second.exec(text);
  if (!match) throw new StorageError('invalid-proposal', '文件提案必须为完整的单文件JSON对象。');
  const content: string = JSON.parse(match[1]!);
  if (/[\uD800-\uDFFF]/u.test(content)) throw new StorageError('invalid-proposal', '提案包含无效Unicode。');
  return validateTextBytes(Buffer.from(content));
}
/** Private SessionManager lifecycle. No model, IPC, source-file access or native Agent tools. */
export class FileTaskLifecycle {
  private readonly root: string;
  private readonly store: ExecutionRecordStore<FileTaskSession>;
  private readonly artifacts: ExecutionArtifactStore;
  private readonly tool: FileWriteTool;
  private readonly cancelled = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly active = new Map<string, Promise<FileTaskSession>>();
  private closed = false;
  constructor(private readonly options: FileTaskOptions) {
    this.root = safeRoot(options.previewRoot); this.store = new ExecutionRecordStore(this.root, 'task-sessions-v3', validateFileSession);
    this.artifacts = new ExecutionArtifactStore(this.root); this.tool = options.tool ?? new FileWriteTool();
  }
  async create(input: { title: string; scope: PreviewPlanScope }): Promise<FileTaskSession> {
    this.ensureOpen(); exactObject(input, ['title', 'scope']); validateFileScope(input.scope);
    const record: FileTaskSession = { schema_version: 3, format: 'task-v3', id: randomUUID(), title: input.title, scope: structuredClone(input.scope), created_at: this.now().toISOString(), revision: 0 };
    validateFileSession(record); return this.store.update(record.id, current => { if (current) throw new StorageError('conflict', '文件会话已存在。'); return record; });
  }
  list(): Promise<FileTaskSession[]> { return this.store.list(); }
  async load(session: FileTurnRef['session']): Promise<FileTaskSession | undefined> {
    exactObject(session, ['format', 'sessionID']); if (session.format !== 'task-v3' || !isUUID(session.sessionID)) throw new StorageError('invalid-reference', '文件会话引用无效。');
    return this.store.load(session.sessionID);
  }
  /** C will call only after a bound ACP end_turn and complete text have been durably confirmed.
   * This internal boundary accepts synthetic completed text in tests; no public route exists. */
  async prepare(input: { session: FileTurnRef['session']; clientRequestID: string; leafName: string; baseline: Uint8Array; completedProposal: { assistantMessageID: string; text: string } }): Promise<FileTaskSession> {
    this.ensureOpen(); exactObject(input, ['session', 'clientRequestID', 'leafName', 'baseline', 'completedProposal']); exactObject(input.completedProposal, ['assistantMessageID', 'text']);
    validateLeaf(input.leafName); if (!isUUID(input.clientRequestID) || !isUUID(input.completedProposal.assistantMessageID)) throw new StorageError('invalid-input', '提案身份无效。');
    const frozen = { ...input, session: structuredClone(input.session), baseline: validateTextBytes(input.baseline), completedProposal: structuredClone(input.completedProposal) };
    const replacement = strictProposal(frozen.completedProposal.text);
    if (fileDigest(frozen.baseline) === fileDigest(replacement)) throw new StorageError('no-change', '提案没有修改。');
    const original = await this.required(frozen.session);
    return this.gate(original.scope, async () => {
      const session = await this.required(frozen.session);
      if (session.turn) {
        const spec = session.turn.spec;
        if (session.turn.clientRequestID !== frozen.clientRequestID || spec.target.leafName !== frozen.leafName || spec.baseline.contentDigest !== fileDigest(frozen.baseline) || spec.replacement.contentDigest !== fileDigest(replacement) || spec.proposal.assistantMessageID !== frozen.completedProposal.assistantMessageID || spec.proposal.text.contentDigest !== fileDigest(Buffer.from(frozen.completedProposal.text))) throw new StorageError('conflict', '原文件提案不可改变。');
        return session;
      }
      await this.assertIdle(session.scope);
      const turnID = randomUUID(), workspaceID = randomUUID();
      const ref: FileTurnRef = { session: frozen.session, turnID };
      const workspaceRoot = join(this.root, 'file-workspaces-v1', workspaceID);
      await checkDirectories(join(this.root, 'file-workspaces-v1'), true); await mkdir(workspaceRoot, { mode: 0o700 });
      const file = await open(join(workspaceRoot, frozen.leafName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(frozen.baseline); await file.sync(); } finally { await file.close(); }
      await syncFileDirectory(workspaceRoot);
      const target = { workspaceRoot, workspaceIdentity: identityOf(await lstat(workspaceRoot, { bigint: true })), leafName: frozen.leafName, baseIdentity: identityOf(await lstat(join(workspaceRoot, frozen.leafName), { bigint: true })), expectedBaseDigest: fileDigest(frozen.baseline) };
      const spec = { workspaceID, target, baseline: await this.artifacts.put(ref, 'baseline', frozen.baseline), replacement: await this.artifacts.put(ref, 'replacement', replacement), proposal: { assistantMessageID: frozen.completedProposal.assistantMessageID, text: await this.artifacts.put(ref, 'proposal', Buffer.from(frozen.completedProposal.text)) } };
      session.turn = { id: turnID, clientRequestID: frozen.clientRequestID, toolRequestID: randomUUID(), created_at: this.now().toISOString(), spec, actionDigest: fileActionDigest(ref, session.scope, spec), state: 'review' };
      return this.save(session);
    });
  }
  async requestApproval(ref: FileTurnRef) {
    validateFileRef(ref); ref = structuredClone(ref);
    const session = await this.get(ref);
    return this.gate(session.scope, async () => { const current = await this.get(ref); if (current.turn!.state !== 'review') throw new StorageError('conflict', '原动作不再待审批。'); return this.options.approvals.requestFileWrite(this.target(current)); });
  }
  async decide(ref: FileTurnRef, approvalID: string, choice: 'approve' | 'reject') {
    validateFileRef(ref); ref = structuredClone(ref);
    const session = await this.get(ref);
    return this.gate(session.scope, async () => {
      const current = await this.get(ref); const request = await this.options.approvals.loadFileApproval(approvalID);
      if (!request || canonicalDigest(request.target) !== canonicalDigest(this.target(current))) throw new StorageError('conflict', '批准不属于原动作。');
      if (current.turn!.state !== 'review' && !(current.turn!.state === 'cancelled' && choice === 'reject')) throw new StorageError('conflict', '原动作已经离开审批阶段。');
      const decided = await this.options.approvals.decideFileWrite(approvalID, choice);
      if (choice === 'reject' && current.turn!.state === 'review') { current.turn!.approvalID = approvalID; current.turn!.state = 'cancelled'; current.turn!.receipt = { status: 'not-applied', reason: 'user-rejected' }; await this.save(current); }
      return decided;
    });
  }
  apply(ref: FileTurnRef, approvalID: string): Promise<FileTaskSession> {
    validateFileRef(ref); this.ensureOpen(); const frozen = structuredClone(ref), key = canonicalDigest(frozen);
    if (this.active.has(key)) return Promise.reject(new StorageError('conflict', '原文件动作正在处理。'));
    const run = this.applyOnce(frozen, approvalID);
    this.active.set(key, run); void run.finally(() => { this.active.delete(key); }).catch(() => undefined); return run;
  }
  private async applyOnce(ref: FileTurnRef, approvalID: string): Promise<FileTaskSession> {
    const original = await this.get(ref);
    return this.gate(original.scope, async () => this.workspace(original, async () => {
      let s = await this.get(ref), turn = s.turn!;
      if (turn.approvalID && turn.approvalID !== approvalID) throw new StorageError('conflict', '不是原批准。');
      if (['finished', 'failed', 'cancelled'].includes(turn.state)) return s;
      if (turn.state !== 'review') throw new StorageError('execution-unknown', '原动作已领取或结果未确认，不能再次应用。');
      await this.assertIdle(s.scope, s.id);
      const approval = await this.options.approvals.assertFileApproved(approvalID, this.target(s));
      const bytes = await this.verifyMaterials(s);
      this.check(ref); this.options.approvals.assertFileCurrent(approval, this.target(s));
      turn.state = 'sending'; turn.approvalID = approvalID; s = await this.save(s); turn = s.turn!;
      let effect: FileWriteEffect;
      try {
        this.check(ref);
        const stage = await this.tool.stage(turn.spec.target, { bytes, contentDigest: turn.spec.replacement.contentDigest });
        turn.intent = stage.intent; s = await this.save(s); turn = s.turn!;
        const fresh = await this.options.approvals.assertFileApproved(approvalID, this.target(s));
        effect = await this.tool.commit(stage.handle, () => { this.check(ref); return this.options.approvals.assertFileCurrent(fresh, this.target(s)); });
      } catch (error) {
        // No commit call has run, but a failed save may already have replaced its record.
        // Do not overwrite uncertain revisions or manufacture a receipt.
        if (error instanceof StorageError && ['write-uncertain', 'revision-changed'].includes(error.code)) throw error;
        const disk = await this.get(ref);
        if (disk.revision !== s.revision) throw new StorageError('persistence', '原记录需要核对；不会再次提交。');
        effect = { status: 'not-applied', reason: error instanceof StorageError ? error.code : 'precommit-failed' };
      } finally {
        this.stopped.add(canonicalDigest(ref));
      }
      return this.recordEffect(s, effect);
    }));
  }
  async inspect(ref: FileTurnRef): Promise<FileTaskSession> {
    validateFileRef(ref); ref = structuredClone(ref);
    const original = await this.get(ref); const key = canonicalDigest(ref);
    if (this.active.has(key)) throw new StorageError('conflict', '原写入者尚未退出。');
    return this.gate(original.scope, async () => this.workspace(original, async () => {
      const s = await this.get(ref), turn = s.turn!;
      if (!['sending', 'unknown'].includes(turn.state)) return s;
      const stopped = this.stopped.has(key) || await this.options.confirmWriterStopped?.(structuredClone(ref)) === true;
      let effect: FileWriteEffect = { status: 'unknown', reason: 'writer-or-intent-unconfirmed' };
      if (stopped && turn.intent) {
        await this.verifyMaterials(s);
        effect = await this.tool.inspect(turn.spec.target, turn.spec.replacement.contentDigest, turn.intent, 'stopped');
      }
      return this.recordEffect(s, effect);
    }));
  }
  async cancel(ref: FileTurnRef): Promise<FileTaskSession> {
    validateFileRef(ref); ref = structuredClone(ref);
    validateFileRef(ref); this.cancelled.add(canonicalDigest(ref));
    const active = this.active.get(canonicalDigest(ref)); if (active) await active.catch(() => undefined);
    const original = await this.get(ref);
    return this.gate(original.scope, async () => {
      const s = await this.get(ref);
      if (s.turn!.state === 'review') { s.turn!.state = 'cancelled'; s.turn!.receipt = { status: 'not-applied', reason: 'cancelled-before-apply' }; return this.save(s); }
      return s; // Cancellation after dispatch never implies rollback.
    });
  }
  async review(ref: FileTurnRef): Promise<{ session: FileTaskSession; before: Uint8Array; after: Uint8Array }> {
    validateFileRef(ref); ref = structuredClone(ref);
    const session = await this.get(ref); const after = await this.verifyMaterials(session);
    return { session, before: await this.artifacts.read(ref, session.turn!.spec.baseline), after };
  }
  async verifyResult(ref: FileTurnRef, digest: string): Promise<FileTaskSession> {
    validateFileRef(ref); ref = structuredClone(ref);
    const s = await this.get(ref), t = s.turn!;
    if (t.state !== 'finished' || t.resultDigest !== digest || t.resultDigest !== fileResultDigest(ref, t) || t.receipt?.status !== 'applied') throw new StorageError('conflict', '没有已确认的原文件成果。');
    await this.verifyMaterials(s); const bytes = await this.artifacts.read(ref, t.receipt.result); const diff = await this.artifacts.read(ref, t.receipt.diff);
    if (fileDigest(diff) !== fileDigest(this.diff(await this.artifacts.read(ref, t.spec.baseline), bytes))) throw new StorageError('artifact-conflict', '成果diff不匹配。');
    return s; // Immutable result, not the subsequently edited live copy.
  }
  async shutdown(): Promise<void> { this.closed = true; await Promise.allSettled(this.active.values()); }
  private async recordEffect(s: FileTaskSession, effect: FileWriteEffect): Promise<FileTaskSession> {
    const t = s.turn!, ref = fileTurnRef(s);
    if (effect.status === 'applied') {
      const result = await this.artifacts.put(ref, 'result', effect.bytes);
      const diff = await this.artifacts.put(ref, 'diff', this.diff(await this.artifacts.read(ref, t.spec.baseline), effect.bytes));
      t.state = 'finished'; t.receipt = { status: 'applied', observedIdentity: effect.observedIdentity, result, diff }; t.resultDigest = fileResultDigest(ref, t);
    } else { t.state = effect.status === 'unknown' ? 'unknown' : this.cancelled.has(canonicalDigest(ref)) || this.closed ? 'cancelled' : 'failed'; t.receipt = effect; }
    return this.save(s);
  }
  private diff(before: Uint8Array, after: Uint8Array): Buffer {
    // Full-fidelity review payload; no line truncation or implicit newline/BOM normalization.
    return Buffer.from(JSON.stringify({ before: Buffer.from(before).toString('utf8'), after: Buffer.from(after).toString('utf8') }));
  }
  private async verifyMaterials(s: FileTaskSession): Promise<Uint8Array> {
    const ref = fileTurnRef(s), t = s.turn!, spec = t.spec;
    if (spec.target.workspaceRoot !== join(this.root, 'file-workspaces-v1', spec.workspaceID)) throw new StorageError('unsafe-path', '不是原私有副本。');
    const base = validateTextBytes(await this.artifacts.read(ref, spec.baseline));
    const replacement = validateTextBytes(await this.artifacts.read(ref, spec.replacement));
    const proposal = await this.artifacts.read(ref, spec.proposal.text);
    if (fileDigest(strictProposal(new TextDecoder('utf-8', { fatal: true }).decode(proposal))) !== fileDigest(replacement) || fileDigest(base) !== spec.target.expectedBaseDigest) throw new StorageError('artifact-conflict', '提案材料不匹配。');
    return replacement;
  }
  private async assertIdle(scope: PreviewPlanScope, except?: string): Promise<void> {
    await assertLegacyFileTaskIdle(this.root, scope);
    if ((await this.store.list()).some(s => s.id !== except && canonicalDigest(s.scope) === canonicalDigest(scope) && fileUnresolved(s))) throw new StorageError('conflict', '同一任务有未决文件执行。');
  }
  private target(s: FileTaskSession): FileApprovalTarget { return { turn: fileTurnRef(s), toolRequestID: s.turn!.toolRequestID, actionDigest: s.turn!.actionDigest }; }
  private async required(ref: FileTurnRef['session']): Promise<FileTaskSession> { const s = await this.load(ref); if (!s) throw new StorageError('missing-session', '原文件会话不存在。'); return s; }
  private async get(ref: FileTurnRef): Promise<FileTaskSession> { validateFileRef(ref); const s = await this.required(ref.session); if (s.turn?.id !== ref.turnID) throw new StorageError('conflict', '不是原文件轮次。'); return s; }
  private save(s: FileTaskSession): Promise<FileTaskSession> {
    const frozen = structuredClone(s);
    return this.store.update(s.id, current => { if (!current || current.revision !== frozen.revision || canonicalDigest(current.scope) !== canonicalDigest(frozen.scope) || current.turn && canonicalDigest(current.turn.spec) !== canonicalDigest(frozen.turn?.spec)) throw new StorageError('revision-changed', '文件会话已变化。'); frozen.revision++; return frozen; });
  }
  private workspace<T>(s: FileTaskSession, operation: () => Promise<T>): Promise<T> { return withExclusiveLock(join(this.root, `.file-workspace-${s.turn!.spec.workspaceID}.lock`), operation); }
  private gate<T>(scope: PreviewPlanScope, operation: () => Promise<T>): Promise<T> { return withExclusiveLock(join(this.root, `.task-${canonicalDigest(scope)}.lock`), operation); }
  private check(ref: FileTurnRef): void { if (this.closed || this.cancelled.has(canonicalDigest(ref))) throw new StorageError('cancelled', '原文件动作已取消。'); }
  private ensureOpen(): void { if (this.closed) throw new StorageError('closed', '文件执行已关闭。'); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}
