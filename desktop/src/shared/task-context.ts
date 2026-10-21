import type { TaskScreenSource } from './types.js';
export interface ConfirmTaskContextInput {
  schemaVersion: 1; confirmationID: string; draftID: string; draftRevision: number;
  target: { key: string; baseVersion: number }; summary: string;
  clues: Array<{ source: TaskScreenSource; note: string; excerpt?: { kind: 'user-reviewed'; text: string } }>;
}
export interface ConfirmTaskContextReceipt { confirmationID: string; materialID: string; targetKey: string; savedVersion: number }
