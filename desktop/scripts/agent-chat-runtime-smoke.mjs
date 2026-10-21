// Explicit official-binary probe with a local synthetic provider, fresh HOME/XDG
// and temporary history. Never downloads OpenCode or calls a real model.
// node --import tsx scripts/agent-chat-runtime-smoke.mjs /absolute/path/to/opencode-1.19.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeRuntime } from '../src/main/opencode-runtime.js';
import { OpenCodeAgentChatAdapter } from '../src/core/agents/opencode/opencode-agent-chat-adapter.js';
import { AgentChatRegistry } from '../src/core/agents/agent-chat-registry.js';
import { AgentChatModeRouter } from '../src/core/agents/agent-chat-mode-router.js';
import { AgentExecutionController } from '../src/core/agents/agent-execution-controller.js';
import { NATIVE_AGENT_CAPABILITIES } from '../src/shared/agent-capabilities.js';
import { SessionManager } from '../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../src/core/sessions/session-history-store.js';
import { AgentSessionHistoryStore } from '../src/core/sessions/agent-session-history-store.js';

const binaryPath = process.argv[2];
if (!binaryPath || !isAbsolute(binaryPath)) throw new Error('Pass an already installed OpenCode 1.19.0 binary.');
const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-official-agent-chat-'));
const credential = 'synthetic-agent-chat-key', requests = [], problems = [];
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + credential) { res.writeHead(404).end(); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  if (body.model !== 'fixture-model' || body.tools?.length) { problems.push('Unexpected model/tools.'); res.writeHead(400).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'synthetic-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  emit({ role: 'assistant' });
  const last = body.messages.filter(m => m.role === 'user').at(-1);
  if (JSON.stringify(last).includes('Hold this synthetic turn')) { emit({ content: 'Partial synthetic text.' }); return; }
  emit({ content: 'Synthetic continuous reply ' + requests.length + '.' }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Synthetic provider did not bind.');
const runtime = new OpenCodeRuntime({ root, startTimeoutMs: 30000 });
const driver = new OpenCodeAgentChatAdapter({ getConnection: () => runtime.getACPConnection(), executionTimeoutMs: 30000, cancelTimeoutMs: 5000 });
const ordinary = { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { throw new Error('Ordinary chat is forbidden in this probe.'); } };
const native = { descriptor: { ...driver.descriptor, capabilities: NATIVE_AGENT_CAPABILITIES }, getSource: () => { const source = driver.getSource(); return source ? { ...source, capabilities: NATIVE_AGENT_CAPABILITIES } : undefined; }, sendTurn: async () => { throw new Error('Native tools forbidden in plain-chat smoke'); }, cancelTurn: lookup => driver.cancelTurn(lookup) };
const routed = new AgentExecutionController(root, () => {}).wrap(new AgentChatModeRouter(native, driver));
const makeManager = () => new SessionManager({ store: new SessionHistoryStore(join(root, 'sessions')), driver: ordinary, agent: { store: new AgentSessionHistoryStore(root), drivers: new AgentChatRegistry([{ driver: routed }]) } });
let manager = makeManager();
try {
  await runtime.startACP({ binaryPath, provider: { baseURL: 'http://127.0.0.1:' + address.port + '/v1', modelID: 'fixture-model', credential }, allowLocalProvider: true });
  assert.equal(requests.length, 0, 'initialize/config must not prompt the model');
  const session = await manager.createAgentSession({ title: 'Continuous synthetic chat', agentID: 'opencode' });
  assert.equal(requests.length, 0, 'creating an empty local chat must not prompt');
  const first = await manager.sendAgentMessage({ sessionID: session.conversation_id, text: 'First synthetic input A193.' });
  assert.equal(first.session.turns[0].state, 'finished', first.reason);
  const binding = structuredClone(first.session.binding); assert.ok(binding?.externalSessionID);
  const second = await manager.sendAgentMessage({ sessionID: session.conversation_id, text: 'Second synthetic input B274.' });
  assert.equal(second.session.turns.at(-1).state, 'finished', second.reason);
  assert.deepEqual(second.session.binding, binding);
  assert.equal(requests.length, 2, 'two explicit turns must mean exactly two provider calls');
  const secondUsers = requests[1].messages.filter(m => m.role === 'user');
  const history = JSON.stringify(secondUsers);
  assert.equal((history.match(/First synthetic input A193/g) ?? []).length, 1);
  assert.equal((history.match(/Second synthetic input B274/g) ?? []).length, 1);
  assert.match(JSON.stringify(requests[1].messages), /Synthetic continuous reply 1/);
  const pending = manager.sendAgentMessage({ sessionID: session.conversation_id, text: 'Hold this synthetic turn until explicit stop.' });
  for (let i = 0; i < 300 && requests.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(requests.length, 3);
  await manager.stopAgentGeneration(session.conversation_id);
  const stopped = await pending;
  assert.equal(stopped.session.turns.at(-1).state, 'cancelled', stopped.reason);
  const continued = await manager.sendAgentMessage({ sessionID: session.conversation_id, text: 'Explicit synthetic continuation after confirmed stop.' });
  assert.equal(continued.session.turns.at(-1).state, 'finished', continued.reason);
  assert.deepEqual(continued.session.binding, binding);
  assert.equal(requests.length, 4, 'confirmed cancellation permits one subsequent explicit input');
  await manager.shutdown(); await runtime.stop();
  manager = makeManager();
  const read = await manager.loadAgentSession(session.conversation_id);
  assert.deepEqual(read.binding, binding);
  await assert.rejects(manager.sendAgentMessage({ sessionID: session.conversation_id, text: 'Do not replay on restart.' }));
  assert.equal(requests.length, 4);
  assert.equal((await readdir(join(root, 'agent-sessions-v1'))).filter(f => f.endsWith('.json')).length, 1);
  assert.doesNotMatch(await readFile(join(root, 'agent-sessions-v1', session.conversation_id + '.json'), 'utf8'), /synthetic-agent-chat-key|authorization|apiKey/);
  assert.deepEqual(problems, []);
  const report = { agentChatRuntimeSmoke: 'passed', officialVersion: '1.19.0', sdk: '1.8.0 stable ACP v1', provider: 'local synthetic only', turns: 4, providerCalls: requests.length, nativeContext: 'same binding; previous input once', cancellation: 'original prompt cancelled; explicit next turn reuses binding', restart: 'readonly; no replay', tools: false, evidence: root };
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally {
  await manager.shutdown(); await runtime.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
