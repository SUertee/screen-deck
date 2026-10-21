import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeRuntime, OpenCodeRuntimeError, type OpenCodeStartInput } from '../../src/main/opencode-runtime.js';
const provider = { baseURL: 'https://acp-fixture.invalid/v1', modelID: 'acp-fixture-model', credential: 'fixture-only-acp-secret' };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const exists = async (file: string) => access(file).then(() => true, () => false);
async function fixture(t: test.TestContext, scenario = 'healthy', timeout = 2000) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'screendeck-acp-runtime-test-'));
  const binaryPath = path.join(root, 'fixture-opencode');
  const source = await readFile(new URL('../fixtures/opencode-acp-runtime.mjs', import.meta.url), 'utf8');
  await writeFile(binaryPath, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await writeFile(path.join(root, 'scenario.json'), JSON.stringify({ scenario }));
  const runtime = new OpenCodeRuntime({ root, startTimeoutMs: timeout, shutdownTimeoutMs: 80 });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, binaryPath, runtime, input: { binaryPath, provider } satisfies OpenCodeStartInput };
}
async function json(root: string, filename: string) { return JSON.parse(await readFile(path.join(root, filename), 'utf8')); }
async function eventually(check: () => boolean) { for (let count = 0; count < 100 && !check(); count++) await pause(10); assert.equal(check(), true); }

