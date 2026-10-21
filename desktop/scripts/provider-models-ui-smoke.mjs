import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

// Actual Settings/Modal components with synthetic, fixed API responses only.
// No Electron credentials, provider HTTP, Agent process or user data is used.
const source = `
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import './src/renderer/styles.css';
import {Settings} from './src/renderer/Settings';
const seed=window.__providerSeed;
const state={settings:{baseURL:'https://fixture.invalid/v1',modelID:'model-old',hasKey:false,credentialStorage:'none',...seed.settings},catalog:seed.catalog??{baseURL:'',modelIDs:[]},result:seed.result??{kind:'available',modelIDs:['model-old','model-b']},counts:{cacheReads:0,lists:0,saves:0,selections:0,starts:0,submissions:0},hold:false,pending:null,pendingCatalog:null,pendingCache:null,cacheHoldClaimed:false,rejectSave:false,rememberedOnly:true};
const listeners=new Set();
const changed=()=>listeners.forEach(callback=>callback({type:'settings-updated',settings:state.settings}));
const api={
 getProviderModels:async()=>{state.counts.cacheReads++;if(state.counts.saves>0&&seed.afterSaveCatalog==='failure')throw new Error('合成缓存读取失败。');if(state.counts.saves>0&&seed.afterSaveCatalog==='hold'&&!state.cacheHoldClaimed){state.cacheHoldClaimed=true;return new Promise(resolve=>state.pendingCache={resolve});}return state.catalog;},
 listProviderModels:async input=>{state.counts.lists++;if(state.hold){state.hold=false;return new Promise((resolve,reject)=>state.pending={resolve,reject});}if(state.result.kind==='failure')throw new Error('校验失败，请检查地址和密钥。');state.pendingCatalog={baseURL:input.baseURL,modelIDs:state.result.modelIDs??[]};return state.result;},
 selectProviderModel:async({modelID})=>{state.counts.selections++;if(!state.catalog.modelIDs.includes(modelID))throw new Error('模型不在本机列表。');state.settings={...state.settings,modelID};changed();return state.settings;},
 saveSettings:async input=>{state.counts.saves++;state.rememberedOnly&&=input.rememberKey===true;if(state.rejectSave){state.rejectSave=false;throw new Error('保存失败，输入已保留。');}state.settings={baseURL:input.baseURL,modelID:input.modelID,hasKey:!input.forgetKey&&!!(input.apiKey||state.settings.hasKey),credentialStorage:input.forgetKey?'none':'file'};if(input.forgetKey||seed.afterSaveCatalog==='empty'||seed.afterSaveCatalog==='failure'||seed.afterSaveCatalog==='hold')state.catalog={baseURL:input.baseURL,modelIDs:[]};else if(seed.afterSaveCatalog==='wrong-address')state.catalog={baseURL:'https://other-fixture.invalid/v1',modelIDs:['unusable-other-model']};else if(state.pendingCatalog?.baseURL===input.baseURL)state.catalog=state.pendingCatalog;state.pendingCatalog=null;changed();return state.settings;},
 getOpenCodeStatus:async()=>({state:'stopped'}),getOpenCodeInstallation:async()=>({candidates:[]}),
 startOpenCode:async()=>{state.counts.starts++;throw new Error('Fixture forbids Agent startup.');},
 sendMessage:async()=>{state.counts.submissions++;throw new Error('Fixture forbids model submission.');},
 subscribe:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}
};
window.providerFixture={counts:state.counts,setResult:result=>state.result=result,holdList:()=>state.hold=true,hasPending:()=>!!state.pending,resolveList:result=>{const pending=state.pending;state.pending=null;pending.resolve(result);},hasPendingCache:()=>!!state.pendingCache,resolveCache:catalog=>{const pending=state.pendingCache;state.pendingCache=null;pending.resolve(catalog);},rejectNextSave:()=>state.rejectSave=true,publicSettings:()=>state.settings,rememberedOnly:()=>state.rememberedOnly};
function Preview(){const[settings,setSettings]=useState(state.settings);const[open,setOpen]=useState(false);useEffect(()=>api.subscribe(event=>setSettings(event.settings)),[]);return <><main id='app-shell'><button id='settings-trigger' onClick={()=>setOpen(true)}>打开设置</button></main><Settings open={open} settings={settings} initialSection='models' runtimeAPI={api} dataRootLabel='合成临时目录' onClose={()=>setOpen(false)} onSave={async input=>{const saved=await api.saveSettings(input);setSettings(saved);return saved;}}/></>;}
createRoot(document.getElementById('root')).render(<Preview/>);
`;
const output = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'provider-fixture.tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: 'fixture.js', loader: { '.svg': 'dataurl' }, write: false });
const javascript = output.outputFiles.find(file => file.path.endsWith('.js')).text, stylesheet = output.outputFiles.find(file => file.path.endsWith('.css')).text;
const origin = 'https://provider-ui-fixture.invalid';
let browser, externalRequests = 0;
const checks = [], pageErrors = [];
const check = async (name, operation) => { await operation(); checks.push(name); console.log('PASS ' + name); };
const modal = page => page.getByRole('dialog', { name: '设置', exact: true });
const primary = page => page.getByTestId('settings-save-model');
const model = page => page.locator('#provider-model');
const key = page => page.locator('#provider-key');
const counts = page => page.evaluate(() => ({ ...window.providerFixture.counts }));
const saved = page => page.evaluate(() => window.providerFixture.publicSettings());
async function open(page) { await page.getByRole('button', { name: '打开设置', exact: true }).click(); await expect(modal(page)).toBeVisible(); await expect(page.locator('#app-shell')).toHaveAttribute('inert', ''); }
async function close(page) { await page.keyboard.press('Escape'); await expect(modal(page)).toHaveCount(0); await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeFocused(); }
async function fixture(seed = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  page.on('pageerror', error => { pageErrors.push(error.message); console.error(error.message); });
  await page.addInitScript(value => { window.__providerSeed = value; }, seed);
  await page.route('**/*', route => {
    const url = new URL(route.request().url()); if (url.origin !== origin) { externalRequests++; return route.abort(); }
    const script = url.pathname === '/fixture.js', css = url.pathname === '/fixture.css';
    return route.fulfill({ contentType: script ? 'text/javascript' : css ? 'text/css' : 'text/html', body: script ? javascript : css ? stylesheet : '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
  });
  await page.goto(origin); await open(page); return page;
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SCREENDECK_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SCREENDECK_CHROMIUM_EXECUTABLE } : {}) });
  await check('model-settings-omit-static-helper-copy-with-labelled-fields', async () => {
    const page = await fixture();
    await expect(page.locator('#settings-panel-models .field-help, #settings-panel-models .settings-section-header p')).toHaveCount(0);
    for (const id of ['provider-url', 'provider-key', 'provider-model']) {
      await expect(page.locator('#' + id)).toBeVisible(); await expect(page.locator('label[for="' + id + '"]')).toBeVisible();
      await expect(page.locator('#' + id)).not.toHaveAttribute('aria-describedby', /provider-.*-help/);
    }
    await page.close();
  });
  await check('opening-reads-only-local-catalog-and-never-reveals-existing-key', async () => {
    const page = await fixture({ settings: { hasKey: true, credentialStorage: 'file' }, catalog: { baseURL: 'https://fixture.invalid/v1', modelIDs: ['model-old', 'model-b'] } });
    await expect.poll(async () => (await counts(page)).cacheReads).toBe(1); assert.equal((await counts(page)).lists, 0); assert.equal((await counts(page)).saves, 0);
    await expect(key(page)).toHaveValue(''); await expect(key(page)).toHaveAttribute('placeholder', '•••••• · 输入新密钥替换'); await expect(page.getByTestId('provider-key-status')).toHaveText('已保存');
    await expect(page.getByRole('checkbox', { name: '记住 API 密钥' })).toHaveCount(0); await expect(model(page)).toHaveValue('model-old');
    await model(page).selectOption('model-b'); await expect.poll(async () => (await saved(page)).modelID).toBe('model-b'); assert.equal((await counts(page)).selections, 1); assert.equal((await counts(page)).lists, 0); await page.close();
  });
  await check('explicit-check-saves-matching-model-and-always-remembers-key', async () => {
    const page = await fixture(); await key(page).fill('synthetic-provider-key'); await primary(page).click();
    await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1); await expect(key(page)).toHaveValue(''); await expect(page.getByTestId('provider-key-status')).toHaveText('已保存');
    assert.equal((await counts(page)).lists, 1); assert.equal((await counts(page)).saves, 1); assert.equal(await page.evaluate(() => window.providerFixture.rememberedOnly()), true);
    assert.equal(JSON.stringify(await saved(page)).includes('synthetic-provider-key'), false); await page.close();
  });
  await check('missing-current-model-needs-explicit-choice-without-default-first', async () => {
    const page = await fixture({ result: { kind: 'available', modelIDs: ['model-a', 'model-b'] } }); await key(page).fill('synthetic-provider-key'); await primary(page).click();
    await expect(model(page)).toHaveValue(''); await expect(model(page).locator('option:checked')).toHaveText('请选择模型'); assert.equal((await counts(page)).saves, 0);
    await model(page).selectOption('model-b'); await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1); assert.equal((await saved(page)).modelID, 'model-b'); assert.equal((await counts(page)).saves, 1); await page.close();
  });
  await check('unsupported-or-empty-catalog-requires-second-unverified-save', async () => {
    for (const result of [{ kind: 'unsupported' }, { kind: 'available', modelIDs: [] }]) {
      const page = await fixture({ result }); await key(page).fill('synthetic-provider-key'); await primary(page).click();
      await expect(primary(page)).toHaveText('保存（未验证）'); assert.equal((await counts(page)).saves, 0); await model(page).fill('manual-model'); await primary(page).click();
      await expect(page.getByText('连接已保存，模型未验证。', { exact: true })).toBeVisible(); assert.equal((await counts(page)).lists, 1); assert.equal((await counts(page)).saves, 1); await page.close();
    }
  });
  await check('failed-check-retains-input-and-editing-invalidates-old-verification', async () => {
    const page = await fixture({ result: { kind: 'failure' } }); await key(page).fill('synthetic-retained-key'); await primary(page).click();
    await expect(page.getByText('校验失败，请检查地址和密钥。', { exact: true })).toBeVisible(); await expect(key(page)).toHaveValue('synthetic-retained-key'); assert.equal((await counts(page)).saves, 0);
    await page.evaluate(() => window.providerFixture.setResult({ kind: 'available', modelIDs: ['model-a'] })); await primary(page).click(); await expect(model(page)).toHaveValue('');
    await page.locator('#provider-url').fill('https://edited.invalid/v1'); await expect(model(page)).toHaveJSProperty('tagName', 'INPUT'); await expect(primary(page)).toHaveText('校验并保存');
    await key(page).fill('new-synthetic-key'); assert.equal((await counts(page)).saves, 0); await close(page); await open(page); await expect(key(page)).toHaveValue(''); await page.close();
  });
  await check('pending-check-is-once-and-late-result-after-close-cannot-save', async () => {
    const page = await fixture(); await key(page).fill('synthetic-pending-key'); await page.evaluate(() => window.providerFixture.holdList());
    await page.locator('.provider-connection').evaluate(node => { node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await expect.poll(() => page.evaluate(() => window.providerFixture.hasPending())).toBe(true); await expect(primary(page)).toBeDisabled(); await expect(key(page)).toBeDisabled(); assert.equal((await counts(page)).lists, 1);
    await close(page); await page.evaluate(() => window.providerFixture.resolveList({ kind: 'available', modelIDs: ['model-old'] }));
    await open(page); await expect(primary(page)).toBeEnabled(); await expect(key(page)).toHaveValue(''); assert.equal((await counts(page)).saves, 0); await page.close();
  });
  await check('saved-key-is-replaced-by-editing-without-a-removal-control', async () => {
    const page = await fixture({ settings: { hasKey: true, credentialStorage: 'file' } });
    await expect(page.getByRole('button', {name: '移除已保存密钥', exact: true})).toHaveCount(0);
    await key(page).fill('synthetic-replacement-key'); await page.evaluate(() => window.providerFixture.rejectNextSave());
    await primary(page).click(); await expect(page.getByText('保存失败，输入已保留。', {exact: true})).toBeVisible();
    await expect(key(page)).toHaveValue('synthetic-replacement-key'); assert.equal((await saved(page)).hasKey, true);
    await primary(page).click(); await expect(primary(page)).toBeEnabled(); await expect(key(page)).toHaveValue('');
    await expect(page.getByTestId('provider-key-status')).toHaveText('已保存');
    assert.equal((await counts(page)).lists, 1); assert.equal((await counts(page)).saves, 2);
    await close(page); await open(page); await expect(key(page)).toHaveValue('');
    await expect(page.getByRole('button', {name: '移除已保存密钥', exact: true})).toHaveCount(0); await page.close();
  });
  await check('saved-connection-never-advertises-unavailable-or-late-catalog', async () => {
    for (const afterSaveCatalog of ['empty', 'failure', 'wrong-address']) {
      const page = await fixture({ afterSaveCatalog }); await key(page).fill('synthetic-saved-key'); await primary(page).click();
      await expect(primary(page)).toBeEnabled(); await expect(page.locator('.provider-result')).toContainText('连接已保存');
      await expect(page.locator('.provider-result')).toContainText('模型列表暂不可用');
      await expect(key(page)).toHaveValue(''); await expect(page.getByTestId('provider-key-status')).toHaveText('已保存');
      await expect(model(page)).toHaveJSProperty('tagName', 'INPUT'); await expect(model(page)).toHaveValue('model-old');
      await expect(page.locator('.provider-model-field option')).toHaveCount(0); assert.equal((await saved(page)).hasKey, true); assert.equal((await saved(page)).modelID, 'model-old');
      assert.equal((await counts(page)).saves, 1); assert.equal((await counts(page)).lists, 1); assert.equal((await counts(page)).selections, 0); await page.close();
    }
    const page = await fixture({ afterSaveCatalog: 'hold' }); await key(page).fill('synthetic-saved-key'); await primary(page).click();
    await expect.poll(() => page.evaluate(() => window.providerFixture.hasPendingCache())).toBe(true);
    await expect(key(page)).toHaveValue(''); await expect(page.getByText('连接已保存。', { exact: true })).toHaveCount(1);
    assert.equal((await saved(page)).hasKey, true); await expect(primary(page)).toBeDisabled();
    await close(page); await page.evaluate(() => window.providerFixture.resolveCache({ baseURL: 'https://fixture.invalid/v1', modelIDs: ['late-unusable-model'] }));
    await open(page); await expect(primary(page)).toBeEnabled(); await expect(model(page)).toHaveJSProperty('tagName', 'INPUT');
    await expect(page.locator('.provider-model-field option')).toHaveCount(0); await model(page).fill('new-local-model-draft');
    await expect(model(page)).toHaveValue('new-local-model-draft'); assert.equal((await counts(page)).saves, 1); await page.close();
  });
  await check('manual-saved-unlisted-model-remains-selected-after-save-and-reopen', async () => {
    const page = await fixture({ settings: { hasKey: true, credentialStorage: 'file' }, catalog: { baseURL: 'https://fixture.invalid/v1', modelIDs: ['model-old', 'model-b'] } });
    await expect(model(page)).toHaveValue('model-old'); await page.getByRole('button', { name: '手工填写', exact: true }).click();
    await model(page).fill('custom-unlisted'); await expect(primary(page)).toHaveText('保存（未验证）'); await primary(page).click();
    await expect(page.locator('.provider-result')).toHaveText('连接已保存，模型未验证。'); await expect(primary(page)).toBeEnabled();
    await expect(model(page)).toHaveValue('custom-unlisted'); await expect(model(page).locator('option:checked')).toHaveText('custom-unlisted（当前，未列出）');
    await expect(model(page).locator('option[value="model-old"]')).toHaveCount(1); await expect(model(page).locator('option[value="model-b"]')).toHaveCount(1);
    assert.equal((await saved(page)).modelID, 'custom-unlisted'); assert.equal((await counts(page)).saves, 1); assert.equal((await counts(page)).lists, 0);
    await close(page); await open(page); await expect(model(page)).toHaveValue('custom-unlisted'); await expect(model(page).locator('option:checked')).toHaveText('custom-unlisted（当前，未列出）');
    assert.equal((await counts(page)).saves, 1); await page.close();
  });
  await check('keyboard-categories-and-narrow-modal-preserve-unsaved-input', async () => {
    const page = await fixture(); await page.setViewportSize({ width: 860, height: 680 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await key(page).fill('synthetic-category-draft');
    await page.getByRole('tab', { name: '模型服务', exact: true }).focus(); await page.keyboard.press('ArrowDown'); await expect(page.getByRole('tab', { name: 'Agent 设置', exact: true })).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(page.getByRole('tab', { name: '本地数据', exact: true })).toBeFocused(); await page.keyboard.press('Home'); await expect(key(page)).toHaveValue('synthetic-category-draft');
    for (let index = 0; index < 14; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.settings-modal')), true); }
    const box = await modal(page).boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 861 && box.y + box.height <= 681); await close(page); await open(page); await expect(key(page)).toHaveValue(''); await page.close();
  });
  assert.equal(externalRequests, 0); assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ providerModelsRenderer: 'passed', checks, externalRequests, limitations: ['Actual Settings component with synthetic fixed API responses; network validation, file permissions and cache persistence require separate main-process tests.'] }));
} finally { await browser?.close(); }
