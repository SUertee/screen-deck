import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionEngine } from '../../src/core/tasks/decision-engine.js';
import { assertJevDraftCurrent, JevAdviceError, JevDecisionProvider, validateJevChoiceResponse, type JevTransport, type JevChoiceRequest } from '../../src/core/tasks/providers/jev-decision-provider.js';
import type { DecisionContext } from '../../src/shared/types.js';

// Every service response here is synthetic. No keys, filesystem, HTTP, or real models.
const planID = '11111111-1111-4111-8111-111111111111';
const itemID = '22222222-2222-4222-8222-222222222222';
const context = (): DecisionContext => ({ planVersion: 3, workItem: { id: itemID, title: 'Synthetic discussion', kind: 'discussion', assignee: 'unassigned', expected_result: 'A text proposal', dependencies: [], status: 'planned' }, risk: 'low', capabilities: ['stateless-chat'], budgetAvailable: true });
const response = () => ({ model: 'jev-1.13.0', answers: { assignee: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: { human: 0.05, chat: 0.95 } } }, usage: { input_tokens: 100, output_tokens: 20 } });
function fixture(run: JevTransport['systemOne'] = async () => response(), timeoutMs = 1000) {
  let calls = 0;
  const provider = new JevDecisionProvider({ planID, model: 'jev-1.13.0', minimumConfidence: 0.8, timeoutMs, transport: { provenance: 'test-fixture', systemOne: async (...args) => { calls++; return run(...args); } } });
  return { provider, calls: () => calls };
}
const code = (expected: string, delivery?: string) => (error: unknown) => error instanceof JevAdviceError && error.code === expected && (delivery === undefined || error.delivery === delivery);

test('DecisionEngine accepts enriched advice; provenance, version and candidate intent survive cloning', async () => {
  const original = context(); let sent: JevChoiceRequest | undefined;
  const f = fixture(async request => { sent = request; request.state.title = 'Transport mutation'; return response(); });
  const advice = await f.provider.recommend(original);
  assert.equal(advice.source.transport, 'test-fixture'); assert.equal(advice.source.reportedModel, 'jev-1.13.0');
  assert.equal(advice.base.planID, planID); assert.equal(advice.base.planVersion, 3); assert.equal(advice.base.workItemID, itemID);
  assert.equal(advice.reasonSource, 'application-explanation'); assert.equal(advice.requiresConfirmation, true);
  assert.deepEqual(advice.candidateChanges, [{ kind: 'suggest-assignee', workItemID: itemID, candidate: 'chat' }]);
  assertJevDraftCurrent(advice, planID, original); assert.deepEqual(original, context());
  assert.ok(sent); assert.deepEqual(Object.keys(sent.state).sort(), ['title', 'kind', 'expected_result', 'risk', 'capabilities'].sort());
  assert.ok(!JSON.stringify(sent).includes(planID)); assert.ok(!JSON.stringify(sent).includes(itemID));
  const viaEngine = await new DecisionEngine(f.provider).recommend(original);
  assert.equal(viaEngine.candidate, 'chat'); assert.ok('source' in viaEngine); assert.equal(viaEngine.advisory, true);
});

test('unconfigured service and unconfirmed budget fail closed, without fallback or calls', async () => {
  const provider = new JevDecisionProvider({ planID, model: 'jev-latest', minimumConfidence: 0.8, timeoutMs: 100 });
  await assert.rejects(provider.recommend(context()), code('unavailable', 'not-sent'));
  const f = fixture();
  for (const budgetAvailable of [false, undefined]) await assert.rejects(f.provider.recommend({ ...context(), budgetAvailable }), code('budget-unconfirmed', 'not-sent'));
  assert.equal(f.calls(), 0);
});

test('application review policy preserves raw model choice and does not label policy as model reasoning', async () => {
  const cases = [ { ...context(), risk: 'high' as const }, { ...context(), capabilities: [] }, { ...context(), workItem: { ...context().workItem, kind: 'implementation' as const } } ];
  for (const input of cases) {
    const advice = await fixture().provider.recommend(input);
    assert.equal(advice.candidate, 'human'); assert.equal(advice.evidence.choice, 'chat'); assert.equal(advice.reasonSource, 'application-explanation');
  }
  const low = await fixture(async () => { const r = response(); r.answers.assignee.confidence = 0.2; return r; }).provider.recommend(context());
  assert.equal(low.candidate, 'human'); assert.equal(low.evidence.confidence, 0.2);
});

test('strict response validation rejects malformed, extra, nonfinite and inconsistent values', async t => {
  const malformed: Array<[string, (r: any) => void]> = [
    ['missing answers', r => delete r.answers], ['extra output command', r => r.execute = true],
    ['unknown answer', r => r.answers.other = {}], ['missing answer', r => delete r.answers.assignee],
    ['wrong type', r => r.answers.assignee.type = 'score'], ['unknown choice', r => r.answers.assignee.choice = 'agent'],
    ['NaN', r => r.answers.assignee.confidence = NaN], ['infinity', r => r.answers.assignee.confidence = Infinity],
    ['confidence > 1', r => r.answers.assignee.confidence = 1.1], ['string probability', r => r.answers.assignee.probabilities.chat = '0.95'],
    ['negative probability', r => r.answers.assignee.probabilities.human = -0.1], ['bad sum', r => r.answers.assignee.probabilities.chat = 0.5],
    ['missing probability', r => delete r.answers.assignee.probabilities.human], ['extra probability', r => r.answers.assignee.probabilities.agent = 0],
    ['choice disagrees with maximum', r => r.answers.assignee.choice = 'human'], ['invented explanation', r => r.answers.assignee.reason = 'Fabricated'],
    ['missing usage', r => delete r.usage], ['negative tokens', r => r.usage.input_tokens = -1],
    ['fraction tokens', r => r.usage.output_tokens = 0.1], ['other model', r => r.model = 'other-latest'],
  ];
  for (const [name, mutate] of malformed) await t.test(name, () => { const r = response(); mutate(r); assert.throws(() => validateJevChoiceResponse(r), code('invalid-response', 'received')); });
  for (const invalid of [null, [], 'json text', {}]) assert.throws(() => validateJevChoiceResponse(invalid), code('invalid-response'));
});

