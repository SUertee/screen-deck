import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../core/storage/private-storage.js';
import { encodeTask, decodeTask } from '../core/storage/task-record-store.js';
import { validatePreviewPlan } from '../core/tasks/plan-schema.js';
const MAX=64*1024*1024;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Copy-once migration: never delete the legacy tree or rewrite frozen DTOs/absolute paths. */
export async function migrateApplicationData(legacyRoot:string,dataRoot:string) {
  const source=safeRoot(legacyRoot),destination=safeRoot(dataRoot);
  if(destination.startsWith(source+'/')) throw new StorageError('migration-root','正式目录不能位于旧数据内部。');
  if(source===destination) throw new StorageError('migration-root','新旧数据目录必须不同。');
  const marker=join(destination,'migrations','electron-v1.json');
  const previous=await readBytes(marker,8*1024*1024);
  if(previous) {
    const done=JSON.parse(previous.toString());
    if(done.schema_version!==1||done.kind!=='screendeck_migration'||done.source!==source||done.state!=='complete'||!Number.isFinite(Date.parse(done.completedAt))||!Array.isArray(done.files)||done.files.length>20_000||done.files.some((f:{path:string;sha256:string})=>!f||typeof f.path!=='string'||f.path.startsWith('/')||f.path.split(/[\\/]/).some(p=>p==='..'||p==='.')||typeof f.sha256!=='string'||! /^[a-f0-9]{64}$/.test(f.sha256))) throw new StorageError('migration-marker','迁移标记无效，未使用旧记录覆盖正式数据。');
    return;
  }
  await withExclusiveLock(join(destination,'.data-migration.lock'),async()=>{
    if(await readBytes(marker,8*1024*1024)) return;
    if (await checkDirectories(source) && (await readdir(source)).some(name => name.endsWith('.lock'))) throw new StorageError('migration-busy','旧实例仍有写入锁，请先正常退出。');
    const entries:Array<{source:string;target:string;sourceHash:string;targetHash:string;task:boolean}>=[];
    let count=0,total=0;
    async function scan(folder:string,targetFolder:string,task=false) {
      if(!await checkDirectories(folder)) return;
      for(const item of await readdir(folder,{withFileTypes:true})) {
        if(++count>20_000) throw new StorageError('migration-limit','迁移文件数量超过上限。');
        if(item.name.endsWith('.lock')||item.name.endsWith('.tmp')) throw new StorageError('migration-busy','旧数据存在写入锁或临时记录，请先正常退出旧实例。');
        const filename=join(folder,item.name);
        if(item.isSymbolicLink()||(!item.isFile()&&!item.isDirectory())) throw new StorageError('migration-unsafe','旧数据含不安全的文件类型。');
        if(item.isDirectory()) { if(task) throw new StorageError('migration-task','旧任务目录结构无效。'); await scan(filename,join(targetFolder,item.name)); continue; }
        const original=await readBytes(filename,MAX); if(!original) throw new StorageError('migration-changed','迁移来源发生变化。');
        total+=original.length;if(total>16*1024*1024*1024) throw new StorageError('migration-limit','自动迁移超过16GB；旧数据未删除。');
        let target=join(targetFolder,item.name),bytes=original;
        if(task) {
          const plan=validatePreviewPlan(JSON.parse(original.toString()));
          if(item.name!==plan.id+'.json') throw new StorageError('migration-task','旧任务文件名与身份不一致。');
          target=join(targetFolder,plan.id,'task.json');bytes=encodeTask(plan);
          if(JSON.stringify(decodeTask(bytes))!==JSON.stringify(plan)) throw new StorageError('migration-task','任务转换未能保留原始内容。');
        }
        entries.push({source:filename,target,sourceHash:hash(original),targetHash:hash(bytes),task});
      }
    }
    await scan(join(source,'preview-plans'),join(destination,'tasks'),true);
    const directories=['sessions','agent-sessions-v1','task-sessions-v2','task-sessions-v3','local-state','preview-approvals','execution-approvals-v1','execution-approvals-v2','execution-acceptances-v1','execution-acceptances-v2','execution-artifacts-v1','agent-execution-v1','native-work-item-evidence-v1','native-work-item-evidence-snapshots-v1','native-work-item-journals-v1','timeline-associations-v1','screen-recordings'];
    for(const folder of directories) await scan(join(source,folder),join(destination,folder));
    for(const name of ['provider.toml','credential.json','credential.bin']) {
      const bytes=await readBytes(join(source,name),MAX);
      if(bytes) entries.push({source:join(source,name),target:join(destination,name),sourceHash:hash(bytes),targetHash:hash(bytes),task:false});
    }
    // Preflight every destination before writing the first one; identical partial copies can resume.
    for(const entry of entries) {
      const existing=await readBytes(entry.target,MAX);
      if(existing&&hash(existing)!==entry.targetHash) throw new StorageError('migration-conflict','正式目录已有不同记录，未覆盖；旧数据仍保留。');
    }
    for(const entry of entries) {
      const original=await readBytes(entry.source,MAX);
      if(!original||hash(original)!==entry.sourceHash) throw new StorageError('migration-changed','迁移来源发生变化，尚未切换数据根。');
      const bytes=entry.task?encodeTask(validatePreviewPlan(JSON.parse(original.toString()))):original;
      if(!await readBytes(entry.target,MAX)) await atomicReplace(entry.target,bytes,undefined,MAX);
      const verified=await readBytes(entry.target,MAX);
      if(!verified||hash(verified)!==entry.targetHash) throw new StorageError('migration-verify','迁移副本校验失败，尚未切换数据根。');
    }
    for(const entry of entries) if(hash((await readBytes(entry.source,MAX))??Buffer.alloc(0))!==entry.sourceHash) throw new StorageError('migration-changed','旧实例在迁移中修改了记录，尚未切换数据根。');
    await atomicReplace(marker,Buffer.from(JSON.stringify({schema_version:1,kind:'screendeck_migration',state:'complete',source,completedAt:new Date().toISOString(),files:entries.map(e=>({path:relative(destination,e.target),sha256:e.targetHash}))})),undefined,8*1024*1024);
  });
}
