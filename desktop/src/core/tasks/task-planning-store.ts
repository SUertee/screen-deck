import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot } from '../storage/private-storage.js';
import { isUUID } from '../sessions/session-schema.js';
import { canonicalDigest } from '../storage/execution-records.js';
import { planningFail, validatePlanningRequest } from './task-planning-schema.js';
import type { PlanningRequest } from './task-planning-contract.js';
const LIMIT = 256 * 1024;
/** Execution metadata under the existing Task. Caller MUST hold TaskOrchestrator.transactPlan. */
export class TaskPlanningStore {
  private root: string;
  constructor(root: string) { this.root = safeRoot(root); }
  private folder(taskID: string) { if (!isUUID(taskID)) planningFail('任务标识无效。'); return join(this.root, 'tasks', taskID, 'planning-requests'); }
  async load(taskID: string, id: string): Promise<PlanningRequest | undefined> {
    if (!isUUID(id)) planningFail('规划请求标识无效。');
    const bytes = await readBytes(join(this.folder(taskID), id + '.json'), LIMIT); if (!bytes) return;
    const record = validatePlanningRequest(JSON.parse(bytes.toString())); if (record.taskID !== taskID || record.id !== id) planningFail('规划请求身份不匹配。'); return record;
  }
  async list(taskID: string): Promise<PlanningRequest[]> {
    const folder = this.folder(taskID); if (!await checkDirectories(folder)) return [];
    const entries = await readdir(folder, { withFileTypes: true }); if (entries.length > 100) planningFail('规划记录超过上限。');
    const records: PlanningRequest[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || !isUUID(entry.name.slice(0, -5))) planningFail('规划记录目录无效。');
      const r = await this.load(taskID, entry.name.slice(0, -5)); if (!r) planningFail('规划记录丢失。'); records.push(r!);
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async save(record: PlanningRequest): Promise<void> {
    validatePlanningRequest(record); const folder = this.folder(record.taskID); await checkDirectories(folder, true);
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.some(e => !e.isFile() || e.isSymbolicLink() || !e.name.endsWith('.json') || !isUUID(e.name.slice(0, -5)))) planningFail('规划目录结构无效。');
    const file = join(folder, record.id + '.json'), old = await readBytes(file, LIMIT);
    if (!old && entries.length >= 100) planningFail('该任务规划请求已达上限。');
    if (old) {
      const previous = validatePlanningRequest(JSON.parse(old.toString()));
      const identity = (v: PlanningRequest) => ({ taskID: v.taskID, id: v.id, inputDigest: v.inputDigest, baseVersion: v.baseVersion, baseDigest: v.baseDigest, createdAt: v.createdAt, candidates: v.candidates });
      if (canonicalDigest(identity(record)) !== canonicalDigest(identity(previous)) || previous.status !== 'generating' && record.status !== previous.status || previous.source && canonicalDigest(record.source ?? null) !== canonicalDigest(previous.source) || previous.draft && canonicalDigest(record.draft ?? null) !== canonicalDigest(previous.draft)) planningFail('规划事实不可回退或替换。');
      if (previous.confirmation && (previous.confirmation.assignmentDigest !== record.confirmation?.assignmentDigest || previous.confirmation.targetDigest !== record.confirmation?.targetDigest || previous.confirmation.state === 'saved' && record.confirmation.state !== 'saved')) planningFail('确认回执不可覆盖。');
    }
    await atomicReplace(file, Buffer.from(JSON.stringify(record)), old, LIMIT);
  }
}
