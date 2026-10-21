import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskPlanningService } from '../../src/core/tasks/task-planning-service.js';
import { validateGeneratedPlan } from '../../src/core/tasks/task-planning-schema.js';
import { canonicalDigest } from '../../src/core/storage/execution-records.js';
import { TaskPlanningStore } from '../../src/core/tasks/task-planning-store.js';
import { ConfiguredTaskPlanningModel } from '../../src/main/task-planning-model.js';
import { taskPlanningFixture } from '../helpers/task-planning-fixture.js';
import type { PlanningModel } from '../../src/core/tasks/task-planning-contract.js';
import { ExecutionError } from '../../src/core/sessions/execution-driver.js';
const service = (f: Awaited<ReturnType<typeof taskPlanningFixture>>, model = f.model) => new TaskPlanningService({ root: f.root, plans: f.plans, model, candidates: f.candidates });
const input = (f: Awaited<ReturnType<typeof taskPlanningFixture>>) => ({ taskID: f.plan.id, expectedVersion: f.plan.version, clientRequestID: randomUUID(), selectedMaterialIDs: [] });
const confirmation = (f: Awaited<ReturnType<typeof taskPlanningFixture>>, r: Awaited<ReturnType<TaskPlanningService['generate']>>) => ({ taskID: f.plan.id, requestID: r.id, expectedVersion: r.baseVersion, draftDigest: r.draftDigest!, assignments: r.draft!.steps.map(s => ({ stepKey: s.key, candidateID: s.preferredCandidateID })) });
test('main-task generation is single-submit draft; explicit confirmation CAS writes the formal Task once', async t => {
  const f = await taskPlanningFixture(t), planning = service(f), request = input(f);
  const original = await readFile(join(f.root, 'tasks', f.plan.id, 'task.json'));
  const [a, b] = await Promise.all([planning.generate(request), planning.generate(request)]);
  assert.equal(a.status, 'draft'); assert.deepEqual(a, b); assert.equal(f.modelCalls(), 1); assert.equal(f.sends(), 0);
  assert.deepEqual(await readFile(join(f.root, 'tasks', f.plan.id, 'task.json')), original);
  const saved = await planning.confirm(confirmation(f, a)); assert.equal(saved.version, 2); assert.equal(saved.work_items[0].status, 'planned');
  assert.equal(saved.work_items[0].agentID, 'alpha'); assert.equal(saved.work_items[1].model?.model_id, 'beta-model'); assert.deepEqual(saved.work_items[1].dependencies, [saved.work_items[0].id]);
  assert.equal(JSON.parse(await readFile(join(f.root, 'tasks', f.plan.id, 'task.json'), 'utf8')).kind, 'screendeck_task');
  assert.equal((await planning.confirm(confirmation(f, a))).version, 2); assert.equal(f.sends(), 0);
  const current = await f.plans.loadPlan(f.plan.id); await f.plans.editPlan(f.plan.id, current!.version, { title: 'Later user edit' });
  assert.equal((await planning.confirm(confirmation(f, a))).title, 'Later user edit'); assert.equal(f.modelCalls(), 1);
  assert.equal((await readdir(join(f.root, 'tasks', f.plan.id, 'planning-requests'))).length, 1);
});
test('strict generated DAG, capacity, candidate capability and authority fields are enforced', async t => {
  const f = await taskPlanningFixture(t), candidates = f.candidates();
  const variants: unknown[] = [ { steps: [] }, { ...f.draft, status: 'completed' }, { steps: Array(33).fill(f.draft.steps[0]) }, { steps: [{ ...f.draft.steps[0], dependencies: ['missing'] }] }, { steps: [{ ...f.draft.steps[0], dependencies: ['first'] }] }, { steps: [{ ...f.draft.steps[0], candidateIDs: ['invented-model'], preferredCandidateID: 'invented-model' }] }, { steps: [{ ...f.draft.steps[0], completion_conditions: [] }] }, { steps: [{ ...f.draft.steps[0], tools: 'full-access' }] }, { steps: [f.draft.steps[0], f.draft.steps[0]] } ];
  for (const v of variants) assert.throws(() => validateGeneratedPlan(v, candidates));
  assert.throws(() => validateGeneratedPlan(f.draft, candidates.map(c => ({ ...c, supportedKinds: ['discussion'] }))));
  assert.throws(() => validateGeneratedPlan({ steps: [{ ...f.draft.steps[0], dependencies: ['second'] }, { ...f.draft.steps[1], dependencies: ['first'] }] }, candidates));
});
test('stale task and changed real candidate model cannot be overwritten by a draft', async t => {
  const f = await taskPlanningFixture(t), planning = service(f), r = await planning.generate(input(f));
  await f.plans.editPlan(f.plan.id, 1, { title: 'Manual change' }); await assert.rejects(planning.confirm(confirmation(f, r)), /旧草稿/);
  const next = await planning.generate({ ...input(f), expectedVersion: 2 }); f.sources[0].model = { provider_id: 'fixture', model_id: 'changed-model' };
  await assert.rejects(planning.confirm({ ...confirmation(f, next), expectedVersion: 2 }), /模型已变化/); assert.equal((await f.plans.loadPlan(f.plan.id))!.version, 2);
});
test('network uncertainty and process recovery never resubmit the same generation', async t => {
  const f = await taskPlanningFixture(t); let calls = 0;
  const model: PlanningModel = { async capture() { const captured = await f.model.capture(); return { ...captured, async generate() { calls++; throw new ExecutionError('network', 'synthetic private transport message', true); } }; } };
  const planning = service(f, model), request = input(f); const a = await planning.generate(request); assert.equal(a.status, 'unknown'); assert.equal(calls, 1);
  assert.equal((await service(f, model).generate(request)).status, 'unknown'); assert.equal(calls, 1);
  await assert.rejects(planning.generate({ ...request, selectedMaterialIDs: [randomUUID()] }), /更改输入/);
  assert.doesNotMatch(JSON.stringify(a), /private transport/);
  const store = new TaskPlanningStore(f.root), id = randomUUID();
  const { failure: _failure, ...body } = a;
  const crashedInput = { ...request, clientRequestID: id };
  await f.plans.transactPlan(f.plan.id, async () => { await store.save({ ...body, id, status: 'generating', inputDigest: canonicalDigest(crashedInput) }); return { value: undefined }; });
  assert.equal((await service(f, model).get(f.plan.id, id))?.status, 'unknown');
  assert.equal((await service(f, model).generate(crashedInput)).status, 'unknown'); assert.equal(calls, 1);
});
test('invalid completed JSON is a failed draft without plan writes or execution', async t => {
  const f = await taskPlanningFixture(t), model: PlanningModel = { async capture() { const c = await f.model.capture(); return { ...c, async generate() { return { text: '{"steps":[],"execute":true}' }; } }; } };
  const r = await service(f, model).generate(input(f)); assert.equal(r.status, 'failed'); assert.equal(r.failure, 'invalid-result'); assert.equal((await f.plans.loadPlan(f.plan.id))!.version, 1); assert.equal(f.sends(), 0);
});
test('lost confirmation response reconciles the same exact saved plan without a second CAS update', async t => {
  const f = await taskPlanningFixture(t), planning = service(f), r = await planning.generate(input(f)); let writes = 0;
  const plans = { loadPlan: f.plans.loadPlan.bind(f.plans), async transactPlan<T>(id: string, op: Parameters<typeof f.plans.transactPlan<T>>[1]) { const result = await f.plans.transactPlan(id, op); if (result.plan && ++writes === 1) throw new Error('synthetic lost response'); return result; } };
  const interrupted = new TaskPlanningService({ root: f.root, plans, model: f.model, candidates: f.candidates });
  await assert.rejects(interrupted.confirm(confirmation(f, r)), /lost response/); assert.equal((await f.plans.loadPlan(f.plan.id))!.version, 2);
  assert.equal((await planning.confirm(confirmation(f, r))).version, 2); assert.equal(f.modelCalls(), 1);
});
test('configured generative adapter uses synthetic SSE once and retains reported model provenance', async t => {
  const f = await taskPlanningFixture(t); let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'synthetic-planner'); assert.equal(body.messages.length, 1);
    const delta = { model: 'synthetic-planner', choices: [{ index: 0, delta: { content: JSON.stringify(f.draft) }, finish_reason: null }] }, done = { model: 'synthetic-planner', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const configured = new ConfiguredTaskPlanningModel({ generation: randomUUID(), async prepareRequest() { return { baseURL: 'https://synthetic.invalid/v1', modelID: 'synthetic-planner', credential: 'synthetic-only-key' }; } }, fetch);
  const r = await service(f, configured).generate(input(f)); assert.equal(r.status, 'draft'); assert.equal(calls, 1); assert.equal(r.observedModel?.model_id, 'synthetic-planner'); assert.doesNotMatch(JSON.stringify(r), /synthetic-only-key|https:/);
});
test('user may edit the draft and choose human while all work remains planned', async t => {
  const f = await taskPlanningFixture(t), planning = service(f), r = await planning.generate(input(f));
  const editedDraft = structuredClone(r.draft!); editedDraft.steps[0].title = 'Human-reviewed first step';
  const confirm = confirmation(f, r); confirm.assignments[0].candidateID = 'human';
  const saved = await planning.confirm({ ...confirm, editedDraft }); assert.equal(saved.work_items[0].assignee, 'human'); assert.equal(saved.work_items[0].agentID, undefined); assert.equal(saved.work_items[0].title, 'Human-reviewed first step'); assert.equal(f.sends(), 0);
  await assert.rejects(planning.confirm({ ...confirmation(f, r), editedDraft }), /替换计划/);
});
test('missing model configuration is a known no-submit failure; bad request fields are rejected', async t => {
  const f = await taskPlanningFixture(t), planning = service(f, { async capture() { throw new Error('private credential missing'); } });
  const r = await planning.generate(input(f)); assert.equal(r.status, 'failed'); assert.equal(r.failure, 'not-submitted'); assert.doesNotMatch(JSON.stringify(r), /credential/);
  await assert.rejects(async () => planning.generate({ ...input(f), autoStart: true } as never));
  await assert.rejects(async () => planning.generate({ ...input(f), taskID: '../escape' }));
  assert.equal(f.sends(), 0);
});
test('incomplete synthetic model response stays unknown and is not automatically retried', async t => {
  const f = await taskPlanningFixture(t); let calls = 0;
  const configured = new ConfiguredTaskPlanningModel({ generation: randomUUID(), async prepareRequest() { return { baseURL: 'https://synthetic.invalid/v1', modelID: 'synthetic-planner', credential: 'synthetic-only-key' }; } }, async () => { calls++; return new Response('data: {"choices":[{"index":0,"delta":{"content":"{\\"steps\\":[]}"},"finish_reason":null}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); });
  const planning = service(f, configured), request = input(f); assert.equal((await planning.generate(request)).status, 'unknown'); await planning.generate(request); assert.equal(calls, 1); assert.equal((await f.plans.loadPlan(f.plan.id))!.version, 1);
});


test('planning accepts bounded reasoning/fence envelopes but still rejects prose, extra objects and authority fields', async t => {
  const { parseGeneratedPlanText } = await import('../../src/core/tasks/task-planning-schema.js');
  const f = await taskPlanningFixture(t), body = JSON.stringify(f.draft);
  for (const text of [body, '<think>reasoning</think>' + body, 'gateway reasoning</think>' + body, '```json\n' + body + '\n```']) assert.deepEqual(parseGeneratedPlanText(text, f.candidates()), f.draft);
  for (const text of ['Here is a plan: ' + body, body + body, '<think>unfinished' + body, '</think>x</think>' + body, body + ' done']) assert.throws(() => parseGeneratedPlanText(text, f.candidates()));
  assert.throws(() => parseGeneratedPlanText(JSON.stringify({ ...f.draft, permissions: 'full-access' }), f.candidates()));
});
