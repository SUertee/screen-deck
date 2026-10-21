import { exactObject } from '../storage/execution-records.js';
import { StorageError } from '../storage/private-storage.js';
import { isUUID } from '../sessions/session-schema.js';
import { nativeTaskKey } from './native-work-item-durable-schema.js';
import type { NativeTaskRef, NativeWorkItemInput } from './native-work-item-contract.js';
import type { NativeEvidenceSelection } from './native-work-item-host-verifier.js';
import type { NativeWorkItemRuntime } from './native-work-item-runtime.js';
const target = (input: unknown) => {
  const v = exactObject(input, ['task', 'attemptID']); nativeTaskKey(v.task as NativeTaskRef);
  if (!isUUID(v.attemptID)) throw new StorageError('invalid-input', '尝试标识无效。');
  return v as unknown as { task: NativeTaskRef; attemptID: string };
};
/** Fixed main routes. Register ONLY through main's existing trusted-window IPC wrapper.
 * This returns handlers, never registers unrestricted Electron listeners or expands preload itself. */
export function nativeWorkItemRouteHandlers(runtime: NativeWorkItemRuntime) {
  return {
    'task:native:prepare': async (input: unknown) => {
      const v = exactObject(input, ['input', 'selection']); return runtime.prepare(v.input as NativeWorkItemInput, v.selection as NativeEvidenceSelection);
    },
    'task:native:selection': async (input: unknown) => { const v = target(input); return runtime.owner.withTask(v.task, async tx => { const attempt = (await tx.attempts()).find(a => a.id === v.attemptID); if (!attempt) throw new StorageError('missing-attempt', '尝试不存在。'); return runtime.host.readSelection(attempt); }); },
    'task:native:list': async (input: unknown) => { const v = exactObject(input, ['task']); nativeTaskKey(v.task as NativeTaskRef); return runtime.owner.withTask(v.task as NativeTaskRef, tx => tx.attempts()); },
    'task:native:approval-request': async (input: unknown) => { const v = target(input); return runtime.owner.requestStartApproval(v.task, v.attemptID); },
    'task:native:approval-decide': async (input: unknown) => {
      const v = exactObject(input, ['task', 'approvalID', 'decision']); nativeTaskKey(v.task as NativeTaskRef);
      if (!isUUID(v.approvalID) || !['approved', 'rejected'].includes(String(v.decision))) throw new StorageError('invalid-input', '开始审批输入无效。');
      return runtime.decideStart(v.task as NativeTaskRef, v.approvalID as string, v.decision as 'approved' | 'rejected');
    },
    'task:native:approval-revoke': async (input: unknown) => { const v = exactObject(input, ['task', 'approvalID']); nativeTaskKey(v.task as NativeTaskRef); if (!isUUID(v.approvalID)) throw new StorageError('invalid-input', '审批标识无效。'); return runtime.owner.revokeStartApproval(v.task as NativeTaskRef, v.approvalID as string); },
    'task:native:start': async (input: unknown) => { const v = exactObject(input, ['task', 'attemptID', 'approvalID']); const ref = target({ task: v.task, attemptID: v.attemptID }); if (!isUUID(v.approvalID)) throw new StorageError('invalid-input', '审批标识无效。'); return runtime.begin(ref.task, ref.attemptID, v.approvalID as string); },
    'task:native:refresh': async (input: unknown) => { const v = target(input); return runtime.bridge.refresh(v.task, v.attemptID); },
    'task:native:stop': async (input: unknown) => { const v = target(input); return runtime.bridge.stop(v.task, v.attemptID); },
    'task:native:evidence': async (input: unknown) => { const v = target(input); return runtime.evidence.collect(v.task, v.attemptID); },
    'task:native:evidence-snapshot': async (input: unknown) => {
      const v = exactObject(input, ['task', 'attemptID', 'digest']); const ref = target({ task: v.task, attemptID: v.attemptID });
      return runtime.owner.withTask(ref.task, async tx => {
        const attempt = (await tx.attempts()).find(a => a.id === ref.attemptID);
        const snapshot = await runtime.snapshots.load(ref.attemptID, v.digest as string);
        if (!attempt || !snapshot || snapshot.inputDigest !== attempt.inputDigest) throw new StorageError('missing-evidence', '历史证据不存在或来源不匹配。');
        return snapshot;
      });
    },
    'task:native:acceptance': async (input: unknown) => { const v = exactObject(input, ['task', 'attemptID', 'evidenceDigest', 'decision', 'comment']); const ref = target({ task: v.task, attemptID: v.attemptID }); return runtime.decideResult(ref.task, ref.attemptID, { evidenceDigest: v.evidenceDigest as string, decision: v.decision as 'accepted' | 'rejected', comment: v.comment as string }); },
  };
}
