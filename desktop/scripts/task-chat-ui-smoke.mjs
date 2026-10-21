import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = 'work/task-chat';
await mkdir(out, {recursive:true});
const source = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import './src/renderer/styles.css';
import{TaskChatPanel,TaskChatApprovals,TaskPlanProposalCard}from'./src/renderer/task-chat/TaskChatPanel';
const scope={key:'local:fixture-plan',title:'整理任务材料与讨论方案',version:3};
const proposal={id:'proposal-1',taskKey:scope.key,baseVersion:3,sourceLabel:'聊天消息 fixture-2',reason:'补充验收条件',text:'先检查失败路径，再确认验收。'};
const initialSessions={state:'ready',items:[{id:'chat-a',title:'方案讨论',sourceLabel:'Codex',agentID:'codex',execution:{workspace:{id:'workspace',path:'/tmp/synthetic-workspace/long-folder-name-only-for-layout',label:'隔离目录'},mode:'auto-edit'}},{id:'chat-b',title:'普通聊天',sourceLabel:'直接模型'},{id:'chat-old',title:'旧只读聊天',sourceLabel:'Codex',agentID:'codex',execution:{workspace:{id:'workspace',path:'/tmp/synthetic-only',label:'隔离目录'},mode:'read-only'}}]};
const initialMaterials={state:'ready',items:[{id:'m-a',title:'确认过的材料摘要',sourceLabel:'手动选择 · fixture-a',summary:'仅这段合成摘要被选入聊天草稿。',available:true},{id:'m-b',title:'尚未选择的材料',sourceLabel:'文件 · fixture-b',summary:'不应自动附加。',available:true},{id:'m-x',title:'失效来源',sourceLabel:'文件 · fixture-x',summary:'原摘要保留',available:false}]};
const events=[];window.events=events;
function Preview(){const[draft,setDraft]=useState({target:{kind:'new'},materialIDs:[],text:''}),[sessions,setSessions]=useState(initialSessions),[materials,setMaterials]=useState(initialMaterials),[operation,setOperation]=useState({state:'idle'}),[text,setText]=useState(proposal.text),[version,setVersion]=useState(3),[linked,setLinked]=useState('chat-a'),[task,setTask]=useState(true);
window.fixture={sessions:setSessions,materials:setMaterials,operation:setOperation,stale:()=>setVersion(4),standalone:()=>setTask(false),draft:()=>draft};
return <main style={{maxWidth:640,margin:'24px auto',display:'grid',gap:16,padding:12}}><p>隔离 UI harness · 合成数据 · 未接生产 IPC</p><TaskChatPanel scope={task?{...scope,version}:undefined} sessions={sessions} materials={materials} draft={draft} operation={operation} linkedSessionID={linked} onChange={setDraft} onPrepare={value=>{events.push(value);setOperation({state:'success'})}} onRetrySessions={()=>setSessions(initialSessions)} onRetryMaterials={()=>setMaterials(initialMaterials)} onOpenSession={id=>events.push({kind:'open',id})} onUnlink={()=>{events.push({kind:'unlink'});setLinked(undefined)}} onOpenStandaloneChat={()=>events.push({kind:'standalone'})}/><TaskPlanProposalCard scope={{...scope,version}} proposal={proposal} text={text} operation={operation} onChange={setText} onStage={value=>events.push(value)} onReject={()=>events.push({kind:'reject'})}/><TaskChatApprovals sessionID='chat-a' turnID='turn-a' approvals={{state:'ready',items:[{id:'approval-a',toolID:'tool-a',title:'运行合成检查命令',detail:'node fixture-check.mjs',canAllow:true,state:'pending'},{id:'approval-policy',toolID:'tool-b',title:'写入工作区文件',detail:'/tmp/synthetic-only/a.txt',canAllow:true,state:'pending',decider:'policy'},{id:'expired',toolID:'tool-c',title:'旧请求',detail:'已结束',canAllow:true,state:'expired'}]}} onOpenApproval={value=>events.push({kind:'approval-open',...value})}/></main>}
createRoot(document.getElementById('root')).render(<Preview/>);`;
const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:'fixture.js',loader:{'.svg':'dataurl'},write:false});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
await writeFile(`${out}/TaskChat.preview.html`, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TaskChat · isolated preview</title><style>${css} html,body,#root{height:auto;min-height:100%;overflow:visible}</style><div id="root"></div><script>${js.replaceAll('</script','<\\/script')}</script></html>`);
const browser=await chromium.launch({headless:true,...(process.env.SCREENDECK_CHROMIUM_EXECUTABLE?{executablePath:process.env.SCREENDECK_CHROMIUM_EXECUTABLE}:{})});
let externalRequests=0;const errors=[],checks=[];
const page=await browser.newPage({viewport:{width:1000,height:1000}});page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',r=>{if(r.request().url().startsWith('file:')) return r.continue(); externalRequests++;return r.abort()});
const events=()=>page.evaluate(()=>window.events);
const panel=page.getByRole('region',{name:'任务关联聊天',exact:true});
const prepare=()=>page.getByRole('button',{name:'放入聊天草稿',exact:true});
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)};
try{
await page.goto(new URL('../'+out+'/TaskChat.preview.html',import.meta.url).href);
await check('opening-selection-and-material-toggles-do-not-prepare-or-send',async()=>{
assert.deepEqual(await events(),[]);await expect(prepare()).toBeDisabled();await page.getByRole('textbox',{name:'讨论内容',exact:true}).fill('讨论这项工作的方案');await page.getByRole('radio',{name:'选择已有聊天'}).check();await expect(prepare()).toBeDisabled();await page.getByLabel('已有聊天',{exact:true}).selectOption('chat-a');await expect(page.getByRole('button',{name:'Agent 权限'})).toBeDisabled();await panel.getByRole('checkbox').nth(0).check();assert.deepEqual(await events(),[]);await page.screenshot({path:out+'/selection.png',fullPage:true});
});
await check('explicit-handoff-contains-only-selected-summary-and-no-execution',async()=>{
await prepare().click();const result=(await events())[0];assert.equal(result.kind,'discussion-draft');assert.equal(result.baseVersion,3);assert.deepEqual(result.materials.map(x=>x.id),['m-a']);assert.equal('execution'in result,false);await expect(panel.getByRole('status')).toContainText('已放入聊天草稿');
});
await check('open-unlink-and-standalone-are-distinct-intents',async()=>{
await panel.getByRole('button',{name:'打开聊天',exact:true}).click();await panel.getByRole('button',{name:'解除关联'}).click();await panel.getByRole('button',{name:'独立聊天',exact:true}).click();assert.deepEqual((await events()).slice(-3).map(e=>e.kind),['open','unlink','standalone']);
});
await check('pending-operation-disables-editing-and-preserves-text',async()=>{
await page.evaluate(()=>window.fixture.operation({state:'pending'}));await expect(page.getByRole('textbox',{name:'讨论内容',exact:true})).toBeDisabled();await expect(page.getByRole('textbox',{name:'讨论内容',exact:true})).toHaveValue('讨论这项工作的方案');await expect(page.getByRole('button',{name:'正在准备…'})).toBeDisabled();await page.evaluate(()=>window.fixture.operation({state:'idle'}));
});
await check('load-error-is-distinct-from-empty-and-retry-retains-selection',async()=>{
await page.evaluate(()=>window.fixture.materials({state:'error',message:'合成材料读取失败'}));await expect(panel.getByRole('alert')).toContainText('合成材料读取失败');await expect(prepare()).toBeDisabled();await panel.getByRole('button',{name:'重新读取'}).click();await expect(panel.getByRole('checkbox').nth(0)).toBeChecked();await page.evaluate(()=>window.fixture.materials({state:'ready',items:[]}));await expect(panel).toContainText('任务暂无材料');await expect(prepare()).toBeDisabled();await panel.getByRole('button',{name:'清空材料选择'}).click();await expect(prepare()).toBeEnabled();
});
await check('chat-loading-error-empty-and-legacy-mode-render-honestly',async()=>{
await page.evaluate(()=>window.fixture.sessions({state:'loading'}));await expect(panel).toContainText('正在读取');await expect(prepare()).toBeDisabled();await page.evaluate(()=>window.fixture.sessions({state:'error',message:'合成聊天不可读'}));await expect(panel.getByRole('alert')).toContainText('合成聊天不可读');await panel.getByRole('button',{name:'重新读取'}).click();await page.getByLabel('已有聊天',{exact:true}).selectOption('chat-old');await expect(panel).toContainText('只读（旧会话）');await expect(panel.getByRole('button',{name:'Agent 权限'})).toBeDisabled();await page.evaluate(()=>window.fixture.sessions({state:'ready',items:[]}));await expect(panel).toContainText('没有可选择的聊天');await page.getByRole('radio',{name:'新建讨论',exact:true}).check();await expect(prepare()).toBeEnabled();
});
await check('plan-edits-only-stage-pending-draft-and-stale-version-blocks',async()=>{
await page.getByRole('textbox',{name:'候选修改',exact:true}).fill('人工修订候选');await page.getByRole('button',{name:'生成待确认草稿'}).click();const last=(await events()).at(-1);assert.equal(last.state,'pending-confirmation');assert.equal(last.text,'人工修订候选');await page.evaluate(()=>window.fixture.stale());await expect(page.getByRole('button',{name:'生成待确认草稿'})).toBeDisabled();await page.getByRole('button',{name:'拒绝建议'}).click();assert.equal((await events()).at(-1).kind,'reject');
});
await check('approvals-only-navigate-to-original-bound-request',async()=>{
const approvals=page.getByRole('region',{name:'任务聊天审批'});await expect(approvals).toContainText('正在按所选模式处理');await expect(approvals).toContainText('申请已失效');assert.equal(await approvals.getByRole('button',{name:/批准|拒绝/}).count(),0);await approvals.getByRole('button',{name:'在原聊天查看'}).first().click();assert.deepEqual((await events()).at(-1),{kind:'approval-open',sessionID:'chat-a',turnID:'turn-a',approvalID:'approval-a'});
});
await check('failure-retains-input-and-keyboard-focus-is-visible',async()=>{
await page.evaluate(()=>window.fixture.operation({state:'error',message:'合成准备失败，请重试'}));await expect(panel.getByRole('alert')).toContainText('合成准备失败');await expect(page.getByRole('textbox',{name:'讨论内容',exact:true})).toHaveValue('讨论这项工作的方案');await prepare().focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'TEXTAREA');assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'solid');
});
await page.screenshot({path:`${out}/desktop.png`,fullPage:true});
await check('320px-and-reduced-motion-have-no-horizontal-overflow',async()=>{
await page.setViewportSize({width:320,height:900});await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`${out}/narrow.png`,fullPage:true});
});
await check('no-task-retains-ordinary-chat-entry',async()=>{
await page.evaluate(()=>window.fixture.standalone());await page.getByRole('button',{name:'打开独立聊天',exact:true}).click();assert.equal((await events()).at(-1).kind,'standalone');
});
assert.deepEqual(errors,[]);assert.equal(externalRequests,0);
await writeFile(`${out}/verification.json`,JSON.stringify({checks,errors,externalRequests,productionIPC:false,realModels:false},null,2));
}finally{await browser.close()}
