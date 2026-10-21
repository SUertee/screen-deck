import { basename, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicReplace, readBytes, safeRoot, StorageError, withExclusiveLock } from '../core/storage/private-storage.js';
import { isUUID } from '../core/sessions/session-schema.js';
import type { ProjectIdentity } from './types.js';
interface DirectoryProject extends ProjectIdentity { root_path:string }
/** App-owned registration. Never writes an identity or configuration into the selected folder. */
export class DirectoryProjects {
  private root:string;
  constructor(root:string){this.root=safeRoot(root);}
  async register(root_path:string):Promise<ProjectIdentity> {
    const filename=join(this.root,'projects','directory-index.json');
    return withExclusiveLock(join(this.root,'projects','.directory-index.lock'),async()=>{
      const bytes=await readBytes(filename,256*1024);
      const value=bytes?JSON.parse(bytes.toString()):{schema_version:1,kind:'screendeck_directory_projects',projects:[]};
      if(!value||Object.keys(value).sort().join(',')!=='kind,projects,schema_version'||value.schema_version!==1||value.kind!=='screendeck_directory_projects'||!Array.isArray(value.projects)||value.projects.length>100||value.projects.some((p:DirectoryProject)=>!p||Object.keys(p).sort().join(',')!=='created_at,kind,name,project_id,root_path,schema_version'||p.schema_version!==2||p.kind!=='project'||typeof p.project_id!=='string'||!p.project_id.startsWith('project-')||!isUUID(p.project_id.slice(8))||typeof p.root_path!=='string'||!isAbsolute(p.root_path)||/[\0\r\n]/.test(p.root_path)||Buffer.byteLength(p.root_path)>4096||typeof p.name!=='string'||!p.name.trim()||Buffer.byteLength(p.name)>600||!Number.isFinite(Date.parse(p.created_at)))) throw new StorageError('project-index','项目目录索引无效，未覆盖。');
      if(new Set(value.projects.map((p:DirectoryProject)=>p.project_id)).size!==value.projects.length||new Set(value.projects.map((p:DirectoryProject)=>p.root_path)).size!==value.projects.length)throw new StorageError('project-index','项目索引含重复身份，未覆盖。');
      let project=value.projects.find((p:DirectoryProject)=>p.root_path===root_path) as DirectoryProject|undefined;
      if(!project){if(value.projects.length>=100)throw new StorageError('project-limit','项目登记达到上限。');project={schema_version:2,kind:'project',project_id:'project-'+randomUUID(),name:basename(root_path)||'项目',created_at:new Date().toISOString(),root_path};value.projects.push(project);await atomicReplace(filename,Buffer.from(JSON.stringify(value,null,2)+'\n'),bytes,256*1024);}
      const {root_path:_root,...identity}=project;return identity;
    });
  }
}
