import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalState } from '../../src/main/local-state.js';
import { JevSettingsStore } from '../../src/main/jev-settings.js';
import { JevService, validateJevServiceResponse, type JevCandidate, type JevPlanInput } from '../../src/main/jev-service.js';
import { JevHttpTransport, JevServiceError, type JevHttpRequest } from '../../src/core/tasks/providers/jev-http-transport.js';

const key = 'synthetic-jev-key-only-never-real';
const pid = '11111111-1111-4111-8111-111111111111';
const wid = '22222222-2222-4222-8222-222222222222';
const mid = '33333333-3333-4333-8333-333333333333';
const candidates = (): JevCandidate[] => [
  { id: 'human', label: '人工', description: 'Human review when uncertain', assignee: 'human' },
  { id: 'codex', label: 'Codex', description: 'Propose a code implementation; separate execution authorization required', assignee: 'agent', agentID: 'codex' },
];
const plan = (): JevPlanInput => ({ schema_version: 3, kind: 'electron_preview_plan', id: pid, title: 'Synthetic task', version: 4, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
  task: { goal: 'Fix synthetic bug', completion_conditions: ['Isolated checks pass'], materials: [{ id: mid, title: 'Reviewed note', summary: 'Selected summary only', source: { kind: 'screen', reference: 'screenpipe://private-source-not-to-send', label: 'Reviewed frame' }, confirmation_id: pid, screen_clues: [{ source: { frameID: 'private-frame' }, excerpt: { text: 'raw-excerpt-not-to-send' } }] }], chat_refs: [{ source: 'agent', sessionID: pid }], context_receipts: [{ confirmationID: pid }] },
  work_items: [{ id: wid, title: 'Fix work item', kind: 'implementation', expected_result: 'Patch with checks', assignee: 'unassigned', dependencies: [], status: 'planned' }] });
