import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = process.cwd(), temp = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-codex-ui-'));
for (const dir of ['bin', 'home', 'tmp', 'workspace']) await mkdir(path.join(temp, dir));
const binary = path.join(temp, 'bin/codex');
await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
if(process.argv.includes('--version')){ console.log('codex-cli 0.133.0');process.exit(0); }
const home=process.env.CODEX_HOME; let signed=fs.existsSync(path.join(home,'signed'));let turn=0;
const notify=(method,params)=>console.log(JSON.stringify({method,params}));
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(path.join(home,'fixture-requests.jsonl'),JSON.stringify(q)+'\\n');if(!q.id)return;const reply=result=>console.log(JSON.stringify({id:q.id,result}));
if(q.method==='initialize')reply({userAgent:'fixture/0.133.0'});
else if(q.method==='account/read')reply({account:signed?{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}:null,requiresOpenaiAuth:true});
else if(q.method==='account/login/start'){reply({type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/oauth/authorize?state=fixture'});setTimeout(()=>{signed=true;fs.writeFileSync(path.join(home,'signed'),'fixture');notify('account/login/completed',{loginId:'fixture-login',success:true,error:null});},50);}
else if(q.method==='model/list')reply({data:[{model:'gpt-5.5',isDefault:true,hidden:false}]});
else if(q.method==='thread/start')reply({thread:{id:'native-thread'},cwd:q.params.cwd,model:'gpt-5.5',modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}});
else if(q.method==='turn/start'){const id='turn-'+(++turn);reply({turn:{id,status:'inProgress'}});setTimeout(()=>{notify('item/agentMessage/delta',{threadId:'native-thread',turnId:id,itemId:'message-'+turn,delta:'Codex 合成回复 '+turn});notify('turn/completed',{threadId:'native-thread',turn:{id,status:'completed'}});},40);}
else reply({});});`); await chmod(binary, 0o700);
const env = { HOME: path.join(temp, 'home'), TMPDIR: path.join(temp, 'tmp'), PATH: [path.join(temp, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: path.join(temp, 'preview'), SCREENDECK_PROJECT_HISTORY_ROOT: path.join(temp, 'project-history') };
for (const key of ['LANG', 'USER', 'LOGNAME', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key];
const artifacts = path.join(root, 'artifacts/codex-ui-smoke'); await mkdir(artifacts, { recursive: true });
let app; const checks = [], errors = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS '+name); };
try {
 app = await electron.launch({ args: [root], env, timeout: 30000 }); const page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
 await app.evaluate(({ shell, dialog }, workspace) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]}); globalThis.__codexOpened=[]; shell.openExternal=async url=>{globalThis.__codexOpened.push(url);}; },path.join(temp,'workspace'));
 const input=page.getByRole('textbox',{name:'输入消息',exact:true}), source=page.getByRole('combobox',{name:'聊天来源',exact:true});
 await expect(input).toBeVisible(); await source.selectOption('agent:codex'); await page.getByRole('button',{name:'Agent 设置',exact:true}).click();
 const card=page.getByTestId('codex-runtime-card');
 await check('source-selection-and-settings-do-not-start-or-login',async()=>{await expect(card).toContainText('未连接');assert.deepEqual(await page.evaluate(()=>window.screendeck.getCodexStatus()),{state:'stopped'});assert.equal((await app.evaluate(()=>globalThis.__codexOpened)).length,0);});
 await check('explicit-connect-and-browser-login-update-source-without-provider-key',async()=>{await card.getByRole('button',{name:'连接 Codex',exact:true}).click();await expect(card.getByRole('button',{name:'使用 ChatGPT 登录',exact:true})).toBeVisible();await card.getByRole('button',{name:'使用 ChatGPT 登录',exact:true}).click();await expect(card).toContainText('fixture@example.invalid');assert.equal((await app.evaluate(()=>globalThis.__codexOpened)).length,1);const data=await page.evaluate(()=>window.screendeck.getAgentSources());assert.equal(data.find(s=>s.agentID==='codex').state,'ready');});
 await page.screenshot({path:path.join(artifacts,'codex-settings.png')});
 await page.getByRole('dialog',{name:'设置',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'选择工作目录',exact:true}).click();
 await check('two-turn-chat-reuses-one-native-thread-and-clears-input',async()=>{for(let n=1;n<=2;n++){await input.fill('合成输入 '+n);await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(input).toHaveValue('');await expect(page.getByText('Codex 合成回复 '+n,{exact:true})).toBeVisible();}const calls=(await readFile(path.join(temp,'preview/codex/home/fixture-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(q=>q.method==='thread/start').length,1);assert.deepEqual(calls.filter(q=>q.method==='turn/start').map(q=>q.params.input[0].text),['合成输入 1','合成输入 2']);});
 await check('disconnect-preserves-history-and-blocks-old-binding',async()=>{await page.getByRole('button',{name:'Agent 设置',exact:true}).click();await card.getByRole('button',{name:'断开连接',exact:true}).click();await expect(card).toContainText('未连接');await page.getByRole('dialog',{name:'设置',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByText('Codex 合成回复 2',{exact:true})).toBeVisible();await input.fill('不能发送');await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();});
 await check('narrow-settings-remain-within-viewport-and-keyboard-operable',async()=>{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(680,820));await page.getByRole('button',{name:'Agent 设置',exact:true}).click();await card.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await card.getByRole('button',{name:'连接 Codex',exact:true}).focus();await expect(card.getByRole('button',{name:'连接 Codex',exact:true})).toBeFocused();await page.screenshot({path:path.join(artifacts,'codex-settings-narrow.png')});});
 assert.deepEqual(errors,[]);await writeFile(path.join(artifacts,'report.json'),JSON.stringify({checks,errors,temp},null,2));
}finally{await app?.close();}
