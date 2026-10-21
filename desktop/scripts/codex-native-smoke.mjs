// node --import tsx scripts/codex-native-smoke.mjs /absolute/path/to/codex
// Real CLI, fresh homes, synthetic local Responses server. No login or external inference.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { codexTextCatalog, CODEX_VERSION, CODEX_TEXT_MODEL } from '../src/main/codex-runtime.ts';
const binary = process.argv[2]; assert.ok(binary && path.isAbsolute(binary), 'Pass an explicit Codex binary path.');
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'screendeck-codex-native-'));
for (const dir of ['home', 'workspace']) await mkdir(path.join(root, dir));
await writeFile(path.join(root, 'models.json'), JSON.stringify(codexTextCatalog()));
const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'home'), TMPDIR: root };
assert.equal(execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(), `codex-cli ${CODEX_VERSION}`);
const requests = [], pending = new Map(); let child, id = 0, completed;
const done = new Promise(resolve => { completed = resolve; });
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request); res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  event('response.created', { response: { id: `resp-${requests.length}` } });
  if (requests.length === 1) {
    const call = { type: 'function_call', id: 'image-call', call_id: 'image-call', name: 'view_image', arguments: JSON.stringify({ path: path.join(root, 'never-read.png') }) };
    event('response.output_item.added', { output_index: 0, item: call }); event('response.output_item.done', { output_index: 0, item: call });
  } else {
    const item = { type: 'message', id: 'message-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic native reply.' }] };
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'Synthetic native reply.' }); event('response.output_item.done', { output_index: 0, item });
  }
  event('response.completed', { response: { id: `resp-${requests.length}`, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const args = ['app-server', '-c', `model_catalog_json=${JSON.stringify(path.join(root, 'models.json'))}`, '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`, '-c', 'web_search="disabled"', '-c', 'tools.view_image=false'];
  for (const key of ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'goals', 'image_generation', 'browser_use', 'computer_use', 'in_app_browser']) args.push('-c', `features.${key}=false`);
  child = spawn(binary, args, { env, cwd: path.join(root, 'workspace'), stdio: 'pipe' }); child.stderr.resume();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) pending.get(message.id)?.(message);
    if (message.method === 'turn/completed') completed(message.params);
    if (message.id !== undefined && message.method) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Not available' } }) + '\n');
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => reject(Error('Native request timed out: ' + method)), 10000);
    pending.set(key, message => { clearTimeout(timer); pending.delete(key); message.error ? reject(Error('Native protocol failed: ' + JSON.stringify(message.error))) : resolve(message.result); });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
  await request('initialize', { clientInfo: { name: 'screendeck_native_fixture', version: '0.2' }, capabilities: null }); child.stdin.write('{"method":"initialized"}\n');
  const thread = await request('thread/start', { model: CODEX_TEXT_MODEL, cwd: path.join(root, 'workspace'), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
  assert.deepEqual(thread.sandbox, { type: 'readOnly', networkAccess: false });
  await request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Synthetic native fixture.', text_elements: [] }] });
  let timer; const terminal = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native completion missing')), 15000); })]); clearTimeout(timer);
  assert.equal(terminal.turn.status, 'completed'); assert.equal(requests.length, 2);
  const tools = requests[0].tools.map(tool => tool.name ?? tool.type);
  assert.ok(tools.every(name => ['update_plan', 'request_user_input', 'view_image'].includes(name)), 'No command/write/web/MCP tools are exposed.');
  const feedback = requests[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'image-call');
  assert.ok(JSON.stringify(feedback).includes('view_image is not allowed because you do not support image inputs'), 'Native image handler must reject before trying a nonexistent file.');
  assert.ok(!JSON.stringify(requests[1]).includes('data:image/'));
  console.log(JSON.stringify({ version: CODEX_VERSION, nativeThread: true, terminal: terminal.turn.status, modelRequests: requests.length, tools, imageReadRejected: true, externalInference: 0, credentialsRead: 0 }, null, 2));
} finally {
  child?.kill(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
