import type { TaskPlanningAPI } from './task-planning.js';
import type { TaskKnowledgeAPI } from './task-knowledge.js';
import type { TaskHandoffAPI } from './task-handoffs.js';
import type { NativeWorkItemInput, NativeWorkItemAttempt, NativeTaskRef } from '../core/tasks/native-work-item-contract.js';
import type { NativeEvidenceSelection } from '../core/tasks/native-work-item-host-verifier.js';
import type { NativeWorkItemEvidence } from '../core/tasks/native-work-item-evidence.js';
import type { NativeStartApproval } from '../core/tasks/native-work-item-durable-schema.js';
import type { JevPreview, JevServiceAdvice } from '../main/jev-service.js';
import type { PreviewPlan } from './types.js';
/** Type-only boundary; preload exposes fixed methods, never arbitrary channels or host service objects. */
export interface TaskIntegrationsAPI extends TaskHandoffAPI, TaskKnowledgeAPI, TaskPlanningAPI {
  nativePrepare(input: { input: NativeWorkItemInput; selection: NativeEvidenceSelection }): Promise<NativeWorkItemAttempt>;
  nativeList(task: NativeTaskRef): Promise<NativeWorkItemAttempt[]>;
  nativeRequestApproval(input: { task: NativeTaskRef; attemptID: string }): Promise<NativeStartApproval>;
  nativeDecideStart(input: { task: NativeTaskRef; approvalID: string; decision: 'approved' | 'rejected' }): Promise<NativeStartApproval>;
  nativeStart(input: { task: NativeTaskRef; attemptID: string; approvalID: string }): Promise<NativeWorkItemAttempt>;
  nativeRefresh(input: { task: NativeTaskRef; attemptID: string }): Promise<NativeWorkItemAttempt>;
  nativeStop(input: { task: NativeTaskRef; attemptID: string }): Promise<void>;
  nativeEvidence(input: { task: NativeTaskRef; attemptID: string }): Promise<NativeWorkItemEvidence>;
  nativeDecideResult(input: { task: NativeTaskRef; attemptID: string; evidenceDigest: string; decision: 'accepted' | 'rejected'; comment: string }): Promise<void>;
  nativeReadSelection(input: { task: NativeTaskRef; attemptID: string }): Promise<NativeEvidenceSelection>;
  nativeMaterials(planID: string): Promise<Array<{id:string;title:string;reference:string;digest:string;summary:string}>>;
  getJevSettings(): Promise<{ hasKey: boolean; model: string }>;
  saveJevSettings(input: { model: string; apiKey?: string }): Promise<{hasKey:boolean;model:string}>;
  previewJevAdvice(input: { planID: string; workItemID: string; materialIDs: string[] }): Promise<{id:string;preview:JevPreview}>;
  requestJevAdvice(input: { id: string; budgetConfirmed: true }): Promise<{id:string;advice:JevServiceAdvice}>;
  applyJevAdvice(input: { id: string; candidateID: string }): Promise<PreviewPlan>;
}
