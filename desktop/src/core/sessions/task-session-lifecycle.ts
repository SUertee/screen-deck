import { randomUUID } from 'node:crypto';
import type { ModelSelection } from '../../shared/types.js';
import type { ApprovalRequest, ExecutionLookup, ExecutionSpec, PermissionExchange, StartReceipt, TaskEventEnvelope, TaskExecutionRequest, TaskSessionEvent, TaskSessionRecord, TaskSessionRef, TaskTurnRecord, TaskTurnRef } from '../../shared/task-execution.js';
import { ExecutionError } from './execution-driver.js';
import { StorageError } from '../storage/private-storage.js';
import { isUUID, SESSION_LIMITS, validateModel } from './session-schema.js';
import type { TaskExecutionDriver } from './task-execution-driver.js';
import type { TaskSessionHistoryStoring } from './task-session-history-store.js';
import { canonicalTask, taskActionAllowed, taskDigest, taskSpecDigest, validateExecutionSpec, validateTaskBinding, validateTaskResult } from './task-session-schema.js';

const terminal = (state: string) => ['finished', 'failed', 'cancelled'].includes(state);
interface Active { controller: AbortController; callbacks: boolean; done?: Promise<void> }
/** Private implementation owned by SessionManager; there is no independent Run/controller. */
export class TaskSessionLifecycle {
  private readonly cache = new Map<string, TaskSessionRecord>();
  private readonly pending = new Map<string, TaskSessionRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Set<(event: TaskSessionEvent) => void>();
  private closed = false;
  constructor(private readonly store: TaskSessionHistoryStoring, private readonly driver: TaskExecutionDriver, private readonly now: () => Date = () => new Date(), private readonly resolveApproval?: (id: string) => Promise<ApprovalRequest | undefined>) {}
  async create(input: { title: string; projectID: string; taskID: string }): Promise<TaskSessionRecord> {
    this.open(); const id = randomUUID(); const now = this.time();
    const record: TaskSessionRecord = { schema_version: 2, kind: 'electron_task_session', conversation_id: id, title: input.title.trim(), scope: { kind: 'project', project_id: input.projectID, task_id: input.taskID }, created_at: now, updated_at: now, revision: 0, turns: [], messages: [] };
    const saved = await this.store.save(record); this.cache.set(id, saved); this.emit(saved); return structuredClone(saved);
  }
  async list(scope?: { projectID: string; taskID: string }) {
    this.open(); const listing = await this.store.list({ observeRecord: id => !this.active.has(id) && !this.pending.has(id) });
    const records: TaskSessionRecord[] = [];
    for (const record of listing.records) {
      if (scope && (record.scope.project_id !== scope.projectID || record.scope.task_id !== scope.taskID)) continue;
      records.push(await this.serial(record.conversation_id, async () => {
        if (this.pending.has(record.conversation_id) || this.active.has(record.conversation_id)) return structuredClone(this.record(record.conversation_id));
        if (!this.cache.has(record.conversation_id)) await this.recover(record); else this.cache.set(record.conversation_id, record);
        return structuredClone(this.record(record.conversation_id));
      }));
    }
    return { records: records.sort((a, b) => b.updated_at.localeCompare(a.updated_at)), diagnostics: listing.diagnostics };
  }
  async load(ref: TaskSessionRef): Promise<TaskSessionRecord | undefined> { this.reference(ref); return this.serial(ref.sessionID, async () => { const record = await this.fresh(ref.sessionID); return record && structuredClone(record); }); }
  async get(ref: TaskTurnRef): Promise<TaskTurnRecord> { this.reference(ref.session); return this.serial(ref.session.sessionID, async () => { await this.required(ref.session.sessionID); return structuredClone(this.turn(ref)); }); }
  async prepare(input: { session: TaskSessionRef; clientRequestID: string; text: string; model: ModelSelection; spec: ExecutionSpec }): Promise<TaskTurnRef> {
    this.reference(input.session); this.open();
    return this.serial(input.session.sessionID, async () => {
      const record = await this.required(input.session.sessionID); this.writable(record.conversation_id);
      validateModel(input.model);
      if (!isUUID(input.clientRequestID) || !input.text.trim() || Buffer.byteLength(input.text) > SESSION_LIMITS.messageBytes) throw new StorageError('invalid-input', '任务输入无效。');
      const duplicate = record.turns.find(turn => turn.client_request_id === input.clientRequestID);
      const messageID = duplicate?.execution.spec.inputMessageID ?? randomUUID();
      const spec = { ...structuredClone(input.spec), inputMessageID: messageID }; validateExecutionSpec(spec);
      const digest = taskSpecDigest(spec, input.model, input.text);
      if (duplicate) {
        if (duplicate.execution.specDigest !== digest) throw new StorageError('conflict', '同一启动请求不能更换输入或范围。');
        return { session: input.session, turnID: duplicate.turn_id };
      }
      if (record.turns.some(turn => !terminal(turn.state) || this.unresolvedPermission(turn))) throw new StorageError('unresolved-turn', '任务会话存在未解决的尝试。');
      if (record.turns.length >= SESSION_LIMITS.turns || record.messages.length + 2 > SESSION_LIMITS.messages) throw new StorageError('too-large', '任务会话已达到容量上限。');
      const now = this.time(); const turnID = randomUUID();
      record.turns.push({ turn_id: turnID, client_request_id: input.clientRequestID, requested_model: structuredClone(input.model), state: 'prepared', created_at: now, updated_at: now, draft_revision: 0, execution: { spec, specDigest: digest, eventReceipts: [], permissions: [] } });
      record.messages.push({ message_id: messageID, turn_id: turnID, role: 'user', text: input.text, created_at: now, updated_at: now }, { message_id: randomUUID(), turn_id: turnID, role: 'assistant', text: '', created_at: now, updated_at: now });
      record.updated_at = now; await this.persist(record.conversation_id); return { session: input.session, turnID };
    });
  }
  async start(input: { turn: TaskTurnRef; approvalID: string; check: () => void; resolved: TaskExecutionRequest['resolved'] }): Promise<StartReceipt> {
    this.reference(input.turn.session); this.open();
    return this.serial(input.turn.session.sessionID, async () => {
      await this.required(input.turn.session.sessionID); this.writable(input.turn.session.sessionID); const turn = this.turn(input.turn);
      if (turn.state !== 'prepared') return { turn: input.turn, status: turn.state === 'unknown' ? 'unknown' : turn.execution.authorizationID ? 'already-started' : 'not-started' };
      if (!isUUID(input.approvalID)) throw new StorageError('not-approved', '批准标识无效。');
      if (turn.execution.spec.tools.kind === 'restricted' && (!this.driver.capabilities.tools || !this.driver.taskCapabilities.reconcile || !this.driver.taskCapabilities.confirmedCancel || !this.driver.taskCapabilities.permissionReply || !this.driver.taskCapabilities.enforcedToolScope)) throw new StorageError('unsupported', '执行器不能约束并逐次审批本次工具范围。');
      input.check(); turn.execution.authorizationID = input.approvalID; this.state(input.turn, 'submitting'); await this.persist(input.turn.session.sessionID);
      try { input.check(); this.open(); } catch (error) { this.state(input.turn, 'failed', '首次外部调用前授权已失效，尚未提交。'); await this.persist(input.turn.session.sessionID); throw error; }
      const active: Active = { controller: new AbortController(), callbacks: true }; this.active.set(input.turn.session.sessionID, active);
      const record = this.record(input.turn.session.sessionID); const message = record.messages.find(value => value.message_id === turn.execution.spec.inputMessageID)!;
      const request: TaskExecutionRequest = { turn: structuredClone(input.turn), clientRequestID: turn.client_request_id, spec: structuredClone(turn.execution.spec), model: structuredClone(turn.requested_model), input: message.text, resolved: input.resolved };
      // Never await the driver while owning the session queue: it calls this same queue.
      active.done = this.run(input.turn, active, request);
      return { turn: input.turn, status: 'started' };
    });
  }
  async failPrepared(ref: TaskTurnRef, reason: string): Promise<void> { await this.serial(ref.session.sessionID, async () => { await this.required(ref.session.sessionID); this.writable(ref.session.sessionID); if (this.turn(ref).state === 'prepared') { this.state(ref, 'failed', reason); await this.persist(ref.session.sessionID); } }); }
  async cancel(ref: TaskTurnRef): Promise<TaskTurnRecord> {
    const lookup = await this.serial(ref.session.sessionID, async () => {
      await this.required(ref.session.sessionID); this.writable(ref.session.sessionID); const turn = this.turn(ref);
      if (terminal(turn.state)) return undefined;
      if (turn.state === 'prepared') { this.state(ref, 'cancelled', '已取消本地准备，尚未提交。'); await this.persist(ref.session.sessionID); return undefined; }
      this.state(ref, 'cancelling'); await this.persist(ref.session.sessionID); return this.lookup(turn);
    });
    if (!lookup) return this.get(ref);
    let confirmed = false; try { confirmed = this.driver.capabilities.remoteAbort && (await this.driver.cancelExecution(lookup)).status === 'confirmed'; } catch { /* Unknown is not cancellation. */ }
    await this.serial(ref.session.sessionID, async () => {
      const turn = this.turn(ref); if (terminal(turn.state)) return;
      this.state(ref, confirmed ? 'cancelled' : 'unknown', confirmed ? '执行已确认停止。' : '无法确认外部停止。');
      this.active.get(ref.session.sessionID)?.controller.abort(); await this.persist(ref.session.sessionID);
    }); return this.get(ref);
  }
  async reply(input: { turn: TaskTurnRef; approval: ApprovalRequest; check: () => void }): Promise<PermissionExchange> {
    const selected = await this.serial(input.turn.session.sessionID, async () => {
      await this.required(input.turn.session.sessionID); this.writable(input.turn.session.sessionID); const turn = this.turn(input.turn); const target = input.approval.target;
      if (target.kind !== 'tool' || canonicalTask(target.turn) !== canonicalTask(input.turn)) throw new StorageError('not-approved', '工具决定不属于此尝试。');
      const exchange = turn.execution.permissions.find(value => value.externalRequestID === target.externalRequestID);
      if (!exchange || exchange.actionDigest !== target.actionDigest) throw new StorageError('not-approved', '工具参数已变化。');
      if (exchange.delivery) return { exchange: structuredClone(exchange) };
      if (turn.state !== 'awaiting_permission' || !this.driver.taskCapabilities.permissionReply || input.approval.state === 'pending') throw new StorageError('not-approved', '当前不能投递工具许可。');
      input.check(); if (input.approval.invalidation || Date.parse(input.approval.expires_at) <= this.now().getTime()) throw new StorageError('not-approved', '工具申请已失效。');
      if (input.approval.state === 'approved' && !taskActionAllowed(exchange.action, turn.execution.spec.tools)) throw new StorageError('unsupported', '工具超出原范围。');
      exchange.approvalID = input.approval.id; exchange.delivery = 'sending'; await this.persist(input.turn.session.sessionID);
      try { input.check(); if (input.approval.invalidation || Date.parse(input.approval.expires_at) <= this.now().getTime()) throw new StorageError('not-approved', '工具申请已失效。'); }
      catch (error) { const current = this.turn(input.turn).execution.permissions.find(value => value.externalRequestID === target.externalRequestID)!; current.delivery = 'unknown'; this.state(input.turn, 'unknown', '许可投递前已失效，未放行。'); await this.persist(input.turn.session.sessionID); throw error; }
      return { exchange: structuredClone(exchange), lookup: this.lookup(turn), choice: input.approval.state === 'approved' ? 'allowOnce' as const : 'deny' as const };
    });
    if (!selected.lookup || !selected.choice) return selected.exchange;
    // The queue result is awaited: cancel/expiry may have changed before this continuation.
    try {
      this.open(); input.check();
      const current = this.turn(input.turn);
      const exchange = current.execution.permissions.find(value => value.externalRequestID === selected.exchange.externalRequestID);
      if (current.state !== 'awaiting_permission' || exchange?.delivery !== 'sending' || canonicalTask(this.lookup(current)) !== canonicalTask(selected.lookup)) throw new StorageError('conflict', '许可投递前原执行已关闭或绑定变化。');
    } catch (error) {
      await this.serial(input.turn.session.sessionID, async () => {
        const current = this.turn(input.turn); const exchange = current.execution.permissions.find(value => value.externalRequestID === selected.exchange.externalRequestID)!;
        if (exchange.delivery === 'sending') exchange.delivery = 'unknown';
        if (!terminal(current.state)) this.state(input.turn, 'unknown', '许可首次投递前已失效，不会补发。');
        await this.persist(input.turn.session.sessionID);
      });
      throw error;
    }
    let status: 'accepted' | 'rejected' | 'unknown' = 'unknown';
    try { status = (await this.driver.replyPermission({ lookup: selected.lookup, externalRequestID: selected.exchange.externalRequestID, actionDigest: selected.exchange.actionDigest, choice: selected.choice })).status; } catch { /* No resend. */ }
    await this.serial(input.turn.session.sessionID, async () => {
      const turn = this.turn(input.turn); const exchange = turn.execution.permissions.find(value => value.externalRequestID === selected.exchange.externalRequestID)!;
      exchange.delivery = status; if (status !== 'accepted' && !terminal(turn.state)) this.state(input.turn, 'unknown', '工具许可投递无法确认。'); await this.persist(input.turn.session.sessionID);
    });
    if (status === 'accepted') await this.inspect(input.turn, false);
    const turn = await this.get(input.turn); return turn.execution.permissions.find(value => value.externalRequestID === selected.exchange.externalRequestID)!;
  }
  async reconcile(ref: TaskTurnRef): Promise<TaskTurnRecord> { return this.inspect(ref, true); }
  hasPending(id: string): boolean { return this.pending.has(id); }
  async retry(ref: TaskSessionRef): Promise<void> {
    this.reference(ref); await this.serial(ref.sessionID, async () => {
      if (!this.pending.has(ref.sessionID)) return;
      const pending = structuredClone(this.record(ref.sessionID));
      try { await this.persist(ref.sessionID); }
      catch (error) {
        const expected = { ...pending, revision: pending.revision + 1 };
        const saved = await this.store.load(ref.sessionID, { observeRecord: record => canonicalTask(record) === canonicalTask(expected) });
        if (!saved || canonicalTask(saved) !== canonicalTask(expected)) throw error;
        this.pending.delete(ref.sessionID); this.cache.set(ref.sessionID, saved); this.emit(saved);
      }
    });
  }
  subscribe(callback: (event: TaskSessionEvent) => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  async shutdown(): Promise<void> { this.closed = true; const active = [...this.active.values()]; for (const item of active) item.controller.abort(); await Promise.all(active.map(item => item.done)); this.listeners.clear(); }
  private async run(ref: TaskTurnRef, active: Active, request: TaskExecutionRequest): Promise<void> {
    try {
      await this.driver.executeTask(request, event => this.event(ref, active, event), active.controller.signal);
      await this.serial(ref.session.sessionID, async () => { if (!terminal(this.turn(ref).state) && active.callbacks) { this.state(ref, 'unknown', '执行器结束但没有确认终结。'); await this.persist(ref.session.sessionID); } });
    } catch (error) {
      await this.serial(ref.session.sessionID, async () => {
        if (terminal(this.turn(ref).state) || (!active.callbacks && !this.pending.has(ref.session.sessionID))) return;
        this.state(ref, error instanceof ExecutionError && !error.attempted ? 'failed' : 'unknown', '执行未能确认完成，不会自动重发。');
        if (this.pending.has(ref.session.sessionID)) this.pending.set(ref.session.sessionID, structuredClone(this.record(ref.session.sessionID)));
        else try { await this.persist(ref.session.sessionID); } catch { /* Pending facts remain in memory. */ }
      });
    } finally { if (this.active.get(ref.session.sessionID) === active) this.active.delete(ref.session.sessionID); }
  }
  private event(ref: TaskTurnRef, active: Active, envelope: TaskEventEnvelope): Promise<void> {
    return this.serial(ref.session.sessionID, async () => {
      if (this.active.get(ref.session.sessionID) !== active || !active.callbacks || active.controller.signal.aborted) return;
      this.writable(ref.session.sessionID); const turn = this.turn(ref); if (terminal(turn.state)) return;
      if (typeof envelope.eventID !== 'string' || !envelope.eventID || Buffer.byteLength(envelope.eventID) > 200 || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new ExecutionError('protocol', '事件身份无效。', true);
      const digest = taskDigest(envelope.event); const receipts = turn.execution.eventReceipts; const duplicate = receipts.find(value => value.eventID === envelope.eventID || value.sequence === envelope.sequence);
      if (duplicate) { if (duplicate.eventID !== envelope.eventID || duplicate.sequence !== envelope.sequence || duplicate.digest !== digest) throw new ExecutionError('protocol', '事件身份冲突。', true); return; }
      if (envelope.sequence !== receipts.length + 1 || receipts.length >= 4096) throw new ExecutionError('protocol', '事件序列不连续或超过上限。', true);
      const event = envelope.event;
      if (event.type === 'bound') { validateTaskBinding(event.binding); if (turn.execution.external && canonicalTask(turn.execution.external) !== canonicalTask(event.binding)) throw new ExecutionError('protocol', '外部绑定变化。', true); turn.execution.external = structuredClone(event.binding); }
      else if (event.type === 'submitted') {
        if (!turn.execution.external) throw new ExecutionError('protocol', '外部会话绑定缺失。', true);
        if (event.externalSubmissionID !== undefined) {
          validateTaskBinding({ ...turn.execution.external, externalSubmissionID: event.externalSubmissionID });
          if (turn.execution.external.externalSubmissionID && turn.execution.external.externalSubmissionID !== event.externalSubmissionID) throw new ExecutionError('protocol', '外部提交身份变化。', true);
          turn.execution.external.externalSubmissionID = event.externalSubmissionID;
        }
        if (turn.state !== 'cancelling') this.state(ref, 'running');
      }
      else if (event.type === 'text-delta') { const assistant = this.record(ref.session.sessionID).messages.find(value => value.turn_id === ref.turnID && value.role === 'assistant')!; if (typeof event.text !== 'string' || Buffer.byteLength(assistant.text) + Buffer.byteLength(event.text) > SESSION_LIMITS.messageBytes) throw new ExecutionError('protocol', '输出超出上限。', true); assistant.text += event.text; assistant.updated_at = this.time(); }
      else if (event.type === 'observed-model') { validateModel(event.model); if (turn.observed_model && canonicalTask(turn.observed_model) !== canonicalTask(event.model)) throw new ExecutionError('protocol', '观测模型变化。', true); turn.observed_model = structuredClone(event.model); }
      else if (event.type === 'permission-request') {
        if (turn.state === 'cancelling' || !turn.execution.external || !taskActionAllowed(event.action, turn.execution.spec.tools)) throw new ExecutionError('tools-forbidden', '拒绝越界或取消后的工具请求。', true);
        const prior = turn.execution.permissions.find(value => value.externalRequestID === event.externalRequestID);
        if (prior) { if (prior.actionDigest !== taskDigest(event.action)) throw new ExecutionError('protocol', '工具请求参数变化。', true); }
        else { if (turn.execution.permissions.some(value => !value.delivery || value.delivery === 'sending' || value.delivery === 'unknown') || turn.execution.permissions.length >= 128) throw new ExecutionError('protocol', '并发工具请求不受支持。', true); turn.execution.permissions.push({ externalRequestID: event.externalRequestID, action: structuredClone(event.action), actionDigest: taskDigest(event.action) }); }
        this.state(ref, 'awaiting_permission');
      } else if (event.type === 'settled') { if (!['finished', 'failed', 'cancelled'].includes(event.outcome) || event.outcome === 'finished' && !event.result) throw new ExecutionError('protocol', '缺少明确终结或成果。', true); if (event.result) { validateTaskResult(event.result); turn.execution.result = structuredClone(event.result); } this.state(ref, event.outcome, 'reason' in event ? event.reason : undefined); }
      else throw new ExecutionError('protocol', '未知执行事件。', true);
      receipts.push({ eventID: envelope.eventID, sequence: envelope.sequence, digest }); await this.persist(ref.session.sessionID);
    });
  }
  private async inspect(ref: TaskTurnRef, stopCallbacks: boolean): Promise<TaskTurnRecord> {
    const selected = await this.serial(ref.session.sessionID, async () => { await this.required(ref.session.sessionID); this.writable(ref.session.sessionID); const turn = this.turn(ref); if (!turn.execution.authorizationID || terminal(turn.state) && !this.unresolvedPermission(turn)) return undefined; if (stopCallbacks && ['submitting', 'running', 'awaiting_permission'].includes(turn.state) && this.active.get(ref.session.sessionID)?.callbacks) return undefined; if (stopCallbacks) { const active = this.active.get(ref.session.sessionID); if (active) { active.callbacks = false; active.controller.abort(); } } return { lookup: this.lookup(turn), approvalIDs: turn.execution.permissions.flatMap(value => value.approvalID ? [value.approvalID] : []) }; });
    if (!selected) return this.get(ref);
    const lookup = selected.lookup;
    let observation; try { observation = await this.driver.inspectExecution(lookup); } catch { observation = { status: 'unverifiable' as const, reason: '执行器无法核对。' }; }
    const approvals = new Map<string, ApprovalRequest>();
    if (this.resolveApproval) for (const id of selected.approvalIDs) { try { const approval = await this.resolveApproval(id); if (approval) approvals.set(id, approval); } catch { /* Missing decision cannot confirm delivery. */ } }
    await this.serial(ref.session.sessionID, async () => {
      this.writable(ref.session.sessionID); const turn = this.turn(ref);
      if (observation.status === 'unverifiable') { if (!terminal(turn.state)) this.state(ref, 'unknown', observation.reason); await this.persist(ref.session.sessionID); return; }
      validateTaskBinding(observation.binding);
      if (!lookup.binding || canonicalTask(lookup.binding) !== canonicalTask(observation.binding)) { if (!terminal(turn.state)) this.state(ref, 'unknown', '核对身份不匹配。'); await this.persist(ref.session.sessionID); return; }
      for (const receipt of observation.permissionReceipts) {
        const exchange = turn.execution.permissions.find(value => value.externalRequestID === receipt.externalRequestID);
        const approval = exchange?.approvalID && approvals.get(exchange.approvalID);
        if (exchange && ['sending', 'unknown'].includes(exchange.delivery ?? '') && ['accepted', 'rejected'].includes(receipt.status) && approval && approval.target.kind === 'tool' && canonicalTask(approval.target.turn) === canonicalTask(ref) && approval.target.externalRequestID === exchange.externalRequestID && approval.target.actionDigest === exchange.actionDigest && exchange.actionDigest === receipt.actionDigest && (approval.state === 'approved' && receipt.choice === 'allowOnce' || approval.state === 'rejected' && receipt.choice === 'deny')) exchange.delivery = receipt.status;
      }
      // A frozen terminal result/output is never rewritten by a later snapshot.
      if (terminal(turn.state)) { await this.persist(ref.session.sessionID); return; }
      if (typeof observation.output !== 'string' || Buffer.byteLength(observation.output) > SESSION_LIMITS.messageBytes) throw new StorageError('too-large', '核对输出超过上限。');
      const assistant = this.record(ref.session.sessionID).messages.find(value => value.turn_id === ref.turnID && value.role === 'assistant')!; assistant.text = observation.output; assistant.updated_at = this.time();
      if (observation.observedModel) { validateModel(observation.observedModel); if (turn.observed_model && canonicalTask(turn.observed_model) !== canonicalTask(observation.observedModel)) throw new StorageError('conflict', '观测模型变化。'); turn.observed_model = structuredClone(observation.observedModel); }
      if (observation.status === 'awaiting_permission') {
        if (!taskActionAllowed(observation.pending.action, turn.execution.spec.tools)) throw new StorageError('unsupported', '核对工具超出范围。');
        const existing = turn.execution.permissions.find(value => value.externalRequestID === observation.pending.externalRequestID);
        if (existing && existing.actionDigest !== taskDigest(observation.pending.action)) throw new StorageError('conflict', '核对工具参数变化。');
        if (!existing) turn.execution.permissions.push({ ...observation.pending, actionDigest: taskDigest(observation.pending.action) });
      }
      if ('result' in observation && observation.result) { validateTaskResult(observation.result); turn.execution.result = observation.result; }
      if (!terminal(turn.state)) this.state(ref, this.unresolvedPermission(turn, observation.status) && observation.status !== 'awaiting_permission' ? 'unknown' : observation.status, 'reason' in observation ? observation.reason : undefined);
      await this.persist(ref.session.sessionID);
    }); return this.get(ref);
  }
  private lookup(turn: TaskTurnRecord): ExecutionLookup { return { clientRequestID: turn.client_request_id, driver: structuredClone(turn.execution.spec.driver), workspace: structuredClone(turn.execution.spec.workspace), ...(turn.execution.external ? { binding: structuredClone(turn.execution.external) } : {}) }; }
  private unresolvedPermission(turn: TaskTurnRecord, state: TaskTurnRecord['state'] = turn.state): boolean { return turn.execution.permissions.some(value => value.delivery === 'sending' || value.delivery === 'unknown' || !value.delivery && !['failed', 'cancelled'].includes(state)); }
  private async fresh(id: string): Promise<TaskSessionRecord | undefined> {
    if (this.pending.has(id) || this.active.has(id)) return this.cache.get(id);
    const record = await this.store.load(id); if (!record) return undefined;
    if (!this.cache.has(id)) await this.recover(record); else this.cache.set(id, record); return this.cache.get(id);
  }
  private async required(id: string): Promise<TaskSessionRecord> { const record = await this.fresh(id); if (!record) throw new StorageError('missing-session', '任务会话不存在。'); return record; }
  private async recover(record: TaskSessionRecord): Promise<void> {
    this.cache.set(record.conversation_id, record);
    // Legacy simulation files are read-only, including mixed sessions. Recovering
    // another turn would still rewrite their shared JSON and revision.
    if (record.turns.some(turn => turn.execution.spec.driver.mode === 'simulation')) return;
    let changed = false;
    for (const turn of record.turns) if (!terminal(turn.state) && turn.state !== 'unknown') { turn.state = turn.state === 'prepared' ? 'failed' : 'unknown'; turn.failure = '应用重启后未自动重发；请核对原尝试。'; turn.updated_at = this.time(); changed = true; }
    if (changed) await this.persist(record.conversation_id);
  }
  private record(id: string): TaskSessionRecord { const record = this.cache.get(id); if (!record) throw new StorageError('missing-session', '任务会话未加载。'); return record; }
  private turn(ref: TaskTurnRef): TaskTurnRecord { const turn = this.record(ref.session.sessionID).turns.find(value => value.turn_id === ref.turnID); if (!turn) throw new StorageError('missing-turn', '任务尝试不存在。'); return turn; }
  private state(ref: TaskTurnRef, state: TaskTurnRecord['state'], reason?: string): void { const turn = this.turn(ref); turn.state = state; turn.updated_at = this.time(); if (reason) turn.failure = reason; else delete turn.failure; this.record(ref.session.sessionID).updated_at = turn.updated_at; }
  private async persist(id: string): Promise<void> {
    const record = this.record(id);
    try { const saved = await this.store.save(structuredClone(record), record.revision || undefined); this.cache.set(id, saved); this.pending.delete(id); this.emit(saved); }
    catch (error) { this.pending.set(id, structuredClone(record)); const active = this.active.get(id); if (active) { active.callbacks = false; active.controller.abort(); } this.diagnostic(id, '本地保存失败，只能补保存，不会重发。'); throw error; }
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> { const next = (this.queues.get(id) ?? Promise.resolve()).then(operation, operation); this.queues.set(id, next.catch(() => undefined)); return next; }
  private reference(ref: TaskSessionRef): void { if (!ref || ref.format !== 'task-v2' || !isUUID(ref.sessionID)) throw new StorageError('invalid-id', '任务会话引用无效。'); }
  private writable(id: string): void { if (this.pending.has(id)) throw new StorageError('pending-write', '先补保存本地事实。'); }
  private open(): void { if (this.closed) throw new StorageError('closed', '会话管理器已关闭。'); }
  private time(): string { return this.now().toISOString(); }
  private emit(record: TaskSessionRecord): void { for (const listener of this.listeners) { try { listener({ type: 'task-session-updated', session: structuredClone(record) }); } catch { /* Read-only observer. */ } } }
  private diagnostic(id: string, message: string): void { for (const listener of this.listeners) { try { listener({ type: 'diagnostic', session: { format: 'task-v2', sessionID: id }, message }); } catch { /* Read-only observer. */ } } }
}