const response = () => ({ model: 'jev-1.13.0', answers: { assignee: { type: 'choice', choice: 'codex', confidence: 0.9, probabilities: { human: 0.05, codex: 0.95 } } }, usage: { input_tokens: 100, output_tokens: 10 } });
const request = (): JevHttpRequest => ({ model: 'jev-1.13.0', state: { title: 'Synthetic' }, questions: { assignee: { type: 'choice', instructions: 'Choose handler', criteria: { human: 'Human', codex: 'Coding advice' } } } });
const errorCode = (expected: string, delivery?: string) => (error: unknown) => error instanceof JevServiceError && error.code === expected && (!delivery || error.delivery === delivery) && !JSON.stringify(error).includes(key) && !String(error).includes(key);
async function server(t: { after(fn: () => unknown): void }, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const s = createServer(handle); await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  t.after(() => { s.closeAllConnections(); return new Promise<void>(resolve => s.close(() => resolve())); });
  const address = s.address(); assert.ok(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}/v1/systemone`;
}
function memorySettings(initial: string | null = key) {
  let value: unknown = initial === null ? undefined : { schema_version: 1, kind: 'typesafe_jev_credential', apiKey: initial };
  const writes: string[] = [];
  const store = new JevSettingsStore({ read: async <T>(_name: string, fallback: T) => structuredClone(value ?? fallback) as T, write: async (name, next) => { writes.push(name); value = structuredClone(next); } });
  return { store, writes };
}

test('main-only Jev settings use private LocalState 0600 file, return only hasKey, survive restart and clear', async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'screendeck-jev-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JevSettingsStore(new LocalState(root)); assert.deepEqual(await store.publicSettings(), { hasKey: false });
  assert.deepEqual(await store.save(key), { hasKey: true }); assert.deepEqual(Object.keys(store), []);
  const files = (await readdir(root)).filter(f => f.endsWith('.json')); assert.equal(files.length, 1);
  assert.equal((await stat(path.join(root, files[0]))).mode & 0o777, 0o600); assert.ok((await readFile(path.join(root, files[0]), 'utf8')).includes(key));
  const restarted = new JevSettingsStore(new LocalState(root)); assert.deepEqual(await restarted.publicSettings(), { hasKey: true });
  assert.deepEqual(await restarted.save(null), { hasKey: false }); assert.equal((await restarted.snapshot()).apiKey, undefined);
  await assert.rejects(restarted.save('header\r\ninjection'), errorCode('invalid-input'));
});

test('corrupt credentials are not overwritten, and arbitrary storage errors are sanitized', async () => {
  let writes = 0;
  const corrupt = new JevSettingsStore({ read: async <T>() => ({ kind: 'wrong', apiKey: key } as T), write: async () => { writes++; } });
  await assert.rejects(corrupt.publicSettings(), errorCode('storage-failed')); await assert.rejects(corrupt.save(key), errorCode('storage-failed')); assert.equal(writes, 0);
  const failing = new JevSettingsStore({ read: async <T>(_n: string, fallback: T) => fallback, write: async () => { throw new Error(key); } });
  await assert.rejects(failing.save(key), errorCode('storage-failed'));
});

test('no-key is explicit, construction/preview/settings make no request, budget-unconfirmed does not dispatch', async () => {
  let calls = 0; const fixture = memorySettings(null);
  const svc = new JevService(fixture.store, { model: 'jev-1.13.0', minimumConfidence: 0.8, transportFactory: () => { calls++; throw new Error(); } });
  svc.preview(plan(), wid, candidates(), { materialIDs: [] }); await fixture.store.publicSettings();
  assert.deepEqual(await svc.recommend(plan(), wid, candidates(), { materialIDs: [], budgetConfirmed: false }), { kind: 'not-configured', hasKey: false });
  await fixture.store.save(key);
  await assert.rejects(svc.recommend(plan(), wid, candidates(), { materialIDs: [], budgetConfirmed: false }), errorCode('budget-unconfirmed'));
  assert.equal(calls, 0);
});

test('mock HTTP roundtrip maps v3 task and selected summaries; keeps source references local and never saves task', async t => {
  let received: any; let calls = 0;
  const endpoint = await server(t, (req, res) => { calls++; assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, `Bearer ${key}`); let body = ''; req.on('data', c => body += c); req.on('end', () => { received = JSON.parse(body); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response())); }); });
  const f = memorySettings(); const svc = new JevService(f.store, { model: 'jev-1.13.0', minimumConfidence: 0.95, transportFactory: credential => new JevHttpTransport(credential, { testOnly: { endpoint } }) });
  const original = plan(); const preview = svc.preview(original, wid, candidates(), { materialIDs: [mid] });
  const advice = await svc.recommend(original, wid, candidates(), { materialIDs: [mid], budgetConfirmed: true }); assert.equal(advice.kind, 'advice'); if (advice.kind !== 'advice') return;
  assert.deepEqual(received, preview.request); assert.deepEqual((received.state as any).materials, [{ title: 'Reviewed note', summary: 'Selected summary only' }]);
  for (const text of [pid, wid, mid, 'screenpipe://', 'raw-excerpt-not-to-send', 'confirmation_id', 'chat_refs']) assert.ok(!JSON.stringify(received).includes(text), text);
  assert.equal(advice.source.transport, 'test-fixture'); assert.equal(advice.base.baseVersion, 4); assert.equal(advice.needsReview, true);
  assert.equal(advice.candidateChanges[0].candidate.agentID, 'codex'); assert.equal(advice.materials[0].source.reference, original.task!.materials[0].source.reference);
  assert.equal(advice.requiresConfirmation, true); assert.deepEqual(original, plan()); assert.deepEqual(f.writes, []); assert.equal(calls, 1);
  svc.assertCurrent(advice, original, candidates(), { materialIDs: [mid] });
  for (const current of [{ ...plan(), version: 5 }, { ...plan(), task: { ...plan().task!, goal: 'Changed' } }]) assert.throws(() => svc.assertCurrent(advice, current, candidates(), { materialIDs: [mid] }), errorCode('stale-draft'));
  assert.throws(() => svc.assertCurrent(advice, original, candidates(), { materialIDs: [] }), errorCode('stale-draft'));
});

test('legacy plans remain readable, missing materials/candidates/unsafe assignments reject before send', () => {
  const svc = new JevService(memorySettings().store, { model: 'jev-latest', minimumConfidence: 0.8 });
  const { task: _task, ...legacy } = plan(); const v2 = { ...legacy, schema_version: 2 as const };
  assert.deepEqual((svc.preview(v2, wid, candidates(), { materialIDs: [] }).request.state as any).materials, []);
  assert.throws(() => svc.preview(plan(), wid, candidates(), { materialIDs: [pid] }), errorCode('invalid-input'));
  assert.throws(() => svc.preview(plan(), wid, [candidates()[1]], { materialIDs: [] }), errorCode('invalid-input'));
  assert.throws(() => svc.preview(plan(), wid, [...candidates(), { id: 'chat', label: 'Chat', description: 'No tools', assignee: 'chat' }], { materialIDs: [] }), errorCode('invalid-input'));
});

test('HTTP failures return only stable code/status and never retry, follow redirect or expose body/key', async t => {
  for (const [status, code] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate-limited'], [529, 'overloaded'], [422, 'request-rejected'], [500, 'http-error']] as const) {
    let calls = 0; const endpoint = await server(t, (_req, res) => { calls++; res.writeHead(status, { 'Retry-After': '0' }); res.end(`private-body-${key}`); });
    await assert.rejects(new JevHttpTransport(key, { testOnly: { endpoint } }).systemOne(request()), errorCode(code, 'received')); assert.equal(calls, 1);
  }
  let redirectCalls = 0;
  const endpoint = await server(t, (_req, res) => { redirectCalls++; res.writeHead(302, { Location: '/stolen-key-target' }); res.end(); });
  await assert.rejects(new JevHttpTransport(key, { testOnly: { endpoint } }).systemOne(request()), errorCode('network', 'unknown')); assert.equal(redirectCalls, 1);
});

test('bounded HTTP reader rejects content type, invalid JSON/UTF8, declared/chunked oversize, and credential echoes', async t => {
  const cases: Array<[string, (res: ServerResponse) => void, string]> = [
    ['type', r => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('{}'); }, 'invalid-response'],
    ['json', r => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('bad'); }, 'invalid-response'],
    ['utf8', r => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(Buffer.from([0xff])); }, 'invalid-response'],
    ['length', r => { r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' }); r.end(); }, 'response-too-large'],
    ['chunks', r => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.write(' '.repeat(100)); r.end(' '.repeat(100)); }, 'response-too-large'],
    ['echo', r => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ secret: key })); }, 'invalid-response'],
  ];
  for (const [_name, handle, code] of cases) { const endpoint = await server(t, (_req, res) => handle(res)); await assert.rejects(new JevHttpTransport(key, { maxResponseBytes: 128, testOnly: { endpoint } }).systemOne(request()), errorCode(code, 'received')); }
});

test('HTTP header and body timeouts, cancellation and late injected fetch remain bounded', async t => {
  for (const bodyStall of [false, true]) {
    const endpoint = await server(t, (_req, res) => { if (bodyStall) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); } });
    await assert.rejects(new JevHttpTransport(key, { timeoutMs: 25, testOnly: { endpoint } }).systemOne(request()), errorCode('timeout', 'unknown'));
  }
  const endpoint = 'http://127.0.0.1:12345/v1/systemone'; let calls = 0;
  const transport = new JevHttpTransport(key, { timeoutMs: 10, testOnly: { endpoint, fetch: async () => { calls++; return new Promise(() => {}); } } });
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(transport.systemOne(request(), { signal: cancelled.signal }), errorCode('cancelled', 'not-sent')); assert.equal(calls, 0);
  await assert.rejects(transport.systemOne(request()), errorCode('timeout', 'unknown')); assert.equal(calls, 1);
  assert.throws(() => new JevHttpTransport(key, { testOnly: { endpoint: 'https://attacker.invalid/v1/systemone' } }), errorCode('invalid-input'));
  assert.equal(new JevHttpTransport(key).endpoint, 'https://api.typesafe.ai/v1/systemone'); assert.ok(!JSON.stringify(new JevHttpTransport(key)).includes(key));
});

test('key change while request is pending invalidates late advice and raw injected errors cannot leak', async () => {
  const f = memorySettings(); let release!: (v: unknown) => void; const pending = new Promise(resolve => release = resolve);
  const svc = new JevService(f.store, { model: 'jev-1.13.0', minimumConfidence: 0.8, transportFactory: () => ({ provenance: 'test-fixture', systemOne: async () => pending }) });
  const advice = svc.recommend(plan(), wid, candidates(), { materialIDs: [], budgetConfirmed: true });
  await new Promise(resolve => setImmediate(resolve)); await f.store.save(null); release(response());
  await assert.rejects(advice, errorCode('settings-changed', 'received'));
  await f.store.save(key);
  const bad = new JevService(f.store, { model: 'jev-1.13.0', minimumConfidence: 0.8, transportFactory: () => { throw new Error(key); } });
  await assert.rejects(bad.recommend(plan(), wid, candidates(), { materialIDs: [], budgetConfirmed: true }), errorCode('network'));
});

test('generic candidate response rejects unknown choices, inconsistent distributions and silent model switches', () => {
  const mutations: Array<(v: any) => void> = [v => v.answers.assignee.choice = 'unknown', v => v.answers.assignee.probabilities.other = 0, v => v.answers.assignee.probabilities.codex = 0.1, v => v.answers.assignee.confidence = NaN, v => v.model = 'jev-1.14.0', v => v.answers.assignee.reason = 'invented', v => v.usage.input_tokens = -1];
  for (const mutate of mutations) { const r = response(); mutate(r); assert.throws(() => validateJevServiceResponse(r, candidates(), 'jev-1.13.0'), errorCode('invalid-response')); }
});

test('uncertain credential write blocks snapshots until a later explicit successful save', async () => {
  let fail = true; let value: unknown = { schema_version: 1, kind: 'typesafe_jev_credential', apiKey: key };
  const store = new JevSettingsStore({ read: async <T>() => value as T, write: async (_n, next) => { value = next; if (fail) throw new Error(key); } });
  await assert.rejects(store.save('synthetic-replacement-key'), errorCode('storage-failed'));
  await assert.rejects(store.snapshot(), errorCode('storage-failed')); await assert.rejects(store.publicSettings(), errorCode('storage-failed'));
  fail = false; await store.save(key); assert.equal((await store.snapshot()).apiKey, key);
});

test('queued credential change cannot pair a previous key with a current generation', async () => {
  const f = memorySettings();
  const snapshot = f.store.snapshot(); const saving = f.store.save(null);
  await assert.rejects(snapshot, errorCode('settings-changed')); await saving;
  assert.equal((await f.store.snapshot()).apiKey, undefined);
});

test('in-flight HTTP cancellation aborts one original request and does not retry', async t => {
  let started!: () => void; const ready = new Promise<void>(resolve => started = resolve); let calls = 0;
  const endpoint = await server(t, (_req, _res) => { calls++; started(); });
  const controller = new AbortController(); const pending = new JevHttpTransport(key, { testOnly: { endpoint } }).systemOne(request(), { signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(pending, errorCode('cancelled', 'unknown')); assert.equal(calls, 1);
});

test('invalid outgoing values and oversized summary sets reject before HTTP dispatch', async () => {
  let calls = 0; const transport = new JevHttpTransport(key, { testOnly: { endpoint: 'http://127.0.0.1:12345/v1/systemone', fetch: async () => { calls++; throw new Error(); } } });
  for (const state of [{ invalid: NaN }, { field: undefined }, { deeply: new Date() }, { enormous: 'x'.repeat(130 * 1024) }]) await assert.rejects(transport.systemOne({ ...request(), state }), errorCode('invalid-input', 'not-sent'));
  assert.equal(calls, 0);
});


test('Jev accepts goal-first creation and optional project/chat provenance without sending those local fields', () => {
  const input = plan(); input.task!.creation_receipt = { requestID: pid, requestDigest: 'a'.repeat(64) }; input.task!.project_id = 'project-' + pid;
  input.task!.chat_origin = { private: 'source-metadata-must-stay-local' };
  const svc = new JevService(memorySettings().store, { model: 'jev-latest', minimumConfidence: .8 });
  const preview = svc.preview(input, wid, candidates(), { materialIDs: [] });
  assert.equal(preview.request.model, 'jev-latest');
  assert.doesNotMatch(JSON.stringify(preview.request), /creation_receipt|project_id|chat_origin|source-metadata-must-stay-local/);
  assert.equal((preview.request.state as any).task.goal, input.task!.goal);
});
