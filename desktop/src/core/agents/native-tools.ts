import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentChatLookup, AgentChatExecutionEvent } from '../sessions/agent-chat-driver.js';
import type { AgentNativeApproval, AgentToolActivity } from '../../shared/agent-execution.js';
export const nativeText = (value: unknown, max = 8192): string => typeof value === 'string' ? Buffer.from(value).subarray(0, max).toString('utf8').replace(/\0/g, '') : '';
export function nativeToolKind(value: unknown): AgentToolActivity['kind'] { return value === 'read' || value === 'search' ? 'read' : value === 'edit' || value === 'fileChange' ? 'write' : value === 'execute' || value === 'commandExecution' ? 'command' : 'other'; }
/** In-memory native response handles; persistent decisions belong to the controller. */
export class NativePermissionRequests {
  private pending = new Map<string, { lookup: AgentChatLookup; canAllow: boolean; resolve(value: boolean): void }>();
  async ask(lookup: AgentChatLookup, approval: Omit<AgentNativeApproval, 'id' | 'state' | 'decision' | 'reply'>, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, timeout = 600_000, autoApprove = false): Promise<boolean> {
    if (!lookup.binding) return false;
    const id = randomUUID(); let resolve!: (value: boolean) => void;
    const answer = new Promise<boolean>(done => { resolve = done; });
    this.pending.set(id, { lookup: structuredClone(lookup), canAllow: approval.canAllow, resolve });
    const timer = setTimeout(() => resolve(false), timeout);
    try { await onEvent({ type: 'permission', approval: { ...approval, id }, ...(autoApprove ? { autoApprove: true } : {}) }); return await answer; }
    finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async reply(lookup: AgentChatLookup, approvalID: string, decision: 'allow' | 'deny'): Promise<{ status: 'queued' | 'unknown' }> {
    const pending = this.pending.get(approvalID);
    if (!pending || !isDeepStrictEqual(pending.lookup, lookup) || decision === 'allow' && !pending.canAllow) return { status: 'unknown' };
    this.pending.delete(approvalID); pending.resolve(decision === 'allow'); return { status: 'queued' };
  }
  cancel(lookup: AgentChatLookup): void { for (const [id, pending] of this.pending) if (isDeepStrictEqual(pending.lookup, lookup)) { this.pending.delete(id); pending.resolve(false); } }
}
