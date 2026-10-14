import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, lstat, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import fileOperations from 'node:fs/promises';
import childOperations, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenCodeRuntime, OpenCodeRuntimeError, OPENCODE_VERSION, type OpenCodeStartInput } from '../../src/main/opencode-runtime.js';

const provider = { baseURL: 'https://models.example.invalid/v1', modelID: 'fixture-model', credential: 'fixture-only-secret' };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** This generated executable is a local Node HTTP fixture, never the downloaded binary. */
async function fixture(t: test.TestContext, scenario = 'healthy', prefix = 'screendeck-runtime-test-') {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), prefix));
  const binaryPath = path.join(root, 'fixture-opencode');
  const code = `#!${process.execPath}
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const scenario = ${JSON.stringify(scenario)};
const base = path.dirname(process.argv[1]);
const capture = name => writeFileSync(path.join(base, name), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
if (scenario === 'log-secret' || scenario === 'log-secret-error') {
  appendFileSync(path.join(process.env.XDG_DATA_HOME, 'opencode', 'log', 'opencode.log'), 'provider body fixture-only-provider-body; credential=' + process.env.SCREENDECK_LLM_API_KEY + '; stack=synthetic-stack\\n');
  process.stderr.write('fixture-only-provider-body ' + process.env.SCREENDECK_LLM_API_KEY + '\\n');
}
if (process.argv.includes('--version')) {
  capture('version.json');
  if (scenario === 'version-timeout') setInterval(() => {}, 1000);
  else { console.log(scenario === 'version-mismatch' ? '1.18.0' : '1.19.0'); process.exit(0); }
} else {
  capture('server.json');
  const key = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT.replace(/\\{env:SCREENDECK_LLM_API_KEY\\}/g, () => process.env.SCREENDECK_LLM_API_KEY));
  config.command = {};
  config.agent.build = { options: {}, ...config.agent.build };
  if (scenario === 'config-drift') config.mcp = { outside: { type: 'remote', url: 'https://example.invalid' } };
  if (scenario === 'plugin-drift') config.plugin = ['unexpected-plugin'];
  if (scenario === 'log-secret-error') config.plugin = ['unexpected-plugin'];
  if (scenario === 'permission-drift') config.permission = { '*': 'allow' };
  if (scenario === 'command-drift') config.command = { unexpected: { template: 'fixture only' } };
  if (scenario === 'command-invalid') config.command = [];
  if (scenario === 'agent-options-drift') config.agent.build.options = { unexpected: true };
  if (scenario === 'agent-options-invalid') config.agent.build.options = [];
  if (scenario === 'agent-drift') config.agent.other = { permission: { '*': 'deny' } };
  const modelID = config.model.slice('screendeck/'.length);
  if (scenario === 'model-keys-reordered') {
    const model = config.provider.screendeck.models[modelID];
    config.provider.screendeck.models[modelID] = { limit: { output: model.limit.output, context: model.limit.context }, modalities: { output: model.modalities.output, input: model.modalities.input }, tool_call: model.tool_call, name: model.name, id: model.id };
  }
  if (scenario === 'model-limit-drift') config.provider.screendeck.models[modelID].limit.output += 1;
  if (scenario === 'model-modalities-drift') config.provider.screendeck.models[modelID].modalities.input = ['image', 'text'];
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, directory: decodeURIComponent(req.headers['x-opencode-directory'] || ''), authorized: req.headers.authorization === key });
    writeFileSync(path.join(base, 'calls.json'), JSON.stringify(calls));
    if (scenario !== 'no-auth' && req.headers.authorization !== key) { res.writeHead(401); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/global/health') res.end(JSON.stringify({ healthy: true, version: scenario === 'health-version' ? '9.0.0' : '1.19.0' }));
    else if (req.url === '/config') {
      if (scenario === 'hang-config') return;
      if (scenario === 'large-config') { res.end('x'.repeat(300000)); return; }
      res.end(JSON.stringify({ ...config, mode: {} }));
    } else if (req.url === '/provider') {
      const id = config.model.slice('screendeck/'.length);
      res.end(JSON.stringify({ all: [{ id: scenario === 'provider-drift' ? 'other' : 'screendeck', models: { [id]: { id, api: { npm: '@ai-sdk/openai-compatible', url: config.provider.screendeck.api } } } }], connected: ['screendeck'], default: { screendeck: id } }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  if (scenario === 'stubborn') process.on('SIGTERM', () => writeFileSync(path.join(base, 'term.txt'), 'owned'));
  else process.on('SIGTERM', () => server.close(() => process.exit(0)));
  server.listen(0, '127.0.0.1', () => {
    console.log('opencode server listening on http://127.0.0.1:' + server.address().port);
    if (scenario === 'crash') setTimeout(() => process.exit(7), 220);
  });
}
`;
  await writeFile(binaryPath, code, { mode: 0o700 });
  const runtime = new OpenCodeRuntime({ root, startTimeoutMs: 2000, shutdownTimeoutMs: 150 });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, binaryPath, runtime, input: { binaryPath, provider } satisfies OpenCodeStartInput };
}
async function record(root: string, name: string) { return JSON.parse(await readFile(path.join(root, name), 'utf8')); }
const exists = async (filename: string) => access(filename).then(() => true, () => false);

