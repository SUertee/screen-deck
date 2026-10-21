import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Electron main/routes/preload/renderer/Cocoa bridge, isolated storage and
// injected cursor/button samples. Never moves the system cursor or sends OS input.
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-notch-ui-'));
const testDist = path.join(temporaryRoot, 'dist'), artifactRoot = path.join(temporaryRoot, 'artifacts');
await mkdir(testDist, { recursive: true }); await mkdir(artifactRoot, { recursive: true });
for (const name of ['renderer', 'preload.cjs', 'native', 'brand']) await cp(path.join(desktopRoot, 'dist', name), path.join(testDist, name), { recursive: true });

const indexFile = path.join(desktopRoot, 'src/main/index.ts');
const shim = `
import {ElectronHost as RealHost} from ${JSON.stringify(path.join(desktopRoot, 'src/main/electron-host.ts'))};
import {getNativeDeckWindow} from ${JSON.stringify(path.join(desktopRoot, 'src/main/native-deck-window.ts'))};
export class ElectronHost extends RealHost {
 constructor(root){
  const qa=globalThis.__notchQA;
  super(root,{cursorPoint:()=>{qa.cursorReads++;return {...qa.point}},mouseButtons:()=>{qa.buttonReads++;return qa.buttons},nativeProvider:()=>{
   const bridge=getNativeDeckWindow();if(!bridge){qa.nativeAvailable=false;return undefined}qa.nativeAvailable=true;
   return {...bridge,getDisplays(){const actual=bridge.getDisplays();qa.actualDisplays=actual;
    if(qa.forceFloating)return actual.map(display=>({...display,hasNotch:false,notchWidth:0,notchHeight:0}));
    if(actual.some(display=>display.hasNotch)){qa.geometrySource='actual-native-notch';return actual}
    const selected=actual.find(display=>display.builtIn)??actual[0];if(!selected)return actual;
    qa.geometrySource='synthetic-notch-on-actual-display';return actual.map(display=>display===selected?{...display,hasNotch:true,notchWidth:Math.min(180,display.bounds.width),notchHeight:Math.min(32,display.bounds.height)}:display);
   },applyWindow(window,bounds){if(qa.throwNextNativeApply){qa.throwNextNativeApply=false;qa.nativeApplyThrows++;throw Error('Isolated native apply failure')}const applied=bridge.applyWindow(window,bounds);qa.nativeApplies.push({windowID:window.id,bounds:{...bounds},actual:window.getBounds(),applied});return applied},restoreWindow(window){qa.nativeRestores++;return bridge.restoreWindow(window)}};
  }});qa.host=this;
 }
}
`;
await build({ entryPoints: [indexFile], outfile: path.join(testDist, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], plugins: [{ name: 'notch-host-dependencies-only', setup(builder) {
  builder.onResolve({ filter: /^\.\/electron-host\.js$/ }, args => args.importer === indexFile ? { path: 'notch-test-host', namespace: 'notch-test' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'notch-test' }, () => ({ contents: shim, loader: 'ts', resolveDir: desktopRoot }));
} }] });
const wrapper = path.join(temporaryRoot, 'entry.cjs');
await writeFile(wrapper, `
const {app,BrowserWindow,ipcMain,net,session,shell}=require('electron');
const qa=globalThis.__notchQA={point:{x:-999999,y:-999999},buttons:0,cursorReads:0,buttonReads:0,forceFloating:process.env.SCREENDECK_NOTCH_QA_FLOATING==='1',nativeAvailable:false,geometrySource:null,actualDisplays:[],nativeApplies:[],nativeRestores:0,nativeApplyThrows:0,throwNextNativeApply:false,ignores:[],presentations:[],network:[],processes:[],forbiddenIPC:[],interactionBusy:false,saveCount:0,holdSave:false,heldSave:false,releaseSave:null,errors:[],lifecycle:[]};
for(const name of['before-quit','will-quit','quit','window-all-closed'])app.on(name,event=>{const record={name,at:Date.now(),prevented:!!event?.defaultPrevented};qa.lifecycle.push(record);queueMicrotask(()=>record.prevented=!!event?.defaultPrevented)});
app.setPath('userData',require('node:path').join(process.env.SCREENDECK_PREVIEW_ROOT,'electron-host'));app.setAppPath(${JSON.stringify(desktopRoot)});
const deny=value=>{qa.network.push(String(value));throw Error('Notch smoke blocks external network')};
const remote=value=>/^(https?|wss?|ftp):/i.test(typeof value==='string'?value:value?.url??String(value));
for(const target of[globalThis,net])if(typeof target.fetch==='function'){const original=target.fetch.bind(target);target.fetch=(input,...rest)=>remote(input)?Promise.reject(new Error((qa.network.push(String(input)),'Notch smoke blocks external network'))):original(input,...rest)}
for(const name of['node:http','node:https']){const module=require(name);for(const method of['request','get'])module[method]=()=>deny(name+'.'+method)}
const child=require('node:child_process');for(const method of['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[method]=()=>{qa.processes.push(method);throw Error('Notch smoke forbids child runtimes')};require('node:module').syncBuiltinESMExports();
const guard=value=>value.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*','ftp://*/*']},(details,done)=>{qa.network.push(details.url);done({cancel:true})});app.on('session-created',guard);app.whenReady().then(()=>guard(session.defaultSession));shell.openExternal=async url=>deny(url);
const ignore=BrowserWindow.prototype.setIgnoreMouseEvents;BrowserWindow.prototype.setIgnoreMouseEvents=function(value,...rest){qa.ignores.push({windowID:this.id,value,at:Date.now()});return ignore.call(this,value,...rest)};
app.on('browser-window-created',(_event,window)=>{const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,value,...rest)=>{if(value?.type==='deck-presentation-updated')qa.presentations.push({windowID:window.id,...value.presentation,at:Date.now()});return send(channel,value,...rest)}});
const register=ipcMain.handle.bind(ipcMain);const forbidden=new Set(['send-message','send-agent-message','start-opencode','start-codex','login-codex','request-execution-authorization','start-task-execution','decide-execution-approval','reply-task-permission']);
ipcMain.handle=(channel,listener)=>register(channel,async(event,input)=>{if(forbidden.has(channel.replace(/^screendeck:/,''))){qa.forbiddenIPC.push(channel);throw Error('Notch smoke does not call models or Agents')}
 if(channel==='screendeck:save-plan'){qa.saveCount++;if(qa.holdSave){qa.heldSave=true;await new Promise(resolve=>qa.releaseSave=resolve);qa.heldSave=false;qa.releaseSave=null}}
 const result=await listener(event,input);if(channel==='screendeck:set-deck-interaction')qa.interactionBusy=Boolean(input.busy);return result});
process.on('uncaughtExceptionMonitor',error=>qa.errors.push(String(error)));app.on('render-process-gone',(_event,_contents,details)=>qa.errors.push(details.reason));
require(${JSON.stringify(path.join(testDist, 'main.cjs'))});
`);

