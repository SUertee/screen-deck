import type { PlanningCandidate, GeneratedPlanDraft, PlanningRequest } from './task-planning-contract.js';
import { boundedString, canonicalDigest, exactObject, strictDate } from '../storage/execution-records.js';
import { StorageError } from '../storage/private-storage.js';
import { validateModel, isUUID } from '../sessions/session-schema.js';
import { validateAgentBinding, validateAgentSource } from '../sessions/agent-session-schema.js';
import { digestString } from './native-work-item-durable-schema.js';
export const planningFail = (message: string): never => { throw new StorageError('planning-invalid', message); };
export function validatePlanningCandidates(value: unknown): PlanningCandidate[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) planningFail('需要1至16个真实候选。');
  const candidates = value as PlanningCandidate[];
  for (const c of candidates) {
    exactObject(c, ['id', 'kind', 'label', 'supportedKinds'], ['source']);
    if (!boundedString(c.id, 100) || !boundedString(c.label, 200) || !Array.isArray(c.supportedKinds) || !c.supportedKinds.length || new Set(c.supportedKinds).size !== c.supportedKinds.length || c.supportedKinds.some(k => !['discussion', 'implementation', 'validation'].includes(k))) planningFail('候选能力无效。');
    if (c.kind === 'human') { if (c.source) planningFail('人工候选不能伪装模型。'); }
    else if (c.kind === 'agent') {
      const s = c.source; if (!s) planningFail('Agent候选缺少实际连接。');
      validateAgentSource({ agentID: s!.agentID, configDigest: s!.configDigest }); validateAgentBinding({ runtimeID: s!.runtimeID, connectionGeneration: s!.connectionGeneration, externalSessionID: 'candidate' }); validateModel(s!.model);
      if (s!.state !== 'ready' || !s!.capabilities.tools || !s!.capabilities.approvals || !s!.capabilities.nativeContext) planningFail('候选尚无所需原生执行能力。');
      exactObject(s, ['agentID', 'name', 'protocol', 'capabilities', 'state', 'runtimeID', 'connectionGeneration', 'configDigest', 'model']);
    } else planningFail('候选类型无效。');
  }
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) planningFail('候选标识重复。');
  return structuredClone(candidates);
}
/** Gateways sometimes prepend a reasoning block or wrap the final JSON in one code fence.
 * Only unwrap those envelopes; never search arbitrary prose for an executable plan. */
