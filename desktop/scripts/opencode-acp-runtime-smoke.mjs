// Run explicitly with the already installed official binary and local synthetic
// provider. This script never downloads OpenCode or contacts a real model.
// node --import tsx scripts/opencode-acp-runtime-smoke.mjs /absolute/path/to/opencode-1.19.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeRuntime } from '../src/main/opencode-runtime.js';
import { OpenCodeAcpAdapter } from '../src/core/agents/opencode/opencode-acp-adapter.js';
import { SessionManager } from '../src/core/sessions/session-manager.js';
import { SessionHistoryStore } from '../src/core/sessions/session-history-store.js';
import { TaskSessionHistoryStore } from '../src/core/sessions/task-session-history-store.js';

const binaryPath = process.argv[2];
if (!binaryPath || !isAbsolute(binaryPath)) throw new Error('Usage: node --import tsx scripts/opencode-acp-runtime-smoke.mjs /absolute/path/to/opencode-1.19.0');
const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-official-acp-probe-'));
const credential = 'synthetic-local-acp-fixture', requests = [], providerProblems = [];
const provider = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + credential) { response.writeHead(404).end(); return; }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { response.writeHead(400).end(); return; }
  requests.push(body);
  if (body.model !== 'fixture-model' || body.tools?.length) { providerProblems.push('Unexpected model or tool schema.'); response.writeHead(400).end(); return; }
  const messages = JSON.stringify(body.messages);
  if (messages.includes('Return synthetic error')) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'synthetic-acp-sensitive-error-body' } })); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  emit({ role: 'assistant' });
  if (messages.includes('Hold synthetic reply')) { emit({ content: 'Partial local ACP fixture.' }); return; }
  emit({ content: 'Local ACP fixture reply.' }); emit({}, 'stop'); response.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Local provider did not bind.');
