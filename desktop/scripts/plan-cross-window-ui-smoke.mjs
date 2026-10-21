import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

// Mount the real TaskDetails component. The in-memory callbacks simulate only
// plan persistence and a second window's props; no Electron, model, or user data.
const source = String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import './src/renderer/styles.css';
import {TaskDetails} from './src/renderer/TaskDetails';
const copy=value=>structuredClone(value);
const at=version=>'2026-10-21T01:00:'+String(version).padStart(2,'0')+'.000Z';
const scope={project_id:'project-abcdef00-0000-0000-0000-000000000000',task_id:'task-001'};
const task={schema_version:1,kind:'task',...scope,title:'合成项目任务',goal:'只验证预览计划跨窗状态',status:'draft',plan_version:1,assignee:'human',created_at:at(1),updated_at:at(1),run_ids:[],acceptance:[],references:[],historical:true,is_live:false};
const agent=window.__seed?.agent===true;
const child={id:'abcdef01-0000-0000-0000-000000000000',title:agent?'由具体 Agent 处理的合成步骤':'初始已保存工作项',kind:agent?'implementation':'discussion',assignee:agent?'agent':'unassigned',...(agent?{agentID:'opencode',model:{provider_id:'fixture-provider',model_id:'fixture-model'}}:{}),expected_result:agent?'':'合成预期结果',dependencies:[],status:'planned'};
let persisted=[{schema_version:agent?2:1,kind:'electron_preview_plan',id:'abcdef02-0000-0000-0000-000000000000',title:'已有合成计划',version:1,created_at:at(1),updated_at:at(1),scope,work_items:[child]}];
const calls={create:[],save:[],recommend:0,preview:0};
function App(){
 const[plans,setPlans]=useState(copy(persisted));
 const publish=plan=>{persisted=[copy(plan),...persisted.filter(value=>value.id!==plan.id)];setPlans(copy(persisted));};
 window.planFixture={snapshot:()=>copy({plans:persisted,calls}),publishVersion:({version,childTitle})=>{const current=persisted.find(value=>value.id==='abcdef02-0000-0000-0000-000000000000');publish({...current,version,updated_at:at(version),work_items:current.work_items.map((item,index)=>index===0?{...item,title:childTitle}:item)});}};
 const create=async(title,items)=>{calls.create.push(copy({title,items}));const plan={schema_version:1,kind:'electron_preview_plan',id:crypto.randomUUID(),title,version:1,created_at:at(5),updated_at:at(5),scope,work_items:copy(items)};publish(plan);return copy(plan);};
 const save=async plan=>{calls.save.push(copy(plan));const current=persisted.find(value=>value.id===plan.id);if(!current||current.version!==plan.version)throw Error('预览计划版本冲突。');const saved={...copy(plan),version:plan.version+1,updated_at:at(plan.version+1)};publish(saved);return copy(saved);};
 return <main id="app-shell" className="app-shell context-open"><div className="brand-header">ScreenDeck · 合成回归</div><aside className="sidebar"/><header className="topbar"><span>计划跨窗回归</span></header><section id="center-column"><p style={{padding:32}}>仅挂载真实 TaskDetails；外部计划更新由合成属性驱动。</p></section><TaskDetails open task={task} runs={[]} references={[]} plans={plans} model={{provider_id:'fixture-provider',model_id:'fixture-model'}} onClose={()=>{}} onPreview={async()=>{calls.preview++;throw Error('No file preview in this fixture')}} onCreatePlan={create} onSavePlan={save} onRecommend={async()=>{calls.recommend++;return[];}}/></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

const result = await build({
  stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'iife', outfile: 'fixture.js',
  loader: { '.svg': 'dataurl' }, write: false,
});
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text;
const artifacts = path.join(process.cwd(), 'artifacts/plan-cross-window-ui-smoke');
await mkdir(artifacts, { recursive: true });
const checks = [], screenshots = [], pageErrors = [];
let externalRequests = 0, browser, activePage, failure;
const snapshot = page => page.evaluate(() => window.planFixture.snapshot());
const check = async (name, run) => { await run(); checks.push(name); console.log('PASS ' + name); };
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(artifacts, name) }); screenshots.push(name);
}
async function fixture(seed = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); activePage = page;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(seed => { window.__seed = seed; }, seed);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://plans.invalid') { externalRequests++; return route.abort(); }
    const script = url.pathname.endsWith('.js'), style = url.pathname.endsWith('.css');
    return route.fulfill({ contentType: script ? 'text/javascript' : style ? 'text/css' : 'text/html', body: script ? js : style ? css : '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>' });
  });
  await page.goto('https://plans.invalid');
  await page.getByRole('tab', { name: '分工', exact: true }).click();
  await expect(page.locator('.task-section-heading')).toContainText('v1');
  return page;
}
async function edit(page) {
  await page.getByRole('button', { name: '编辑计划', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '打开已保存的预览计划' })).toBeVisible();
}

