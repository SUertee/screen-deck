// Official OpenCode binary + local synthetic provider. No real model or user data.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, mkdtemp, realpath, readFile, readdir } from "node:fs/promises";
import { join, isAbsolute, dirname } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeRuntime } from "../src/main/opencode-runtime.js";
import { OpenCodeAdapter } from "../src/core/agents/opencode/opencode-adapter.js";
import { SessionManager } from "../src/core/sessions/session-manager.js";
import { SessionHistoryStore } from "../src/core/sessions/session-history-store.js";
import { TaskSessionHistoryStore } from "../src/core/sessions/task-session-history-store.js";
const binaryPath = process.argv[2];
if (!binaryPath || !isAbsolute(binaryPath)) throw new Error("Usage: npm run smoke:opencode -- /absolute/path/to/opencode-1.19.0");
const root = await mkdtemp(join(await realpath(tmpdir()), "screendeck-real-runtime-probe-"));
const requests = [];
const providerProblems = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk2 of request) chunks.push(chunk2);
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  if (body.model !== 'fixture-model' || body.tools?.length) {
    providerProblems.push('Unexpected model or tool schema'); response.writeHead(400).end(); return;
  }
  if (JSON.stringify(body.messages).includes('Return synthetic error')) {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture-sensitive-error-body' } })); return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1e3), model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}

`);
  chunk({ role: "assistant" });
  if (JSON.stringify(body.messages).includes('Hold synthetic reply')) {
    chunk({ content: 'Partial local fixture.' }); return;
  }
  chunk({ content: "Local fixture reply." });
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture listen");
const runtime = new OpenCodeRuntime({ root, startTimeoutMs: 3e4 });
const ordinary = { capabilities: { chat: true, tools: false, remoteSessions: false, remoteAbort: false }, execute: async () => {
  throw new Error("No ordinary model calls.");
} };
let manager;
try {
  const connection = await runtime.start({ binaryPath, provider: { baseURL: `http://127.0.0.1:${address.port}/v1`, modelID: "fixture-model", credential: "synthetic-local-fixture" }, allowLocalProvider: true });
  const logDirectory = join(dirname(connection.directory), 'data', 'opencode', 'log');
  const logFile = join(logDirectory, 'opencode.log');
  assert.equal(await realpath(logFile), '/dev/null');
  const adapter = new OpenCodeAdapter({ getConnection: () => runtime.getConnection(), executionTimeoutMs: 3e4 });
  manager = new SessionManager({ store: new SessionHistoryStore(join(root, "ordinary")), driver: ordinary, task: { store: new TaskSessionHistoryStore(root), driver: adapter } });
  const session = await manager.createTaskSession({ title: "Actual OpenCode, local provider fixture", projectID: `project-${randomUUID()}`, taskID: "task-001" });
  const spec = { work: { planID: randomUUID(), planVersion: 1, workItemID: randomUUID() }, title: "Local protocol fixture", kind: "discussion", expectedResult: "Local fixture reply.", dependencies: [], inputMessageID: randomUUID(), materials: [], workspace: { workspaceID: randomUUID(), bindingDigest: "a".repeat(64) }, driver: { driverID: "opencode-no-tools", configDigest: connection.configDigest, mode: "external" }, tools: { kind: "none" } };
  const turn = await manager.prepareTaskTurn({ session: { format: "task-v2", sessionID: session.conversation_id }, clientRequestID: randomUUID(), text: "Reply using the local fixture only.", model: connection.model, spec });
  await manager.startTaskTurn({ turn, approvalID: randomUUID(), check: () => {
  }, resolved: { workspaceRoot: root, materials: [] } });
  let record = await manager.getTaskTurn(turn);
  for (let i = 0; i < 300 && !["finished", "failed", "unknown"].includes(record.state); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    record = await manager.getTaskTurn(turn);
  }
  const saved = await manager.loadTaskSession(turn.session);
  assert.equal(record.state, "finished", record.failure);
  assert.equal(saved?.messages.find((message) => message.role === "assistant")?.text, "Local fixture reply.");
  assert.equal(requests.length, 1);
  assert.equal((await manager.startTaskTurn({ turn, approvalID: record.execution.authorizationID, check: () => {
  }, resolved: { workspaceRoot: root, materials: [] } })).status, "already-started");
  const observed = await adapter.inspectExecution({ clientRequestID: record.client_request_id, driver: spec.driver, workspace: spec.workspace, binding: record.execution.external });
  assert.equal(observed.status, "finished");
  assert.equal(requests.length, 1);
  const hold = async () => {
    const next = await manager.prepareTaskTurn({ session: turn.session, clientRequestID: randomUUID(), text: 'Hold synthetic reply until stopped.', model: connection.model, spec: { ...spec, work: { ...spec.work, workItemID: randomUUID() }, inputMessageID: randomUUID() } });
    const before = requests.length;
    await manager.startTaskTurn({ turn: next, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: root, materials: [] } });
    for (let count = 0; count < 100 && requests.length === before; count++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requests.length, before + 1);
    return next;
  };
  const cancelling = await hold();
  const cancellationReceipt = await manager.cancelTaskExecution(cancelling);
  let cancellation = cancellationReceipt;
  for (let count = 0; count < 100 && cancellation.state !== 'cancelled'; count++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    cancellation = await manager.reconcileTaskExecution(cancelling);
  }
  assert.equal(cancellation.state, 'cancelled', 'only a matching completed MessageAbortedError confirms cancel');
  const failure = await manager.prepareTaskTurn({ session: turn.session, clientRequestID: randomUUID(), text: 'Return synthetic error instead of a reply.', model: connection.model, spec: { ...spec, work: { ...spec.work, workItemID: randomUUID() }, inputMessageID: randomUUID() } });
  await manager.startTaskTurn({ turn: failure, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: root, materials: [] } });
  let failed = await manager.getTaskTurn(failure);
  for (let count = 0; count < 100 && !['failed', 'unknown'].includes(failed.state); count++) { await new Promise(resolve => setTimeout(resolve, 50)); failed = await manager.getTaskTurn(failure); }
  assert.equal(failed.state, 'failed');
  assert.deepEqual(await readdir(logDirectory), ['opencode.log']);
  assert.equal((await readFile(logFile)).length, 0, 'native logger must not persist an error body');
  assert.doesNotMatch(JSON.stringify(await manager.loadTaskSession(turn.session)), /fixture-sensitive-error-body/);
  const interrupted = await hold();
  await manager.shutdown();
  await runtime.stop();
  assert.equal(runtime.getConnection(), void 0);
  assert.equal((await adapter.inspectExecution({ clientRequestID: record.client_request_id, driver: spec.driver, workspace: spec.workspace, binding: record.execution.external })).status, "unverifiable");
  manager = new SessionManager({ store: new SessionHistoryStore(join(root, 'ordinary')), driver: ordinary, task: { store: new TaskSessionHistoryStore(root), driver: adapter } });
  const recovered = await manager.loadTaskSession(interrupted.session);
  assert.equal(recovered.turns.find(value => value.turn_id === interrupted.turnID).state, 'unknown');
  assert.equal((await manager.reconcileTaskExecution(interrupted)).state, 'unknown');
  assert.equal((await manager.startTaskTurn({ turn: interrupted, approvalID: randomUUID(), check: () => {}, resolved: { workspaceRoot: root, materials: [] } })).status, 'unknown');
  assert.equal(requests.length, 4, 'restart and reconciliation cannot reissue any prompt');
  assert.deepEqual(providerProblems, []);
  const report = { version: connection.version, runtime: "official binary", provider: "local synthetic fixture; no real model", state: record.state, providerSubmissions: requests.length, originalQuery: observed.status, duplicateStart: "already-started", cancellationReceipt: cancellationReceipt.state, cancellation: cancellation.state, explicitFailure: failed.state, nativeLog: 'null device; error body not persisted', restart: 'unknown; no resend', afterRuntimeStop: "unverifiable", artifacts: 0, tools: false };
  await mkdir(join(root, "report"), { recursive: true });
  await writeFile(join(root, "report/result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: root }));
} finally {
  await manager?.shutdown();
  await runtime.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}
