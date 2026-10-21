import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CodexRuntime } from '../../src/main/codex-runtime.js';
import { installCodexRoutes } from '../../src/main/codex-routes.js';
const wait = async (fn: () => boolean) => { for (let n = 0; n < 200 && !fn(); n++) await new Promise(r => setTimeout(r, 5)); assert.ok(fn()); };
async function fixture(t: test.TestContext, mode = 'normal', nativeTools = false) {
  const root = await mkdtemp('/private/tmp/screendeck-codex-fixture-'), binary = path.join(root, 'codex');
  const script = `#!${process.execPath}\nimport readline from 'node:readline'; import fs from 'node:fs'; import path from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli ${mode === 'version' ? '0.1.0' : '0.133.0'}'); process.exit(0); }
const home = process.env.CODEX_HOME, log = path.join(home, 'requests.jsonl');
fs.writeFileSync(path.join(home, 'environment.json'), JSON.stringify({ apiKey: !!process.env.OPENAI_API_KEY, codexHome: home, home: process.env.HOME, args: process.argv.slice(2) }));
let signedIn = fs.existsSync(path.join(home, 'signed-in'));
const notify = (method, params) => console.log(JSON.stringify({ method, params }));
readline.createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line); fs.appendFileSync(log, JSON.stringify(request) + '\\n'); if (!request.id) return;
 const reply = result => console.log(JSON.stringify({ id: request.id, result }));
 if (request.method === 'initialize') reply({ userAgent: 'codex/0.133.0' });
 else if (request.method === 'account/read') reply({ account: signedIn ? { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus', accessToken: 'must-not-leak' } : null, requiresOpenaiAuth: true });
 else if (request.method === 'model/list') reply({ data: [{ model: 'gpt-5.5', isDefault: true, hidden: false }] });
 else if (request.method === 'account/login/start') {
  reply({ type: 'chatgpt', loginId: 'login-fixture', authUrl: '${mode === 'bad-url' ? 'https://chatgpt.com.evil.invalid/oauth' : 'https://auth.openai.com/oauth/authorize?state=fixture'}' });
  ${mode === 'normal' ? "setTimeout(() => { signedIn = true; fs.writeFileSync(path.join(home, 'signed-in'), 'fixture'); notify('account/login/completed', { loginId: 'login-fixture', success: true, error: null }); }, 30);" : ''}
 } else if (request.method === 'account/login/cancel') reply({ status: 'canceled' });
 else reply({});
});`;
  await writeFile(binary, script); await chmod(binary, 0o700);
  const opened: string[] = [];
  const runtime = new CodexRuntime(path.join(root, 'runtime'), () => {}, async url => { opened.push(url); }, { nativeTools });
  t.after(async () => { await runtime.stop(); await new Promise(r => setTimeout(r, 20)); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, binary, opened, log: async () => (await readFile(path.join(root, 'runtime/home/requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
test('native login, metadata privacy, persistent native account and text catalog are independent of provider keys', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.runtime.start(f.binary), { state: 'login-required', version: '0.133.0' });
  assert.equal(f.opened.length, 0); assert.equal(f.runtime.getConnection(), undefined);
  assert.equal((await f.log()).filter(row => row.method === 'turn/start').length, 0);
  await f.runtime.login(); await wait(() => f.runtime.getStatus().state === 'ready');
  assert.equal(f.opened.length, 1); assert.ok(!JSON.stringify(f.runtime.getStatus()).includes('must-not-leak'));
  const ready = f.runtime.getConnection()!; await f.runtime.refresh(); assert.equal(f.runtime.getConnection(), ready, 'Status refresh must preserve a live connection object.'); assert.equal(ready.model.model_id, 'gpt-5.5');
  const catalog = JSON.parse(await readFile(path.join(f.root, 'runtime/text-models.json'), 'utf8'));
  assert.equal(catalog.models[0].shell_type, 'disabled'); assert.equal(catalog.models[0].apply_patch_tool_type, null);
  const env = JSON.parse(await readFile(path.join(f.root, 'runtime/home/environment.json'), 'utf8')); assert.equal(env.apiKey, false); assert.ok(env.home.startsWith(f.root));
  assert.ok(env.args.includes('features.hooks=false')); assert.ok(env.args.includes('web_search="disabled"'));
  await f.runtime.stop(); await f.runtime.start(f.binary); assert.equal(f.runtime.getStatus().state, 'ready');
  assert.notEqual(f.runtime.getConnection()!.connectionGeneration, ready.connectionGeneration); assert.equal(f.opened.length, 1);
});
test('native login URL must use an exact official HTTPS host, and rejected login is cancelled', async t => {
  const f = await fixture(t, 'bad-url'); await f.runtime.start(f.binary); await assert.rejects(f.runtime.login(), /非官方登录地址/); assert.equal(f.opened.length, 0);
  assert.ok((await f.log()).some(row => row.method === 'account/login/cancel'));
});
test('cancel login does not log out or delete native account storage', async t => {
  const f = await fixture(t, 'hold'); await f.runtime.start(f.binary); await f.runtime.login(); assert.equal(f.runtime.getStatus().state, 'logging-in');
  await f.runtime.cancelLogin(); assert.equal(f.runtime.getStatus().state, 'login-required'); assert.ok(!(await f.log()).some(row => row.method === 'account/logout'));
});
test('unverified Codex version never starts app-server', async t => { const f = await fixture(t, 'version'); await assert.rejects(f.runtime.start(f.binary), /0.133.0/); assert.equal(f.runtime.getStatus().state, 'stopped'); });
test('Codex IPC rejects config/key/method/URL injection before runtime access', async t => {
  const f = await fixture(t), routes = new Map<string, (input: unknown) => unknown>();
  installCodexRoutes({ host: { handle: (name: string, handler: (input: unknown) => unknown) => { routes.set(name, handler); } } as any, runtime: f.runtime, resolveBinary: async () => f.binary, chooseBinary: async () => f.binary });
  for (const [name, handler] of routes) await assert.rejects(async () => handler({ apiKey: 'fixture', method: 'command/exec', authUrl: 'https://evil.invalid', binaryPath: f.binary }), /不接受配置参数/);
  assert.equal(f.runtime.getStatus().state, 'stopped');
});


test('native connection lazily starts a tool-disabled chat profile with the same app-owned login', async t => {
  const f = await fixture(t, 'normal', true); await f.runtime.start(f.binary); await f.runtime.login(); await wait(() => f.runtime.getStatus().state === 'ready');
  const primary = f.runtime.getConnection(); assert.equal(f.runtime.getTextConnection(), undefined);
  await f.runtime.prepareText(); const text = f.runtime.getTextConnection()!; assert.ok(text); assert.notEqual(text, primary); assert.equal(f.runtime.getConnection(), primary);
  assert.equal(text.directory, path.join(f.root, 'runtime/text-profile/workspace'));
  const env = JSON.parse(await readFile(path.join(f.root, 'runtime/home/environment.json'), 'utf8'));
  assert.equal(env.codexHome, path.join(f.root, 'runtime/home')); assert.equal(env.home, path.join(f.root, 'runtime/text-profile/host-home'));
  assert.ok(env.args.includes('features.shell_tool=false')); assert.ok(env.args.includes('sandbox_mode="read-only"'));
  const catalog = JSON.parse(await readFile(path.join(f.root, 'runtime/text-profile/text-models.json'), 'utf8')); assert.equal(catalog.models[0].shell_type, 'disabled'); assert.equal(catalog.models[0].apply_patch_tool_type, null);
  await f.runtime.prepareText(); assert.equal(f.runtime.getTextConnection(), text); assert.equal(f.opened.length, 1); assert.equal((await f.log()).filter(row => row.method === 'account/login/start').length, 1); assert.equal((await f.log()).filter(row => row.method === 'turn/start').length, 0);
  await f.runtime.stop(); assert.equal(f.runtime.getTextConnection(), undefined);
});