test('runtime is inert until explicit start; verifies owned auth, config and provider without model calls', async t => {
  const { root, runtime, input } = await fixture(t);
  assert.equal(runtime.getConnection(), undefined);
  assert.equal(await exists(path.join(root, 'server.json')), false);
  const connection = await runtime.start(input);
  assert.equal(connection.version, OPENCODE_VERSION);
  assert.match(connection.baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(connection.model, { provider_id: 'screendeck', model_id: provider.modelID });
  runtime.assertCurrent(connection);
  const child = await record(root, 'server.json');
  assert.deepEqual(child.args, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--mdns=false']);
  assert.equal(child.cwd, connection.directory);
  assert.deepEqual(await readdir(connection.directory), []);
  const calls = await record(root, 'calls.json');
  assert.deepEqual([...new Set(calls.map((call: { url: string }) => call.url))].sort(), ['/config', '/global/health', '/provider']);
  assert.ok(calls.every((call: { method: string; directory: string }) => call.method === 'GET' && call.directory === connection.directory));
  assert.equal(calls.some((call: { url: string; authorized: boolean }) => call.url === '/global/health' && !call.authorized), true);
  assert.equal(JSON.stringify(connection).includes(provider.credential), false);
  await runtime.stop();
  assert.equal(runtime.getConnection(), undefined);
  assert.throws(() => runtime.assertCurrent(connection), /失效/);
  assert.equal(await exists(connection.directory), false);
});

test('runtime replaces HOME/XDG and drops inherited credentials, proxies, Node/Bun and OpenCode configuration', async t => {
  const contaminated = { HOME: '/not-the-runtime-home', XDG_CONFIG_HOME: '/not-the-runtime-config', NODE_OPTIONS: '--require=/definitely-missing.js', BUN_OPTIONS: 'malicious', OPENAI_API_KEY: 'inherited-test-secret', HTTPS_PROXY: 'http://bad-proxy.invalid', OPENCODE_CONFIG: '/secret-config', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_EXPERIMENTAL: 'true', OTEL_EXPORTER_OTLP_HEADERS: 'test-token' };
  const old = Object.fromEntries(Object.keys(contaminated).map(key => [key, process.env[key]]));
  Object.assign(process.env, contaminated);
  t.after(() => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const { root, runtime, input } = await fixture(t);
  const connection = await runtime.start(input);
  const { env } = await record(root, 'server.json');
  for (const key of ['NODE_OPTIONS', 'BUN_OPTIONS', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'OPENCODE_CONFIG', 'OPENCODE_EXPERIMENTAL', 'OTEL_EXPORTER_OTLP_HEADERS']) assert.equal(env[key], undefined, key);
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'OPENCODE_TEST_MANAGED_CONFIG_DIR']) assert.ok(env[key].startsWith(path.dirname(connection.directory) + path.sep), key);
  for (const key of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_LSP_DOWNLOAD']) assert.equal(env[key], 'true');
  assert.equal(await readFile(env.OPENCODE_MODELS_PATH, 'utf8'), '{}\n');
  assert.equal(await exists(path.join(env.OPENCODE_CONFIG_DIR, 'node_modules')), false);
  assert.equal(await exists(path.join(env.OPENCODE_CONFIG_DIR, 'package.json')), false);
  await assert.rejects(writeFile(path.join(env.OPENCODE_CONFIG_DIR, 'attempt.txt'), 'blocked'), /EACCES|EPERM/);
});

test('same live snapshot reuses one owned runtime; changed snapshot requires explicit disconnect', async t => {
  const { runtime, input } = await fixture(t);
  const first = await runtime.start(input);
  const again = await runtime.start(input);
  assert.deepEqual(again, first);
  await assert.rejects(runtime.start({ ...input, provider: { ...provider, credential: 'other-fixture-secret' } }), /先断开/);
  assert.deepEqual(runtime.getConnection(), first);
  await runtime.stop(); await runtime.stop();
  const replacement = await runtime.start(input);
  assert.notEqual(replacement.runtimeID, first.runtimeID);
  assert.notEqual(replacement.connectionGeneration, first.connectionGeneration);
  assert.notEqual(replacement.configDigest, first.configDigest);
  assert.throws(() => runtime.assertCurrent(first), /失效/);
});

test('wrong binary or health version fails closed and child output is not reported', async t => {
  for (const scenario of ['version-mismatch', 'health-version']) {
    const { root, runtime, input } = await fixture(t, scenario);
    await assert.rejects(runtime.start(input), error => { assert.ok(error instanceof OpenCodeRuntimeError); assert.equal(error.code, 'runtime-version'); assert.match(error.message, /版本/); assert.equal(error.message.includes(root), false); assert.equal(error.message.includes(provider.credential), false); return true; });
    assert.equal(runtime.getConnection(), undefined);
    assert.equal((await readdir(root)).some(name => name.startsWith('screendeck-opencode-')), false);
  }
});

test('missing auth, config changes, provider drift and unbounded bodies never publish a connection', async t => {
  for (const scenario of ['no-auth', 'config-drift', 'plugin-drift', 'permission-drift', 'provider-drift', 'large-config']) {
    const { root, runtime, input } = await fixture(t, scenario);
    await assert.rejects(runtime.start(input), /拒绝|配置|模型|认证|容量/);
    assert.equal(runtime.getConnection(), undefined);
    const capture = await record(root, 'server.json');
    assert.throws(() => process.kill(capture.pid, 0), /ESRCH/);
  }
});

test('unexpected process exit immediately revokes the old generation and permits a new explicit start', async t => {
  const { runtime, input } = await fixture(t, 'crash');
  const connection = await runtime.start(input);
  await pause(350);
  assert.equal(runtime.getConnection(), undefined);
  assert.throws(() => runtime.assertCurrent(connection), /失效/);
  const next = await runtime.start(input);
  assert.notEqual(next.connectionGeneration, connection.connectionGeneration);
});

test('explicit stop is bounded, kills only its own stubborn child and clears the credential directory', async t => {
  const { root, runtime, input } = await fixture(t, 'stubborn');
  const connection = await runtime.start(input);
  const child = await record(root, 'server.json');
  const began = Date.now();
  await runtime.stop();
  assert.ok(Date.now() - began < 1200);
  assert.equal(await readFile(path.join(root, 'term.txt'), 'utf8'), 'owned');
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  assert.equal(await exists(connection.directory), false);
  process.kill(process.pid, 0);
});

test('start timeout and stop during initialization clean up instead of enabling send', async t => {
  const { root, binaryPath, input } = await fixture(t, 'hang-config');
  const runtime = new OpenCodeRuntime({ root, startTimeoutMs: 300, shutdownTimeoutMs: 100 });
  t.after(() => runtime.stop());
  const attempt = runtime.start(input);
  await pause(100); const stopped = runtime.stop();
  await assert.rejects(attempt, /未通过|取消|失效/); await stopped;
  assert.equal(runtime.getConnection(), undefined);
  const timeout = new OpenCodeRuntime({ root, startTimeoutMs: 200, shutdownTimeoutMs: 100 });
  t.after(() => timeout.stop());
  await assert.rejects(timeout.start({ binaryPath, provider }), /未通过|取消|超时/);
  assert.equal(timeout.getConnection(), undefined);
});

test('configuration substitution directives and unsafe binary paths are rejected before a fixture is spawned', async t => {
  const { root, runtime, input } = await fixture(t);
  await assert.rejects(runtime.start({ ...input, provider: { ...provider, credential: '{file:/should-not-read}' } }), /替换/);
  await assert.rejects(runtime.start({ ...input, provider: { ...provider, baseURL: 'http://provider.example/v1' } }), /HTTPS/);
  await assert.rejects(runtime.start({ ...input, provider: { ...provider, modelID: '../escape' } }), /快照/);
  const link = path.join(root, 'linked-binary'); await symlink(input.binaryPath, link);
  await assert.rejects(runtime.start({ ...input, binaryPath: link }), /确切/);
  assert.equal(await exists(path.join(root, 'version.json')), false);
});

test('explicit loopback test provider and quoted credentials remain data, not configuration commands', async t => {
  const { root, runtime, input } = await fixture(t);
  const quoted = 'fixture-"quoted\\credential';
  const connection = await runtime.start({ ...input, allowLocalProvider: true, provider: { ...provider, baseURL: 'http://127.0.0.1:12345/v1', credential: quoted } });
  const child = await record(root, 'server.json');
  assert.equal(child.env.SCREENDECK_LLM_API_KEY, JSON.stringify(quoted).slice(1, -1));
  assert.equal(JSON.stringify(connection).includes(quoted), false);
});

test('owned directories with Unicode and spaces are encoded in the instance header', async t => {
  const { root, input, runtime } = await fixture(t, 'healthy', 'screendeck-runtime-test-中文 ');
  const connection = await runtime.start(input);
  const calls = await record(root, 'calls.json');
  assert.ok(calls.every((call: { directory: string }) => call.directory === connection.directory));
});

test('cleanup failure remains explicit and blocks replacement until a later stop confirms removal', async t => {
  const { root, runtime, input } = await fixture(t);
  const connection = await runtime.start(input);
  const ownedRoot = path.dirname(connection.directory), original = fileOperations.rm;
  try {
    fileOperations.rm = async (target, options) => {
      if (String(target) === ownedRoot) throw Object.assign(new Error('fixture cleanup denied'), { code: 'EACCES' });
      return original(target, options);
    };
    syncBuiltinESMExports();
    await assert.rejects(runtime.stop(), /清理尚未确认/);
    assert.equal(runtime.getConnection(), undefined);
    await assert.rejects(runtime.start(input), /清理尚未确认/);
    assert.equal(await exists(connection.directory), true);
  } finally { fileOperations.rm = original; syncBuiltinESMExports(); }
  await runtime.stop();
  assert.equal(await exists(connection.directory), false);
  assert.equal((await readdir(root)).some(name => name.startsWith('screendeck-opencode-')), false);
});

test('v1.19.0 empty command and normalized build options are accepted; nonempty or malformed values are rejected', async t => {
  const healthy = await fixture(t);
  const connection = await healthy.runtime.start(healthy.input);
  healthy.runtime.assertCurrent(connection);
  for (const scenario of ['command-drift', 'command-invalid', 'agent-options-drift', 'agent-options-invalid', 'agent-drift']) {
    const { runtime, input } = await fixture(t, scenario);
    await assert.rejects(runtime.start(input), error => {
      assert.ok(error instanceof OpenCodeRuntimeError);
      assert.ok(['runtime-config', 'runtime-contract'].includes(error.code));
      return true;
    });
    assert.equal(runtime.getConnection(), undefined);
  }
});

test('object key reordering preserves the model contract; changed nested values or array contents are rejected', async t => {
  const reordered = await fixture(t, 'model-keys-reordered');
  const connection = await reordered.runtime.start(reordered.input);
  reordered.runtime.assertCurrent(connection);
  for (const scenario of ['model-limit-drift', 'model-modalities-drift']) {
    const { runtime, input } = await fixture(t, scenario);
    await assert.rejects(runtime.start(input), error => {
      assert.ok(error instanceof OpenCodeRuntimeError);
      assert.equal(error.code, 'runtime-provider');
      return true;
    });
    assert.equal(runtime.getConnection(), undefined);
  }
});

test('fixed file logger appends only to the verified null device; ordinary new files and replacement are blocked', async t => {
  const { root, runtime, input } = await fixture(t, 'log-secret');
  const connection = await runtime.start(input);
  const logDirectory = path.join(path.dirname(connection.directory), 'data', 'opencode', 'log');
  const logFile = path.join(logDirectory, 'opencode.log');
  assert.equal((await lstat(logFile)).isSymbolicLink(), true);
  assert.equal(await readlink(logFile), '/dev/null');
  assert.equal((await stat(logFile)).isCharacterDevice(), true);
  assert.deepEqual(await readdir(logDirectory), ['opencode.log']);
  assert.equal((await lstat(logDirectory)).mode & 0o222, 0);
  await appendFile(logFile, 'fixture-only-provider-body ' + provider.credential);
  assert.equal(await readFile(logFile, 'utf8'), '');
  await assert.rejects(writeFile(path.join(logDirectory, 'other.log'), provider.credential), /EACCES|EPERM/);
  await assert.rejects(unlink(logFile), /EACCES|EPERM/);
  await assert.rejects(rename(logFile, path.join(logDirectory, 'replacement.log')), /EACCES|EPERM/);
  assert.equal(JSON.stringify(connection).includes(provider.credential), false);
  await runtime.stop();
  assert.equal(await exists(logDirectory), false);
  assert.equal((await readdir(root)).some(name => name.startsWith('screendeck-opencode-')), false);
});

test('initialization error body and stack cannot persist in the fixed log even when cleanup is denied', async t => {
  const { root, runtime, input } = await fixture(t, 'log-secret-error');
  const original = fileOperations.rm;
  let ownedRoot = '';
  try {
    fileOperations.rm = async (target, options) => {
      if (String(target).startsWith(root + path.sep + 'screendeck-opencode-')) { ownedRoot = String(target); throw Object.assign(new Error('fixture cleanup denied'), { code: 'EACCES' }); }
      return original(target, options);
    };
    syncBuiltinESMExports();
    await assert.rejects(runtime.start(input), error => { assert.ok(error instanceof OpenCodeRuntimeError); assert.equal(error.code, 'runtime-cleanup'); assert.equal(error.message.includes(provider.credential), false); assert.equal(error.message.includes('fixture-only-provider-body'), false); return true; });
    assert.equal(runtime.getConnection(), undefined);
    assert.ok(ownedRoot);
    const logDirectory = path.join(ownedRoot, 'data', 'opencode', 'log');
    assert.deepEqual(await readdir(logDirectory), ['opencode.log']);
    assert.equal((await lstat(path.join(logDirectory, 'opencode.log'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(logDirectory, 'opencode.log'), 'utf8'), '');
  } finally { fileOperations.rm = original; syncBuiltinESMExports(); }
  await runtime.stop();
  assert.equal(await exists(ownedRoot), false);
});

test('a server without a confirmed exit retains failed ownership and its directory until an explicit stop succeeds', async t => {
  const { runtime, input } = await fixture(t);
  const original = childOperations.spawn;
  let child: ChildProcess | undefined, originalKill: ChildProcess['kill'] | undefined, spawns = 0;
  try {
    childOperations.spawn = ((...args: Parameters<typeof original>) => {
      const spawned = original(...args); spawns++;
      if (Array.isArray(args[1]) && args[1][0] === 'serve') { child = spawned; originalKill = spawned.kill; spawned.kill = () => true; }
      return spawned;
    }) as typeof original;
    syncBuiltinESMExports();
    const connection = await runtime.start(input);
    await assert.rejects(runtime.stop(), /退出尚未确认/);
    assert.equal(runtime.getConnection(), undefined);
    assert.equal(await exists(connection.directory), true);
    assert.equal((await lstat(path.join(path.dirname(connection.directory), 'data', 'opencode', 'log'))).mode & 0o222, 0);
    assert.equal(child?.exitCode, null);
    assert.equal(child?.signalCode, null);
    await assert.rejects(runtime.start(input), /退出尚未确认/);
    assert.equal(spawns, 2, 'no replacement version probe or server is spawned');
    if (child && originalKill) child.kill = originalKill;
    await runtime.stop();
    assert.equal(await exists(connection.directory), false);
  } finally {
    childOperations.spawn = original; syncBuiltinESMExports();
    if (child && originalKill) child.kill = originalKill;
    await runtime.stop();
  }
});

test('a version probe without a confirmed exit retains ownership and blocks any server or replacement probe', async t => {
  const { root, binaryPath, input } = await fixture(t, 'version-timeout');
  const runtime = new OpenCodeRuntime({ root, startTimeoutMs: 150, shutdownTimeoutMs: 40 });
  const original = childOperations.spawn;
  let child: ChildProcess | undefined, originalKill: ChildProcess['kill'] | undefined, spawns = 0;
  try {
    childOperations.spawn = ((...args: Parameters<typeof original>) => {
      const spawned = original(...args); spawns++;
      if (Array.isArray(args[1]) && args[1][0] === '--version') { child = spawned; originalKill = spawned.kill; spawned.kill = () => true; }
      return spawned;
    }) as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(runtime.start(input), /版本探针退出尚未确认/);
    const ownedDirectories = (await readdir(root)).filter(name => name.startsWith('screendeck-opencode-'));
    assert.equal(ownedDirectories.length, 1);
    assert.equal(runtime.getConnection(), undefined);
    assert.equal(await exists(path.join(root, 'server.json')), false);
    await assert.rejects(runtime.start({ binaryPath, provider }), /退出尚未确认/);
    assert.equal(spawns, 1);
    if (child && originalKill) child.kill = originalKill;
    await runtime.stop();
    assert.equal(await exists(path.join(root, ownedDirectories[0])), false);
  } finally {
    childOperations.spawn = original; syncBuiltinESMExports();
    if (child && originalKill) child.kill = originalKill;
    await runtime.stop();
  }
});
