import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DecisionRecommendation, HistoryDiagnostic, ModelSelection, PlanWorkItem, PreviewPlan, PreviewPlanScope } from '../shared/types.js';
import type { AcceptanceRecord, ApprovalRequest, AuthorizationInput, DriverRef, ExecutionResult, ExecutionSpec, MaterialRef, PermissionExchange, PreparedAuthorization, StartReceipt, TaskSessionRecord, TaskSessionRef, TaskTurnRecord, TaskTurnRef, WorkspaceRef } from '../shared/task-execution.js';
import { PreviewRecordStore } from './preview-record-store.js';
import { safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { isUUID, validateModel } from './session-schema.js';
import { DecisionEngine } from './decision-engine.js';
import { ApprovalService } from './approval-service.js';
import { boundedString, canonicalDigest, exactObject, validateTaskTurnRef } from './execution-records.js';
import { ExecutionAcceptanceStore } from './execution-acceptance-store.js';
import { taskActionAllowed, taskResultDigest, validateExecutionSpec, validateTaskTools } from './task-session-schema.js';

/** Concrete coordinator dependency: the existing SessionManager remains the Turn writer. */
export interface TaskExecutionManager {
  listTaskSessions(input: { projectID: string; taskID: string }): Promise<{ records: TaskSessionRecord[]; diagnostics: HistoryDiagnostic[] }>;
  loadTaskSession(ref: TaskSessionRef): Promise<TaskSessionRecord | undefined>;
  getTaskTurn(ref: TaskTurnRef): Promise<TaskTurnRecord | undefined>;
  prepareTaskTurn(input: { session: TaskSessionRef; clientRequestID: string; text: string; model: ModelSelection; spec: ExecutionSpec }): Promise<TaskTurnRef>;
  startTaskTurn(input: { turn: TaskTurnRef; approvalID: string; check: () => void; resolved: { workspaceRoot: string; materials: Array<{ reference: MaterialRef; bytes: Uint8Array }> } }): Promise<StartReceipt>;
  cancelTaskExecution(turn: TaskTurnRef): Promise<TaskTurnRecord>;
  replyTaskPermission(input: { turn: TaskTurnRef; approval: ApprovalRequest; check: () => void }): Promise<PermissionExchange>;
  reconcileTaskExecution(turn: TaskTurnRef): Promise<TaskTurnRecord>;
  failPreparedTaskTurn(turn: TaskTurnRef, reason: string): Promise<unknown>;
  hasTaskPendingWrites(sessionID: string): boolean;
}
export interface TaskExecutionConfiguration {
  manager: TaskExecutionManager;
  approvals: ApprovalService;
  resolveWorkspace: (scope: PreviewPlanScope, workspaceID: string) => Promise<{ workspace: WorkspaceRef; root: string }>;
  driverRef: (driverID: string) => DriverRef;
  validateSelection?: (driver: DriverRef, model: ModelSelection) => void;
  resolveMaterials: (scope: PreviewPlanScope, ids: string[]) => Promise<Array<{ reference: MaterialRef; bytes: Uint8Array }>>;
  checkWorkspaceBinding?: (scope: PreviewPlanScope, workspace: WorkspaceRef) => void;
  verifyResult: (turn: TaskTurnRecord, result: ExecutionResult, ref: TaskTurnRef) => Promise<void>;
  actor?: () => string;
  now?: () => Date;
}
const terminal = new Set(['finished', 'failed', 'cancelled']);
const unresolvedPermission = (turn: TaskTurnRecord): boolean => turn.execution.permissions.some(value => value.delivery === 'sending' || value.delivery === 'unknown' || !value.delivery && !['failed', 'cancelled'].includes(turn.state));
const unresolved = (turn: TaskTurnRecord): boolean => !terminal.has(turn.state) || unresolvedPermission(turn);
const refOf = (session: TaskSessionRecord, turn: TaskTurnRecord): TaskTurnRef => ({ session: { format: 'task-v2', sessionID: session.conversation_id }, turnID: turn.turn_id });
const scopeOf = (session: TaskSessionRecord): PreviewPlanScope => ({ project_id: session.scope.project_id, task_id: session.scope.task_id });
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);

