import { assertFileTaskIdle, assertLegacyFileTaskIdle } from '../sessions/file-task-lifecycle.js';
import { AgentChatRegistry, type AgentChatRegistration } from '../agents/agent-chat-registry.js';
import type { AgentExecutionController } from '../agents/agent-execution-controller.js';
import type { PreviewPlan } from '../../shared/types.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { StorageError } from '../storage/private-storage.js';
import { NativeWorkItemBridge } from './native-work-item-bridge.js';
import { NativeWorkItemEvidenceStore } from './native-work-item-evidence-store.js';
import { NativeWorkItemEvidenceService } from './native-work-item-evidence.js';
import { NativeWorkItemDispatchGuard } from './native-work-item-dispatch-guard.js';
import { DurableNativeWorkItemOwner, type DurableNativeOwnerOptions } from './native-work-item-durable-owner.js';
import { FileNativeHostVerifier, validateNativeEvidenceSelection, type NativeEvidenceSelection } from './native-work-item-host-verifier.js';
import { validateNativeTaskMaterials } from './native-work-item-task-adapter.js';
import type { NativeTaskRef, NativeWorkItemInput } from './native-work-item-contract.js';

export interface NativeWorkItemRuntimeOptions extends Pick<DurableNativeOwnerOptions, 'root' | 'loadPlan' | 'transactPlan' | 'approvals' | 'validateMaterials' | 'now' | 'onAttemptSaved'> {
  execution: AgentExecutionController;
  /** Raw adapters, before the existing execution wrapper. */
  registrations: readonly AgentChatRegistration[];
  /** Creates the one existing SessionManager with this exact registry; preserve other options. */
  createSessions(registry: AgentChatRegistry): SessionManager;
  actor(): string;
  onBackgroundError?(): void;
  handoffContext?(plan: import('../../shared/types.js').PreviewPlan): Promise<string>;
}
export function createNativeWorkItemRuntime(options: NativeWorkItemRuntimeOptions) {
  const host = new FileNativeHostVerifier(options.root);
  const snapshots = new NativeWorkItemEvidenceStore(options.root);
  let evidence: NativeWorkItemEvidenceService;
  let sessions: SessionManager;
  const owner = new DurableNativeWorkItemOwner({ ...options, validateMaterials: options.validateMaterials ?? validateNativeTaskMaterials,
    assertOtherExecutionsIdle: async task => {
      if (task.kind !== 'project') return;
      const scope = { project_id: task.projectID, task_id: task.taskID };
      await assertFileTaskIdle(options.root, scope); await assertLegacyFileTaskIdle(options.root, scope);
      const listing = await sessions.listTaskSessions({ projectID: task.projectID, taskID: task.taskID });
      if (listing.diagnostics.length || listing.records.some(s => s.scope.project_id !== task.projectID || s.scope.task_id !== task.taskID || sessions.hasTaskPendingWrites(s.conversation_id) || s.turns.some(t => !['finished', 'failed', 'cancelled'].includes(t.state) || t.execution.permissions.some(p => p.delivery === 'sending' || p.delivery === 'unknown' || !p.delivery && !['failed', 'cancelled'].includes(t.state))))) throw new StorageError('legacy-task-active', '旧任务有活动、未补存或未知执行。');
    },
    evidenceSelectionDigest: a => host.selectionDigest(a),
    verifyAcceptedDependency: async a => {
      const e = await evidence.collectAttempt(a);
      if (!a.acceptance || e.digest !== a.acceptance.evidenceDigest || !e.host) throw new StorageError('dependency-evidence-changed', '依赖验收证据已变化。');
      await host.verify(a, e.host);
    },
  });
  const dispatch = new NativeWorkItemDispatchGuard(id => owner.isManagedSession(id), async permit => {
    await owner.withTask(permit.input.task, async tx => {
      const current = (await tx.attempts()).find(a => a.id === permit.id);
      if (!current || current.status !== 'dispatching' || current.inputDigest !== permit.inputDigest || current.sessionID !== permit.sessionID) throw new StorageError('dispatch-expired', '原尝试已停止或提交范围变化。');
    });
  });
  const registry = new AgentChatRegistry(options.registrations.map(r => ({ ...r, driver: options.execution.wrap(dispatch.wrap(r.driver)) })));
  sessions = options.createSessions(registry);
  const services = { sessions, execution: options.execution, dispatch, drivers: registry, handoffContext: options.handoffContext };
  const bridge = new NativeWorkItemBridge(owner, services);
  evidence = new NativeWorkItemEvidenceService(owner, services, host, snapshots);
  return {
    owner, host, registry, sessions, bridge, evidence, snapshots,
    async prepare(input: NativeWorkItemInput, selection: NativeEvidenceSelection) {
      const checked = validateNativeEvidenceSelection(selection);
      const attempt = await bridge.prepare(input);
      // No model is sent here. An interrupted selection save leaves preparation blocked safely.
      await owner.withTask(input.task, async tx => {
        const current = (await tx.attempts()).find(a => a.id === attempt.id);
        if (!current) throw new StorageError('attempt-not-prepared', '尝试不能变更验收范围。');
        await host.bindSelection(current, checked);
      });
      return attempt;
    },
    /** Reply after durable reservation; stream/tool approvals continue in the original SessionManager. */
    begin(task: NativeTaskRef, attemptID: string, approvalID: string): Promise<import('./native-work-item-contract.js').NativeWorkItemAttempt> {
      return new Promise((resolve, reject) => {
        let announced = false;
        void bridge.start(task, attemptID, approvalID, attempt => { announced = true; resolve(attempt); }).then(resolve, error => {
          if (!announced) reject(error);
          else { try { options.onBackgroundError?.(); } catch { /* Diagnostics cannot trigger another send. */ } }
        });
      });
    },
    decideStart(task: NativeTaskRef, approvalID: string, choice: 'approved' | 'rejected') { return owner.decideStartApproval(task, approvalID, choice, options.actor()); },
    decideResult(task: NativeTaskRef, attemptID: string, input: { evidenceDigest: string; decision: 'accepted' | 'rejected'; comment: string }) {
      return evidence.decide(task, attemptID, { ...input, actor: options.actor() });
    },
    /** Called inside TaskOrchestrator's shared plan/task gate; never reacquires its lock. */
    assertPlanIdle(plan: PreviewPlan) { return owner.assertIdle(plan); },
  };
}
export type NativeWorkItemRuntime = ReturnType<typeof createNativeWorkItemRuntime>;
