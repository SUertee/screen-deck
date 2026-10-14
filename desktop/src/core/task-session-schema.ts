import { createHash } from 'node:crypto';
import type { ModelSelection } from '../shared/types.js';
import type { ExecutionSpec, TaskSessionRecord, TaskTurnRecord, ToolAction, ToolPolicy } from '../shared/task-execution.js';
import { isUUID, validateModel, validateSession, SESSION_LIMITS } from './session-schema.js';
import { StorageError } from './private-storage.js';

export const canonicalTask = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTask).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTask((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new StorageError('invalid-task-record', '任务记录必须为有限 JSON 值。');
};
export const taskDigest = (value: unknown): string => createHash('sha256').update(canonicalTask(value)).digest('hex');
export const taskSpecDigest = (spec: ExecutionSpec, model: ModelSelection, text: string): string => taskDigest({ spec, model, text });
export function taskResultDigest(turn: TaskTurnRecord, session?: TaskSessionRecord): string {
  const result = { specDigest: turn.execution.specDigest, result: turn.execution.result ?? null };
  // Existing simulation acceptance IDs must remain byte-for-byte compatible.
  if (turn.execution.spec.driver.mode === 'simulation') return taskDigest(result);
  const turns = session?.turns.filter(value => value.turn_id === turn.turn_id);
  const assistants = session?.messages.filter(value => value.turn_id === turn.turn_id && value.role === 'assistant');
  if (!turns || turns.length !== 1 || canonicalTask(turns[0]) !== canonicalTask(turn) || !assistants || assistants.length !== 1 || !isUUID(assistants[0]!.message_id) || typeof assistants[0]!.text !== 'string') throw new StorageError('conflict', '成果必须绑定同一会话快照中唯一的原助手消息。');
  const assistant = assistants[0]!;
  return taskDigest({ ...result, assistant: { message_id: assistant.message_id, textDigest: createHash('sha256').update(assistant.text).digest('hex') } });
}
const fail = (): never => { throw new StorageError('invalid-task-record', '任务执行记录字段无效，原文件未覆盖。'); };
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const fields = (value: Record<string, unknown>, required: string[], optional: string[] = []) => { if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(); };
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= max;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const array = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail();
export function validateTaskPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || value.startsWith('/') || value.includes('\\') || /[\0\r\n]/.test(value) || value.split('/').some(part => part === '..') || !value.length) fail();
}
const refs = (value: unknown, max: number) => { for (const raw of array(value, max)) { const ref = obj(raw); fields(ref, ['referenceID', 'contentDigest']); if (!bounded(ref.referenceID, 200) || !digest(ref.contentDigest)) fail(); } };
export function validateTaskTools(value: unknown): asserts value is ToolPolicy {
  const tools = obj(value);
  if (tools.kind === 'none') { fields(tools, ['kind']); return; }
  if (tools.kind !== 'restricted') fail();
  fields(tools, ['kind', 'readRoots', 'writeRoots', 'commands']);
  for (const path of [...array(tools.readRoots, 32), ...array(tools.writeRoots, 32)]) validateTaskPath(path);
  for (const raw of array(tools.commands, 32)) { const command = obj(raw); fields(command, ['argv', 'cwd']); validateTaskPath(command.cwd); const args = array(command.argv, 64); if (!args.length || args.some(arg => !bounded(arg, 4096))) fail(); }
}
export function validateTaskAction(value: unknown): asserts value is ToolAction {
  const action = obj(value);
  if (action.kind === 'file-read') { fields(action, ['kind', 'path']); validateTaskPath(action.path); }
  else if (action.kind === 'file-write') { fields(action, ['kind', 'path', 'content']); validateTaskPath(action.path); if (typeof action.content !== 'string' || Buffer.byteLength(action.content) > SESSION_LIMITS.messageBytes) fail(); }
  else if (action.kind === 'command') { fields(action, ['kind', 'argv', 'cwd']); validateTaskPath(action.cwd); const args = array(action.argv, 64); if (!args.length || args.some(arg => !bounded(arg, 4096))) fail(); }
  else fail();
}
export function taskActionAllowed(action: ToolAction, policy: ToolPolicy): boolean {
  validateTaskAction(action); validateTaskTools(policy);
  if (policy.kind === 'none') return false;
  if (action.kind === 'command') return policy.commands.some(command => canonicalTask(command) === canonicalTask({ argv: action.argv, cwd: action.cwd }));
  return (action.kind === 'file-read' ? policy.readRoots : policy.writeRoots).some(root => root === '.' || action.path === root || action.path.startsWith(`${root.replace(/\/+$/, '')}/`));
}
export function validateExecutionSpec(value: unknown): asserts value is ExecutionSpec {
  const spec = obj(value); fields(spec, ['work', 'title', 'kind', 'expectedResult', 'dependencies', 'inputMessageID', 'materials', 'workspace', 'driver', 'tools']);
  const work = obj(spec.work); fields(work, ['planID', 'planVersion', 'workItemID']);
  if (!isUUID(work.planID) || !isUUID(work.workItemID) || !Number.isSafeInteger(work.planVersion) || (work.planVersion as number) < 1 || !isUUID(spec.inputMessageID) || !bounded(spec.title, 600) || !bounded(spec.expectedResult, 4096) || !['discussion', 'implementation', 'validation'].includes(String(spec.kind))) fail();
  const seen = new Set<string>();
  for (const raw of array(spec.dependencies, 1000)) { const dependency = obj(raw); fields(dependency, ['workItemID', 'acceptanceID']); if (!isUUID(dependency.workItemID) || !isUUID(dependency.acceptanceID) || seen.has(dependency.workItemID)) fail(); seen.add(dependency.workItemID as string); }
  refs(spec.materials, 32);
  const workspace = obj(spec.workspace); fields(workspace, ['workspaceID', 'bindingDigest']); if (!isUUID(workspace.workspaceID) || !digest(workspace.bindingDigest)) fail();
  const driver = obj(spec.driver); fields(driver, ['driverID', 'configDigest', 'mode']); if (!bounded(driver.driverID, 200) || !digest(driver.configDigest) || !['simulation', 'external'].includes(String(driver.mode))) fail();
  validateTaskTools(spec.tools);
  if (Buffer.byteLength(canonicalTask(spec)) > 2 * 1024 * 1024) fail();
}
export function validateTaskResult(value: unknown): void {
  const result = obj(value); fields(result, ['summary', 'artifacts', 'evidence']); if (!bounded(result.summary, SESSION_LIMITS.messageBytes)) fail(); refs(result.artifacts, 64); refs(result.evidence, 64);
}
export function validateTaskBinding(value: unknown): void {
  const binding = obj(value); fields(binding, ['runtimeID', 'connectionGeneration', 'externalSessionID'], ['externalSubmissionID']);
  if (!bounded(binding.runtimeID, 200) || !bounded(binding.connectionGeneration, 200) || !bounded(binding.externalSessionID, 200) || binding.externalSubmissionID !== undefined && !bounded(binding.externalSubmissionID, 200)) fail();
}
export function validateTaskSession(value: unknown, persisted = false): asserts value is TaskSessionRecord {
  const session = obj(value); fields(session, ['schema_version', 'kind', 'conversation_id', 'title', 'scope', 'created_at', 'updated_at', 'revision', 'turns', 'messages']);
  if (session.schema_version !== 2 || session.kind !== 'electron_task_session') fail();
  const scope = obj(session.scope); fields(scope, ['kind', 'project_id', 'task_id']); if (scope.kind !== 'project' || typeof scope.task_id !== 'string') fail();
  const turns = array(session.turns, SESSION_LIMITS.turns);
  // Reuse the unchanged v1 primitive/message validation without writing or decoding v1.
  const { kind: _, ...baseSession } = session;
  validateSession({ ...baseSession, schema_version: 1, turns: turns.map(raw => { const turn = obj(raw); const { execution: _, ...base } = turn; return { ...base, state: 'prepared' }; }) }, persisted);
  for (const raw of turns) {
    const turn = obj(raw); if (!['prepared', 'submitting', 'running', 'awaiting_permission', 'cancelling', 'finished', 'failed', 'cancelled', 'unknown'].includes(String(turn.state))) fail();
    const execution = obj(turn.execution); fields(execution, ['spec', 'specDigest', 'eventReceipts', 'permissions'], ['authorizationID', 'external', 'result']);
    validateExecutionSpec(execution.spec); if (!digest(execution.specDigest) || execution.authorizationID !== undefined && !isUUID(execution.authorizationID)) fail();
    if (turn.state === 'prepared' && (execution.authorizationID !== undefined || execution.external !== undefined || execution.result !== undefined)) fail();
    if (['submitting', 'running', 'awaiting_permission', 'cancelling', 'finished'].includes(String(turn.state)) && execution.authorizationID === undefined || turn.state === 'finished' && execution.result === undefined) fail();
    const spec = execution.spec;
    const input = (session.messages as TaskSessionRecord['messages']).find(message => message.message_id === spec.inputMessageID && message.turn_id === turn.turn_id && message.role === 'user');
    if (!input || taskSpecDigest(execution.spec, turn.requested_model as ModelSelection, input.text) !== execution.specDigest) fail();
    if (execution.external !== undefined) validateTaskBinding(execution.external);
    if (execution.result !== undefined) validateTaskResult(execution.result);
    const requestIDs = new Set<string>();
    for (const rawPermission of array(execution.permissions, 128)) {
      const permission = obj(rawPermission); fields(permission, ['externalRequestID', 'action', 'actionDigest'], ['approvalID', 'delivery']); validateTaskAction(permission.action);
      if (!bounded(permission.externalRequestID, 200) || requestIDs.has(permission.externalRequestID) || permission.actionDigest !== taskDigest(permission.action) || permission.approvalID !== undefined && !isUUID(permission.approvalID) || permission.delivery !== undefined && (!isUUID(permission.approvalID) || !['sending', 'accepted', 'rejected', 'unknown'].includes(String(permission.delivery)))) fail();
      requestIDs.add(permission.externalRequestID as string);
    }
    const eventIDs = new Set<string>(); const sequences = new Set<number>();
    for (const rawReceipt of array(execution.eventReceipts, 4096)) {
      const receipt = obj(rawReceipt); fields(receipt, ['eventID', 'sequence', 'digest']);
      if (!bounded(receipt.eventID, 200) || !Number.isSafeInteger(receipt.sequence) || (receipt.sequence as number) < 1 || !digest(receipt.digest) || eventIDs.has(receipt.eventID) || sequences.has(receipt.sequence as number)) fail();
      eventIDs.add(receipt.eventID as string); sequences.add(receipt.sequence as number);
    }
  }
}
export function decodeTaskSession(bytes: Buffer): TaskSessionRecord {
  if (bytes.length > SESSION_LIMITS.fileBytes) throw new StorageError('too-large', '任务会话超过容量上限。');
  let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
  validateTaskSession(value, true); return value;
}