function validateAuthorization(input: AuthorizationInput): void {
  exactObject(input, ['planID', 'expectedPlanVersion', 'workItemID', 'session', 'clientRequestID', 'text', 'materialIDs', 'workspaceID', 'driverID', 'model', 'tools']);
  const session = exactObject(input.session, ['format', 'sessionID']);
  if (session.format !== 'task-v2' || !isUUID(session.sessionID) || !isUUID(input.planID) || !isUUID(input.workItemID) || !isUUID(input.clientRequestID) || !isUUID(input.workspaceID) || !Number.isSafeInteger(input.expectedPlanVersion) || input.expectedPlanVersion < 1 || !boundedString(input.text, 256 * 1024) || !boundedString(input.driverID, 200) || !Array.isArray(input.materialIDs) || input.materialIDs.length > 32 || input.materialIDs.some(id => !boundedString(id, 200)) || new Set(input.materialIDs).size !== input.materialIDs.length) throw new StorageError('invalid-input', '任务授权输入无效。');
  validateModel(input.model); validateTaskTools(input.tools);
}

export function validatePreviewPlanScope(value: unknown): asserts value is PreviewPlanScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('invalid-plan-scope', '预览计划关联无效。');
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2 || !Object.keys(scope).every(key => ['project_id', 'task_id'].includes(key)) || typeof scope.project_id !== 'string' || !/^project-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(scope.project_id) || typeof scope.task_id !== 'string' || !/^task-\d{3,}$/.test(scope.task_id)) throw new StorageError('invalid-plan-scope', '预览计划项目或任务标识无效。');
}

