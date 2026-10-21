import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { isUUID } from '../sessions/session-schema.js';
import { validatePreviewPlan } from '../tasks/plan-schema.js';
import type { PreviewPlan } from '../../shared/types.js';
const LIMIT = 2 * 1024 * 1024;
/** Formal disk format; preserve the existing lossless DTO so frozen attempt digests stay valid. */
export function encodeTask(plan: PreviewPlan): Buffer {
  validatePreviewPlan(plan);
  return Buffer.from(JSON.stringify({ ...plan, schema_version: 1, kind: 'screendeck_task', plan_format_version: plan.schema_version }, null, 2) + '\n');
}
export function decodeTask(bytes: Buffer): PreviewPlan {
  const value = JSON.parse(bytes.toString('utf8'));
  if (value?.schema_version !== 1 || value.kind !== 'screendeck_task' || ![1,2,3].includes(value.plan_format_version)) throw new StorageError('invalid-task', '任务记录格式无效。');
  const { plan_format_version, ...rest } = value;
  return validatePreviewPlan({ ...rest, schema_version: plan_format_version, kind: 'electron_preview_plan' });
}
export class TaskRecordStore {
  private observed = new Map<string, Buffer>();
  private directory: string;
  constructor(root: string) { this.directory = join(safeRoot(root), 'tasks'); }
  async load(id: string): Promise<PreviewPlan | undefined> {
    if (!isUUID(id)) throw new StorageError('invalid-id', '任务标识无效。');
    const bytes = await readBytes(join(this.directory,id,'task.json'),LIMIT);
    if (!bytes) { if(this.observed.has(id)) throw new StorageError('missing-file','已读取任务丢失，未重建。'); return; }
    const task = decodeTask(bytes);
    if(task.id!==id) throw new StorageError('invalid-task','任务身份与目录不一致。');
    this.observed.set(id,bytes); return structuredClone(task);
  }
  async list(): Promise<PreviewPlan[]> {
    if(!await checkDirectories(this.directory)) return [];
    const entries=await readdir(this.directory,{withFileTypes:true});
    if(entries.length>2000) throw new StorageError('too-large','任务数量超过上限。');
    const result:PreviewPlan[]=[];
    for(const entry of entries) {
      if(!entry.isDirectory()||entry.isSymbolicLink()||!isUUID(entry.name)) throw new StorageError('unsafe-path','任务目录结构无效。');
      const plan=await this.load(entry.name); if(!plan) throw new StorageError('missing-file','任务记录不完整。'); result.push(plan);
    }
    return result;
  }
  async save(plan:PreviewPlan,existing:boolean):Promise<PreviewPlan> {
    const bytes=encodeTask(plan);
    return withExclusiveLock(join(this.directory,'..','.tasks.write.lock'),async()=>{
      const expected=this.observed.get(plan.id);
      if(existing&&!expected) throw new StorageError('unobserved-record','请先读取任务。');
      if(existing&&plan.version!==decodeTask(expected!).version+1) throw new StorageError('revision-changed','任务版本已变化。');
      await atomicReplace(join(this.directory,plan.id,'task.json'),bytes,existing?expected:undefined,LIMIT);
      this.observed.set(plan.id,bytes); return structuredClone(plan);
    });
  }
}
