import type { AgentChatReadySource } from '../../shared/agent-chat.js';
import type { ModelSelection, PlanWorkItem, PreviewPlan } from '../../shared/types.js';
export interface PlanningCandidate {
  id: string; kind: 'human' | 'agent'; label: string;
  supportedKinds: PlanWorkItem['kind'][];
  source?: AgentChatReadySource;
}
export interface GeneratedPlanStep {
  key: string; title: string; kind: PlanWorkItem['kind']; completion_conditions: string[];
  dependencies: string[]; candidateIDs: string[]; preferredCandidateID: string;
}
export interface GeneratedPlanDraft { steps: GeneratedPlanStep[] }
export interface PlanningSource { kind: 'chat-completions'; requestedModel: ModelSelection; configDigest: string }
export interface PlanningModel {
  capture(): Promise<{ source: PlanningSource; generate(prompt: string, signal: AbortSignal): Promise<{ text: string; observedModel?: ModelSelection }> }>;
}
export interface PlanningPlans {
  loadPlan(id: string): Promise<PreviewPlan | undefined>;
  transactPlan<T>(id: string, operation: (current: PreviewPlan) => Promise<{ plan?: PreviewPlan; value: T }>): Promise<{ plan?: PreviewPlan; value: T }>;
}
export interface GenerateTaskPlanInput { taskID: string; expectedVersion: number; clientRequestID: string; selectedMaterialIDs: string[] }
export interface PlanConfirmation {
  assignmentDigest: string; targetDigest: string; draft: GeneratedPlanDraft; assignments: Array<{ stepKey: string; candidateID: string }>; state: 'intent' | 'saved'; savedVersion?: number;
}
export interface PlanningRequest {
  schema_version: 1; taskID: string; id: string; createdAt: string; inputDigest: string; baseVersion: number; baseDigest: string;
  candidates: PlanningCandidate[]; status: 'generating' | 'draft' | 'failed' | 'unknown';
  source?: PlanningSource; observedModel?: ModelSelection; draft?: GeneratedPlanDraft; draftDigest?: string;
  failure?: 'not-submitted' | 'invalid-result' | 'uncertain'; confirmation?: PlanConfirmation;
}