export function parseGeneratedPlanText(text: string, candidates: PlanningCandidate[]): GeneratedPlanDraft {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) planningFail('规划响应过大。');
  let body = text.trim();
  const end = body.indexOf('</think>');
  if (end >= 0) {
    if (body.indexOf('</think>', end + 8) >= 0) planningFail('规划思考块格式无效。');
    body = body.slice(end + 8).trim();
  }
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  return validateGeneratedPlan(JSON.parse(body), candidates);
}
export function validateGeneratedPlan(value: unknown, candidates: PlanningCandidate[]): GeneratedPlanDraft {
  const v = exactObject(value, ['steps']); validatePlanningCandidates(candidates);
  if (!Array.isArray(v.steps) || !v.steps.length || v.steps.length > 32) planningFail('计划必须包含1至32个子任务。');
  const draft = v as unknown as GeneratedPlanDraft, keys = new Set<string>();
  for (const s of draft.steps) {
    exactObject(s, ['key', 'title', 'kind', 'completion_conditions', 'dependencies', 'candidateIDs', 'preferredCandidateID']);
    if (typeof s.key !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(s.key) || keys.has(s.key) || !boundedString(s.title, 600) || !['discussion', 'implementation', 'validation'].includes(s.kind) || !Array.isArray(s.completion_conditions) || !s.completion_conditions.length || s.completion_conditions.length > 8 || s.completion_conditions.some(v => !boundedString(v, 400)) || s.completion_conditions.join('\n').length > 4096 || !Array.isArray(s.dependencies) || s.dependencies.length > 8 || new Set(s.dependencies).size !== s.dependencies.length || !Array.isArray(s.candidateIDs) || !s.candidateIDs.length || s.candidateIDs.length > 16 || new Set(s.candidateIDs).size !== s.candidateIDs.length || !s.candidateIDs.includes(s.preferredCandidateID)) planningFail('子任务字段或边界无效。');
    for (const id of s.candidateIDs) { const c = candidates.find(c => c.id === id); if (!c || !c.supportedKinds.includes(s.kind)) planningFail('计划引用不存在或能力不足的候选。'); }
    keys.add(s.key);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string) => {
    if (!keys.has(key)) planningFail('依赖不存在。'); if (visiting.has(key)) planningFail('计划包含依赖环。'); if (visited.has(key)) return;
    visiting.add(key); for (const dep of draft.steps.find(s => s.key === key)!.dependencies) visit(dep); visiting.delete(key); visited.add(key);
  };
  draft.steps.forEach(s => visit(s.key));
  if (Buffer.byteLength(JSON.stringify(draft)) > 48 * 1024) planningFail('计划草稿过大。');
  return structuredClone(draft);
}
export function validatePlanningRequest(value: unknown): PlanningRequest {
  const v = exactObject(value, ['schema_version', 'taskID', 'id', 'createdAt', 'inputDigest', 'baseVersion', 'baseDigest', 'candidates', 'status'], ['source', 'observedModel', 'draft', 'draftDigest', 'failure', 'confirmation']);
  const r = v as unknown as PlanningRequest;
  if (r.schema_version !== 1 || !strictDate(r.createdAt) || !isUUID(r.taskID) || !isUUID(r.id) || !digestString(r.inputDigest) || !digestString(r.baseDigest) || !Number.isSafeInteger(r.baseVersion) || r.baseVersion < 1 || !['generating', 'draft', 'failed', 'unknown'].includes(r.status)) planningFail('规划记录无效。');
  validatePlanningCandidates(r.candidates);
  if (r.source) { exactObject(r.source, ['kind', 'requestedModel', 'configDigest']); validateModel(r.source.requestedModel); if (r.source.kind !== 'chat-completions' || !digestString(r.source.configDigest)) planningFail('规划模型来源无效。'); }
  if (r.observedModel) validateModel(r.observedModel);
  if (r.draft) { validateGeneratedPlan(r.draft, r.candidates); if (r.status !== 'draft' || r.draftDigest !== canonicalDigest(r.draft)) planningFail('规划指纹无效。'); }
  if (r.status === 'draft' && (!r.source || !r.draft)) planningFail('缺少完成的规划结果。');
  if (r.failure !== undefined && !['not-submitted', 'invalid-result', 'uncertain'].includes(r.failure)) planningFail('规划失败状态无效。');
  if (r.confirmation) { const c = exactObject(r.confirmation, ['assignmentDigest', 'targetDigest', 'draft', 'assignments', 'state'], ['savedVersion']); validateGeneratedPlan(c.draft, r.candidates);
    if (!Array.isArray(c.assignments) || c.assignments.length !== r.confirmation.draft.steps.length) planningFail('确认分工无效。');
    const chosen = new Map<string, string>(); for (const a of r.confirmation.assignments) { exactObject(a, ['stepKey', 'candidateID']); if (chosen.has(a.stepKey)) planningFail('确认分工重复。'); chosen.set(a.stepKey, a.candidateID); }
    if (r.confirmation.draft.steps.some(s => !s.candidateIDs.includes(chosen.get(s.key)!)) || canonicalDigest({ draft: c.draft, assignments: [...chosen.entries()].sort() }) !== c.assignmentDigest) planningFail('确认内容指纹不匹配。');
    if (!digestString(c.assignmentDigest) || !digestString(c.targetDigest) || !['intent', 'saved'].includes(String(c.state)) || c.state === 'saved' && c.savedVersion !== r.baseVersion + 1 || r.status !== 'draft') planningFail('计划确认回执无效。'); }
  return structuredClone(r);
}