const runtime = new OpenCodeRuntime({ root, startTimeoutMs: 30_000 });
const ordinary = { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => { throw new Error('Ordinary model calls are forbidden in this smoke.'); } };
const projectID = 'project-' + randomUUID();
let manager, adapter, connection, attemptNumber = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (ref, predicate, message) => {
  for (let index = 0; index < 300; index++) {
    const turn = await manager.getTaskTurn(ref);
    if (predicate(turn)) return turn;
    await sleep(100);
  }
  throw new Error(message);
};
const prepare = async text => {
  const session = await manager.createTaskSession({ title: 'Official ACP synthetic attempt ' + ++attemptNumber, projectID, taskID: 'task-00' + attemptNumber });
  const spec = { work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: 'Local ACP protocol fixture', kind: 'discussion', expectedResult: 'Local ACP fixture reply.', dependencies: [], inputMessageID: randomUUID(), materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: 'a'.repeat(64) }, driver: { driverID: 'opencode-acp-no-tools', configDigest: connection.configDigest, mode: 'external' }, tools: { kind: 'none' } };
  const turn = await manager.prepareTaskTurn({ session: { format: 'task-v2', sessionID: session.conversation_id }, clientRequestID: randomUUID(), text, model: connection.model, spec });
  return { turn, spec };
};
const start = value => manager.startTaskTurn({ turn: value.turn, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: root, materials: [] } });
const hold = async () => {
  const value = await prepare('Hold synthetic reply until explicitly stopped.');
  const before = requests.length; await start(value);
  await waitFor(value.turn, turn => turn.state === 'running', 'ACP hold did not start.');
  for (let index = 0; index < 100 && requests.length === before; index++) await sleep(50);
  assert.equal(requests.length, before + 1); return value;
};
try {
  connection = await runtime.startACP({ binaryPath, provider: { baseURL: 'http://127.0.0.1:' + address.port + '/v1', modelID: 'fixture-model', credential }, allowLocalProvider: true });
  assert.equal(requests.length, 0, 'ACP initialize and config probe must not call the provider');
  assert.equal(connection.version, '1.19.0');
  const logDirectory = join(dirname(connection.directory), 'data', 'opencode', 'log'), logFile = join(logDirectory, 'opencode.log');
  assert.equal(await realpath(logFile), '/dev/null');
  adapter = new OpenCodeAcpAdapter({ getConnection: () => runtime.getACPConnection(), executionTimeoutMs: 30_000, cancelTimeoutMs: 5000 });
  manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'ordinary')), driver: ordinary, task: { store: new TaskSessionHistoryStore(root), driver: adapter } });
  const success = await prepare('Reply using the local ACP fixture only.');
  assert.equal(requests.length, 0, 'preparing the local Turn is not a prompt');
  await start(success);
  const finished = await waitFor(success.turn, turn => ['finished', 'failed', 'unknown'].includes(turn.state), 'ACP text did not terminate.');
  assert.equal(finished.state, 'finished', finished.failure);
  assert.ok(finished.execution.external.externalSessionID);
  assert.equal(finished.execution.external.externalSubmissionID, undefined);
  const saved = await manager.loadTaskSession(success.turn.session);
  assert.equal(saved.messages.find(message => message.role === 'assistant').text, 'Local ACP fixture reply.');
  assert.equal(requests.length, 1);
  const duplicate = await manager.startTaskTurn({ turn: success.turn, approvalID: finished.execution.authorizationID, check: () => {}, resolved: { workspaceRoot: root, materials: [] } });
  assert.equal(duplicate.status, 'already-started'); assert.equal(requests.length, 1);
  const lookup = { clientRequestID: finished.client_request_id, driver: success.spec.driver, workspace: success.spec.workspace, binding: finished.execution.external };
  assert.equal((await adapter.inspectExecution(lookup)).status, 'finished', 'only the same live adapter retains original prompt evidence');
  assert.equal(requests.length, 1);
  const cancelling = await hold();
  const cancellation = await manager.cancelTaskExecution(cancelling.turn);
  assert.equal(cancellation.state, 'cancelled', 'a cancel notification alone is insufficient; the original prompt must return cancelled');
  assert.equal(cancellation.execution.result, undefined);
  const failure = await prepare('Return synthetic error instead of a reply.');
  await start(failure);
  const failed = await waitFor(failure.turn, turn => ['failed', 'unknown'].includes(turn.state), 'ACP error did not settle safely.');
  assert.equal(failed.execution.result, undefined);
  assert.doesNotMatch(JSON.stringify(await manager.loadTaskSession(failure.turn.session)), /synthetic-acp-sensitive-error-body|synthetic-local-acp-fixture/);
  assert.deepEqual(await readdir(logDirectory), ['opencode.log']); assert.equal((await readFile(logFile)).length, 0);
  const interrupted = await hold();
  await manager.shutdown(); await runtime.stop();
  assert.equal(runtime.getACPConnection(), undefined);
  assert.equal((await adapter.inspectExecution(lookup)).status, 'unverifiable');
  manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'ordinary')), driver: ordinary, task: { store: new TaskSessionHistoryStore(root), driver: adapter } });
  const recovered = await manager.loadTaskSession(interrupted.turn.session);
  assert.equal(recovered.turns[0].state, 'unknown');
  assert.equal((await manager.reconcileTaskExecution(interrupted.turn)).state, 'unknown');
  assert.equal((await manager.startTaskTurn({ turn: interrupted.turn, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: root, materials: [] } })).status, 'unknown');
  assert.equal(requests.length, 4, 'restart, duplicate start and reconcile cannot replay a prompt');
  assert.deepEqual(providerProblems, []);
  const report = { officialAcpRuntimeSmoke: 'passed', version: connection.version, sdk: '1.8.0 stable ACP v1', provider: 'local synthetic fixture; no real model', providerSubmissions: requests.length, duplicateStart: duplicate.status, externalSubmissionID: 'absent', cancellation: cancellation.state, failure: failed.state, restarted: 'unknown; no replay', afterStop: 'unverifiable', nativeLog: 'verified null-device sink', tools: false, limitation: 'Protocol/runtime smoke uses direct local manager start; real approval and UI are covered separately by the ACP GUI smoke.' };
  await mkdir(join(root, 'report'), { recursive: true }); await writeFile(join(root, 'report', 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidence: root }));
} finally {
  await manager?.shutdown(); await runtime.stop();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
