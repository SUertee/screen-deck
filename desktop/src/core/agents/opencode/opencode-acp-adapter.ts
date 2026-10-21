import { ExecutionError } from '../../sessions/execution-driver.js';
import type { TaskExecutionDriver } from '../../sessions/task-execution-driver.js';
import type { ExecutionLookup, ExternalObservation, TaskEventEnvelope, TaskExecutionRequest } from '../../../shared/task-execution.js';
import { OpenCodeAcpSessionClient, acpSameModel, type OpenCodeAcpSessionOptions } from './opencode-acp-session.js';

export type OpenCodeAcpAdapterOptions = OpenCodeAcpSessionOptions;
const DRIVER_ID = 'opencode-acp-no-tools';
const result = () => ({ summary: 'OpenCode ACP 无工具文本回复已结束；没有工作区变更或执行产物。', artifacts: [], evidence: [] });

/** Task-specific authorization and result projection over the concrete ACP session client.
 * A task turn always creates a fresh native session, without mounting its workspace.
 */
export class OpenCodeAcpAdapter implements TaskExecutionDriver {
  readonly capabilities = Object.freeze({ chat: false, tools: false, remoteSessions: true, remoteAbort: true });
  readonly taskCapabilities = Object.freeze({ reconcile: false, confirmedCancel: true, permissionReply: false, enforcedToolScope: false });
  private readonly sessions: OpenCodeAcpSessionClient;
  private readonly scopes = new Map<string, string>();
  constructor(options: OpenCodeAcpAdapterOptions) { this.sessions = new OpenCodeAcpSessionClient(options); }
  async executeTask(request: TaskExecutionRequest, onEvent: (event: TaskEventEnvelope) => Promise<void>, signal: AbortSignal): Promise<void> {
    const connection = this.sessions.getConnection();
    if (request.spec.driver.driverID !== DRIVER_ID || request.spec.driver.mode !== 'external' || request.spec.driver.configDigest !== connection.configDigest || request.spec.kind !== 'discussion' || request.spec.tools.kind !== 'none' || request.spec.materials.length || request.resolved.materials.length || !acpSameModel(request.model, connection.model) || request.model.variant !== undefined) throw new ExecutionError('configuration', 'ACP 首版只接受当前模型、无工具、无附件的明确讨论文本。', false);
    const key = this.key(connection.runtimeID, connection.connectionGeneration, request.clientRequestID);
    if (!this.scopes.has(key) && this.scopes.size < 2000) this.scopes.set(key, JSON.stringify(request.spec.workspace));
    let sequence = 0;
    await this.sessions.send({ ownerID: `task:${request.turn.session.sessionID}`, clientRequestID: request.clientRequestID, configDigest: request.spec.driver.configDigest, model: request.model, input: request.input, continuous: false, preparationCountsAsAttempt: true }, async event => {
      const normalized: TaskEventEnvelope['event'] = event.type === 'settled' ? event.outcome === 'finished' ? { type: 'settled', outcome: 'finished', result: result() } : { type: 'settled', outcome: event.outcome, reason: event.reason } : event;
      const next = ++sequence;
      await onEvent({ eventID: `${request.turn.turnID}:${next}`, sequence: next, event: normalized });
    }, signal);
  }
  async inspectExecution(lookup: ExecutionLookup): Promise<ExternalObservation> {
    if (!this.validLookup(lookup)) return { status: 'unverifiable', reason: '原 ACP 实例、工作区或尝试无法确认。' };
    const proof = this.sessions.inspect({ clientRequestID: lookup.clientRequestID, configDigest: lookup.driver.configDigest, binding: lookup.binding });
    if (!proof) return { status: 'unverifiable', reason: '没有同一活连接内原 prompt 的已确认终结证据；不会加载会话或重发。' };
    const common = { binding: proof.binding, output: proof.output, permissionReceipts: [] };
    return proof.outcome === 'finished' ? { ...common, status: 'finished', result: result() } : { ...common, status: proof.outcome, reason: proof.reason };
  }
  async cancelExecution(lookup: ExecutionLookup): Promise<{ status: 'confirmed' | 'unknown' }> {
    return this.validLookup(lookup) ? this.sessions.cancel({ clientRequestID: lookup.clientRequestID, configDigest: lookup.driver.configDigest, binding: lookup.binding }) : { status: 'unknown' };
  }
  async replyPermission(): Promise<{ status: 'accepted' | 'rejected' | 'unknown' }> { throw new ExecutionError('tools-forbidden', '此 ACP 连接不开放工具许可。', false); }
  private key(runtimeID: string, generation: string, requestID: string): string { return JSON.stringify([runtimeID, generation, requestID]); }
  private validLookup(lookup: ExecutionLookup): boolean {
    try {
      const connection = this.sessions.getConnection();
      return lookup.driver.driverID === DRIVER_ID && lookup.driver.mode === 'external' && lookup.driver.configDigest === connection.configDigest && this.scopes.get(this.key(connection.runtimeID, connection.connectionGeneration, lookup.clientRequestID)) === JSON.stringify(lookup.workspace);
    } catch { return false; }
  }
}
