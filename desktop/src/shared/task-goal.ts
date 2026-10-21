/** A task may be saved before conditions, work items or assignments exist. */
export interface TaskGoalDraftInput {
  requestID: string; goal: string; title?: string; completionConditions?: string[]; projectID?: string;
}
export interface TaskCreationReceipt { requestID: string; requestDigest: string }
export function taskTitleFromGoal(goal: string): string {
  const first = goal.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  return Array.from(first).slice(0,60).join('');
}
