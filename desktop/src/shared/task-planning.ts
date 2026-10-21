import type { PreviewPlan } from './types.js';
import type { ConfirmTaskPlanInput } from '../core/tasks/task-planning-service.js';
import type { GenerateTaskPlanInput, PlanningCandidate, PlanningRequest } from '../core/tasks/task-planning-contract.js';
import type { QueueSetup, TaskSequentialView } from '../core/tasks/task-sequential-queue.js';
/** Type-only UI boundary. Expose only these fixed preload methods; no arbitrary invoke/model endpoint. */
export interface TaskPlanningAPI {
  getTaskPlanningStatus(): Promise<{ configured: boolean; modelID: string }>;
  listTaskPlanDrafts(input: { taskID: string }): Promise<PlanningRequest[]>;
  getTaskPlanningCandidates(): Promise<PlanningCandidate[]>;
  generateTaskPlan(input: GenerateTaskPlanInput): Promise<PlanningRequest>;
  getTaskPlanDraft(input: { taskID: string; requestID: string }): Promise<PlanningRequest | undefined>;
  cancelTaskPlanGeneration(input: { taskID: string; requestID: string }): Promise<void>;
  confirmTaskPlanDraft(input: ConfirmTaskPlanInput): Promise<PreviewPlan>;
  createTaskQueue(input: { taskID: string; expectedVersion: number; clientRequestID: string }): Promise<TaskSequentialView>;
  inspectTaskQueue(input: { taskID: string; queueID: string }): Promise<TaskSequentialView>;
  prepareNextTaskItem(input: { taskID: string; queueID: string; setup: QueueSetup }): Promise<TaskSequentialView>;
  startNextTaskItem(input: { taskID: string; queueID: string; approvalID: string }): Promise<TaskSequentialView>;
  stopTaskQueue(input: { taskID: string; queueID: string }): Promise<TaskSequentialView>;
  reconcileTaskQueue(input: { taskID: string; queueID: string }): Promise<TaskSequentialView>;
}
