// Synthetic stdio/HTTP peer only; no model, filesystem tools or external network.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const root = path.dirname(process.argv[1]);
const scenario = JSON.parse(readFileSync(path.join(root, 'scenario.json'), 'utf8')).scenario;
const calls = (() => { try { return JSON.parse(readFileSync(path.join(root, 'calls.json'), 'utf8')); } catch { return []; } })();
const capture = name => {
  calls.push({ name, pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, config: process.env.OPENCODE_CONFIG_DIR, isolated: process.env.HOME !== process.env.USERPROFILE, inheritedKey: !!process.env.OPENAI_API_KEY, hasKey: !!process.env.SCREENDECK_LLM_API_KEY, titleDisabled: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).agent.title?.disable === true });
  writeFileSync(path.join(root, 'calls.json'), JSON.stringify(calls));
};
const parsed = () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT.replace(/\{env:SCREENDECK_LLM_API_KEY\}/g, () => process.env.SCREENDECK_LLM_API_KEY));
  config.command = {}; config.mode = {}; config.agent.build.options = {};
  if (config.agent.title) { config.agent.title.options = {}; config.agent.title.permission = {}; }
  return config;
};
if (process.argv.includes('--version')) {
  capture('version');
  if (scenario === 'version-timeout') setInterval(() => {}, 1000);
  else { console.log('1.19.0'); process.exit(0); }
} else if (process.argv[2] === 'debug') {
  capture('config');
  const config = parsed();
  config.provider.screendeck.options.apiKey = scenario === 'debug-unredacted' ? 'fixture-only-acp-secret' : '***';
  if (scenario === 'debug-plugin') config.plugin = ['fixture-unexpected'];
  if (scenario === 'debug-permission') config.permission = { '*': 'allow' };
  if (scenario === 'debug-model') config.model = 'screendeck/unexpected';
  if (scenario === 'debug-title-missing') delete config.agent.title;
  if (scenario === 'debug-title-enabled') config.agent.title.disable = false;
  if (scenario === 'debug-title-options') config.agent.title.options = { unexpected: true };
  if (scenario === 'debug-title-permission') config.agent.title.permission = { '*': 'allow' };
  if (scenario === 'debug-title-extra') config.agent.title.model = 'screendeck/other';
  if (scenario === 'debug-timeout') setInterval(() => {}, 1000);
  else if (scenario === 'debug-bad-json') { console.log('fixture-only-acp-secret invalid config'); process.exit(0); }
  else { console.log(JSON.stringify(config)); process.exit(0); }
} else if (process.argv[2] === 'serve') {
  capture('http');
  const config = parsed();
  const authorization = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  const server = createServer((request, response) => {
    if (request.headers.authorization !== authorization) { response.writeHead(401); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/global/health') response.end(JSON.stringify({ healthy: true, version: '1.19.0' }));
    else if (request.url === '/config') response.end(JSON.stringify(config));
    else if (request.url === '/provider') response.end(JSON.stringify({ connected: ['screendeck'], all: [{ id: 'screendeck', models: { [config.provider.screendeck.models[config.model.slice(11)].id]: { id: config.model.slice(11), api: { npm: '@ai-sdk/openai-compatible' } } } }] }));
    else { response.writeHead(404); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  capture('acp');
  process.stderr.write('fixture-only-acp-secret must never be reported\n');
  const output = value => process.stdout.write(JSON.stringify(value) + '\n');
  const reply = (id, result) => output({ jsonrpc: '2.0', id, result });
  const callbacks = new Map(); let requestID = 0;
  const update = text => output({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const peerRequest = (method, params, originalID) => {
    const id = 'peer-' + ++requestID;
    callbacks.set(id, result => { appendFileSync(path.join(root, 'peer-replies.jsonl'), JSON.stringify(result) + '\n'); reply(originalID, result); });
    output({ jsonrpc: '2.0', id, method, params });
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (!message.method) { const respond = callbacks.get(message.id); callbacks.delete(message.id); respond?.(message.result ?? { error: message.error }); return; }
    if (message.method === 'initialize') {
      if (scenario === 'init-hang') return;
      if (scenario === 'init-error') { output({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'fixture-only-acp-secret', data: { body: 'synthetic-provider-body' } } }); return; }
      if (scenario === 'malformed-stdout') { process.stdout.write('fixture-only-acp-secret invalid stdout\n'); return; }
      if (scenario === 'oversized-stdout') { process.stdout.write('x'.repeat(300000) + '\n'); return; }
      writeFileSync(path.join(root, 'initialize.json'), JSON.stringify(message.params));
      reply(message.id, { protocolVersion: scenario === 'protocol-version' ? 2 : 1, agentInfo: { name: 'OpenCode', version: scenario === 'agent-version' ? '1.18.0' : '1.19.0' }, agentCapabilities: { loadSession: scenario !== 'missing-capability' }, authMethods: [] });
      if (scenario === 'crash') setTimeout(() => process.exit(7), 250);
    } else if (message.method === '_fixture/update') { update('first'); update('second'); reply(message.id, {}); }
    else if (message.method === '_fixture/permission') peerRequest('session/request_permission', { sessionId: 'ses_fixture', toolCall: { toolCallId: 'call_fixture', title: 'synthetic forbidden tool' }, options: message.params.noReject ? [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] : [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] }, message.id);
    else if (message.method === '_fixture/fs') peerRequest('fs/read_text_file', { sessionId: 'ses_fixture', path: '/must-not-read' }, message.id);
    else if (message.method === '_fixture/terminal') peerRequest('terminal/create', { sessionId: 'ses_fixture', command: 'must-not-execute' }, message.id);
    else if (message.method === '_fixture/close') process.stdout.end();
    else if (message.method === '_fixture/bad-update') output({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_fixture', update: 'fixture-only-acp-secret' } });
    else if (message.method === '_fixture/bad-envelope') output({ jsonrpc: '2.0', unexpected: 'fixture-only-acp-secret' });
    else if (message.method === '_fixture/unknown-response') reply('fixture-only-acp-secret', {});
    else if (message.method === 'session/new') reply(message.id, { sessionId: 'ses_fixture' });
    else reply(message.id, {});
  });
  if (scenario === 'stubborn') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => process.exit(0));
}
