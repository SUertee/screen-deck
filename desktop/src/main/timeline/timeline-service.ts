import { frameSearchText } from '../recording/frame-metadata.js';
import { randomUUID } from 'node:crypto';
import { dayAt, dayBounds, projectTimeline, overlaps, timelineFingerprint, matchSnippet, type TimelineSources } from '../../core/timeline/projector.js';
import { StorageError } from '../../core/storage/private-storage.js';
import { timelineRefKey, type TimelineContext, type TimelineEvent, type TimelineFrame, type TimelinePage, type TimelineQuery, type TimelineScene, type TimelineSceneQuery, type TimelineRef } from '../../shared/timeline.js';
import type { RecordingStore } from '../recording/recording-store.js';
import { TimelineAssociationStore } from './association-store.js';
import { queryInput, sceneInput } from './validation.js';
import { validateFrameID } from '../recording/recording-store.js';
interface WorkSnapshot { at:number; key:string; events:TimelineEvent[]; projects:TimelinePage['projects']; diagnostics:string[]; fingerprint:string; days:string[] }
interface SceneSnapshot { at:number; key:string; frames:TimelineFrame[]; displays:number[]; apps:string[]; days:string[] }
const queryKey = (q:unknown) => JSON.stringify(q,(_key,v) => v);
const withoutPaging = <T extends {snapshotID?:string;cursor?:string}>(q:T) => { const {snapshotID,cursor,...rest}=q; return queryKey(rest); };
const stale = () => new StorageError('timeline-expired','这次时间线读取已过期，请刷新后继续。');
function pageStart(cursor:string|undefined,ids:string[]) {
  if (!cursor) return 0;
  const index=ids.indexOf(cursor); if(index<0) throw stale(); return index+1;
}
const publicEvent = (e:TimelineEvent):TimelineEvent => ({...e,items:[],related:e.related.map(r=>({...r}))});
export const frameSummary = (f:ReturnType<RecordingStore['listFrames']>[number],query=''):TimelineFrame => { const {text,...rest}=f; return {...rest,snippet:matchSnippet(query && f.context?.window?.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? f.context.window.title : text,query)}; };
/** Immutable, expiring read snapshots prevent reordering during pagination. User associations are durable. */
export class TimelineService {
  readonly links:TimelineAssociationStore;
  private work = new Map<string,WorkSnapshot>();
  private scenes = new Map<string,SceneSnapshot>();
  constructor(root:string,private readSources:()=>Promise<{sources:TimelineSources;diagnostics:string[]}>,private frames?:RecordingStore) {
    this.links=new TimelineAssociationStore(root);
    frames?.onRemoved(id=>{ for(const s of this.scenes.values()) s.frames=s.frames.filter(f=>f.id!==id); });
  }
  private retain<T extends {at:number}>(map:Map<string,T>,id:string,value:T) {
    for(const [key,v] of map) if(Date.now()-v.at>10*60000) map.delete(key);
    while(map.size>=12) map.delete(map.keys().next().value!); map.set(id,value);
  }
  private snapshot(id:string) { const s=this.work.get(id); if(!s||Date.now()-s.at>10*60000) throw stale(); return s; }
  async query(input:unknown):Promise<TimelinePage> {
    const q=queryInput(input); const key=withoutPaging(q); let id=q.snapshotID; let s=id ? this.snapshot(id) : undefined;
    if(s && s.key!==key) throw stale();
    if(!s) {
      if(q.cursor) throw stale();
      const {sources,diagnostics}=await this.readSources();
      const all=projectTimeline(sources,q.timeZone,q.query); if(all.length>20000) throw new StorageError('timeline-limit','工作事件超过读取上限，请先整理来源。');
      const [start,end]=dayBounds(q.day,q.timeZone);
      const events=all.filter(e=>(q.allDates||!e.startedAt||overlaps(e,start,end)) && (q.kind==='all'||e.kind===q.kind) && (!q.projectID||e.projectID===q.projectID));
      const fingerprint=timelineFingerprint(events); const prior=[...this.work].find(([,v])=>v.key===key&&v.fingerprint===fingerprint&&JSON.stringify(v.diagnostics)===JSON.stringify(diagnostics));
      id=prior?.[0]??randomUUID(); s={at:Date.now(),key,events,projects:sources.projects.filter(p=>p.project).map(p=>({id:p.project!.project_id,name:p.project!.name})),diagnostics:[...diagnostics,...(!this.frames?['屏幕来源暂不可用，工作事件仍可浏览。']:[])],fingerprint,days:[...new Set(all.flatMap(e=>e.startedAt?[dayAt(e.startedAt,q.timeZone)]:[]))].sort().reverse()}; this.retain(this.work,id,s);
    }
    const offset=pageStart(q.cursor,s.events.map(e=>e.id)),events=s.events.slice(offset,offset+50);
    return {snapshotID:id!,events:events.map(publicEvent),total:s.events.length,...(offset+50<s.events.length?{nextCursor:events.at(-1)!.id}:{}),projects:s.projects,diagnostics:s.diagnostics,markers:s.events.filter(e=>e.startedAt).filter((_,i)=>i%Math.max(1,Math.ceil(s!.events.length/2000))===0).map(e=>({id:e.id,time:e.startedAt!,title:e.title.slice(0,100)})),markersSampled:s.events.length>2000,availableDays:s.days,fingerprint:s.fingerprint};
  }
  locate(snapshotID:string,sceneSnapshotID:string|undefined,timestamp:number):{eventID?:string;frameID?:string} {
    if(!Number.isSafeInteger(timestamp)||!Number.isFinite(new Date(timestamp).getTime())) throw new StorageError('timeline-input','定位时间无效。');
    const work=this.snapshot(snapshotID),q=JSON.parse(work.key) as TimelineQuery;
    const [start,end]=dayBounds(q.day,q.timeZone);
    if(q.allDates||timestamp<start||timestamp>=end) throw new StorageError('timeline-input','请先选择要定位的一天。');
    const event=work.events.find(e=>overlaps(e,timestamp,timestamp+1));
    let nearest:TimelineFrame|undefined;
    if(sceneSnapshotID){
      const scene=this.scenes.get(sceneSnapshotID);if(!scene||Date.now()-scene.at>10*60000) throw stale();
      const sq=JSON.parse(scene.key) as TimelineSceneQuery;
      if(sq.allDates||sq.day!==q.day||sq.timeZone!==q.timeZone) throw stale();
      // A nearby observation is a preview, never a continuous recording or an ownership claim.
      nearest=scene.frames.filter(f=>Math.abs(Date.parse(f.timestamp)-timestamp)<=60000).sort((a,b)=>Math.abs(Date.parse(a.timestamp)-timestamp)-Math.abs(Date.parse(b.timestamp)-timestamp)||a.id.localeCompare(b.id))[0];
    }
    return {...(event?{eventID:event.id}:{}),...(nearest?{frameID:nearest.id}:{})};
  }
  detail(snapshotID:string,eventID:string) { const event=this.snapshot(snapshotID).events.find(e=>e.id===eventID); if(!event) throw new StorageError('timeline-missing','这项工作不在当前读取范围。'); return structuredClone(event); }
  async scene(input:unknown):Promise<TimelineScene> {
    const q=sceneInput(input); const key=withoutPaging(q); let id=q.snapshotID; let s=id?this.scenes.get(id):undefined;
    if(id && (!s||s.key!==key||Date.now()-s.at>10*60000)) throw stale();
    if(!s) {
      if(q.cursor) throw stale(); const frames=this.frames?.listFrames()??[]; const [start,end]=dayBounds(q.day,q.timeZone); const needle=q.query?.toLocaleLowerCase();
      s={at:Date.now(),key,frames:frames.filter(f=>(q.allDates||Date.parse(f.timestamp)>=start&&Date.parse(f.timestamp)<end)&&(!q.displayID||f.displayID===q.displayID)&&(!q.app||f.appName===q.app)&&(!needle||frameSearchText(f).toLocaleLowerCase().includes(needle))).sort((a,b)=>b.id.localeCompare(a.id)).map(f=>frameSummary(f,q.query)),displays:[...new Set(frames.map(f=>f.displayID))].sort((a,b)=>a-b),apps:[...new Set(frames.map(f=>f.appName))].sort(),days:[...new Set(frames.map(f=>dayAt(f.timestamp,q.timeZone)))].sort().reverse()};
      id=randomUUID(); this.retain(this.scenes,id,s);
    }
    const offset=pageStart(q.cursor,s.frames.map(f=>f.id)),frames=s.frames.slice(offset,offset+50);
    const [start,end]=dayBounds(q.day,q.timeZone);
    const stride=Math.max(1,Math.ceil(s.frames.length/2000));
    return {snapshotID:id!,frames,total:s.frames.length,points:s.frames.filter((_,i)=>i%stride===0).map(f=>({id:f.id,timestamp:f.timestamp,displayID:f.displayID})),sampled:stride>1,start:new Date(start).toISOString(),end:new Date(end).toISOString(),...(offset+50<s.frames.length?{nextCursor:frames.at(-1)!.id}:{}),displays:s.displays,apps:s.apps,availableDays:s.days};
  }
  async context(snapshotID:string,eventID:string):Promise<TimelineContext> {
    const event=this.detail(snapshotID,eventID); const all=await this.links.load();
    const links=all.links.filter(l=>!l.removedAt&&timelineRefKey(l.target)===timelineRefKey(event.ref));
    const ids=[...new Set(links.flatMap(l=>l.frameIDs))]; const linked=ids.flatMap(id=>{const f=this.frames?.getFrame(id);return f?[frameSummary(f)]:[];});
    // Point observations stay points; a singleton event has no invented ±N-minute ownership window.
    const start=event.startedAt?Date.parse(event.startedAt):NaN,end=event.endedAt?Date.parse(event.endedAt):start;
    const candidates=(this.frames?.listFrames()??[]).filter(f=>Date.parse(f.timestamp)>=start&&Date.parse(f.timestamp)<=Math.max(start,end)&&!ids.includes(f.id)).sort((a,b)=>b.id.localeCompare(a.id));
    return {revision:all.revision,links,linked:linked.slice(0,100),unavailableCount:ids.length-linked.length,contemporaneous:candidates.slice(0,100).map(f=>frameSummary(f)),totalContemporaneous:candidates.length};
  }
  async at(frameID:string,timeZone:string) {
    const frame=this.frame(frameID);const page=await this.query({day:dayAt(frame.timestamp,timeZone),timeZone,kind:'all'});
    const timestamp=Date.parse(frame.timestamp);const candidates=this.snapshot(page.snapshotID).events.filter(e=>overlaps(e,timestamp,timestamp+1));
    return {snapshotID:page.snapshotID,events:candidates.slice(0,100).map(publicEvent),total:candidates.length};
  }
  async frameRelations(id:string) {
    validateFrameID(id); const links=await this.links.load();const {sources}=await this.readSources();
    const events=projectTimeline(sources,'UTC');
    return {revision:links.revision,links:links.links.filter(l=>!l.removedAt&&l.frameIDs.includes(id)).map(l=>({id:l.id,event:events.find(e=>timelineRefKey(e.ref)===timelineRefKey(l.target))??null}))};
  }
  frame(id:string) { const f=this.frames?.getFrame(id);if(!f) throw new StorageError('timeline-missing','画面已删除或过期。');return frameSummary(f); }
  frameText(id:string) { const f=this.frames?.getFrame(id);if(!f) throw new StorageError('timeline-missing','画面已删除或过期。');return f.text; }
  async associate(target:TimelineRef,frameIDs:string[],expectedRevision:number) {
    frameIDs.forEach(validateFrameID);
    return this.links.associate(target,frameIDs,expectedRevision,async()=>{
      const {sources}=await this.readSources();
      const exists=projectTimeline(sources,'UTC').some(e=>timelineRefKey(e.ref)===timelineRefKey(target));
      if(!exists) throw new StorageError('timeline-missing','任务或会话来源已不可读，请刷新后重试。');
      if(frameIDs.some(id=>!this.frames?.getFrame(id))) throw new StorageError('timeline-missing','所选画面已删除或过期，请刷新后重试。');
    });
  }
}
