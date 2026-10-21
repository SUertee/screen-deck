import type { TaskGoalDraftInput } from './task-goal';
import type { PreviewPlan } from './types';
export interface ChatTaskReference { source: 'model' | 'agent'; sessionID: string; messageID: string }
export interface ChatTaskSource extends ChatTaskReference { sessionTitle: string; turnID: string; role: 'user' | 'assistant'; text: string; digest: string }
export interface CreateChatTaskInput extends TaskGoalDraftInput {
  source: ChatTaskReference & { digest: string }; excerpt?: string;
}

/** Immutable creation provenance and idempotent receipt; no whole conversation text. */
export interface ChatTaskOrigin {
  requestID: string; requestDigest: string; source: 'model' | 'agent'; sessionID: string;
  messageID: string; turnID: string; messageDigest: string;
}
export interface ChatTaskAPI {
  createTaskDraft(input: TaskGoalDraftInput): Promise<PreviewPlan>;
  getChatTaskSource(input: ChatTaskReference): Promise<ChatTaskSource>;
  createTaskFromChat(input: CreateChatTaskInput): Promise<PreviewPlan>;
}

export type ChatTaskCreateReply = { ok: true; plan: PreviewPlan } | { ok: false; error: { message: string; code: string; safeToEdit: boolean } };