const checks = [], screenshots = [], pageErrors = [];
let application, workbench, deck, failure, currentCheck = 'launch', mainFacts;
const quitFacts = [];
const note = async extra => writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify({ temporaryRoot, artifactRoot, checks, screenshots, pageErrors, currentCheck, failure, ...extra }, null, 2));
const check = async (name, run) => { currentCheck = name; await run(); checks.push(name); await note(); console.log('PASS ' + name); };
const qa = () => application.evaluate(() => { const { host, releaseSave, ...facts } = globalThis.__notchQA; return facts; });
const nativeWindows = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, url: window.webContents.getURL(), focused: window.isFocused(), visible: window.isVisible(), hiddenInMissionControl:window.isHiddenInMissionControl(), excludedFromWindowMenu:window.excludedFromShownWindowsMenu, bounds: window.getBounds() })));
const state = () => deck.evaluate(() => window.screendeck.getDeckPresentation());
const expectState = async expected => { await expect.poll(async () => (await state()).state, { intervals: [15, 25, 40], timeout: 5000 }).toBe(expected); };
const picture = async name => { await deck.screenshot({ path: path.join(artifactRoot, name) }); screenshots.push(name); };
async function sampled(point, buttons = 0) {
  const before = await application.evaluate((_electron, next) => { const qa = globalThis.__notchQA; qa.point = next.point; qa.buttons = next.buttons; return qa.buttonReads; }, { point, buttons });
  await expect.poll(async () => (await qa()).buttonReads, { intervals: [10, 20], timeout: 5000 }).toBeGreaterThan(before);
}
async function outsideClick(point) { await sampled(point, 0); await sampled(point, 1); }
async function launch(floating = false) {
  const isolated = path.join(temporaryRoot, floating ? 'floating' : 'notch');
  for (const name of ['home', 'preview', 'history', 'tmp', 'bin']) await mkdir(path.join(isolated, name), { recursive: true });
  const home = path.join(isolated, 'home');
  const env = { HOME: home, TMPDIR: path.join(isolated, 'tmp'), TMP: path.join(isolated, 'tmp'), TEMP: path.join(isolated, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'), PATH: [path.join(isolated, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), SCREENDECK_PREVIEW_ROOT: path.join(isolated, 'preview'), SCREENDECK_PROJECT_HISTORY_ROOT: path.join(isolated, 'history'), SCREENDECK_NOTCH_QA_FLOATING: floating ? '1' : '0' };
  for (const key of ['LANG', 'LC_ALL', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
  application = await electron.launch({ args: [wrapper], env, timeout: 30000 });
  application.on('window', page => page.on('pageerror', error => pageErrors.push(error.message)));
  await expect.poll(async () => (await application.windows()).filter(page => page.url().startsWith('screendeck-app:') && !page.url().includes('deck=1')).length, { timeout: 30000 }).toBe(1);
  workbench = (await application.windows()).find(page => page.url().startsWith('screendeck-app:') && !page.url().includes('deck=1'));
  await expect(workbench.locator('.workbench')).toBeVisible({ timeout: 30000 });
  workbench.setDefaultTimeout(10000);
  if (!floating) {
    await expect.poll(async () => (await application.windows()).filter(page => page.url().includes('deck=1')).length, { timeout: 10000 }).toBe(1);
    deck = (await application.windows()).find(page => page.url().includes('deck=1')); deck.setDefaultTimeout(10000);
    await expect(deck.locator('.deck-workbench')).toHaveAttribute('data-presentation-mode', 'notch');
  }
}
const releaseMouse = point => sampled(point, 0);
async function closeApplication() {
  if (!application) return;
  // A notched Deck intentionally intercepts a plain window close. Use the
  // application's normal quit path so host disposal runs before CDP shutdown.
  const closing = application.waitForEvent('close', { timeout: 10000 }).then(() => ({ closed: true })).catch(error => ({ error }));
  await application.evaluate(({ app }) => { app.quit(); }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500));
  quitFacts.push(await application.evaluate(({ BrowserWindow }) => {
    const qa = globalThis.__notchQA;
    return { lifecycle: qa.lifecycle, dockDisposed: qa.host.dockDisposed, deckBusy: qa.host.deckBusy, windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, destroyed: window.isDestroyed(), visible: window.isVisible(), url: window.webContents.getURL() })) };
  }).catch(error => ({ disconnected: String(error) })));
  const result = await closing;
  if (result.error) throw result.error;
  application = null;
}
console.log('Notch smoke artifacts: ' + artifactRoot);
try {
  await launch();
  let display, hotPoint, bodyPoint, outsidePoint, planID;
  await check('startup-automatically-creates-a-collapsed-notched-deck-without-taking-workbench-focus', async () => {
    const facts = await qa(); assert.equal(facts.nativeAvailable, true);
    display = facts.actualDisplays.find(value => value.builtIn && value.hasNotch) ?? facts.actualDisplays.find(value => value.hasNotch) ?? facts.actualDisplays.find(value => value.builtIn) ?? facts.actualDisplays[0];
    const notchWidth = facts.geometrySource === 'actual-native-notch' ? display.notchWidth : Math.min(180, display.bounds.width);
    const notchHeight = facts.geometrySource === 'actual-native-notch' ? display.notchHeight : Math.min(32, display.bounds.height);
    hotPoint = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + notchHeight / 2 };
    bodyPoint = { x: hotPoint.x, y: display.bounds.y + notchHeight + 120 };
    outsidePoint = { x: display.bounds.x + 20, y: display.bounds.y + Math.min(500, display.bounds.height - 10) };
    await expectState('collapsed');
    const windows = await nativeWindows(), main = windows.find(value => !value.url.includes('deck=1')), floating = windows.find(value => value.url.includes('deck=1'));
    // The user may have another app foregrounded; startup must never focus the Deck.
    assert.equal(floating.focused, false);
    assert.equal(floating.hiddenInMissionControl,true);assert.equal(floating.excludedFromWindowMenu,true);
    assert.equal(main.hiddenInMissionControl,false);assert.equal(main.excludedFromWindowMenu,false);
    assert.equal(floating.bounds.y, display.bounds.y); assert.ok(floating.bounds.height > notchHeight);
    assert.equal((await state()).notchWidth, notchWidth);
    assert.equal(facts.ignores.filter(entry => entry.windowID === floating.id).at(-1)?.value, true);
    assert.equal((await workbench.evaluate(() => window.screendeck.bootstrap())).settings.hasKey, false);
    await picture('startup-collapsed.png');
  });
  await check('hot-zone-hover-peeks-then-expands-at-native-screen-top-without-activation', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('deck=1')).focus());
    await sampled(hotPoint); await expectState('peeked');
    const peek = await nativeWindows(); const stableBounds = peek.find(value => value.url.includes('deck=1')).bounds;
    await expectState('expanded');
    const windows = await nativeWindows(), floating = windows.find(value => value.url.includes('deck=1'));
    assert.deepEqual(floating.bounds, stableBounds, 'native window resized during reveal');
    assert.equal(floating.hiddenInMissionControl,true);assert.equal(floating.excludedFromWindowMenu,true);
    assert.equal(floating.bounds.y, display.bounds.y); assert.equal(floating.focused, false); assert.equal(windows.find(value => !value.url.includes('deck=1')).focused, true);
    const events = (await qa()).presentations.filter(value => value.windowID === floating.id);
    const peeked = events.find(value => value.state === 'peeked'), expanded = events.find(value => value.state === 'expanded');
    assert.ok(peeked && expanded && expanded.at - peeked.at >= 140, 'hover did not preserve its dwell delay');
    await sampled(outsidePoint); await new Promise(resolve => setTimeout(resolve, 300)); await expectState('expanded');
    await picture('hover-expanded-native-top.png');
  });
  await check('camera-cap-is-empty-and-expanded-controls-begin-below-the-camera-zone', async () => {
    const cap = deck.locator('.deck-notch-cap'); await expect(cap).toHaveText('');
    const height = (await state()).notchHeight;
    const violations = await deck.locator('.deck-workbench button:visible,.deck-workbench input:visible').evaluateAll((nodes, top) => nodes.filter(node => node.getBoundingClientRect().top < top - .5).map(node => node.getAttribute('aria-label') ?? node.textContent), height);
    assert.deepEqual(violations, []);
    const applies = (await qa()).nativeApplies; assert.ok(applies.length > 0); assert.ok(applies.every(value => value.applied && value.actual.y === display.bounds.y));
  });
  await check('interaction-protection-is-accepted-only-from-the-deck-renderer', async () => {
    await assert.rejects(workbench.evaluate(() => window.screendeck.setDeckInteraction({ busy: true })));
    assert.equal((await qa()).interactionBusy, false);
    await deck.evaluate(() => window.screendeck.setDeckInteraction({ busy: true })); assert.equal((await qa()).interactionBusy, true);
    await deck.evaluate(() => window.screendeck.setDeckInteraction({ busy: false })); assert.equal((await qa()).interactionBusy, false);
  });
  await check('outside-button-edge-collapses-and-enables-real-click-through-without-generating-a-system-click', async () => {
    await outsideClick(outsidePoint); await expectState('collapsed');
    const window = (await nativeWindows()).find(value => value.url.includes('deck=1'));
    assert.equal((await qa()).ignores.filter(value => value.windowID === window.id).at(-1)?.value, true);
    await releaseMouse(outsidePoint);
  });
  await check('shell-morphs-with-stationary-content-and-respects-reduced-motion', async () => {
    await deck.evaluate(async () => {
      const root = document.querySelector('.deck-workbench');
      getComputedStyle(root.querySelector('.deck-notch-surface')).transform;
      await Promise.all(root.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    const nativeCallsBefore = (await qa()).nativeApplies.length;
    await deck.evaluate(() => {
      const root = document.querySelector('.deck-workbench');
      window.__motionSamples = [];
      window.__motionFinished = new Promise(resolve => {
        let frames = 0; const started = performance.now();
        const sample = () => {
          const content = root.querySelector('.deck-content-shell');
          const style = getComputedStyle(root), rect = content.getBoundingClientRect();
          window.__motionSamples.push({ shellTransform: getComputedStyle(root.querySelector('.deck-notch-surface')).transform, opacity: Number(getComputedStyle(content).opacity), x: rect.x, y: rect.y, width: rect.width, height: rect.height, at: performance.now() });
          if (++frames < 180 && performance.now() - started < 600) requestAnimationFrame(sample); else resolve();
        };
        requestAnimationFrame(sample);
      });
    });
    const before = (await nativeWindows()).find(value => value.url.includes('deck=1')).bounds;
    await deck.evaluate(() => window.screendeck.setDeckCollapsed(false));
    await expectState('expanded');
    const samples = await deck.evaluate(async () => { await window.__motionFinished; return window.__motionSamples; });
    await writeFile(path.join(artifactRoot, 'motion-frames.json'), JSON.stringify(samples, null, 2));
    const gaps = samples.slice(1).map((sample, index) => sample.at - samples[index].at).sort((a,b) => a-b);
    await writeFile(path.join(artifactRoot, 'motion-timing.json'), JSON.stringify({ frames:samples.length, durationMs:samples.at(-1).at-samples[0].at, medianGapMs:gaps[Math.floor(gaps.length/2)], p95GapMs:gaps[Math.floor(gaps.length*.95)], maxGapMs:gaps.at(-1), gapsOver25Ms:gaps.filter(gap=>gap>25).length, nativeCallsBefore, nativeCallsAfter:(await qa()).nativeApplies.length }, null, 2));
    assert.equal((await qa()).nativeApplies.length, nativeCallsBefore, 'visual reveal repeated native window configuration');
    assert.ok(new Set(samples.map(value => value.shellTransform)).size > 3, 'shell snapped instead of animating');
    assert.ok(samples.some(value => value.opacity > 0 && value.opacity < 1), 'content did not fade');
    for (const sample of samples) for (const key of ['x','y','width','height']) assert.equal(sample[key], samples[0][key], 'content layout moved during reveal');
    assert.deepEqual((await nativeWindows()).find(value => value.url.includes('deck=1')).bounds, before);
    await picture('smooth-expanded.png');
    const closing = await deck.evaluate(async () => {
      const root = document.querySelector('.deck-workbench'), samples = [];
      await window.screendeck.setDeckCollapsed(true);
      const closingStarted = performance.now();
      while (performance.now() - closingStarted < 420) {
        await new Promise(requestAnimationFrame);
        samples.push({ at:performance.now()-closingStarted, shellTransform: getComputedStyle(root.querySelector('.deck-notch-surface')).transform, opacity: Number(getComputedStyle(root.querySelector('.deck-content-shell')).opacity) });
      }
      return samples;
    });
    assert.ok(new Set(closing.map(value => value.shellTransform)).size > 3, 'closing shell snapped');
    assert.equal(closing.at(-1).opacity, 0);
    assert.ok(closing.some(value => value.at > 100 && value.at < 290 && value.shellTransform !== closing.at(-1).shellTransform), 'surface disappeared before its closing motion finished');
    await writeFile(path.join(artifactRoot, 'closing-frames.json'), JSON.stringify(closing, null, 2));
    await deck.evaluate(async () => {
      await window.screendeck.setDeckCollapsed(false);
      await new Promise(resolve => setTimeout(resolve, 65));
      await window.screendeck.setDeckCollapsed(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      await window.screendeck.setDeckCollapsed(false);
    });
    await expectState('expanded');
    await expect.poll(() => deck.locator('.deck-content-shell').evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    assert.deepEqual((await nativeWindows()).find(value => value.url.includes('deck=1')).bounds, before);
    await deck.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await deck.locator('.deck-notch-surface').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    await deck.evaluate(() => window.screendeck.setDeckCollapsed(true)); await expectState('collapsed');
    await deck.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await check('draft-and-repeat-open-preserve-input-dom-selection-and-protect-outside-dismissal', async () => {
    const plan = await workbench.evaluate(async () => {
      const api = window.screendeck, plan = await api.createPlan({ title: '刘海离线交互任务', schemaVersion: 2 });
      return api.savePlan({ plan: { ...plan, work_items: [{ id: crypto.randomUUID(), title: '合成子任务', kind: 'implementation', assignee: 'human', expected_result: '', dependencies: [], status: 'planned' }] }, expectedVersion: plan.version });
    }); planID = plan.id;
    await sampled(bodyPoint); await workbench.evaluate(id => window.screendeck.openDeck(undefined, id), planID); await expectState('expanded');
    await deck.locator('[data-inline-read="title"]').dblclick();
    const input = deck.getByRole('textbox', { name: '编辑任务名称', exact: true }); await input.fill('保留的刘海任务草稿');
    await input.evaluate(node => { window.__notchDraftNode = node; window.__notchDocument = crypto.randomUUID(); node.setSelectionRange(1, 3); });
    const token = await deck.evaluate(() => window.__notchDocument);
    await expect.poll(async () => (await qa()).interactionBusy).toBe(true);
    await outsideClick(outsidePoint); await expectState('expanded'); await expect(input).toHaveValue('保留的刘海任务草稿');
    await workbench.evaluate(id => window.screendeck.openDeck(undefined, id), planID);
    assert.equal(await input.evaluate(node => node === window.__notchDraftNode && node.selectionStart === 1 && node.selectionEnd === 3), true);
    assert.equal(await deck.evaluate(() => window.__notchDocument), token);
    await input.press('Escape'); await expect(input).toHaveCount(0); await releaseMouse(bodyPoint);
  });
  await check('open-assignment-menu-prevents-outside-dismissal-and-never-covers-the-camera-cap', async () => {
    await deck.getByRole('button', { name: /^分工：合成子任务/ }).click();
    const menu = deck.getByRole('dialog', { name: '分工选择', exact: true }); await expect(menu).toBeVisible();
    await expect.poll(async () => (await qa()).interactionBusy).toBe(true);
    const box = await menu.boundingBox(); assert.ok(box.y >= (await state()).notchHeight - .5, 'assignment menu overlaps the camera zone');
    await outsideClick(outsidePoint); await expectState('expanded'); await expect(menu).toBeVisible();
    await picture('menu-protected-below-camera.png'); await menu.getByRole('combobox').press('Escape'); await releaseMouse(bodyPoint);
  });
  await check('IME-composition-remains-unsubmitted-and-protected-from-outside-dismissal', async () => {
    await deck.locator('[data-inline-read="title"]').dblclick();
    const input = deck.getByRole('textbox', { name: '编辑任务名称', exact: true }); await input.fill('输入法草稿');
    const before = (await qa()).saveCount, session = await deck.context().newCDPSession(deck);
    try {
      await session.send('Input.imeSetComposition', { text: '测试组合', selectionStart: 4, selectionEnd: 4 });
      await outsideClick(outsidePoint); await expectState('expanded'); await expect(input).toBeVisible(); assert.equal((await qa()).saveCount, before);
      await session.send('Input.insertText', { text: '测试组合' });
    } finally { await session.detach(); }
    await input.press('Escape'); await releaseMouse(bodyPoint);
  });
  await check('pending-plan-write-stays-protected-and-an-outside-click-can-dismiss-after-completion', async () => {
    await deck.locator('[data-inline-read="title"]').dblclick();
    const input = deck.getByRole('textbox', { name: '编辑任务名称', exact: true }); await input.fill('刘海保存完成后的任务');
    await application.evaluate(() => { globalThis.__notchQA.holdSave = true; });
    await input.press('Enter'); await expect.poll(async () => (await qa()).heldSave).toBe(true); await expect.poll(async () => (await qa()).interactionBusy).toBe(true);
    await outsideClick(outsidePoint); await expectState('expanded'); await expect(input).toHaveValue('刘海保存完成后的任务');
    await application.evaluate(() => { const qa = globalThis.__notchQA; qa.holdSave = false; qa.releaseSave?.(); });
    await expect(input).toHaveCount(0); await expect.poll(async () => (await qa()).interactionBusy).toBe(false);
    await outsideClick(outsidePoint); await expectState('collapsed');
    mainFacts = await qa(); assert.deepEqual(mainFacts.network, []); assert.deepEqual(mainFacts.processes, []); assert.deepEqual(mainFacts.forbiddenIPC, []); assert.deepEqual(mainFacts.errors, []);
  });
  await check('display-topology-fallback-restores-the-same-live-renderer-and-preserves-its-draft', async () => {
    await releaseMouse(bodyPoint); await workbench.evaluate(id => window.screendeck.openDeck(undefined, id), planID); await expectState('expanded');
    await deck.locator('[data-inline-read="title"]').dblclick();
    const input = deck.getByRole('textbox', { name: '编辑任务名称', exact: true }); await input.fill('屏幕变化期间保留的草稿');
    const token = await input.evaluate(node => { window.__notchTopologyInput = node; return window.__notchTopologyDocument = crypto.randomUUID(); });
    const restores = (await qa()).nativeRestores;
    await application.evaluate(({ screen }) => { globalThis.__notchQA.forceFloating = true; screen.emit('display-removed', {}, screen.getAllDisplays()[0]); });
    await expect(deck.locator('.deck-workbench')).toHaveAttribute('data-presentation-mode', 'floating');
    assert.ok((await qa()).nativeRestores > restores); assert.equal(await input.evaluate(node => node === window.__notchTopologyInput), true); await expect(input).toHaveValue('屏幕变化期间保留的草稿');
    assert.equal(await deck.evaluate(() => window.__notchTopologyDocument), token);
    const window = (await nativeWindows()).find(value => value.url.includes('deck=1')); assert.equal(window.bounds.width, 380); assert.equal(window.bounds.height, 380);
    await picture('display-removed-floating-draft-preserved.png');
    await application.evaluate(({ screen }) => { globalThis.__notchQA.forceFloating = false; screen.emit('display-added', {}, screen.getAllDisplays()[0]); });
    await expect(deck.locator('.deck-workbench')).toHaveAttribute('data-presentation-mode', 'notch'); await expectState('expanded');
    assert.equal(await input.evaluate(node => node === window.__notchTopologyInput), true); await expect(input).toHaveValue('屏幕变化期间保留的草稿');
    assert.equal(await deck.evaluate(() => window.__notchTopologyDocument), token);
    const beforeFailureRestores = (await qa()).nativeRestores;
    await application.evaluate(({ screen }) => { globalThis.__notchQA.throwNextNativeApply = true; screen.emit('display-metrics-changed', {}, screen.getAllDisplays()[0], ['bounds']); });
    await expect(deck.locator('.deck-workbench')).toHaveAttribute('data-presentation-mode', 'floating');
    const failureFacts = await qa(); assert.equal(failureFacts.nativeApplyThrows, 1); assert.ok(failureFacts.nativeRestores > beforeFailureRestores);
    assert.equal(await input.evaluate(node => node === window.__notchTopologyInput), true); await expect(input).toHaveValue('屏幕变化期间保留的草稿');
    const restored = (await nativeWindows()).find(value => value.url.includes('deck=1')); assert.equal(restored.visible, true); assert.equal(restored.bounds.width, 380); assert.equal(restored.bounds.height, 380);assert.equal(restored.hiddenInMissionControl,true);assert.equal(restored.excludedFromWindowMenu,true);
    await input.press('Escape'); await expect(input).toHaveCount(0);
    await application.evaluate(({ screen }) => { screen.emit('display-metrics-changed', {}, screen.getAllDisplays()[0], ['bounds']); });
    await expect(deck.locator('.deck-workbench')).toHaveAttribute('data-presentation-mode', 'notch'); await expectState('collapsed');
    mainFacts = await qa();
    assert.deepEqual(mainFacts.network, []); assert.deepEqual(mainFacts.processes, []); assert.deepEqual(mainFacts.forbiddenIPC, []); assert.deepEqual(mainFacts.errors, []);
  });
  await check('normal-quit-closes-the-live-notched-window-without-forced-process-exit', closeApplication);
  await check('native-no-notch-display-set-keeps-an-ordinary-floating-deck', async () => {
    await launch(true);
    await workbench.evaluate(() => window.screendeck.openDeck());
    await expect.poll(async () => (await application.windows()).filter(page => page.url().includes('deck=1')).length).toBe(1);
    deck = (await application.windows()).find(page => page.url().includes('deck=1')); deck.setDefaultTimeout(10000);
    await expect(deck.locator('.deck-workbench')).toHaveAttribute('data-presentation-mode', 'floating');
    assert.equal((await state()).mode, 'floating'); await expect(deck.locator('.deck-notch-cap')).toBeHidden();
    const window = (await nativeWindows()).find(value => value.url.includes('deck=1')); assert.equal(window.bounds.width, 380); assert.equal(window.bounds.height, 380);
    const facts = await qa(); assert.equal(facts.nativeApplies.length, 0); assert.deepEqual(facts.network, []); assert.deepEqual(facts.processes, []); assert.deepEqual(facts.forbiddenIPC, []);
    await picture('no-notch-floating-fallback.png');
  });
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  if (deck && !deck.isClosed()) await picture('failure.png').catch(() => {});
  throw error;
} finally {
  const fallbackFacts = application ? await qa().catch(() => null) : null;
  let cleanupFailure;
  if (failure) application?.process().kill('SIGKILL');
  else try { await closeApplication(); } catch (error) { cleanupFailure = error; failure = String(error); application?.process().kill('SIGKILL'); }
  await note({ mainFacts, quitFacts, fallbackFacts, limitations: ['Cursor and button samples are injected at the host dependency boundary; no system cursor movement, OS click event, or physical click-through test occurs.', 'Native applyWindow/restoreWindow and BrowserWindow bounds are real. Synthetic notch geometry is used only if native display discovery has no actual notch, and is labeled by geometrySource.', 'The no-notch launch intentionally filters notch metadata while retaining the real native bridge; no model, Agent, credentials or user task records are used.', 'SIGKILL is permitted only after a failing check or cleanup and is never counted as a successful application shutdown.'] });
  if (cleanupFailure) throw cleanupFailure;
}
