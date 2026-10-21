import { _electron as electron,expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,mkdir,realpath,writeFile,readFile } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { taskSpecDigest,validateTaskSession } from '../src/core/sessions/task-session-schema.ts';
import { validateAgentSession } from '../src/core/sessions/agent-session-schema.ts';
import { RecordingStore } from '../src/main/recording/recording-store.ts';
const root=process.cwd();const temporary=await mkdtemp(path.join(await realpath(os.tmpdir()),'screendeck-unified-ui-'));const preview=path.join(temporary,'preview'),home=path.join(temporary,'home'),projectRoot=path.join(temporary,'project'),privateRoot=path.join(temporary,'private');
const now=Date.now(),at=minutes=>new Date(now-minutes*60000).toISOString(),projectID='project-'+randomUUID();
const task={schema_version:1,kind:'task',project_id:projectID,task_id:'task-001',title:'实现屏幕历史索引',goal:'按工作内容找回现场，保持原始数据。',status:'awaiting_review',plan_version:1,assignee:'human',created_at:at(50),updated_at:at(10),run_ids:['run-20261021-001'],acceptance:[{id:'local-only',description:'本地记录与原件保留',verification:'not_checked',requires_human:true}],references:[]};
const run={schema_version:1,kind:'run',project_id:projectID,task_id:task.task_id,run_id:'run-20261021-001',plan_version:1,status:'completed',started_at:at(22),ended_at:at(14),recorded_at:at(5),executor:{agent:'Fixture Agent',model:null,effort:null,metadata_source:'isolated fixture'},skills:[],summary:'索引构建结束，等待人工验收。',references:[],git:{commit_status:'none',commit_ids:[],push_status:'not_pushed'}};
for(const dir of [home,path.join(projectRoot,'.screendeck'),...['tasks','runs','artifacts'].map(d=>path.join(privateRoot,'projects',projectID,d))])await mkdir(dir,{recursive:true});
const json=async(file,value)=>writeFile(file,JSON.stringify(value));
await json(path.join(projectRoot,'.screendeck','project.json'),{schema_version:2,kind:'project',project_id:projectID,name:'ScreenDeck · 合成项目',created_at:at(50)});
await json(path.join(privateRoot,'projects',projectID,'history.json'),{schema_version:1,kind:'project_history',project_id:projectID,source_root:projectRoot,created_at:at(50),project:{schema_version:1,kind:'project',project_id:projectID,name:'合成项目',created_at:at(50),timezone:'Asia/Shanghai',mode:'manual_pilot',references:[]},migration:{backup_path:path.join(temporary,'unread-backup'),migrated_at:at(50)}});
const taskFile=path.join(privateRoot,'projects',projectID,'tasks',task.task_id+'.json');await json(taskFile,task);await json(path.join(privateRoot,'projects',projectID,'runs',run.run_id+'.json'),run);
function session(title,times,agent=false){const id=randomUUID();const turns=times.map(t=>({turn_id:randomUUID(),client_request_id:randomUUID(),requested_model:{provider_id:'fixture',model_id:'fixture-model'},state:'finished',created_at:t,updated_at:new Date(Date.parse(t)+60000).toISOString(),draft_revision:0}));return {schema_version:1,conversation_id:id,title,scope:{kind:'project',project_id:projectID,task_id:task.task_id},created_at:times[0],updated_at:turns.at(-1).updated_at,revision:1,turns,messages:turns.flatMap((t,i)=>['user','assistant'].map((role,n)=>({message_id:randomUUID(),turn_id:t.turn_id,role,text:n?'已经保存设计讨论，等待下一步确认。':`屏幕历史方案讨论 ${i+1} · timeline needle`,created_at:t.created_at,updated_at:t.updated_at}))),...(agent?{kind:'electron_agent_chat',source:{agentID:'opencode',configDigest:'a'.repeat(64)},binding:{runtimeID:randomUUID(),connectionGeneration:randomUUID(),externalSessionID:'fixture-session'}}:{})};}
const model=session('屏幕历史方案',[at(30),at(25),at(3)]),agent=session('Agent 索引讨论',[at(20)],true),old=session('昨天的交互讨论',[at(24*60+10)]);
validateAgentSession(agent,true);
const legacy=session('任务执行会话（历史）',[at(18)]);legacy.schema_version=2;legacy.kind='electron_task_session';
const legacyTurn=legacy.turns[0];const spec={work:{planID:randomUUID(),planVersion:1,workItemID:randomUUID()},title:'旧执行输入',kind:'discussion',expectedResult:'读取原输入',dependencies:[],inputMessageID:legacy.messages[0].message_id,materials:[],workspace:{workspaceID:randomUUID(),bindingDigest:'a'.repeat(64)},driver:{driverID:'simulation-success',configDigest:'b'.repeat(64),mode:'simulation'},tools:{kind:'none'}};
legacyTurn.state='failed';legacyTurn.execution={spec,specDigest:taskSpecDigest(spec,legacyTurn.requested_model,legacy.messages[0].text),eventReceipts:[],permissions:[]};validateTaskSession(legacy,true);
const taskSessionFile=path.join(preview,'task-sessions-v2',legacy.conversation_id+'.json');await mkdir(path.dirname(taskSessionFile),{recursive:true});await json(taskSessionFile,legacy);
const historyFiles=[taskSessionFile];
for(const record of [model,agent,old]){const file='kind'in record?path.join(preview,'agent-sessions-v1',record.conversation_id+'.json'):path.join(preview,'sessions',...record.created_at.slice(0,10).split('-'),record.conversation_id+'.json');await mkdir(path.dirname(file),{recursive:true});await json(file,record);historyFiles.push(file);}
const hash=async f=>createHash('sha256').update(await readFile(f)).digest('hex');const sourceHashes=await Promise.all([taskFile,...historyFiles].map(hash));
const env={HOME:home,PATH:[path.dirname(process.execPath),'/usr/bin','/bin'].join(':'),SCREENDECK_PREVIEW_ROOT:preview,SCREENDECK_PROJECT_HISTORY_ROOT:privateRoot,SCREENDECK_INITIAL_PROJECT:projectRoot};for(const key of ['TMPDIR','LANG','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
let application,page;const checks=[],pageErrors=[];
async function launch(){application=await electron.launch({args:[root,'--disable-gpu'],env,timeout:30000});page=await application.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>pageErrors.push(e.message));await expect(page.getByRole('button',{name:'时间线',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'输入消息',exact:true})).toBeVisible();}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function navigate(){await page.getByRole('button',{name:'时间线',exact:true}).click();await expect(page.locator('.tl-screen-stage')).toBeVisible();await expect(page.locator('.tl-list')).toHaveAttribute('aria-busy','false');}
try{
  await launch();const jpeg=await application.evaluate(async({BrowserWindow})=>{const w=new BrowserWindow({width:960,height:600,show:false,webPreferences:{nodeIntegration:false,sandbox:true,contextIsolation:true}});await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="font:16px system-ui;background:#f5f5f5;padding:56px;color:#202020"><small>SCREENDECK / WORK NOTES</small><h1>统一时间线</h1><hr><h2>从工作进展，找回当时的现场。</h2><p>任务 · Session · 同期画面</p><p>Timeline design · local OCR needle</p><p>讨论方案 → 执行索引 → 人工验收</p>'));const image=await w.webContents.capturePage();w.destroy();return image.toJPEG(80).toString('base64');});await application.close();application=undefined;
  const store=new RecordingStore(preview);await store.initialize();const add=async(minutes,displayID=1)=>store.add({appName:displayID===1?'Notes':'Editor',bundleID:'fixture.notes',displayID,width:960,height:600,text:'统一时间线设计\n任务与 Session 是主内容\nlocal OCR needle'},Buffer.from(jpeg,'base64'),new Date(at(minutes)));
  const frame=await add(28),second=await add(27,2),yesterday=await add(24*60+10);
  await launch();await application.evaluate(({session,ipcMain})=>{globalThis.__timelineSmoke={captureStarts:0,network:0};session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,done)=>{globalThis.__timelineSmoke.network++;done({cancel:true});});ipcMain.removeHandler('screendeck:screen-start');ipcMain.handle('screendeck:screen-start',()=>{globalThis.__timelineSmoke.captureStarts++;throw new Error('Real screen capture forbidden in UI smoke');});});
  await navigate();
  await check('default-screen-preview-without-inspector-or-capture',async()=>{
    await expect(page.getByRole('button',{name:'屏幕回看',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('.tl-screen-canvas img')).toBeVisible();await expect(page.locator('.tl-detail')).toHaveCount(0);
    await expect(page.locator('.tl-scene-row')).toHaveCount(2);await expect(page.locator('.tl-event')).toHaveCount(0);
    assert.equal((await page.evaluate(()=>window.screendeck.screenStatus())).state,'stopped');
    const size=await page.locator('.tl-screen-canvas').boundingBox();assert.ok(size.width>500&&size.height>150);
    await page.screenshot({path:path.join(temporary,'screen-first-wide.png')});
  });
  await check('work-markers-open-details-with-screen-retained',async()=>{
    const src=await page.locator('.tl-screen-canvas img').getAttribute('src');
    await page.locator('.tl-work-points button').first().click();await expect(page.locator('.tl-detail')).toBeVisible();
    assert.equal(await page.locator('.tl-screen-canvas img').getAttribute('src'),src);
    await page.getByRole('button',{name:'关闭时间线详情'}).click();await expect(page.locator('.tl-detail')).toHaveCount(0);
    await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
  });
  await check('work-list-is-secondary-and-does-not-replace-picture',async()=>{
    await page.getByRole('button',{name:/^工作活动/}).click();await expect(page.locator('.tl-event').first()).toBeVisible();
    await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
    await page.locator('.tl-event').first().click();await expect(page.locator('.tl-detail')).toBeVisible();
    await page.getByRole('button',{name:'关闭时间线详情'}).click();
    await page.getByRole('button',{name:'屏幕回看',exact:true}).click();await expect(page.locator('.tl-scene-row')).toHaveCount(2);
    await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
  });
  await check('screen-details-ocr-and-manual-association',async()=>{
    await page.getByRole('button',{name:'画面详情',exact:true}).click();await expect(page.locator('.tl-detail')).toBeVisible();
    await page.getByText('识别文字',{exact:true}).click();await expect(page.locator('.tl-ocr pre')).toContainText('local OCR needle');
    await page.getByRole('button',{name:'关联任务／会话',exact:true}).click();await expect(page.getByRole('dialog',{name:'关联现场'})).toBeVisible();
    await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'关闭时间线详情'}).click();
  });
  await check('screen-search-filter-and-day-navigation',async()=>{
    await page.getByRole('combobox',{name:'历史显示器筛选'}).selectOption('2');await expect(page.locator('.tl-scene-row')).toHaveCount(1);await expect(page.locator('.tl-screen-heading')).toContainText('Editor');
    await page.getByRole('textbox',{name:'搜索时间线'}).fill('nonexistent-screen-content');await expect(page.locator('.tl-screen-empty')).toContainText('没有符合筛选条件');await expect(page.locator('.tl-screen-canvas img')).toHaveCount(0);
    await page.getByRole('button',{name:'清除筛选'}).click();await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
    await page.getByRole('textbox',{name:'时间线日期'}).fill('2020-01-01').catch(async()=>{await page.locator('input[type=date]').fill('2020-01-01');});
    await expect(page.locator('.tl-screen-empty')).toContainText('这一天没有屏幕记录');await expect(page.getByRole('combobox',{name:'跳到有屏幕记录的日期'})).toBeVisible();
    await page.getByRole('button',{name:'今天',exact:true}).click();await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
  });
  await check('context-draft-selects-material-without-model-send',async()=>{
    await page.locator('.tl-scene-selectable>input').first().check();await expect(page.getByLabel('已选屏幕线索')).toContainText('1 条线索');
    await page.getByLabel('已选屏幕线索').getByRole('button',{name:'整理上下文',exact:true}).click();await expect(page.getByRole('dialog',{name:'整理任务上下文'})).toBeVisible();await page.keyboard.press('Escape');
  });
  await check('narrow-preview-remains-inline-details-close-with-escape',async()=>{
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='screendeck-app://workbench/index.html').setContentSize(860,820));
    await page.emulateMedia({reducedMotion:'reduce'});await expect(page.locator('.tl-screen-canvas img')).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button',{name:'画面详情',exact:true}).click();await expect(page.getByRole('dialog',{name:'时间线详情'})).toBeVisible();await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'画面详情',exact:true})).toBeFocused();
    assert.equal(await page.locator('.unified-timeline').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    await page.screenshot({path:path.join(temporary,'screen-first-narrow.png')});
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='screendeck-app://workbench/index.html').setContentSize(1440,940));
  });
  await check('delete-screen-retains-work-and-empty-explains-stopped-recording',async()=>{
    await page.getByRole('button',{name:'画面详情',exact:true}).click();await page.getByRole('button',{name:'删除这个画面',exact:true}).click();await page.getByRole('button',{name:'确认删除画面',exact:true}).click();
    await expect(page.locator('.tl-scene-row')).toHaveCount(1);await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
    await page.getByRole('button',{name:/^工作活动/}).click();await expect(page.locator('.tl-event').first()).toBeVisible();
  });
  await check('no-network-no-capture-no-source-rewrites',async()=>{assert.deepEqual(await Promise.all([taskFile,...historyFiles].map(hash)),sourceHashes);assert.deepEqual(await application.evaluate(()=>globalThis.__timelineSmoke),{captureStarts:0,network:0});assert.deepEqual(pageErrors,[]);});
  await check('empty-day-is-clear-and-next-launch-uses-latest-recorded-day',async()=>{
    await page.getByRole('button',{name:'屏幕回看',exact:true}).click();await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
    const remaining=(await page.evaluate(async()=>{const scene=await window.screendeck.timelineScene({day:document.querySelector('input[type=date]').value,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});return scene.frames.map(f=>f.id);}));
    assert.equal(remaining.length,1);await page.evaluate(id=>window.screendeck.screenDelete(id),remaining[0]);
    await expect(page.locator('.tl-screen-empty')).toContainText('这一天没有屏幕记录');await expect(page.locator('.tl-screen-empty')).toContainText('记录已关闭');await expect(page.locator('.tl-screen-canvas img')).toHaveCount(0);
    await page.screenshot({path:path.join(temporary,'screen-first-empty.png')});
    await application.close();application=undefined;await launch();await navigate();
    await expect(page.locator('.tl-screen-canvas img')).toBeVisible();
    const latest=new Intl.DateTimeFormat('en-CA',{timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(yesterday.timestamp));
    await expect(page.locator('input[type=date]')).toHaveValue(latest);assert.equal((await page.evaluate(()=>window.screendeck.screenStatus())).state,'stopped');assert.deepEqual(pageErrors,[]);
  });
  await writeFile(path.join(temporary,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify({checks:checks.length,artifacts:temporary}));
}catch(error){console.error(error);throw error;}finally{if(application){let timer;try{await Promise.race([application.close(),new Promise(resolve=>{timer=setTimeout(()=>{application.process().kill();resolve();},5000);})]);}finally{clearTimeout(timer);}}}
