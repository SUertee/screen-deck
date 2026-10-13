import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SessionManager } from '../core/session-manager.js';
import { validatePreviewPlanScope, type TaskOrchestrator } from '../core/task-orchestrator.js';
import { ApprovalService } from '../core/approval-service.js';
import { checkDirectories, readBytes, StorageError } from '../core/private-storage.js';
import { validateModel } from '../core/session-schema.js';
import type { ProjectWorkspaceReader } from '../projects/reader.js';
import type { PreviewPlanScope } from '../shared/types.js';
import type { AuthorizationInput, DriverRef, HarnessErrorCode, MaterialRef, TaskSessionRef, TaskTurnRef, ToolPolicy, WorkspaceRef } from '../shared/task-execution.js';
import type { ElectronHost } from './electron-host.js';
import { payload, textInput, uuidInput } from './ipc-validation.js';

export const SIMULATION_DRIVER_IDS = ['simulation-success', 'simulation-failure', 'simulation-unknown'] as const;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableUUID = (value: unknown): string => {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};
const scopeInput = (input: unknown): { projectID: string; taskID: string } => {
  const value = payload(input, ['projectID', 'taskID']);
  const projectID = textInput(value.projectID, 100); const taskID = textInput(value.taskID, 100);
  validatePreviewPlanScope({ project_id: projectID, task_id: taskID });
  return { projectID, taskID };
};
const sessionInput = (input: unknown): TaskSessionRef => {
  const value = payload(input, ['format', 'sessionID']);
  if (value.format !== 'task-v2') throw new StorageError('invalid-input', '此入口只接受任务会话。');
  return { format: 'task-v2', sessionID: uuidInput(value.sessionID) };
};
const turnInput = (input: unknown): TaskTurnRef => {
  const value = payload(input, ['session', 'turnID']);
  return { session: sessionInput(value.session), turnID: uuidInput(value.turnID) };
};
const relativePath = (input: unknown): string => {
  const value = textInput(input, 4096);
  if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => part === '..' || !part)) throw new StorageError('invalid-input', '工具范围只能使用项目内相对路径。');
  return value;
};
const toolsInput = (input: unknown): ToolPolicy => {
  const kind = (input as { kind?: unknown } | undefined)?.kind;
  const value = payload(input, kind === 'none' ? ['kind'] : ['kind', 'readRoots', 'writeRoots', 'commands']);
  if (kind === 'none') return { kind: 'none' };
  if (kind !== 'restricted' || !Array.isArray(value.readRoots) || !Array.isArray(value.writeRoots) || !Array.isArray(value.commands) || value.readRoots.length > 32 || value.writeRoots.length > 32 || value.commands.length > 32) throw new StorageError('invalid-input', '工具范围无效。');
  // This preview only simulates one file action. Command scope is deliberately unavailable.
  if (value.commands.length) throw new StorageError('unsupported', '本轮模拟执行不支持命令许可。');
  return { kind: 'restricted', readRoots: value.readRoots.map(relativePath), writeRoots: value.writeRoots.map(relativePath), commands: [] };
};
const authorizationInput = (input: unknown): AuthorizationInput => {
  const value = payload(input, ['planID', 'expectedPlanVersion', 'workItemID', 'session', 'clientRequestID', 'text', 'materialIDs', 'workspaceID', 'driverID', 'model', 'tools']);
  if (!Number.isSafeInteger(value.expectedPlanVersion) || (value.expectedPlanVersion as number) < 1 || !Array.isArray(value.materialIDs) || value.materialIDs.length > 32) throw new StorageError('invalid-input', '计划版本或材料选择无效。');
  validateModel(value.model);
  if ((value.model as { provider_id: string; model_id: string; variant?: string }).provider_id !== 'simulation' || (value.model as { model_id: string }).model_id !== 'simulation-v1' || (value.model as { variant?: string }).variant !== undefined) throw new StorageError('unsupported', '模拟执行仅支持明确标注的模拟模型。');
  const text = textInput(value.text, 1024 * 1024);
  if (!text.trim()) throw new StorageError('invalid-input', '请先填写本次工作项输入。');
  const materialIDs = value.materialIDs.map(id => textInput(id, 200));
  if (new Set(materialIDs).size !== materialIDs.length) throw new StorageError('invalid-input', '材料不能重复选择。');
  return {
    planID: uuidInput(value.planID), expectedPlanVersion: value.expectedPlanVersion as number,
    workItemID: uuidInput(value.workItemID), session: sessionInput(value.session), clientRequestID: uuidInput(value.clientRequestID), text, materialIDs,
    workspaceID: uuidInput(value.workspaceID), driverID: textInput(value.driverID, 200), model: value.model as AuthorizationInput['model'], tools: toolsInput(value.tools),
  };
};
const errorCode = (error: StorageError): HarnessErrorCode => {
  if (['invalid-input', 'conflict', 'not-approved', 'unsupported', 'persistence', 'execution-unknown'].includes(error.code)) return error.code as HarnessErrorCode;
  if (/approv|authoriz|expir|denied/.test(error.code)) return 'not-approved';
  if (/unknown|uncertain/.test(error.code)) return 'execution-unknown';
  if (/locked|busy|conflict|changed|missing|stale/.test(error.code)) return 'conflict';
  if (/write|save|read|file|scan/.test(error.code)) return 'persistence';
  return 'invalid-input';
};

