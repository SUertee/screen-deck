import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = process.cwd(), temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-context-ui-'));
await mkdir(path.join(temporary, 'home'));
await build({ entryPoints: [path.join(root, 'tests/helpers/screen-context-ui-fixture.tsx')], outfile: path.join(temporary, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
await writeFile(path.join(temporary, 'index.html'), '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
await writeFile(path.join(temporary, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'userdata'));app.whenReady().then(async()=>{globalThis.__network=0;session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,done)=>{globalThis.__network++;done({cancel:true});});const w=new BrowserWindow({width:1280,height:980,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadFile(path.join(__dirname,'index.html'));});app.on('window-all-closed',()=>app.quit());`);
let application; const checks = [], errors = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS ' + name); };
try {
  const env = { HOME: path.join(temporary, 'home'), PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(':') }; for (const key of ['TMPDIR', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
  application = await electron.launch({ args: [path.join(temporary, 'main.cjs'), '--disable-gpu'], env, timeout: 30000 });
  const page = await application.firstWindow(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(10000);
  await expect(page.getByRole('button', { name: '打开上下文草稿' })).toBeVisible();
  const stats = () => page.evaluate(() => globalThis.__screenContextFixture.stats());
  const control = (name, arg) => page.evaluate(({ name, arg }) => globalThis.__screenContextFixture[name](arg), { name, arg });
  const ids = await page.evaluate(() => globalThis.__screenContextFixture.ids);
  const open = () => page.getByRole('button', { name: '打开上下文草稿' }).click();
  const prepare = async () => { await control('reset'); await page.getByRole('button', { name: '选择两条合成线索' }).click(); await open(); await page.getByRole('textbox', { name: '上下文摘要', exact: true }).fill('提交页面报错，需要核对页面和终端两条线索。'); await page.getByRole('combobox', { name: '关联到任务' }).selectOption('local-plan:fixture-a'); };
  await check('empty-draft-never-auto-selects-target-or-saves', async () => { await open(); await expect(page.getByText('尚未选择屏幕线索。', { exact: false })).toBeVisible(); await expect(page.getByRole('combobox', { name: '关联到任务' })).toHaveValue(''); await expect(page.getByRole('button', { name: '确认关联并保存', exact: true })).toBeDisabled(); assert.equal((await stats()).writes, 0); await page.keyboard.press('Escape'); });
  await check('unconnected-host-is-explicit-and-cancel-keeps-edits', async () => { await control('connect', false); await page.getByRole('button', { name: '选择两条合成线索' }).click(); await open(); await page.getByRole('textbox', { name: '上下文摘要', exact: true }).fill('先保存于窗口的用户草稿'); await expect(page.getByText('任务上下文保存尚未接入', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: '确认关联并保存', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '关闭，保留草稿', exact: true }).click(); await open(); await expect(page.getByRole('textbox', { name: '上下文摘要', exact: true })).toHaveValue('先保存于窗口的用户草稿'); assert.equal((await stats()).ocrReads, 0); assert.equal((await stats()).writes, 0); await page.keyboard.press('Escape'); });
  await check('remove-unrelated-source-and-only-explicit-ocr-excerpt-handoff', async () => {
    await prepare(); await page.getByRole('button', { name: `移除线索 ${ids[1]}` }).click(); await expect(page.locator('.sc-clue')).toHaveCount(1);
    await page.getByRole('textbox', { name: `线索备注 ${ids[0]}` }).fill('用户核对的页面现场'); await page.getByRole('button', { name: '查看识别文字', exact: true }).click();
    await expect(page.getByRole('textbox', { name: `来源识别文字 ${ids[0]}` })).toContainText('PRIVATE_UNSELECTED_OCR'); await expect(page.getByRole('textbox', { name: `选定引用文字 ${ids[0]}` })).toHaveValue('');
    await page.getByRole('textbox', { name: `来源识别文字 ${ids[0]}` }).evaluate(el=>{el.focus();el.setSelectionRange(0,9);});await page.keyboard.press('Shift+ArrowLeft');await page.getByRole('button',{name:'将选中文字加入引用',exact:true}).click();await expect(page.getByRole('textbox',{name:`选定引用文字 ${ids[0]}`})).not.toHaveValue('');
    await page.getByRole('textbox', { name: `选定引用文字 ${ids[0]}` }).fill('可引用的错误信息'); await page.screenshot({ path: path.join(temporary, 'context-wide.png') });
    await page.getByRole('button', { name: '确认关联并保存', exact: true }).dblclick(); await expect(page.getByText('已保存到「修复页面报错」', { exact: false })).toBeVisible();
    const result = await stats(); assert.equal(result.writes, 1); assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].clues.length, 1); assert.equal(result.attempts[0].clues[0].source.frameID, ids[0]); assert.ok(!JSON.stringify(result.attempts[0]).includes('PRIVATE_UNSELECTED_OCR')); assert.ok(!JSON.stringify(result.attempts[0]).includes('UNSELECTED_SNIPPET')); await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  });
  await check('failure-and-lost-acknowledgement-preserve-input-and-deduplicate-retry', async () => {
    await prepare(); await control('mode', 'lost-receipt'); const baseline = (await stats()).writes; await page.getByRole('button', { name: '确认关联并保存', exact: true }).click(); await expect(page.getByText('合成回执丢失', { exact: false })).toBeVisible(); await expect(page.getByRole('textbox', { name: '上下文摘要', exact: true })).toHaveValue('提交页面报错，需要核对页面和终端两条线索。'); const firstID = (await stats()).draft.confirmationID; await control('mode', 'success'); await page.getByRole('button', { name: '重试确认关联', exact: true }).click(); await expect(page.getByRole('button', { name: '已关联并保存', exact: true })).toBeDisabled(); const result = await stats(); assert.equal(result.writes, baseline + 1); assert.equal(result.attempts.at(-1).confirmationID, firstID); await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  });
  await check('source-loss-and-task-version-change-block-save-without-erasing-summary', async () => {
    await prepare(); await control('expire', ids[1]); await expect(page.getByText('来源已删除或过期', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: '确认关联并保存', exact: true })).toBeDisabled(); await page.getByRole('button', { name: `移除线索 ${ids[1]}` }).click(); await control('version'); await expect(page.getByText('所选任务已变化或不可用。', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: '确认关联并保存', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '重新选择任务', exact: true }).click(); await page.getByRole('combobox', { name: '关联到任务' }).selectOption('local-plan:fixture-a'); await expect(page.getByRole('button', { name: '确认关联并保存', exact: true })).toBeEnabled(); await page.keyboard.press('Escape');
  });
  await check('cancelling-source-check-never-calls-host-and-retains-draft', async () => {
    await prepare(); const count = (await stats()).attempts.length; await control('holdReads'); await page.getByRole('button', { name: '确认关联并保存', exact: true }).click(); await expect(page.getByRole('button', { name: '取消检查', exact: true })).toBeVisible(); await page.getByRole('button', { name: '取消检查', exact: true }).click(); await control('releaseReads'); assert.equal((await stats()).attempts.length, count); await expect(page.getByRole('textbox', { name: '上下文摘要', exact: true })).toHaveValue('提交页面报错，需要核对页面和终端两条线索。'); await page.keyboard.press('Escape');
  });
  await check('read-failure-retry-and-keyboard-narrow-layout', async () => {
    await control('reset'); await control('readFailure', true); await page.getByRole('button', { name: '选择两条合成线索' }).click(); await open(); await expect(page.getByRole('button', { name: '重试来源', exact: true })).toHaveCount(2); await control('readFailure', false); await page.getByRole('button', { name: '重试来源', exact: true }).first().click(); await expect(page.getByRole('button', { name: '重试来源', exact: true })).toHaveCount(1);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(620, 800)); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('textbox', { name: '上下文摘要', exact: true }).fill('窄窗草稿保留'); await expect(page.getByRole('dialog')).toHaveCount(1); assert.equal(await page.locator('.screen-context-draft').evaluate(el => el.scrollWidth > el.clientWidth), false); assert.equal(await page.locator('#app-shell').getAttribute('inert'), ''); await page.screenshot({ path: path.join(temporary, 'context-narrow.png') }); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('button', { name: '打开上下文草稿' })).toBeFocused();
  });
  await check('no-network-and-no-render-errors', async () => { assert.equal(await application.evaluate(() => globalThis.__network), 0); assert.deepEqual(errors, []); });
  await writeFile(path.join(temporary, 'checks.json'), JSON.stringify(checks, null, 2)); console.log(JSON.stringify({ checks: checks.length, artifacts: temporary }));
} finally { if (application) await application.close(); }
