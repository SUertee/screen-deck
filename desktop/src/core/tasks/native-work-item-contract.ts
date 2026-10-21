import type { AgentChatReadySource } from '../../shared/agent-chat.js';
import type { AgentExecutionContext } from '../../shared/agent-execution.js';
import type { PreviewPlan } from '../../shared/types.js';

/** Host execution identity, mapped from the shared TaskReference at the boundary. */
export type NativeTaskRef = { kind: 'local'; planID: string } | { kind: 'project'; projectID: string; taskID: string; planID: string };
export interface NativeWorkItemInput {
  task: NativeTaskRef; planVersion: number; workItemID: string; clientRequestID: string;
  agentID: string; context: AgentExecutionContext;
  /** Explicitly selected, user-confirmed material summaries only; no implicit history. */
  materials: Array<{ reference: string; digest: string; summary: string }>;
  text: string;
}
export interface NativeWorkItemAttempt {
  id: string; input: NativeWorkItemInput; planDigest: string; prompt: string; inputDigest: string; source: AgentChatReadySource;
  status: 'preparing' | 'prepared' | 'dispatching' | 'finished' | 'failed' | 'cancelled' | 'unknown';
  sessionID?: string;
  /** Turn identity is assigned only by SessionManager, never invented by the bridge. */
  turnID?: string; clientRequestID?: string;
  acceptance?: { decision: 'accepted' | 'rejected'; evidenceDigest: string; actor: string; comment: string };
}
export interface NativeTaskTransaction {
  loadPlan(): Promise<PreviewPlan | undefined>;
  attempts(): Promise<NativeWorkItemAttempt[]>;
  saveAttempt(attempt: NativeWorkItemAttempt): Promise<void>;
}
/** TaskOrchestrator must supply its EXISTING task gate and durable CAS writer.
 * Not a second database. Lock must also cover plan edits and dependency acceptance changes. */
export interface NativeWorkItemOwner {
  withTask<T>(task: NativeTaskRef, operation: (tx: NativeTaskTransaction) => Promise<T>): Promise<T>;
  assertDependencies(tx: NativeTaskTransaction, plan: PreviewPlan, workItemID: string): Promise<void>;
  /** Consumes/checks a current explicit start approval bound to immutable inputDigest and source.
   * Plan assignment, native tool permission and human result acceptance are separate facts. */
  authorizeStart(attempt: NativeWorkItemAttempt, approvalID: string): Promise<void>;
}
export interface NativeHostReport {
  /** Host verifier identity/version. These observations must come from a trusted host service. */
  verifier: string;
  artifacts: Array<{ reference: string; sha256: string; bytes: number }>;
  checks: Array<{ name: string; outcome: 'passed' | 'failed' | 'unknown'; outputDigest: string }>;
}
export interface NativeHostVerifier {
  inspect(attempt: Readonly<NativeWorkItemAttempt>): Promise<NativeHostReport>;
  /** Re-read/revalidate exact artifacts/check observations. No Agent/command invocation here. */
  verify(attempt: Readonly<NativeWorkItemAttempt>, report: Readonly<NativeHostReport>): Promise<void>;
}