try {
  browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--no-first-run'], ...(process.env.SCREENDECK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SCREENDECK_CHROMIUM_EXECUTABLE } : {}) });
  await check('new-plan-remains-empty-and-creates-a-second-plan-without-overwriting-the-first', async () => {
    const page = await fixture(); await edit(page);
    await page.getByRole('combobox', { name: '打开已保存的预览计划' }).selectOption('');
    await expect(page.getByRole('combobox', { name: '打开已保存的预览计划' })).toHaveValue('');
    await expect(page.locator('.plan-item')).toHaveCount(0);
    // A props refresh after choosing New must not reselect the first saved plan.
    await page.evaluate(() => window.planFixture.publishVersion({ version: 2, childTitle: '外窗更新原有计划' }));
    await expect(page.getByRole('combobox', { name: '打开已保存的预览计划' })).toHaveValue('');
    await expect(page.locator('.plan-item')).toHaveCount(0);
    await page.getByRole('button', { name: '添加工作项', exact: true }).click();
    await page.getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('第二份计划的工作项');
    await page.getByRole('textbox', { name: '工作项 1 预期结果', exact: true }).fill('第二份计划的合成结果');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect(page.getByText(/已保存预览计划/).filter({ hasText: '工作项尚未执行' })).toBeVisible();
    const state = await snapshot(page); assert.equal(state.calls.create.length, 1); assert.equal(state.calls.save.length, 0); assert.equal(state.plans.length, 2);
    assert.equal(state.plans.find(plan => plan.id === 'abcdef02-0000-0000-0000-000000000000').version, 2);
    assert.equal(state.plans[0].work_items[0].title, '第二份计划的工作项');
    assert.notEqual(state.plans[0].id, 'abcdef02-0000-0000-0000-000000000000');
    await screenshot(page, 'second-plan-created.png'); await page.close();
  });
  await check('clean-editor-follows-the-higher-version-from-another-window', async () => {
    const page = await fixture(); await edit(page);
    await page.evaluate(() => window.planFixture.publishVersion({ version: 2, childTitle: '其他窗口已保存的最新内容' }));
    await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue('其他窗口已保存的最新内容');
    await expect(page.locator('.task-section-heading')).toContainText('v2');
    await expect(page.getByText('尚未保存', { exact: true })).toHaveCount(0);
    assert.equal((await snapshot(page)).calls.save.length, 0);
    await screenshot(page, 'clean-editor-updated.png'); await page.close();
  });
  await check('dirty-editor-keeps-its-old-version-and-input-until-explicit-discard-loads-the-latest', async () => {
    const page = await fixture(); await edit(page);
    await page.getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('我的未保存草稿');
    await page.evaluate(() => window.planFixture.publishVersion({ version: 2, childTitle: '其他窗口的版本二' }));
    await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue('我的未保存草稿');
    await expect(page.locator('.task-section-heading')).toContainText('v1');
    await expect(page.getByText('计划已在其他窗口更新，当前输入已保留；请核对后再保存。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect(page.getByText('预览计划版本冲突。', { exact: true })).toBeVisible();
    let state = await snapshot(page); assert.equal(state.calls.save.at(-1).version, 1); assert.equal(state.plans[0].version, 2);
    await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue('我的未保存草稿');
    await screenshot(page, 'dirty-conflict-preserved.png');
    await page.getByRole('button', { name: '放弃修改并加载最新', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '工作项 1 内容', exact: true })).toHaveValue('其他窗口的版本二');
    await expect(page.locator('.task-section-heading')).toContainText('v2');
    await expect(page.getByRole('button', { name: '放弃修改并加载最新', exact: true })).toHaveCount(0);
    await expect(page.getByText('尚未保存', { exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('恢复后可以保存的新草稿');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect(page.locator('.task-section-heading')).toContainText('v3');
    state = await snapshot(page); assert.equal(state.calls.save.at(-1).version, 2); assert.equal(state.plans[0].version, 3);
    await screenshot(page, 'discard-loaded-and-resaved.png'); await page.close();
  });
  await check('v2-Agent-assignment-survives-main-rendering-and-clears-old-Agent-fields-when-changed-to-human', async () => {
    const page = await fixture({ agent: true });
    await expect(page.getByTestId('task-work-items')).toContainText('Agent · opencode');
    await edit(page);
    const owner = page.getByRole('combobox', { name: '工作项 1 分工', exact: true });
    await expect(owner).toHaveValue('agent');
    await expect(owner.locator('option:checked')).toHaveText('Agent · opencode');
    await page.getByRole('textbox', { name: '工作项 1 内容', exact: true }).fill('保留具体 Agent 的改名步骤');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect(page.locator('.task-section-heading')).toContainText('v2');
    let state = await snapshot(page); assert.equal(state.calls.save.at(-1).work_items[0].agentID, 'opencode');
    assert.equal(state.calls.save.at(-1).work_items[0].model.model_id, 'fixture-model');
    await screenshot(page, 'agent-plan-preserved.png');
    await owner.selectOption('human');
    await page.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect(page.locator('.task-section-heading')).toContainText('v3');
    state = await snapshot(page); const saved = state.calls.save.at(-1).work_items[0];
    assert.equal(saved.assignee, 'human'); assert.equal(Object.hasOwn(saved, 'agentID'), false); assert.equal(Object.hasOwn(saved, 'model'), false);
    assert.equal(state.plans[0].schema_version, 2); assert.equal(state.plans[0].work_items[0].expected_result, '');
    await page.getByRole('button', { name: '收起编辑', exact: true }).click();
    await expect(page.getByTestId('task-work-items')).toContainText('由你处理');
    await expect(page.getByTestId('task-work-items')).not.toContainText('Agent ·');
    assert.equal(state.calls.recommend, 0); assert.equal(state.calls.preview, 0);
    await screenshot(page, 'agent-plan-changed-to-human.png'); await page.close();
  });
  assert.deepEqual(pageErrors, []); assert.equal(externalRequests, 0);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure.png').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ checks, screenshots, pageErrors, externalRequests, failure, artifacts, limitations: ['Real TaskDetails React component, synthetic plan props and in-memory CAS callbacks; no Electron IPC or disk persistence is claimed.', 'Network requests are fulfilled locally or aborted; no model, Agent runtime, credentials or real user records are used.'] }, null, 2));
  await browser?.close();
}
