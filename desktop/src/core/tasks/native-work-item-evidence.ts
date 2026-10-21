import type { AgentExecutionRecord } from '../../shared/agent-execution.js';
import { boundedString, canonicalDigest, exactObject } from '../storage/execution-records.js';
import { StorageError } from '../storage/private-storage.js';
import type { NativeHostReport, NativeHostVerifier, NativeTaskRef, NativeWorkItemAttempt, NativeWorkItemOwner } from './native-work-item-contract.js';
import { nativeAttempt, sameNative, type NativeWorkItemServices } from './native-work-item-bridge.js';
export interface NativeWorkItemEvidence {
  attemptID: string; inputDigest: string; sessionID: string; turnID: string; clientRequestID: string;
  /** This is Agent output, never an independent verification claim. */
  summary: string; native: AgentExecutionRecord;
  host?: NativeHostReport;
  digest: string;
}
function validateReport(report: NativeHostReport): void {
  exactObject(report, ['verifier', 'artifacts', 'checks']);
  if (!boundedString(report.verifier, 200) || !Array.isArray(report.artifacts) || report.artifacts.length > 128 || !Array.isArray(report.checks) || report.checks.length > 128) throw new StorageError('invalid-evidence', '宿主证据无效。');
  for (const a of report.artifacts) {
    exactObject(a, ['reference', 'sha256', 'bytes']);
    if (!boundedString(a.reference, 4096) || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes < 0) throw new StorageError('invalid-evidence', '产物指纹无效。');
  }
  for (const c of report.checks) {
    exactObject(c, ['name', 'outcome', 'outputDigest']);
    if (!boundedString(c.name, 1024) || !['passed', 'failed', 'unknown'].includes(c.outcome) || !/^[a-f0-9]{64}$/.test(c.outputDigest)) throw new StorageError('invalid-evidence', '检查证据无效。');
  }
  if (new Set(report.artifacts.map(a => a.reference)).size !== report.artifacts.length || new Set(report.checks.map(c => c.name)).size !== report.checks.length) throw new StorageError('invalid-evidence', '证据重复。');
}
/** Review only: no plan completion, tool invocation or approval granting. */
export class NativeWorkItemEvidenceService {
  constructor(private owner: NativeWorkItemOwner, private services: NativeWorkItemServices, private verifier?: NativeHostVerifier, private snapshots?: { record(evidence: NativeWorkItemEvidence): Promise<void> }) {}
  async collect(task: NativeTaskRef, attemptID: string): Promise<NativeWorkItemEvidence> {
    return this.owner.withTask(task, async tx => {
      const a = await nativeAttempt(tx, attemptID);
      if (!sameNative(a.input.task, task)) throw new StorageError('invalid-evidence', '尝试来源不匹配。');
      return this.collectAttempt(a);
    });
  }
  /** Owner calls this while holding its task gate, avoiding a nested lock for dependencies. */
  async collectAttempt(a: Readonly<NativeWorkItemAttempt>): Promise<NativeWorkItemEvidence> {
      if ( !a.sessionID || !a.turnID || !a.clientRequestID) throw new StorageError('invalid-evidence', '尝试没有可靠原生绑定。');
      const session = await this.services.sessions.loadAgentSession(a.sessionID);
      const record = await this.services.execution.read(a.sessionID, a.turnID);
      const turn = session?.turns.find(t => t.turn_id === a.turnID);
      if (!session || session.turns.length !== 1 || !turn || turn.client_request_id !== a.clientRequestID || !record || record.sessionID !== a.sessionID || record.turnID !== a.turnID || record.clientRequestID !== a.clientRequestID || !sameNative(record.source, session.source) || !sameNative(record.source, { agentID: a.source.agentID, configDigest: a.source.configDigest }) || !sameNative(record.context, a.input.context) || !session.binding || !sameNative(record.binding, session.binding) || record.binding?.runtimeID !== a.source.runtimeID || record.binding?.connectionGeneration !== a.source.connectionGeneration || session.messages.filter(m => m.role === 'user').length !== 1 || session.messages.find(m => m.role === 'user')?.text !== a.prompt) throw new StorageError('invalid-evidence', '原生结果来源不匹配。');
      if (turn.state !== a.status || record.status !== a.status) throw new StorageError('invalid-evidence', '执行事实尚未一致，请先核对原尝试。');
      const summary = session.messages.filter(m => m.turn_id === a.turnID && m.role === 'assistant').map(m => m.text).join('\n');
      const host = this.verifier ? await this.verifier.inspect(structuredClone(a)) : undefined;
      if (host) validateReport(host);
      const value = { attemptID: a.id, inputDigest: a.inputDigest, sessionID: a.sessionID, turnID: a.turnID, clientRequestID: a.clientRequestID, summary, native: record, ...(host ? { host } : {}) };
      const evidence = { ...structuredClone(value), digest: canonicalDigest(value) };
      await this.snapshots?.record(evidence);
      return evidence;
  }
  async decide(task: NativeTaskRef, attemptID: string, input: { evidenceDigest: string; decision: 'accepted' | 'rejected'; actor: string; comment: string }): Promise<void> {
    exactObject(input, ['evidenceDigest', 'decision', 'actor', 'comment']);
    if (!/^[a-f0-9]{64}$/.test(input.evidenceDigest) || !['accepted', 'rejected'].includes(input.decision) || !boundedString(input.actor, 200) || typeof input.comment !== 'string' || Buffer.byteLength(input.comment) > 8192) throw new StorageError('invalid-evidence', '人工验收输入无效。');
    // collect takes the same non-reentrant task gate. Run it first, then compare fresh native facts below.
    const evidence = await this.collect(task, attemptID);
    if (evidence.digest !== input.evidenceDigest) throw new StorageError('result-changed', '结果或证据已变化。');
    await this.owner.withTask(task, async tx => {
      const a = await nativeAttempt(tx, attemptID);
      if (a.acceptance) {
        if (!sameNative(a.acceptance, input)) throw new StorageError('conflict', '原成果已有不同决定。');
        return;
      }
      if (input.decision === 'accepted') {
        const plan = await tx.loadPlan();
        if (!plan || canonicalDigest(plan) !== a.planDigest) throw new StorageError('plan-conflict', '计划版本已变化，不能验收旧尝试为当前成果。');
        await this.owner.assertDependencies(tx, plan, a.input.workItemID);
        const native = await this.services.execution.read(evidence.sessionID, evidence.turnID);
        const session = await this.services.sessions.loadAgentSession(evidence.sessionID);
        const summary = session?.messages.filter(m => m.turn_id === evidence.turnID && m.role === 'assistant').map(m => m.text).join('\n');
        if (a.status !== 'finished' || session?.turns.find(t => t.turn_id === evidence.turnID)?.state !== 'finished' || summary !== evidence.summary || !sameNative(native, evidence.native) || native?.status !== 'finished' || native.tools.some(t => t.status !== 'completed') || native.approvals.some(p => p.state !== 'decided' || p.decision !== 'allow' || p.reply !== 'queued')) throw new StorageError('not-acceptable', '执行未成功、拒绝或结果未知不能接受。');
        if (!this.verifier || !evidence.host || !evidence.host.artifacts.length || !evidence.host.checks.length || evidence.host.checks.some(c => c.outcome !== 'passed')) throw new StorageError('unverified-result', '缺少宿主产物和通过的检查证据。');
        await this.verifier.verify(structuredClone(a), structuredClone(evidence.host));
      }
      a.acceptance = structuredClone(input); await tx.saveAttempt(a);
    });
  }
}
