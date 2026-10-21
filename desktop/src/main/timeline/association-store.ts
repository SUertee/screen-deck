import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicReplace, readBytes, StorageError, withExclusiveLock } from '../../core/storage/private-storage.js';
import { payload, uuidInput } from '../ipc-validation.js';
import { reference } from './validation.js';
import { validateFrameID } from '../recording/recording-store.js';
import { timelineRefKey, type TimelineLinks, type TimelineRef } from '../../shared/timeline.js';
const LIMIT = 2 * 1024 * 1024;
/** Durable user decisions, separate from source formats and disposable timeline snapshots. */
export class TimelineAssociationStore {
  private file: string;
  constructor(root:string) { this.file = path.join(root,'timeline-associations-v1','links.json'); }
  async load():Promise<TimelineLinks> {
    const bytes = await readBytes(this.file,LIMIT); if (!bytes) return {revision:0,links:[]};
    try {
      const v = payload(JSON.parse(bytes.toString()),['schema_version','revision','links']);
      if (v.schema_version !== 1 || !Number.isSafeInteger(v.revision) || (v.revision as number)<0 || !Array.isArray(v.links) || v.links.length>5000) throw new Error();
      const ids = new Set<string>();
      for (const raw of v.links) {
        const link = payload(raw,['id','target','frameIDs','createdAt','removedAt']);
        uuidInput(link.id); reference(link.target);
        if (ids.has(link.id as string)) throw new Error(); ids.add(link.id as string);
        if (!Array.isArray(link.frameIDs) || !link.frameIDs.length || link.frameIDs.length>100 || new Set(link.frameIDs).size !== link.frameIDs.length) throw new Error();
        link.frameIDs.forEach(validateFrameID);
        for (const time of [link.createdAt,link.removedAt].filter(t => t !== undefined)) if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) throw new Error();
      }
      return { revision:v.revision as number,links:v.links as TimelineLinks['links'] };
    } catch { throw new StorageError('timeline-links-corrupt','现场关联记录无法读取，原记录未覆盖。'); }
  }
  private async update(expected:number,fn:(v:TimelineLinks)=>void):Promise<TimelineLinks> {
    if (!Number.isSafeInteger(expected) || expected<0) throw new StorageError('timeline-input','关联修订无效。');
    return withExclusiveLock(this.file+'.lock',async () => {
      const before = await readBytes(this.file,LIMIT); const value = await this.load();
      if (value.revision !== expected) throw new StorageError('timeline-conflict','关联已被其他操作修改，请刷新关联后重试。');
      fn(value); value.revision++;
      await atomicReplace(this.file,Buffer.from(JSON.stringify({schema_version:1,...value})),before,LIMIT); return value;
    });
  }
  async associate(target:TimelineRef,frameIDs:string[],expected:number,validate:()=>Promise<void>):Promise<TimelineLinks> {
    // Revalidate immediately before taking the CAS lock; immutable IDs are retained, no source text is copied.
    await validate();
    return this.update(expected,value => {
      const existing = new Set(value.links.filter(l => !l.removedAt && timelineRefKey(l.target) === timelineRefKey(target)).flatMap(l => l.frameIDs));
      const fresh = frameIDs.filter(id => !existing.has(id));
      if (!fresh.length) return;
      if (value.links.length >= 5000) throw new StorageError('timeline-limit','现场关联已达上限，请整理后重试。');
      value.links.push({id:randomUUID(),target,frameIDs:fresh,createdAt:new Date().toISOString()});
    });
  }
  remove(id:string,expected:number) { return this.update(expected,value => {
    const link = value.links.find(l => l.id===id); if (!link) throw new StorageError('timeline-missing','关联记录不存在。');
    link.removedAt ??= new Date().toISOString();
  }); }
}