function validate(value: unknown): PreviewPlan {
  const plan = value as PreviewPlan;
  if (!plan || plan.schema_version !== 1 || plan.kind !== 'electron_preview_plan' || !isUUID(plan.id) || typeof plan.title !== 'string' || !plan.title.trim() || Buffer.byteLength(plan.title) > 600 || !Number.isSafeInteger(plan.version) || plan.version < 1 || !Number.isFinite(Date.parse(plan.created_at)) || !Number.isFinite(Date.parse(plan.updated_at)) || !Array.isArray(plan.work_items) || plan.work_items.length > 1000 || Object.keys(plan).some(key => !['schema_version', 'kind', 'id', 'title', 'version', 'created_at', 'updated_at', 'scope', 'work_items'].includes(key))) throw new StorageError('invalid-plan', '预览计划无效。');
  if (plan.scope !== undefined) validatePreviewPlanScope(plan.scope);
  const ids = new Set<string>();
  for (const item of plan.work_items) {
    if (!isUUID(item.id) || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 600 || !['discussion', 'implementation', 'validation'].includes(item.kind) || !['human', 'chat', 'unassigned'].includes(item.assignee) || typeof item.expected_result !== 'string' || !item.expected_result.trim() || item.expected_result.length > 4096 || !['planned', 'completed'].includes(item.status) || !Array.isArray(item.dependencies) || Object.keys(item).some(key => !['id', 'title', 'kind', 'assignee', 'model', 'expected_result', 'dependencies', 'status'].includes(key))) throw new StorageError('invalid-plan', '预览工作项无效。');
    if (item.model !== undefined) { if (item.assignee !== 'chat') throw new StorageError('invalid-plan', '只有聊天工作项可以指定模型。'); validateModel(item.model); }
    if (item.assignee === 'chat' && (item.kind !== 'discussion' || !item.model)) throw new StorageError('invalid-plan', '聊天分派仅支持指定模型的讨论工作项。');
    ids.add(item.id);
  }
  const byID = new Map(plan.work_items.map(item => [item.id, item]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new StorageError('dependency-cycle', '工作项依赖包含循环。');
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byID.get(id)!;
    if (new Set(item.dependencies).size !== item.dependencies.length) throw new StorageError('invalid-plan', '工作项依赖重复。');
    for (const dependency of item.dependencies) { if (!ids.has(dependency)) throw new StorageError('invalid-plan', '工作项依赖不存在。'); visit(dependency); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return plan;
}

/** Saving or editing a plan has no execution dependency and cannot send a request. */
export class TaskOrchestrator {
  private readonly store: PreviewRecordStore<PreviewPlan>;
  private readonly acceptance: ExecutionAcceptanceStore;
  private readonly root: string;
  private readonly taskQueues = new Map<string, Promise<unknown>>();
  private execution?: TaskExecutionConfiguration;
  constructor(previewRoot: string) { this.root = safeRoot(previewRoot); this.store = new PreviewRecordStore(previewRoot, 'preview-plans', validate); this.acceptance = new ExecutionAcceptanceStore(previewRoot); }
  configureExecution(configuration: TaskExecutionConfiguration): void {
    if (this.execution) throw new StorageError('conflict', '任务执行依赖已配置。');
    this.execution = configuration;
  }
  async createPlan(title: string, workItems: PlanWorkItem[] = [], scope?: PreviewPlanScope): Promise<PreviewPlan> {
    const now = new Date().toISOString();
    const plan: PreviewPlan = { schema_version: 1, kind: 'electron_preview_plan', id: randomUUID(), title: title.trim(), version: 1, created_at: now, updated_at: now, ...(scope !== undefined ? { scope: structuredClone(scope) } : {}), work_items: structuredClone(workItems) };
    validate(plan);
    if (!scope || !this.execution) return this.store.save(plan, false);
    return this.taskGate(scope, async () => { await this.assertTaskIdle(scope); return this.store.save(plan, false); });
  }
  loadPlan(id: string): Promise<PreviewPlan | undefined> { return this.store.load(id); }
  listPlans(): Promise<PreviewPlan[]> { return this.store.list(); }
  async savePlan(plan: PreviewPlan, expectedVersion: number): Promise<PreviewPlan> {
    validate(plan);
    const save = async () => {
      const original = await this.store.load(plan.id);
      if (!original) throw new StorageError('missing-plan', '预览计划不存在。');
      if (original.version !== expectedVersion || plan.version !== expectedVersion) throw new StorageError('plan-conflict', '预览计划版本冲突。');
      if (original.created_at !== plan.created_at || original.kind !== plan.kind) throw new StorageError('invalid-plan', '预览计划身份不可更改。');
      if (original.scope?.project_id !== plan.scope?.project_id || original.scope?.task_id !== plan.scope?.task_id) throw new StorageError('plan-scope-changed', '预览计划关联不可添加、移除或更改；独立计划仍保持独立。');
      if (original.scope && this.execution) {
        const sessions = await this.scan(original.scope);
        const turns = sessions.flatMap(session => session.turns.map(turn => ({ session, turn })));
        if (turns.some(({ turn }) => unresolvedPermission(turn) || !terminal.has(turn.state) && turn.state !== 'prepared')) throw new StorageError('conflict', '任务有活动执行或未核对结果，核对后才能修改计划。');
        // Cross-file updates are ordered fail closed: invalidate first, settle prepared second, save last.
        for (const { session, turn } of turns.filter(({ turn }) => turn.state === 'prepared')) {
          const ref = refOf(session, turn);
          await this.config().approvals.invalidateTurn(ref, '计划版本已修改。');
          await this.config().manager.failPreparedTaskTurn(ref, '计划版本已修改，请重新申请授权。');
        }
      }
      return this.store.save({ ...structuredClone(plan), version: expectedVersion + 1, updated_at: new Date().toISOString() }, true);
    };
    return plan.scope && this.execution ? this.taskGate(plan.scope, save) : save();
  }
  async recommendations(plan: PreviewPlan): Promise<Array<{ workItemID: string; recommendation: DecisionRecommendation }>> {
    validate(plan);
    const engine = new DecisionEngine();
    return Promise.all(plan.work_items.map(async workItem => ({ workItemID: workItem.id, recommendation: await engine.recommend({ planVersion: plan.version, workItem, risk: workItem.kind === 'discussion' ? 'low' : 'medium', capabilities: ['stateless-chat'] }) })));
  }
  async editPlan(id: string, expectedPlanVersion: number, changes: { title?: string; workItems?: PlanWorkItem[] }): Promise<PreviewPlan> {
    const plan = await this.store.load(id);
    if (!plan) throw new StorageError('missing-plan', '预览计划不存在。');
    if (plan.version !== expectedPlanVersion) throw new StorageError('plan-conflict', '预览计划版本冲突。');
    return this.savePlan({ ...plan, title: changes.title?.trim() ?? plan.title, work_items: structuredClone(changes.workItems ?? plan.work_items) }, expectedPlanVersion);
  }

  async requestExecutionAuthorization(input: AuthorizationInput): Promise<PreparedAuthorization> {
    validateAuthorization(input);
    const context = await this.session(input.session);
    const scope = scopeOf(context);
    return this.taskGate(scope, async () => {
      await this.closeExpiredPreparations(scope);
      const session = await this.session(input.session);
      const plan = await this.currentPlan(input.planID, input.expectedPlanVersion, scope);
      const item = this.executableItem(plan, input.workItemID);
      const existing = session.turns.find(turn => turn.client_request_id === input.clientRequestID);
      await this.assertTaskIdle(scope, existing ? refOf(session, existing) : undefined);
      const workspace = await this.config().resolveWorkspace(scope, input.workspaceID);
      const driver = this.config().driverRef(input.driverID);
      this.selection(driver, input.model, input.tools, input.materialIDs);
      const materials = await this.materials(scope, input.materialIDs);
      const dependencies = await this.dependencies(plan, item.dependencies);
      const spec: ExecutionSpec = { work: { planID: plan.id, planVersion: plan.version, workItemID: item.id }, title: item.title, kind: item.kind, expectedResult: item.expected_result, dependencies, inputMessageID: existing?.execution.spec.inputMessageID ?? randomUUID(), materials: materials.map(value => value.reference), workspace: workspace.workspace, driver, tools: structuredClone(input.tools) };
      validateExecutionSpec(spec);
      const ref = await this.config().manager.prepareTaskTurn({ session: input.session, clientRequestID: input.clientRequestID, text: input.text, model: input.model, spec });
      const turn = await this.turn(ref);
      const request = await this.config().approvals.request({ kind: 'execution', turn: ref, specDigest: turn.execution.specDigest });
      return { turn: ref, request };
    });
  }

  async decideApproval(input: { requestID: string; choice: 'approve' | 'reject' }): Promise<ApprovalRequest> {
    exactObject(input, ['requestID', 'choice']);
    if (!isUUID(input.requestID) || !['approve', 'reject'].includes(input.choice)) throw new StorageError('invalid-input', '人工审批输入无效。');
    const request = await this.config().approvals.loadExecutionApproval(input.requestID);
    if (!request) throw new StorageError('missing-approval', '审批申请不存在。');
    const session = await this.session(request.target.turn.session);
    return this.taskGate(scopeOf(session), async () => {
      await this.closeExpiredPreparations(scopeOf(session));
      const turn = await this.turn(request.target.turn);
      const current = await this.config().approvals.loadExecutionApproval(input.requestID);
      if (!current) throw new StorageError('missing-approval', '审批申请不存在。');
      if (input.choice === 'approve' && current.state === 'pending') {
        if (request.target.kind === 'execution') {
          if (turn.state !== 'prepared') {
            const existing = await this.config().approvals.loadExecutionApproval(input.requestID);
            if (existing?.state === 'approved') return existing;
            throw new StorageError('conflict', '该轮次不再等待启动审批。');
          }
          await this.assertTaskIdle(scopeOf(session), request.target.turn);
          await this.frozenCurrent(request.target.turn, turn, scopeOf(session));
          if (request.target.specDigest !== turn.execution.specDigest) throw new StorageError('conflict', '启动审批范围已改变。');
        } else {
          const permission = this.permission(turn, request);
          if (turn.state !== 'awaiting_permission' || permission.delivery || !taskActionAllowed(permission.action, turn.execution.spec.tools)) throw new StorageError('not-approved', '工具请求已关闭或超出本次冻结的工具范围。');
        }
      }
      const decided = await this.config().approvals.decide(input.requestID, input.choice, this.actor());
      if (decided.state === 'rejected' && request.target.kind === 'execution' && turn.state === 'prepared') await this.config().manager.failPreparedTaskTurn(request.target.turn, '人工拒绝启动执行。');
      return decided;
    });
  }

  async startExecution(input: { turn: TaskTurnRef; approvalID: string }): Promise<StartReceipt> {
    exactObject(input, ['turn', 'approvalID']); validateTaskTurnRef(input.turn);
    if (!isUUID(input.approvalID)) throw new StorageError('invalid-input', '启动审批标识无效。');
    const session = await this.session(input.turn.session); const scope = scopeOf(session);
    return this.taskGate(scope, async () => {
      await this.closeExpiredPreparations(scope);
      const turn = await this.turn(input.turn);
      if (turn.state !== 'prepared') {
        if (turn.execution.authorizationID !== input.approvalID) {
          const request = await this.config().approvals.loadExecutionApproval(input.approvalID);
          if (['failed', 'cancelled'].includes(turn.state) && !turn.execution.authorizationID && request?.target.kind === 'execution' && same(request.target.turn, input.turn) && request.target.specDigest === turn.execution.specDigest) return { turn: input.turn, status: 'not-started' };
          throw new StorageError('conflict', '启动引用与该轮次的原授权不符。');
        }
        return { turn: input.turn, status: turn.state === 'unknown' ? 'unknown' : 'already-started' };
      }
      await this.assertTaskIdle(scope, input.turn);
      const resolved = await this.frozenCurrent(input.turn, turn, scope);
      const target = { kind: 'execution' as const, turn: input.turn, specDigest: turn.execution.specDigest };
      const approval = await this.config().approvals.assertValid(input.approvalID, target, this.now());
      return this.config().manager.startTaskTurn({ turn: input.turn, approvalID: approval.id, check: () => {
        this.config().approvals.assertCurrent(approval, target, this.now());
        this.config().checkWorkspaceBinding?.(scope, turn.execution.spec.workspace);
        if (!same(this.config().driverRef(turn.execution.spec.driver.driverID), turn.execution.spec.driver)) throw new StorageError('conflict', '执行器配置已变化，请重新申请。');
        this.selection(turn.execution.spec.driver, turn.requested_model, turn.execution.spec.tools, turn.execution.spec.materials.map(value => value.referenceID));
      }, resolved });
    });
  }

  async listExecutionApprovals(ref: TaskTurnRef): Promise<ApprovalRequest[]> {
    validateTaskTurnRef(ref); const session = await this.session(ref.session);
    return this.taskGate(scopeOf(session), async () => {
      await this.closeExpiredPreparations(scopeOf(session));
      const turn = await this.turn(ref);
      // Repair a crash between persisted remote permission and local request creation, without redelivery.
      if (turn.state === 'awaiting_permission') for (const permission of turn.execution.permissions.filter(value => !value.delivery)) await this.config().approvals.request({ kind: 'tool', turn: ref, externalRequestID: permission.externalRequestID, actionDigest: permission.actionDigest });
      return this.config().approvals.listExecutionApprovals(ref);
    });
  }

  async cancelExecution(ref: TaskTurnRef): Promise<TaskTurnRecord> {
    validateTaskTurnRef(ref); const session = await this.session(ref.session);
    await this.taskGate(scopeOf(session), async () => {
      const turn = await this.turn(ref);
      if (!terminal.has(turn.state)) await this.config().approvals.invalidateTurn(ref, '人工请求取消执行。');
    });
    // SessionManager owns the local cancellation CAS. The task stays active while the remote result is pending.
    return this.config().manager.cancelTaskExecution(ref);
  }

  async replyToolPermission(input: { turn: TaskTurnRef; approvalID: string }): Promise<PermissionExchange> {
    exactObject(input, ['turn', 'approvalID']); validateTaskTurnRef(input.turn);
    if (!isUUID(input.approvalID)) throw new StorageError('invalid-input', '工具审批标识无效。');
    const session = await this.session(input.turn.session);
    const selected = await this.taskGate(scopeOf(session), async () => {
      const turn = await this.turn(input.turn); const approval = await this.config().approvals.loadExecutionApproval(input.approvalID);
      if (!approval || approval.target.kind !== 'tool' || !same(approval.target.turn, input.turn)) throw new StorageError('not-approved', '工具审批不属于该轮次。');
      const permission = this.permission(turn, approval);
      if (permission.delivery) return { exchange: structuredClone(permission) };
      if (turn.state !== 'awaiting_permission') throw new StorageError('conflict', '轮次不再等待工具许可。');
      if (approval.state === 'pending' || approval.invalidation || Date.parse(approval.expires_at) <= this.now().getTime()) throw new StorageError('not-approved', '工具审批尚未决定、已失效或过期。');
      if (approval.state === 'approved' && !taskActionAllowed(permission.action, turn.execution.spec.tools)) throw new StorageError('not-approved', '工具动作超出本次授权范围。');
      return { approval, workspace: structuredClone(turn.execution.spec.workspace) };
    });
    if (selected.exchange) return selected.exchange;
    const approval = selected.approval;
    return this.config().manager.replyTaskPermission({ turn: input.turn, approval, check: () => {
      if (approval.invalidation || Date.parse(approval.expires_at) <= this.now().getTime()) throw new StorageError('not-approved', '工具审批已失效或过期。');
      if (approval.state === 'approved') {
        this.config().approvals.assertCurrent(approval, approval.target, this.now());
        this.config().checkWorkspaceBinding?.(scopeOf(session), selected.workspace);
      }
    } });
  }

  async reconcileExecution(ref: TaskTurnRef): Promise<TaskTurnRecord> {
    validateTaskTurnRef(ref); const session = await this.session(ref.session);
    await this.taskGate(scopeOf(session), async () => { await this.turn(ref); });
    return this.config().manager.reconcileTaskExecution(ref);
  }

  async getWorkItemReview(ref: TaskTurnRef): Promise<{ turn: TaskTurnRef; resultDigest: string; result: ExecutionResult; acceptance?: AcceptanceRecord }> {
    validateTaskTurnRef(ref); const session = await this.session(ref.session);
    return this.taskGate(scopeOf(session), async () => {
      // Query persisted facts even when current project material access is unavailable.
      const { turn, resultDigest } = await this.reviewable(ref, false);
      const acceptance = await this.acceptance.find(ref, resultDigest);
      return { turn: ref, resultDigest, result: structuredClone(turn.execution.result!), ...(acceptance ? { acceptance } : {}) };
    });
  }

  async reviewWorkItem(input: { turn: TaskTurnRef; resultDigest: string; choice: 'accept' | 'reject'; comment?: string }): Promise<AcceptanceRecord> {
    exactObject(input, ['turn', 'resultDigest', 'choice'], ['comment']); validateTaskTurnRef(input.turn);
    if (typeof input.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.resultDigest) || !['accept', 'reject'].includes(input.choice) || input.comment !== undefined && !boundedString(input.comment, 4096)) throw new StorageError('invalid-input', '验收输入无效。');
    const session = await this.session(input.turn.session);
    return this.taskGate(scopeOf(session), async () => {
      const { resultDigest } = await this.reviewable(input.turn);
      if (resultDigest !== input.resultDigest) throw new StorageError('conflict', '成果摘要已变化，请重新读取原成果。');
      return this.acceptance.record({ turn: input.turn, resultDigest: input.resultDigest, decision: input.choice === 'accept' ? 'accepted' : 'rejected', actor: this.actor(), now: this.now(), ...(input.comment === undefined ? {} : { comment: input.comment }) });
    });
  }

  private config(): TaskExecutionConfiguration { if (!this.execution) throw new StorageError('unsupported', '任务执行尚未配置。'); return this.execution; }
  private now(): Date { return this.config().now?.() ?? new Date(); }
  private actor(): string { return this.config().actor?.() ?? 'local-user'; }
  private selection(driver: DriverRef, model: ModelSelection, tools: ExecutionSpec['tools'], materialIDs: string[]): void {
    const validate = this.config().validateSelection;
    if (!validate && driver.mode !== 'simulation') throw new StorageError('unsupported', '外部执行器尚未注册。');
    if (!validate && (model.provider_id !== 'simulation' || model.model_id !== 'simulation-v1' || model.variant !== undefined)) throw new StorageError('unsupported', '模拟执行仅支持明确标注的模拟模型。');
    if (driver.mode === 'external' && (tools.kind !== 'none' || materialIDs.length)) throw new StorageError('unsupported', '首版外部执行仅支持本次输入和无工具范围。');
    validate?.(driver, model);
  }
  private async session(ref: TaskSessionRef): Promise<TaskSessionRecord> {
    const value = exactObject(ref, ['format', 'sessionID']);
    if (value.format !== 'task-v2' || !isUUID(value.sessionID)) throw new StorageError('invalid-input', '任务会话引用无效。');
    const session = await this.config().manager.loadTaskSession(ref);
    if (!session) throw new StorageError('missing-session', '任务会话不存在。'); validatePreviewPlanScope(scopeOf(session)); return session;
  }
  private async turn(ref: TaskTurnRef): Promise<TaskTurnRecord> { validateTaskTurnRef(ref); const turn = await this.config().manager.getTaskTurn(ref); if (!turn) throw new StorageError('missing-turn', '任务轮次不存在。'); return turn; }
  private snapshotTurn(ref: TaskTurnRef, session: TaskSessionRecord): TaskTurnRecord {
    const turns = session.turns.filter(turn => turn.turn_id === ref.turnID);
    if (session.conversation_id !== ref.session.sessionID || turns.length !== 1) throw new StorageError('conflict', '成果轮次不属于唯一的原会话快照。');
    return turns[0]!;
  }
  private async scan(scope: PreviewPlanScope): Promise<TaskSessionRecord[]> {
    const listing = await this.config().manager.listTaskSessions({ projectID: scope.project_id, taskID: scope.task_id });
    if (listing.diagnostics.length) throw new StorageError('conflict', '任务会话记录未完整核对，不能启动或修改计划。');
    if (listing.records.some(session => !same(scopeOf(session), scope))) throw new StorageError('conflict', '任务会话关联不一致。');
    if (listing.records.some(session => this.config().manager.hasTaskPendingWrites(session.conversation_id))) throw new StorageError('persistence', '任务有尚未持久化的记录，请先重试本地保存。');
    return listing.records;
  }
  private async assertTaskIdle(scope: PreviewPlanScope, except?: TaskTurnRef): Promise<void> {
    for (const session of await this.scan(scope)) for (const turn of session.turns) if (unresolved(turn) && (!except || !same(refOf(session, turn), except))) throw new StorageError(turn.state === 'unknown' ? 'execution-unknown' : 'conflict', '同一任务有未决执行，请取消或核对原轮次。');
  }
  private async currentPlan(id: string, version: number, scope: PreviewPlanScope): Promise<PreviewPlan> {
    const plan = await this.store.load(id);
    if (!plan || !plan.scope || !same(plan.scope, scope) || plan.version !== version) throw new StorageError('conflict', '计划关联或版本已变化，请重新申请授权。'); return plan;
  }
  private executableItem(plan: PreviewPlan, id: string): PlanWorkItem {
    const item = plan.work_items.find(value => value.id === id);
    if (!item) throw new StorageError('invalid-input', '计划工作项不存在。');
    if (item.assignee === 'human') throw new StorageError('unsupported', '人工工作项不能由执行器启动。');
    if (item.assignee === 'chat') throw new StorageError('unsupported', '聊天工作项暂未接入任务执行；请继续使用普通聊天。');
    return item;
  }
  private async materials(scope: PreviewPlanScope, ids: string[]): Promise<Array<{ reference: MaterialRef; bytes: Uint8Array }>> {
    const resolved = await this.config().resolveMaterials(scope, ids);
    if (resolved.length !== ids.length || resolved.some((value, index) => value.reference.referenceID !== ids[index] || createHash('sha256').update(value.bytes).digest('hex') !== value.reference.contentDigest)) throw new StorageError('conflict', '输入材料内容或所属引用已变化。'); return resolved;
  }
  private async dependencies(plan: PreviewPlan, ids: string[]): Promise<ExecutionSpec['dependencies']> {
    const records = await this.acceptance.list(); const result: ExecutionSpec['dependencies'] = [];
    for (const workItemID of ids) {
      let accepted: AcceptanceRecord | undefined;
      for (const candidate of records.filter(record => record.decision === 'accepted').sort((a, b) => b.decided_at.localeCompare(a.decided_at) || a.id.localeCompare(b.id))) {
        const session = await this.session(candidate.turn.session); if (!same(scopeOf(session), plan.scope)) continue;
        const turn = this.snapshotTurn(candidate.turn, session);
        if (turn.execution.spec.work.planID !== plan.id || turn.execution.spec.work.planVersion !== plan.version || turn.execution.spec.work.workItemID !== workItemID) continue;
        const review = await this.reviewable(candidate.turn);
        if (!same(scopeOf(review.session), plan.scope) || review.turn.execution.spec.work.planID !== plan.id || review.turn.execution.spec.work.planVersion !== plan.version || review.turn.execution.spec.work.workItemID !== workItemID || review.resultDigest !== candidate.resultDigest) throw new StorageError('conflict', '依赖成果的验收摘要已变化。');
        accepted = candidate; break;
      }
      if (!accepted) throw new StorageError('not-approved', '依赖工作项尚无当前计划版本的人工验收证据。');
      result.push({ workItemID, acceptanceID: accepted.id });
    }
    return result;
  }
  private async frozenCurrent(ref: TaskTurnRef, turn: TaskTurnRecord, scope: PreviewPlanScope): Promise<{ workspaceRoot: string; materials: Array<{ reference: MaterialRef; bytes: Uint8Array }> }> {
    const spec = turn.execution.spec; const plan = await this.currentPlan(spec.work.planID, spec.work.planVersion, scope); const item = this.executableItem(plan, spec.work.workItemID);
    this.selection(spec.driver, turn.requested_model, spec.tools, spec.materials.map(value => value.referenceID));
    if (spec.title !== item.title || spec.kind !== item.kind || spec.expectedResult !== item.expected_result || !same(spec.dependencies.map(value => value.workItemID), item.dependencies)) throw new StorageError('conflict', '冻结的工作项范围与当前计划不符。');
    for (const dependency of spec.dependencies) {
      const record = await this.acceptance.load(dependency.acceptanceID);
      if (!record || record.decision !== 'accepted') throw new StorageError('not-approved', '依赖验收不存在或未通过。');
      const reviewed = await this.reviewable(record.turn);
      if (!same(scopeOf(reviewed.session), scope) || !same(reviewed.turn.execution.spec.work, { planID: plan.id, planVersion: plan.version, workItemID: dependency.workItemID }) || reviewed.resultDigest !== record.resultDigest) throw new StorageError('conflict', '依赖验收不属于本计划版本。');
    }
    const workspace = await this.config().resolveWorkspace(scope, spec.workspace.workspaceID);
    const materials = await this.materials(scope, spec.materials.map(value => value.referenceID));
    if (!same(workspace.workspace, spec.workspace) || !same(materials.map(value => value.reference), spec.materials) || !same(this.config().driverRef(spec.driver.driverID), spec.driver)) throw new StorageError('conflict', '工作区、输入材料或执行器已变化，请重新申请。');
    if (this.config().manager.hasTaskPendingWrites(ref.session.sessionID)) throw new StorageError('persistence', '原轮次尚未持久化。');
    return { workspaceRoot: safeRoot(workspace.root), materials };
  }
  private permission(turn: TaskTurnRecord, request: ApprovalRequest): PermissionExchange {
    if (request.target.kind !== 'tool') throw new StorageError('invalid-input', '此审批不是工具许可。');
    const target = request.target;
    const permission = turn.execution.permissions.find(value => value.externalRequestID === target.externalRequestID);
    if (!permission || permission.actionDigest !== target.actionDigest) throw new StorageError('conflict', '工具许可目标或动作摘要已改变。'); return permission;
  }
  private async reviewable(ref: TaskTurnRef, verify = true): Promise<{ session: TaskSessionRecord; turn: TaskTurnRecord; resultDigest: string }> {
    const session = await this.session(ref.session); const turn = this.snapshotTurn(ref, session);
    if (turn.state !== 'finished' || !turn.execution.result || this.config().manager.hasTaskPendingWrites(ref.session.sessionID) || unresolvedPermission(turn)) throw new StorageError('conflict', '仅可验收已持久化、已核对许可的 finished 成果。');
    const resultDigest = taskResultDigest(turn, session);
    if (verify) await this.config().verifyResult(turn, turn.execution.result, ref);
    return { session, turn, resultDigest };
  }
  private async closeExpiredPreparations(scope: PreviewPlanScope): Promise<void> {
    for (const session of await this.scan(scope)) for (const turn of session.turns) {
      if (turn.execution.authorizationID || !['prepared', 'failed', 'cancelled'].includes(turn.state)) continue;
      const ref = refOf(session, turn); const requests = await this.config().approvals.listExecutionApprovals(ref);
      const startup = requests.filter(request => request.target.kind === 'execution');
      const expired = turn.state === 'prepared' && (startup.some(request => request.invalidation || Date.parse(request.expires_at) <= this.now().getTime()) || !startup.length && Date.parse(turn.created_at) + 15 * 60 * 1000 <= this.now().getTime());
      if (turn.state !== 'prepared' || expired) {
        for (const request of requests.filter(request => !request.invalidation)) await this.config().approvals.invalidate(request.id, expired ? '准备授权已过期，必须创建新轮次。' : '本地准备已结束，不再许可启动。');
        if (expired) await this.config().manager.failPreparedTaskTurn(ref, '准备授权已过期，请创建新轮次重新申请。');
      }
    }
  }
  private taskGate<T>(scope: PreviewPlanScope, operation: () => Promise<T>): Promise<T> {
    validatePreviewPlanScope(scope); const key = canonicalDigest(scope); const prior = this.taskQueues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(async () => {
      try { return await withExclusiveLock(join(this.root, `.task-${key}.lock`), operation); }
      catch (error) { if (error instanceof StorageError && error.code === 'locked') throw new StorageError('conflict', '同一任务正在由另一写入者修改，请核对后重试。'); throw error; }
    });
    this.taskQueues.set(key, run); void run.finally(() => { if (this.taskQueues.get(key) === run) this.taskQueues.delete(key); }).catch(() => undefined);
    return run;
  }
}
