import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeScreenBackend } from '../../src/main/recording/native-backend.js';
import { RecordingStore, defaultRecordingSettings, validateRecordingSettings } from '../../src/main/recording/recording-store.js';
import { RecordingService, type CapturedScreen } from '../../src/main/recording/recording-service.js';
import { TimelineService } from '../../src/main/timeline/timeline-service.js';
const timestamp = new Date().toISOString(), image = Buffer.from([255,216,255,217]);
const nativeFrame = (id: number, title = 'Synthetic editing window') => ({appName: `App ${id}`,bundleID: `fixture.${id}`,displayID:id,width:640,height:360,text:'synthetic text',jpeg:image.toString('base64'),capturedAt:timestamp,
  display:{id,name:`Display ${id}`,width:1280,height:720,uuid:'00000000-0000-0000-0000-000000000001',bounds:{x:(id-1)*1280,y:0,width:1280,height:720}},
  context:{kind:'topmost-window-on-display',observedAt:timestamp,appIsFrontmost:id===1,windowFocus:'unknown',window:{id:100+id,title,bounds:{x:(id-1)*1280,y:0,width:1000,height:700}}}});
const makeBackend = (fn: (input: {displayID: number | null}) => unknown) => new NativeScreenBackend('/unused-never-run', async (command,input) => {assert.equal(command,'capture'); return fn(input as {displayID:number|null});});
const realSetTimeout = globalThis.setTimeout;
const pause = (ms = 5) => new Promise<void>(r => realSetTimeout(r,ms));
async function waitFor(predicate: () => boolean) {for(let i=0;i<200;i++){if(predicate())return;await pause();}assert.fail('recording did not settle');}
async function fixture(t: {after(fn: () => Promise<void>):void}) {const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'screen-multi-synthetic-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new RecordingStore(root);await store.initialize();return{root,store};}

test('legacy settings remain byte-compatible; explicit selection is bounded, copied, and strict',()=>{
  assert.deepEqual(validateRecordingSettings(defaultRecordingSettings),defaultRecordingSettings);
  assert.equal('displayIDs' in validateRecordingSettings(defaultRecordingSettings),false);
  const ids=[2,3];const validated=validateRecordingSettings({...defaultRecordingSettings,displayID:2,displayIDs:ids});ids[0]=9;assert.deepEqual(validated.displayIDs,[2,3]);
  for(const displayIDs of [[],[1,1],[0],[-1],['1'],Array.from({length:9},(_,i)=>i+1)])assert.throws(()=>validateRecordingSettings({...defaultRecordingSettings,displayIDs}));
  assert.throws(()=>validateRecordingSettings({...defaultRecordingSettings,unknown:true}));
});
test('explicit displays are sampled in order with their own identity; offline never falls back to main',async()=>{
  const called:Array<number|null>=[];const b=makeBackend(({displayID})=>{called.push(displayID);return displayID===3?{error:'display'}:nativeFrame(displayID!);});
  const result=await b.captureMany({...defaultRecordingSettings,displayID:1,displayIDs:[2,3]});assert.deepEqual(called,[2,3]);assert.deepEqual(result.frames.map(f=>f.frame.displayID),[2]);assert.deepEqual(result.unavailableDisplayIDs,[3]);assert.equal(result.frames[0].frame.context!.appIsFrontmost,false);
  const single=makeBackend(({displayID})=>{assert.equal(displayID,null);return nativeFrame(1);});assert.equal((await single.captureMany(defaultRecordingSettings)).frames[0].frame.displayID,1);
});
test('native output rejects mismatched display, invented focus, invalid metadata and timestamps',async()=>{
  for(const override of [{displayID:2},{display:{...nativeFrame(1).display,id:3}},{context:{...nativeFrame(1).context,windowFocus:'focused'}},{context:{...nativeFrame(1).context,window:{...nativeFrame(1).context.window,title:'x'.repeat(1001)}}},{capturedAt:'invalid'}]){
    const b=makeBackend(()=>({...nativeFrame(1),...override}));await assert.rejects(b.capture({...defaultRecordingSettings,displayID:1}));
  }
});
test('legacy frame indexes and new window metadata coexist across restart and title search',async t=>{
  const{root,store}=await fixture(t);const b=makeBackend(()=>nativeFrame(2,'specific window phrase'));const captured=(await b.capture({...defaultRecordingSettings,displayID:2}))!;
  const saved=await store.add(captured.frame,captured.jpeg);await store.add({appName:'Old foreground app',bundleID:'legacy',displayID:1,width:2,height:2,text:'old'},image);
  const reopened=new RecordingStore(root);await reopened.initialize();assert.equal(reopened.stats().frameCount,2);assert.equal(reopened.search({query:'specific window phrase'}).total,1);assert.equal(reopened.getFrame(saved.id)!.context!.windowFocus,'unknown');
  const snapshot=reopened.getFrame(saved.id)!;snapshot.context!.window!.title='mutated';assert.equal(reopened.getFrame(saved.id)!.context!.window!.title,'specific window phrase');
  const timeline=new TimelineService(root,async()=>({sources:{sessions:[],agents:[],taskSessions:[],projects:[],acceptances:[]},diagnostics:[]}),reopened);
  const result=await timeline.scene({day:timestamp.slice(0,10),timeZone:'UTC',query:'specific window phrase'});assert.equal(result.total,1);assert.match(result.frames[0].snippet,/specific window phrase/);
  const file=path.join(store.root,saved.id+'.json');const original=JSON.parse(await readFile(file,'utf8'));original.context.windowFocus='focused';await writeFile(file,JSON.stringify(original));await assert.rejects(new RecordingStore(root).initialize());assert.equal(JSON.parse(await readFile(file,'utf8')).context.windowFocus,'focused');
});
test('multi capture persists separate observations and reports offline selections without starting permissions itself',async t=>{
  const{store}=await fixture(t);let permissionCalls=0;const b=makeBackend(({displayID})=>displayID===3?{error:'display'}:nativeFrame(displayID!));b.permission=async()=>{permissionCalls++;return true;};
  await store.saveSettings({...defaultRecordingSettings,displayID:1,displayIDs:[1,2,3]});const service=new RecordingService(store,b);t.after(()=>service.shutdown());await service.start();await waitFor(()=>service.status().message.includes('未连接'));
  assert.equal(permissionCalls,1);assert.equal(store.stats().frameCount,2);assert.deepEqual(store.listFrames().map(f=>f.displayID).sort(),[1,2]);assert.equal(new Set(store.listFrames().map(f=>f.timestamp)).size,1);assert.equal(store.listFrames().find(f=>f.displayID===2)!.appName,'App 2');await service.stop();
});
test('per-display dedup preserves window-title/focus changes and does not compare one screen to another',async t=>{
  const{store}=await fixture(t);let current=[nativeFrame(1),nativeFrame(2)];let samples=0;
  await store.saveSettings({...defaultRecordingSettings,intervalSeconds:5,displayID:1,displayIDs:[1,2]});
  t.mock.timers.enable({apis:['setTimeout']});
  const service=new RecordingService(store,{supported:true,permission:async()=>true,displays:async()=>[],capture:async()=>undefined,captureMany:async()=>{samples++;const frames:CapturedScreen[]=await Promise.all(current.map(async f=>{const x=makeBackend(()=>f);return(await x.capture({...defaultRecordingSettings,displayID:f.displayID}))!;}));return{frames,skippedDisplayIDs:[],unavailableDisplayIDs:[]};}});
  t.after(()=>service.shutdown());
  await service.start();await waitFor(()=>store.stats().frameCount===2&&service.status().message.includes('2 个显示器'));await pause(20);
  t.mock.timers.tick(5000);await waitFor(()=>samples===2&&service.status().message.includes('静止画面'));await pause(20);assert.equal(store.stats().frameCount,2);
  current=[{...nativeFrame(1),context:{...nativeFrame(1).context,observedAt:new Date(Date.now()+1000).toISOString()}},nativeFrame(2,'changed title')];
  t.mock.timers.tick(5000);await waitFor(()=>store.stats().frameCount===3);await pause(20);assert.equal(samples,3);
  current=[{...nativeFrame(1),context:{...nativeFrame(1).context,appIsFrontmost:false}},nativeFrame(2,'changed title')];
  t.mock.timers.tick(5000);await waitFor(()=>store.stats().frameCount===4);assert.equal(samples,4);await service.shutdown();
});
test('lock invalidates the entire pending multi-display batch without writing any frame',async t=>{
  const{store}=await fixture(t);let resolve!: (v:{frames:CapturedScreen[];skippedDisplayIDs:number[];unavailableDisplayIDs:number[]})=>void;const pending=new Promise<{frames:CapturedScreen[];skippedDisplayIDs:number[];unavailableDisplayIDs:number[]}>(r=>{resolve=r;});
  const frames=await Promise.all([1,2].map(async id=>(await makeBackend(()=>nativeFrame(id)).capture({...defaultRecordingSettings,displayID:id}))!));
  const service=new RecordingService(store,{supported:true,permission:async()=>true,displays:async()=>[],capture:async()=>undefined,captureMany:()=>pending});await service.start();service.pause();resolve({frames,skippedDisplayIDs:[],unavailableDisplayIDs:[]});await pause();assert.equal(service.status().state,'paused');assert.equal(store.stats().frameCount,0);await service.shutdown();
});

test('invalidation between display helper calls never captures the next selected screen',async()=>{
  let current=true;const calls:number[]=[];const b=makeBackend(({displayID})=>{calls.push(displayID!);current=false;return nativeFrame(displayID!);});
  const result=await b.captureMany({...defaultRecordingSettings,displayID:1,displayIDs:[1,2]},()=>current);
  assert.deepEqual(calls,[1]);assert.equal(result.frames.length,1);
});
