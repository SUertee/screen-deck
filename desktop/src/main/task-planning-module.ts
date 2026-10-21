import type { JevCandidate } from './jev-service.js';
import type { PlanningCandidate } from '../core/tasks/task-planning-contract.js';
import { validatePlanningCandidates } from '../core/tasks/task-planning-schema.js';
import { TaskPlanningService } from '../core/tasks/task-planning-service.js';
import { TaskSequentialQueueService } from '../core/tasks/task-sequential-queue.js';
import { ConfiguredTaskPlanningModel } from './task-planning-model.js';
import type { NativeWorkItemRuntime } from '../core/tasks/native-work-item-runtime.js';
import type { AgentExecutionController } from '../core/agents/agent-execution-controller.js';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { ProviderSettingsStore } from './provider-settings.js';
import { taskPlanningRouteHandlers } from './task-planning-routes.js';
/** Metadata only: does not connect/start agents, resolve credentials or send a model request. */
export function currentPlanningCandidates(runtime: Pick<NativeWorkItemRuntime, 'registry'>): PlanningCandidate[] {
  const candidates: PlanningCandidate[] = [{ id: 'human', kind: 'human', label: '人工处理', supportedKinds: ['discussion', 'implementation', 'validation'] }];
  for (const source of runtime.registry.listSources()) if (source.state === 'ready' && source.capabilities.tools && source.capabilities.approvals) candidates.push({ id: 'native-' + source.agentID, kind: 'agent', label: source.name, supportedKinds: ['discussion', 'implementation', 'validation'], source });
  return validatePlanningCandidates(candidates);
}
/** Optional choice-evaluation handoff only. Caller still uses existing Jev preview/fee confirmation.
 * This never invokes Jev and cannot generate task text or authorize an executor. */
export function planningCandidatesForJev(candidates: PlanningCandidate[]): JevCandidate[] {
  return validatePlanningCandidates(candidates).map(c => ({ id: c.id, label: c.label, description: c.kind === 'human' ? '人工确认处理' : `${c.source!.name} 当前真实模型 ${c.source!.model.model_id}`, assignee: c.kind === 'human' ? 'human' : 'agent', ...(c.kind === 'agent' ? { agentID: c.source!.agentID } : {}) }));
}
/** No routes registered until A passes these handlers through existing trusted host.handle. */
export function createTaskPlanningModule(input: { root: string; plans: TaskOrchestrator; native: NativeWorkItemRuntime; execution: AgentExecutionController; settings: ProviderSettingsStore; changed?: ConstructorParameters<typeof TaskPlanningService>[0]['changed'] }) {
  const planning = new TaskPlanningService({ root: input.root, plans: input.plans, model: new ConfiguredTaskPlanningModel(input.settings), candidates: () => currentPlanningCandidates(input.native), changed: input.changed });
  const queue = new TaskSequentialQueueService({ root: input.root, plans: input.plans, runtime: input.native, execution: input.execution });
  return { planning, queue, handlers: { ...taskPlanningRouteHandlers(planning, queue), 'task:planning:status': () => { const status = input.settings.publicSettings(); return { configured: status.hasKey && !!status.modelID, modelID: status.modelID }; }, 'task:planning:candidates': (value: unknown) => { if (value !== undefined && value !== null) throw new Error('不接受候选覆盖。'); return currentPlanningCandidates(input.native); } } };
}