/** Trusted fixed IPC for preview execution. It never loads provider credentials. */
export function installTaskExecutionRoutes({ manager, plans, projects, host, previewRoot, approvals = new ApprovalService(previewRoot) }: {
  manager: SessionManager; plans: TaskOrchestrator; projects: ProjectWorkspaceReader; host: ElectronHost; previewRoot: string; approvals?: ApprovalService;
}): void {
  const generation = randomUUID();
  const currentScope = (scope: PreviewPlanScope) => {
    const record = projects.get(scope.project_id);
    if (!record?.project || record.status !== 'ready' || !record.project.history_bound || !record.tasks.some(task => task.project_id === scope.project_id && task.task_id === scope.task_id)) throw new StorageError('conflict', '任务来源未确认或已失效，请先刷新项目。');
    return record;
  };
  const workspaceOf = (scope: PreviewPlanScope): { workspace: WorkspaceRef; root: string } => {
    const record = currentScope(scope); const project = record.project!;
    return {
      workspace: { workspaceID: stableUUID([scope.project_id, project.root_path]), bindingDigest: digest([scope.project_id, project.root_path, project.created_at, project.name, record.loaded_at, generation]) },
      root: project.root_path,
    };
  };
  const resolveWorkspace = async (scope: PreviewPlanScope, workspaceID: string) => {
    const resolved = workspaceOf(scope);
    if (resolved.workspace.workspaceID !== workspaceID || !await checkDirectories(resolved.root)) throw new StorageError('conflict', '工作区绑定已变化，请重新申请。');
    const identity = await readBytes(join(resolved.root, '.screendeck', 'project.json'), 64 * 1024);
    let actual: Record<string, unknown> | undefined;
    try { actual = JSON.parse(identity?.toString('utf8') ?? 'null'); } catch { /* fail closed */ }
    const project = currentScope(scope).project!;
    const expected = { schema_version: 2, kind: 'project', project_id: project.project_id, name: project.name, created_at: project.created_at };
    if (!actual || Array.isArray(actual) || Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => actual![key] !== value)) throw new StorageError('conflict', '项目身份已变化，请刷新并重新关联。');
    const latest = workspaceOf(scope);
    if (latest.workspace.bindingDigest !== resolved.workspace.bindingDigest) throw new StorageError('conflict', '核对期间项目已刷新，请重新申请。');
    return resolved;
  };
  const driverRef = (driverID: string): DriverRef => {
    if (!(SIMULATION_DRIVER_IDS as readonly string[]).includes(driverID)) throw new StorageError('unsupported', '当前只开放模拟执行器。');
    return { driverID, configDigest: digest([driverID, 'simulation-v1', generation]), mode: 'simulation' };
  };
  const resolveMaterials = async (scope: PreviewPlanScope, ids: string[]) => {
    const registered = currentScope(scope);
    const result: Array<{ reference: MaterialRef; bytes: Uint8Array }> = []; let total = 0;
    for (const id of ids) {
      const ref = registered.artifact_refs.find(value => value.reference_id === id && (value.owner_kind === 'project' || value.owner_kind === 'task' && value.owner_id === scope.task_id || value.owner_kind === 'run' && registered.runs.some(run => run.run_id === value.owner_id && run.task_id === scope.task_id)));
      if (!ref) throw new StorageError('invalid-input', '所选材料不属于当前项目任务。');
      const preview = await projects.preview(scope.project_id, id);
      const bytes = preview.type === 'text' ? Buffer.from(preview.text, 'utf8') : Buffer.from(preview.base64, 'base64');
      total += bytes.length;
      if (total > 4 * 1024 * 1024) throw new StorageError('invalid-input', '所选输入材料总计超过4 MiB。');
      result.push({ reference: { referenceID: id, contentDigest: createHash('sha256').update(bytes).digest('hex') }, bytes });
    }
    return result;
  };
  plans.configureExecution({
    manager, approvals, resolveWorkspace, driverRef, resolveMaterials,
    checkWorkspaceBinding: (scope, workspace) => {
      const current = workspaceOf(scope).workspace;
      if (current.workspaceID !== workspace.workspaceID || current.bindingDigest !== workspace.bindingDigest) throw new StorageError('conflict', '项目注册绑定已刷新，请重新申请授权。');
    },
    verifyResult: async (turn, result, ref) => {
      if (turn.execution.spec.driver.mode !== 'simulation') throw new StorageError('unsupported', '当前只能验收明确标注的模拟结果。');
      const session = await manager.loadTaskSession(ref.session);
      if (!session) throw new StorageError('conflict', '原任务会话不存在。');
      const refs = [...result.artifacts, ...result.evidence];
      if (!refs.length) return;
      const material = await resolveMaterials({ project_id: session.scope.project_id, task_id: session.scope.task_id }, refs.map(ref => ref.referenceID));
      for (let index = 0; index < refs.length; index++) if (material[index]?.reference.contentDigest !== refs[index].contentDigest) throw new StorageError('conflict', '成果内容已变化，不能验收此版本。');
    },
    actor: () => 'local-desktop-user',
  });
  const handler = (channel: string, operation: (input: unknown) => unknown) => host.handle(channel, async input => {
    try { return { ok: true, value: await operation(input) }; }
    catch (error) { return { ok: false, error: { code: error instanceof StorageError ? errorCode(error) : 'persistence', message: error instanceof StorageError ? error.message : '任务操作未完成，请核对本地记录后重试。' } }; }
  });
  manager.subscribeTask(event => host.broadcastTask(event));
  handler('task-execution-options', input => {
    const scope = scopeInput(input);
    return { workspace: workspaceOf({ project_id: scope.projectID, task_id: scope.taskID }).workspace, drivers: SIMULATION_DRIVER_IDS.map(driverRef), model: { provider_id: 'simulation', model_id: 'simulation-v1' } };
  });
  handler('create-task-session', input => {
    const value = payload(input, ['title', 'projectID', 'taskID']); const scope = scopeInput({ projectID: value.projectID, taskID: value.taskID });
    currentScope({ project_id: scope.projectID, task_id: scope.taskID });
    return manager.createTaskSession({ ...scope, title: textInput(value.title, 600) });
  });
  handler('list-task-sessions', input => manager.listTaskSessions(scopeInput(input)));
  handler('load-task-session', input => manager.loadTaskSession(sessionInput(input)));
  handler('request-execution-authorization', input => plans.requestExecutionAuthorization(authorizationInput(input)));
  handler('list-execution-approvals', input => plans.listExecutionApprovals(turnInput(input)));
  handler('decide-execution-approval', input => {
    const value = payload(input, ['requestID', 'choice']);
    if (value.choice !== 'approve' && value.choice !== 'reject') throw new StorageError('invalid-input', '请选择批准或拒绝。');
    return plans.decideApproval({ requestID: uuidInput(value.requestID), choice: value.choice });
  });
  handler('start-task-execution', input => {
    const value = payload(input, ['turn', 'approvalID']);
    return plans.startExecution({ turn: turnInput(value.turn), approvalID: uuidInput(value.approvalID) });
  });
  handler('cancel-task-execution', input => plans.cancelExecution(turnInput(input)));
  handler('reply-task-permission', input => {
    const value = payload(input, ['turn', 'approvalID']);
    return plans.replyToolPermission({ turn: turnInput(value.turn), approvalID: uuidInput(value.approvalID) });
  });
  handler('reconcile-task-execution', input => plans.reconcileExecution(turnInput(input)));
  handler('get-work-item-review', async input => {
    const turn = turnInput(input);
    return plans.getWorkItemReview(turn);
  });
  handler('review-work-item', async input => {
    const value = payload(input, ['turn', 'resultDigest', 'choice', 'comment']);
    if (value.choice !== 'accept' && value.choice !== 'reject' || typeof value.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultDigest)) throw new StorageError('invalid-input', '验收决定或成果摘要无效。');
    const turn = turnInput(value.turn);
    return plans.reviewWorkItem({ turn, resultDigest: value.resultDigest, choice: value.choice, ...(value.comment === undefined ? {} : { comment: textInput(value.comment, 4096) }) });
  });
  handler('retry-task-pending-writes', input => manager.retryTaskPendingWrites(sessionInput(input)));
}
