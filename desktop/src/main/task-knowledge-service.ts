import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../core/storage/private-storage.js';
import { isUUID } from '../core/sessions/session-schema.js';
import { canonicalDigest, exactObject } from '../core/storage/execution-records.js';
import type { KnowledgeCard, KnowledgeSource, KnowledgeText, KnowledgeView } from '../shared/task-knowledge.js';
const LIMIT=64*1024, MAX=1000;
const fail=()=>new StorageError('knowledge-invalid','知识记录无效。');
function text(v:unknown,max:number,required=false):asserts v is string { if(typeof v!=='string'||v.includes('\0')||Buffer.byteLength(v)>max||required&&!v.trim())throw fail(); }
function fields(v:KnowledgeText) {text(v.title,1024,true);text(v.content,24000,true);text(v.context,4096);}
function source(v:KnowledgeSource) {
  exactObject(v,['taskID','planVersion','attemptID','sessionID','evidenceDigest']);
  if(!isUUID(v.taskID)||!isUUID(v.attemptID)||!isUUID(v.sessionID)||!Number.isSafeInteger(v.planVersion)||v.planVersion<1||!/^[a-f0-9]{64}$/.test(v.evidenceDigest))throw fail();
}
function validate(v:KnowledgeCard):KnowledgeCard {
  exactObject(v,['schema_version','kind','id','revision','createdAt','updatedAt','archived','source','title','content','context']);
  if(v.schema_version!==1||v.kind!=='screendeck_knowledge'||!isUUID(v.id)||!Number.isSafeInteger(v.revision)||v.revision<1||typeof v.archived!=='boolean'||typeof v.createdAt!=='string'||typeof v.updatedAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||!Number.isFinite(Date.parse(v.updatedAt)))throw fail();
  fields(v);source(v.source);return v;
}
/** Only explicitly edited text is persisted; provenance is resolved in the host, never supplied by renderer. */
export class TaskKnowledgeService {
  private folder:string;
  constructor(root:string,private resolve:(taskID:string,attemptID:string)=>Promise<KnowledgeSource|undefined>) {this.folder=join(safeRoot(root),'knowledge-v1');}
  private file(id:string){if(!isUUID(id))throw fail();return join(this.folder,id+'.json');}
  async load(id:string):Promise<KnowledgeCard> {const bytes=await readBytes(this.file(id),LIMIT);if(!bytes)throw new StorageError('knowledge-missing','知识卡不存在。');const card=validate(JSON.parse(bytes.toString('utf8')));if(card.id!==id)throw fail();return card;}
  async view(card:KnowledgeCard):Promise<KnowledgeView> {
    let current:KnowledgeSource|undefined;try{current=await this.resolve(card.source.taskID,card.source.attemptID);}catch{/* Unreadable sources reveal no raw content. */}
    return {card,sourceStatus:current&&canonicalDigest(current)===canonicalDigest(card.source)?'available':'unavailable'};
  }
  private async ids(){if(!await checkDirectories(this.folder))return [];const entries=await readdir(this.folder,{withFileTypes:true});if(entries.length>MAX)throw new StorageError('knowledge-limit','知识卡数量超过上限。');return entries.map(e=>{if(!e.isFile()||e.isSymbolicLink()||!e.name.endsWith('.json')||!isUUID(e.name.slice(0,-5)))throw fail();return e.name.slice(0,-5);});}
  async search(query:string,includeArchived:boolean):Promise<KnowledgeView[]> {
    text(query,1024);if(typeof includeArchived!=='boolean')throw fail();const result:KnowledgeView[]=[];
    for(const id of await this.ids()){const c=await this.load(id);if((includeArchived||!c.archived)&&`${c.title}\n${c.content}\n${c.context}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))result.push(await this.view(c));}
    return result.sort((a,b)=>b.card.updatedAt.localeCompare(a.card.updatedAt)||a.card.id.localeCompare(b.card.id));
  }
  async create(input:KnowledgeText,taskID:string,attemptID:string,confirmed:unknown):Promise<KnowledgeView> {
    fields(input);if(confirmed!==true||!isUUID(taskID)||!isUUID(attemptID))throw fail();
    const provenance=await this.resolve(taskID,attemptID);if(!provenance)throw new StorageError('knowledge-source','请先人工接受原尝试，再确认知识内容。');source(provenance);
    return withExclusiveLock(join(this.folder+'.lock'),async()=>{if((await this.ids()).length>=MAX)throw new StorageError('knowledge-limit','知识卡达到上限。');const now=new Date().toISOString(),card:KnowledgeCard={schema_version:1,kind:'screendeck_knowledge',id:randomUUID(),revision:1,createdAt:now,updatedAt:now,archived:false,source:structuredClone(provenance),title:input.title.trim(),content:input.content.trim(),context:input.context.trim()};await atomicReplace(this.file(card.id),Buffer.from(JSON.stringify(card)+'\n'),undefined,LIMIT);return this.view(card);});
  }
  async update(id:string,expectedRevision:number,input:KnowledgeText,archived:boolean):Promise<KnowledgeView> {
    fields(input);if(typeof archived!=='boolean')throw fail();
    return withExclusiveLock(this.folder+'.lock',async()=>{const file=this.file(id),before=await readBytes(file,LIMIT);if(!before)throw new StorageError('knowledge-missing','知识卡不存在。');const original=await this.load(id);if(original.revision!==expectedRevision)throw new StorageError('knowledge-conflict','知识卡已更新，请重新读取；输入尚未保存。');const card=validate({...original,title:input.title.trim(),content:input.content.trim(),context:input.context.trim(),archived,revision:original.revision+1,updatedAt:new Date().toISOString()});await atomicReplace(file,Buffer.from(JSON.stringify(card)+'\n'),before,LIMIT);return this.view(card);});
  }
}