test('invalid input is rejected before invoking transport', async () => {
  const f = fixture();
  const mutations: Array<(c: any) => void> = [c => c.planVersion = 0, c => c.planVersion = NaN, c => c.risk = 'unknown', c => c.capabilities = ['x', 'x'], c => c.workItem.id = 'bad', c => c.workItem.dependencies = [itemID], c => c.workItem.permission = 'full', c => c.workItem.agentID = 'codex', c => c.workItem.assignee = 'chat', c => c.workItem.model = { provider_id: 'hidden' }, c => c.apiKey = 'synthetic-secret', c => c.budgetAvailable = 'yes'];
  for (const mutate of mutations) { const input = context(); mutate(input); await assert.rejects(f.provider.recommend(input), code('invalid-input')); }
  assert.equal(f.calls(), 0);
  assert.throws(() => new JevDecisionProvider({ planID, model: 'jev-latest', minimumConfidence: NaN, timeoutMs: 100 }), code('invalid-input'));
});

test('pinned model mismatch fails; alias preserves reported model without inventing identity', async () => {
  const f = fixture(async () => ({ ...response(), model: 'jev-1.14.0' }));
  await assert.rejects(f.provider.recommend(context()), code('invalid-response', 'received'));
  const p = new JevDecisionProvider({ planID, model: 'jev-latest', minimumConfidence: 0.8, timeoutMs: 100, transport: { provenance: 'test-fixture', systemOne: async () => response() } });
  const advice = await p.recommend(context()); assert.equal(advice.source.requestedModel, 'jev-latest'); assert.equal(advice.source.reportedModel, 'jev-1.13.0');
});

test('current check detects another plan, newer version, same-version edit and capability changes', async () => {
  const advice = await fixture().provider.recommend(context());
  assert.throws(() => assertJevDraftCurrent(advice, itemID, context()), code('stale-draft'));
  const changes = [ { ...context(), planVersion: 4 }, { ...context(), workItem: { ...context().workItem, title: 'Edited' } }, { ...context(), capabilities: [] }, { ...context(), budgetAvailable: false } ];
  for (const current of changes) assert.throws(() => assertJevDraftCurrent(advice, planID, current), code('stale-draft'));
  const reordered = { capabilities: ['stateless-chat'], budgetAvailable: true, risk: 'low', workItem: context().workItem, planVersion: 3 } as DecisionContext;
  assertJevDraftCurrent(advice, planID, reordered);
});

test('snapshot binds the original input even if caller edits while awaiting response', async () => {
  let release!: (r: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; }); const f = fixture(async () => pending);
  const input = context(); const promise = f.provider.recommend(input); input.workItem.title = 'Changed'; release(response());
  const advice = await promise; assertJevDraftCurrent(advice, planID, context());
  assert.throws(() => assertJevDraftCurrent(advice, planID, input), code('stale-draft'));
});

test('pre-cancel never calls; in-flight cancel is unknown, with no retry and no late result', async () => {
  const f = fixture(); const before = new AbortController(); before.abort();
  await assert.rejects(f.provider.recommend(context(), before.signal), code('cancelled', 'not-sent')); assert.equal(f.calls(), 0);
  let release!: (r: unknown) => void; let observed: AbortSignal | undefined;
  const pending = new Promise(resolve => { release = resolve; });
  const inflight = fixture(async (_request, options) => { observed = options.signal; return pending; });
  const controller = new AbortController(); const promise = inflight.provider.recommend(context(), controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(promise, code('cancelled', 'unknown')); assert.equal(observed?.aborted, true);
  release(response()); await Promise.resolve(); assert.equal(inflight.calls(), 1);
});

test('timeout ignores uncooperative transport and never retries; failures do not expose raw error text', async () => {
  const f = fixture(async () => new Promise(() => {}), 10);
  await assert.rejects(f.provider.recommend(context()), code('timeout', 'unknown')); assert.equal(f.calls(), 1);
  const rejected = fixture(async () => { throw new Error('synthetic-sensitive-server-body'); });
  await assert.rejects(rejected.provider.recommend(context()), error => code('transport-failed', 'unknown')(error) && !String(error).includes('synthetic-sensitive'));
  assert.equal(rejected.calls(), 1);
});


test('immediate cancellation before transport dispatch prevents the queued request', async () => {
  const f = fixture(); const controller = new AbortController();
  const promise = f.provider.recommend(context(), controller.signal); controller.abort();
  await assert.rejects(promise, code('cancelled', 'not-sent')); assert.equal(f.calls(), 0);
});