test('ACP is inert until explicit start and performs version, effective config and v1 initialization before ready', async t => {
  const { root, runtime, input } = await fixture(t);
  assert.equal(runtime.getACPConnection(), undefined);
  assert.equal(await exists(path.join(root, 'calls.json')), false);
  const connection = await runtime.startACP(input);
  assert.equal(runtime.getConnection(), undefined);
  assert.equal(runtime.getACPConnection(), connection);
  assert.equal(connection.version, '1.19.0');
  assert.deepEqual(connection.model, { provider_id: 'screendeck', model_id: provider.modelID });
  const calls = await json(root, 'calls.json');
  assert.deepEqual(calls.map((call: { name: string }) => call.name), ['version', 'config', 'acp']);
  assert.deepEqual(calls[2].args, ['acp', '--cwd', connection.directory, '--hostname', '127.0.0.1', '--port', '0', '--mdns=false']);
  assert.ok(calls.every((call: { cwd: string; home: string; inheritedKey: boolean }) => call.cwd === connection.directory && call.home.startsWith(path.dirname(connection.directory) + path.sep) && !call.inheritedKey));
  assert.deepEqual((await json(root, 'initialize.json')).clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(await readdir(connection.directory), []);
  const sink = path.join(path.dirname(connection.directory), 'data', 'opencode', 'log', 'opencode.log');
  assert.equal((await lstat(sink)).isSymbolicLink(), true); assert.equal(await readlink(sink), '/dev/null');
  assert.equal(await readFile(sink, 'utf8'), '');
  await runtime.stop();
  assert.equal(connection.rpc.signal.aborted, true);
  assert.equal(runtime.getACPConnection(), undefined);
  assert.equal(await exists(connection.directory), false);
});

test('same ACP snapshot reuses one process; changed credentials and HTTP switching require an explicit stop', async t => {
  const { root, runtime, input } = await fixture(t);
  const first = await runtime.startACP(input);
  assert.equal(await runtime.startACP(input), first);
  await assert.rejects(runtime.startACP({ ...input, provider: { ...provider, credential: 'other-fixture-key' } }), /先断开/);
  await assert.rejects(runtime.start(input), /ACP.*先明确关闭/);
  assert.deepEqual((await json(root, 'calls.json')).map((call: { name: string }) => call.name), ['version', 'config', 'acp']);
  await runtime.stop();
  const http = await runtime.start(input);
  assert.equal((await json(root, 'calls.json')).find((call: { name: string }) => call.name === 'http').titleDisabled, false);
  await assert.rejects(runtime.startACP(input), /HTTP.*先明确关闭/);
  assert.deepEqual(runtime.getConnection(), http);
  await runtime.stop();
  const second = await runtime.startACP(input);
  assert.notEqual(second.runtimeID, first.runtimeID);
  assert.notEqual(second.connectionGeneration, first.connectionGeneration);
  assert.notEqual(second.configDigest, first.configDigest);
  assert.throws(() => first.subscribe(async () => {}), /无法确认/);
});

test('ACP disables the automatic title agent and only accepts its empty normalized defaults', async t => {
  const { root, runtime, input } = await fixture(t);
  await runtime.startACP(input);
  assert.ok((await json(root, 'calls.json')).every((call: { titleDisabled: boolean }) => call.titleDisabled));
  for (const scenario of ['debug-title-missing', 'debug-title-enabled', 'debug-title-options', 'debug-title-permission', 'debug-title-extra']) {
    const invalid = await fixture(t, scenario);
    await assert.rejects(invalid.runtime.startACP(invalid.input), /受控|初始化记录/);
    assert.equal(invalid.runtime.getACPConnection(), undefined);
    assert.equal((await json(invalid.root, 'calls.json')).some((call: { name: string }) => call.name === 'acp'), false);
  }
});

test('debug config must preserve the exact forbidden policy and official redaction before ACP starts', async t => {
  for (const scenario of ['debug-plugin', 'debug-permission', 'debug-model', 'debug-unredacted', 'debug-bad-json']) {
    const { root, runtime, input } = await fixture(t, scenario);
    await assert.rejects(runtime.startACP(input), error => { assert.ok(error instanceof OpenCodeRuntimeError); assert.ok(['runtime-config', 'runtime-provider'].includes(error.code)); assert.equal(error.message.includes(provider.credential), false); return true; });
    assert.equal(runtime.getACPConnection(), undefined);
    assert.equal((await json(root, 'calls.json')).some((call: { name: string }) => call.name === 'acp'), false);
    assert.equal((await readdir(root)).some(name => name.startsWith('screendeck-opencode-')), false);
  }
});

test('wrong protocol, wrong agent version and missing required capability never publish ACP readiness', async t => {
  for (const scenario of ['protocol-version', 'agent-version', 'missing-capability']) {
    const { root, runtime, input } = await fixture(t, scenario);
    await assert.rejects(runtime.startACP(input), /版本或所需能力不匹配/);
    assert.equal(runtime.getACPConnection(), undefined);
    const call = (await json(root, 'calls.json')).find((value: { name: string }) => value.name === 'acp');
    assert.throws(() => process.kill(call.pid, 0), /ESRCH/);
  }
});

test('initialization failures and malformed or oversized stdout are bounded and never expose child/provider text', async t => {
  for (const scenario of ['init-error', 'malformed-stdout', 'oversized-stdout', 'init-hang', 'debug-timeout']) {
    const { root, runtime, input } = await fixture(t, scenario, 650);
    const start = Date.now();
    await assert.rejects(runtime.startACP(input), error => { assert.ok(error instanceof OpenCodeRuntimeError); assert.equal(error.message.includes(provider.credential), false); assert.equal(error.message.includes('synthetic-provider-body'), false); return true; });
    assert.ok(Date.now() - start < 2000);
    assert.equal(runtime.getACPConnection(), undefined);
    assert.equal((await readdir(root)).some(name => name.startsWith('screendeck-opencode-')), false);
  }
});

test('session notifications await each subscriber in order and unsubscribe prevents further delivery', async t => {
  const { runtime, input } = await fixture(t);
  const connection = await runtime.startACP(input);
  const seen: string[] = [];
  const unsubscribe = connection.subscribe(async event => {
    assert.equal(event.type, 'session-update');
    if (event.type !== 'session-update' || event.notification.update.sessionUpdate !== 'agent_message_chunk') return;
    await pause(15);
    seen.push(event.notification.update.content.type === 'text' ? event.notification.update.content.text : 'unexpected');
  });
  await connection.rpc.agent.request('_fixture/update', {});
  await eventually(() => seen.length === 2);
  assert.deepEqual(seen, ['first', 'second']);
  unsubscribe(); await connection.rpc.agent.request('_fixture/update', {}); await pause(40);
  assert.deepEqual(seen, ['first', 'second']);
});

test('permission requests are always rejected once or cancelled and clients never provide filesystem or terminal access', async t => {
  const { runtime, input } = await fixture(t);
  const connection = await runtime.startACP(input);
  const events: string[] = [];
  connection.subscribe(async event => { await pause(10); events.push(event.type); });
  const denied = await connection.rpc.agent.request('_fixture/permission', { noReject: false });
  assert.deepEqual(denied, { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.deepEqual(events, ['forbidden-permission']);
  assert.deepEqual(await connection.rpc.agent.request('_fixture/permission', { noReject: true }), { outcome: { outcome: 'cancelled' } });
  for (const method of ['_fixture/fs', '_fixture/terminal']) {
    const result = await connection.rpc.agent.request<{ error: { code: number; message: string } }>(method, {});
    assert.equal(result.error.code, -32601);
    assert.equal(result.error.message.includes(provider.credential), false);
  }
});

test('subscriber failure, invalid messages and stdout closure revoke the original generation without replacement', async t => {
  for (const method of ['_fixture/bad-update', '_fixture/bad-envelope', '_fixture/unknown-response', '_fixture/close', '_fixture/update']) {
    const { root, runtime, input } = await fixture(t);
    const connection = await runtime.startACP(input);
    if (method === '_fixture/update') connection.subscribe(async () => { throw new Error('fixture-only-acp-secret'); });
    await connection.rpc.agent.request(method, {}).catch(() => {});
    await eventually(() => connection.rpc.signal.aborted && runtime.getACPConnection() === undefined);
    assert.equal((await json(root, 'calls.json')).filter((call: { name: string }) => call.name === 'acp').length, 1);
    await runtime.stop();
    assert.equal(await exists(connection.directory), false);
  }
});

test('an unexpected ACP process exit revokes the RPC and a new explicit start gets a fresh generation', async t => {
  const { runtime, input } = await fixture(t, 'crash');
  const first = await runtime.startACP(input);
  await eventually(() => runtime.getACPConnection() === undefined && first.rpc.signal.aborted);
  const second = await runtime.startACP(input);
  assert.notEqual(second.connectionGeneration, first.connectionGeneration);
});

test('stop during ACP initialization is bounded and an owned stubborn process is confirmed dead before cleanup', async t => {
  const hanging = await fixture(t, 'init-hang');
  const attempt = hanging.runtime.startACP(hanging.input);
  await pause(100);
  const stopped = hanging.runtime.stop();
  await assert.rejects(attempt, /取消|无法确认/); await stopped;
  assert.equal(hanging.runtime.getACPConnection(), undefined);
  const { root, runtime, input } = await fixture(t, 'stubborn');
  const connection = await runtime.startACP(input);
  const pid = (await json(root, 'calls.json')).find((call: { name: string }) => call.name === 'acp').pid;
  const start = Date.now(); await runtime.stop();
  assert.ok(Date.now() - start < 1000);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(await exists(connection.directory), false);
  assert.equal(runtime.getConnection(), undefined); assert.equal(runtime.getACPConnection(), undefined);
});
