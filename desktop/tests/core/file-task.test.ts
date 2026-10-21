import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../../src/core/sessions/session-history-store.js';
import { ApprovalService } from '../../src/core/approvals/approval-service.js';
import { FileWriteTool } from '../../src/core/tools/write.js';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import { TaskSessionHistoryStore } from '../../src/core/sessions/task-session-history-store.js';
import { TaskDriverFixture } from '../helpers/task-driver-fixture.js';
import { ExecutionRecordStore } from '../../src/core/storage/execution-records.js';
import { StorageError } from '../../src/core/storage/private-storage.js';
import { fileTurnRef, validateFileSession, type FileTaskSession } from '../../src/core/sessions/file-task-schema.js';
import { assertFileTaskIdle } from '../../src/core/sessions/file-task-lifecycle.js';
import type { ExecutionSpec } from '../../src/shared/task-execution.js';
const chat = { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { assert.fail('No model requests'); } };
async function setup(t: { after: (f: () => Promise<void>) => void }, options: { tool?: FileWriteTool; stopped?: boolean } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sd-file-session-')); t.after(() => rm(root, { recursive: true, force: true }));
  let time = new Date('2026-10-21T00:00:00.000Z');
  const approvals = new ApprovalService(root, { now: () => time, actor: () => 'test-user' });
  const manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'sessions')), driver: chat, task: { store: new TaskSessionHistoryStore(root), driver: new TaskDriverFixture() }, file: { previewRoot: root, approvals, tool: options.tool, confirmWriterStopped: async () => options.stopped === true, now: () => time } });
  const plans = new TaskOrchestrator(root, { fileManager: manager });
  const scope = { project_id: `project-${randomUUID()}`, task_id: 'task-001' };
  const s = await manager.createFileTaskSession({ title: 'Synthetic file', scope });
  const input = { session: { format: 'task-v3' as const, sessionID: s.id }, clientRequestID: randomUUID(), leafName: 'note.md', baseline: Buffer.from('old\n'), completedProposal: { assistantMessageID: randomUUID(), text: JSON.stringify({ schema_version: 1, content: 'new\n' }) } };
  const prepare = () => manager.prepareFileWrite(input);
  const file = (s: FileTaskSession) => join(s.turn!.spec.target.workspaceRoot, s.turn!.spec.target.leafName);
  return { root, approvals, manager, plans, scope, s, input, prepare, file, advance: () => { time = new Date(time.getTime() + 16 * 60 * 1000); } };
}
async function ready(f: Awaited<ReturnType<typeof setup>>) {
  const s = await f.prepare(), ref = fileTurnRef(s); const approval = await f.manager.requestFileWriteApproval(ref); await f.manager.decideFileWrite(ref, approval.id, 'approve'); return { s, ref, approval };
}
test('prepare, approve, apply and acceptance are separate; byte-for-byte immutable artifacts and old records', async t => {
  const f = await setup(t); const legacy = await f.manager.createSession('old chat');
  // Capture the actual old file layout without reading any user data.
  const locate = async (dir: string): Promise<string> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) { const found = await locate(p); if (found) return found; } else if (entry.name === `${legacy.conversation_id}.json`) return p; } return ''; };
  const oldPath = await locate(join(f.root, 'sessions')), oldBytes = await readFile(oldPath);
  const s = await f.prepare(), ref = fileTurnRef(s); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n'); assert.deepEqual(await f.prepare(), s);
  const request = await f.manager.requestFileWriteApproval(ref); await assert.rejects(f.manager.applyFileWrite(ref, request.id), /未通过|尚未获批/);
  await f.manager.decideFileWrite(ref, request.id, 'approve'); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n');
  await assert.rejects(f.plans.acceptFileResult({ turn: ref, resultDigest: 'a'.repeat(64), decision: 'accepted' }));
  const result = await f.manager.applyFileWrite(ref, request.id); assert.equal(result.turn!.state, 'finished'); assert.equal(await readFile(f.file(s), 'utf8'), 'new\n');
  assert.deepEqual(await f.manager.applyFileWrite(ref, request.id), result);
  const review = await f.manager.reviewFileWrite(ref); assert.equal(Buffer.from(review.before).toString(), 'old\n'); assert.equal(Buffer.from(review.after).toString(), 'new\n');
  const accepted = await f.plans.acceptFileResult({ turn: ref, resultDigest: result.turn!.resultDigest!, decision: 'accepted' });
  assert.equal(accepted.schema_version, 2); assert.deepEqual(await f.plans.acceptFileResult({ turn: ref, resultDigest: result.turn!.resultDigest!, decision: 'accepted' }), accepted);
  await assert.rejects(f.plans.acceptFileResult({ turn: ref, resultDigest: result.turn!.resultDigest!, decision: 'rejected' }));
  assert.deepEqual(await readFile(oldPath), oldBytes); assert.equal((await f.manager.loadFileTaskSession(ref.session))!.format, 'task-v3');
});
test('reject malformed proposals, invalid unicode, duplicates, extra keys, no-op and changed retry inputs', async t => {
  const f = await setup(t);
  for (const text of ['```json\n{}\n```', '{"schema_version":1,"content":"x","content":"y"}', '{"schema_version":1,"content":"x","path":"evil"}', '{"schema_version":1,"content":"\\ud800"}', JSON.stringify({ schema_version: 1, content: 'old\n' })]) await assert.rejects(f.manager.prepareFileWrite({ ...f.input, completedProposal: { ...f.input.completedProposal, text } }));
  assert.equal((await f.manager.loadFileTaskSession(f.input.session))!.turn, undefined);
  await f.prepare(); await assert.rejects(f.manager.prepareFileWrite({ ...f.input, baseline: Buffer.from('changed') }), /不可改变/);
  await assert.rejects(f.manager.loadFileTaskSession({ ...f.input.session, format: 'task-v2' } as never));
});
test('denial, expiry, revoked approval, wrong action and cancellation have zero target writes', async t => {
  for (const mode of ['deny', 'expire', 'revoke', 'wrong', 'cancel']) {
    const f = await setup(t); const s = await f.prepare(), ref = fileTurnRef(s), a = await f.manager.requestFileWriteApproval(ref);
    if (mode === 'deny') await f.manager.decideFileWrite(ref, a.id, 'reject');
    else { await f.manager.decideFileWrite(ref, a.id, 'approve'); if (mode === 'expire') f.advance(); if (mode === 'revoke') await f.approvals.invalidateFileWrite(a.id, 'test revoke'); if (mode === 'cancel') await f.manager.cancelFileWrite(ref); }
    if (mode === 'wrong') await assert.rejects(f.manager.applyFileWrite(ref, randomUUID()));
    else await f.manager.applyFileWrite(ref, a.id).catch(() => undefined);
    assert.equal(await readFile(f.file(s), 'utf8'), 'old\n');
    await assert.rejects(f.approvals.requestFileWrite({ ...a.target, actionDigest: 'f'.repeat(64) }));
  }
});
test('two managers race for one durable write claim; result can be inspected without rewriting', async t => {
  let writes = 0; const tool = new FileWriteTool({ rename: async (...args) => { writes++; await rename(...args); } });
  const f = await setup(t, { tool }); const { ref, approval } = await ready(f);
  const second = new SessionManager({ store: new SessionHistoryStore(join(f.root, 'sessions')), driver: chat, file: { previewRoot: f.root, approvals: f.approvals, tool } });
  const results = await Promise.allSettled([f.manager.applyFileWrite(ref, approval.id), second.applyFileWrite(ref, approval.id)]);
  assert.equal(writes, 1); assert.ok(results.some(r => r.status === 'fulfilled')); assert.equal((await f.manager.inspectFileWrite(ref)).turn!.state, 'finished');
});
test('uncertain rename is never retried; restart requires trusted writer-stop evidence', async t => {
  let writes = 0; const tool = new FileWriteTool({ rename: async (...args) => { writes++; await rename(...args); throw new Error('lost acknowledgement'); } });
  const f = await setup(t, { tool }); const { ref, approval } = await ready(f);
  assert.equal((await f.manager.applyFileWrite(ref, approval.id)).turn!.state, 'unknown'); await assert.rejects(f.manager.applyFileWrite(ref, approval.id));
  const restart = (stopped: boolean) => new SessionManager({ store: new SessionHistoryStore(join(f.root, 'sessions')), driver: chat, file: { previewRoot: f.root, approvals: f.approvals, confirmWriterStopped: async () => stopped } });
  assert.equal((await restart(false).inspectFileWrite(ref)).turn!.state, 'unknown');
  assert.equal((await restart(true).inspectFileWrite(ref)).turn!.state, 'finished'); assert.equal(writes, 1);
});
test('lost intent persistence receipt prevents commit; recovery only observes retained stage', async t => {
  let writes = 0; const f = await setup(t, { tool: new FileWriteTool({ rename: async (...args) => { writes++; return rename(...args); } }) }); const { ref, approval, s } = await ready(f);
  const original = ExecutionRecordStore.prototype.update; let inject = true;
  ExecutionRecordStore.prototype.update = async function (this: ExecutionRecordStore<{ id: string }>, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    if (inject && this.directory.endsWith('task-sessions-v3') && (result as FileTaskSession).turn?.intent) { inject = false; throw new StorageError('write-uncertain', 'lost persistence receipt'); }
    return result;
  } as typeof original;
  try { await assert.rejects(f.manager.applyFileWrite(ref, approval.id)); } finally { ExecutionRecordStore.prototype.update = original; }
  assert.equal(writes, 0); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n'); await assert.rejects(f.manager.applyFileWrite(ref, approval.id));
  assert.equal((await f.manager.inspectFileWrite(ref)).turn!.state, 'failed'); assert.equal(writes, 0);
});
test('post-write result save failure is recoverable, original target replaced only once', async t => {
  let writes = 0; const f = await setup(t, { tool: new FileWriteTool({ rename: async (...args) => { writes++; return rename(...args); } }) }); const { ref, approval } = await ready(f);
  const original = ExecutionRecordStore.prototype.update; let inject = true;
  ExecutionRecordStore.prototype.update = function (this: ExecutionRecordStore<{ id: string }>, id, operation) {
    return original.call(this, id, current => {
      const proposed = operation(current);
      if (inject && this.directory.endsWith('task-sessions-v3') && (proposed as FileTaskSession).turn?.state === 'finished') { inject = false; throw new StorageError('write-failed', 'receipt not saved'); }
      return proposed;
    });
  } as typeof original;
  try { await assert.rejects(f.manager.applyFileWrite(ref, approval.id)); } finally { ExecutionRecordStore.prototype.update = original; }
  await assert.rejects(f.manager.applyFileWrite(ref, approval.id)); assert.equal((await f.manager.inspectFileWrite(ref)).turn!.state, 'finished'); assert.equal(writes, 1);
});
test('v3 and legacy task attempts block one another; malformed histories fail closed', async t => {
  const f = await setup(t); await f.prepare(); await assert.rejects(assertFileTaskIdle(f.root, f.scope));
  const plan = await f.plans.createPlan('plan', [], f.scope); await assert.rejects(f.plans.savePlan(plan, plan.version));
  const g = await setup(t); const old = await g.manager.createTaskSession({ title: 'old', projectID: g.scope.project_id, taskID: g.scope.task_id });
  const spec: ExecutionSpec = { work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: 'discussion', kind: 'discussion', expectedResult: 'text', dependencies: [], inputMessageID: randomUUID(), materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: 'a'.repeat(64) }, driver: { driverID: 'fixture', configDigest: 'b'.repeat(64), mode: 'simulation' }, tools: { kind: 'none' } };
  await g.manager.prepareTaskTurn({ session: { format: 'task-v2', sessionID: old.conversation_id }, clientRequestID: randomUUID(), text: 'synthetic', model: { provider_id: 'simulation', model_id: 'simulation' }, spec });
  const oldFile = join(g.root, 'task-sessions-v2', `${old.conversation_id}.json`);
  const unknown = JSON.parse(await readFile(oldFile, 'utf8')); unknown.turns[0].state = 'unknown'; await writeFile(oldFile, JSON.stringify(unknown)); const bytes = await readFile(oldFile);
  await assert.rejects(g.prepare(), /未决旧格式/); assert.deepEqual(await readFile(oldFile), bytes);
  await mkdir(join(g.root, 'task-sessions-v3'), { recursive: true }); await writeFile(join(g.root, 'task-sessions-v3', `${randomUUID()}.json`), '{}'); await assert.rejects(assertFileTaskIdle(g.root, g.scope));
});
test('artifact corruption and schema spoofing cannot produce a receipt or acceptance', async t => {
  const f = await setup(t); const { ref, approval, s } = await ready(f);
  const bad = structuredClone(s) as unknown as Record<string, unknown>; bad.format = 'task-v2'; assert.throws(() => validateFileSession(bad));
  await writeFile(join(f.root, 'execution-artifacts-v1', ref.session.sessionID, ref.turnID, 'replacement.txt'), 'tampered');
  await assert.rejects(f.manager.applyFileWrite(ref, approval.id)); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n');
  await assert.rejects(f.plans.acceptFileResult({ turn: ref, resultDigest: 'a'.repeat(64), decision: 'accepted' }));
});
test('cancellation observed during staging stops the final rename without waiting for I/O to finish', async t => {
  let release!: () => void, staged!: () => void; const held = new Promise<void>(r => { release = r; }); const reached = new Promise<void>(r => { staged = r; }); let writes = 0;
  const { syncFileDirectory } = await import('../../src/core/tools/write.js');
  const tool = new FileWriteTool({ syncDirectory: async root => { staged(); await held; await syncFileDirectory(root); }, rename: async (...args) => { writes++; return rename(...args); } });
  const f = await setup(t, { tool }), { ref, s, approval } = await ready(f);
  const applying = f.manager.applyFileWrite(ref, approval.id); await reached;
  const cancelling = f.manager.cancelFileWrite(ref); release();
  assert.equal((await applying).turn!.state, 'cancelled'); await cancelling; assert.equal(writes, 0); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n');
});
test('expiry and revocation during staging are checked again before any commit', async t => {
  const { syncFileDirectory } = await import('../../src/core/tools/write.js');
  for (const mode of ['expiry', 'revoke']) {
    let release!: () => void, staged!: () => void; const held = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { staged = r; }); let writes = 0;
    const tool = new FileWriteTool({ syncDirectory: async root => { staged(); await held; await syncFileDirectory(root); }, rename: async (...args) => { writes++; return rename(...args); } });
    const f = await setup(t, { tool }), { ref, s, approval } = await ready(f);
    const applying = f.manager.applyFileWrite(ref, approval.id); await reached;
    if (mode === 'expiry') f.advance(); else await f.approvals.invalidateFileWrite(approval.id, 'revoked during stage');
    release(); assert.equal((await applying).turn!.state, 'failed'); assert.equal(writes, 0); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n');
  }
});
test('failed generation proof or result-artifact tampering cannot be accepted; later copy changes do not rewrite frozen results', async t => {
  const f = await setup(t), { ref, approval, s } = await ready(f); const done = await f.manager.applyFileWrite(ref, approval.id);
  await writeFile(f.file(s), 'later independent edit');
  assert.equal((await f.manager.verifyFileResult(ref, done.turn!.resultDigest!)).turn!.state, 'finished');
  const artifact = join(f.root, 'execution-artifacts-v1', ref.session.sessionID, ref.turnID, 'result.txt'); await writeFile(artifact, 'corrupt');
  await assert.rejects(f.plans.acceptFileResult({ turn: ref, resultDigest: done.turn!.resultDigest!, decision: 'accepted' }));
  assert.equal(await readFile(f.file(s), 'utf8'), 'later independent edit');
});
test('uncertain claim save before stage stays blocked and is not inferred successful from unchanged bytes', async t => {
  let stages = 0; const { syncFileDirectory } = await import('../../src/core/tools/write.js');
  const f = await setup(t, { tool: new FileWriteTool({ syncDirectory: async root => { stages++; await syncFileDirectory(root); } }) }); const { ref, approval, s } = await ready(f);
  const original = ExecutionRecordStore.prototype.update; let inject = true;
  ExecutionRecordStore.prototype.update = async function (this: ExecutionRecordStore<{ id: string }>, ...args: Parameters<typeof original>) {
    const saved = await original.apply(this, args);
    if (inject && this.directory.endsWith('task-sessions-v3') && (saved as FileTaskSession).turn?.state === 'sending') { inject = false; throw new StorageError('write-uncertain', 'lost claim receipt'); }
    return saved;
  } as typeof original;
  try { await assert.rejects(f.manager.applyFileWrite(ref, approval.id)); } finally { ExecutionRecordStore.prototype.update = original; }
  assert.equal(stages, 0); assert.equal((await f.manager.inspectFileWrite(ref)).turn!.state, 'unknown'); await assert.rejects(f.manager.applyFileWrite(ref, approval.id)); assert.equal(await readFile(f.file(s), 'utf8'), 'old\n');
});
test('existing TaskOrchestrator request path checks the v3 gate before resolving a runtime or materials', async t => {
  const f = await setup(t); const workID = randomUUID();
  const plan = await f.plans.createPlan('synthetic plan', [{ id: workID, title: 'discussion', kind: 'discussion', assignee: 'unassigned', expected_result: 'text', dependencies: [], status: 'planned' }], f.scope);
  const old = await f.manager.createTaskSession({ title: 'legacy', projectID: f.scope.project_id, taskID: f.scope.task_id });
  f.plans.configureExecution({ manager: f.manager, approvals: f.approvals, resolveWorkspace: async () => assert.fail('No workspace resolution'), driverRef: () => assert.fail('No runtime selection'), resolveMaterials: async () => assert.fail('No materials'), verifyResult: async () => assert.fail('No execution') });
  await f.prepare();
  await assert.rejects(f.plans.requestExecutionAuthorization({ planID: plan.id, expectedPlanVersion: plan.version, workItemID: workID, session: { format: 'task-v2', sessionID: old.conversation_id }, clientRequestID: randomUUID(), text: 'synthetic', materialIDs: [], workspaceID: randomUUID(), driverID: 'fixture', model: { provider_id: 'fixture', model_id: 'fixture' }, tools: { kind: 'none' } }), /未决文件执行/);
});
