import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validatePreviewPlan } from '../../src/core/tasks/plan-schema.js';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import type { PlanWorkItem, PreviewPlan } from '../../src/shared/types.js';

const item = (change: Partial<PlanWorkItem> = {}): PlanWorkItem => ({ id: randomUUID(), title: 'Synthetic step', kind: 'implementation', assignee: 'unassigned', expected_result: 'Synthetic result', dependencies: [], status: 'planned', ...change });
const plan = (schema: 1 | 2, workItems = [item()]): PreviewPlan => ({ schema_version: schema, kind: 'electron_preview_plan', id: randomUUID(), title: 'Synthetic goal', version: 1, created_at: '2026-10-21T01:00:00.000Z', updated_at: '2026-10-21T01:00:00.000Z', work_items: workItems });
const temp = async () => mkdtemp(join(await realpath(tmpdir()), 'screendeck-plan-schema-test-'));

test('v1 stays strict while v2 accepts explicit Agent planning metadata and title-only steps', () => {
  assert.equal(validatePreviewPlan(plan(1)).schema_version, 1);
  for (const legacy of [plan(1, [item({ expected_result: '' })]), plan(1, [item({ assignee: 'agent', agentID: 'opencode' })]), plan(1, [{ ...item(), agentID: undefined }])]) {
    assert.throws(() => validatePreviewPlan(legacy), { code: 'invalid-plan' });
  }
  const next = plan(2, [item({ expected_result: '' }), item({ assignee: 'agent', agentID: 'opencode', expected_result: '' }), item({ assignee: 'agent', agentID: 'codex', model: { provider_id: 'codex', model_id: 'native-default' } })]);
  assert.deepEqual(validatePreviewPlan(next), next);
  for (const invalid of [item({ assignee: 'agent' }), item({ assignee: 'agent', agentID: '../opencode' }), item({ assignee: 'human', agentID: 'opencode' }), item({ assignee: 'human', model: { provider_id: 'synthetic', model_id: 'sample' } }), item({ assignee: 'chat', expected_result: '' }), { ...item(), apiKey: 'synthetic-unexpected-field' }]) {
    assert.throws(() => validatePreviewPlan(plan(2, [invalid])), { code: 'invalid-plan' });
  }
  assert.throws(() => validatePreviewPlan({ ...next, agentID: 'opencode' }), { code: 'invalid-plan' });
  assert.throws(() => validatePreviewPlan({ ...next, schema_version: 4 }), { code: 'invalid-plan' });
  assert.throws(() => validatePreviewPlan(plan(2, [null as unknown as PlanWorkItem])), { code: 'invalid-plan' });
  const chat = item({ kind: 'discussion', assignee: 'chat', model: { provider_id: 'synthetic', model_id: 'sample' } });
  assert.deepEqual(validatePreviewPlan(plan(1, [chat])).work_items, [chat]);
  assert.deepEqual(validatePreviewPlan(plan(2, [chat])).work_items, [chat]);
});

test('both plan formats retain unique IDs and dependency validation', () => {
  for (const schema of [1, 2] as const) {
    const first = item(), second = item({ dependencies: [first.id] });
    assert.equal(validatePreviewPlan(plan(schema, [first, second])).work_items.length, 2);
    assert.throws(() => validatePreviewPlan(plan(schema, [first, first])), { code: 'invalid-plan' });
    assert.throws(() => validatePreviewPlan(plan(schema, [item({ dependencies: [randomUUID()] })])), { code: 'invalid-plan' });
    assert.throws(() => validatePreviewPlan(plan(schema, [{ ...first, dependencies: [second.id] }, second])), { code: 'dependency-cycle' });
  }
});

test('mixed plan reads preserve v1 bytes and only an explicit save upgrades the same identity', async t => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const plans = new TaskOrchestrator(root);
  const legacy = await plans.createPlan('Legacy goal', [item()]);
  const empty = await plans.createPlan('Title only', [], undefined, { schemaVersion: 2 });
  const file = join(root, 'preview-plans', `${legacy.id}.json`), before = await readFile(file);
  const restarted = new TaskOrchestrator(root);
  assert.deepEqual((await restarted.listPlans()).map(record => record.schema_version).sort(), [1, 2]);
  assert.equal((await restarted.loadPlan(legacy.id))?.schema_version, 1);
  assert.deepEqual(await readFile(file), before);
  const upgraded = await restarted.savePlan({ ...legacy, schema_version: 2, work_items: [item({ assignee: 'agent', agentID: 'opencode', expected_result: '' })] }, legacy.version);
  assert.equal(upgraded.id, legacy.id); assert.equal(upgraded.created_at, legacy.created_at);
  assert.equal(upgraded.schema_version, 2); assert.equal(upgraded.version, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schema_version, 2);
  assert.equal((await new TaskOrchestrator(root).loadPlan(legacy.id))?.work_items[0]?.agentID, 'opencode');
  assert.deepEqual((await readdir(join(root, 'preview-plans'))).sort(), [`${legacy.id}.json`, `${empty.id}.json`].sort());
  await assert.rejects(restarted.savePlan({ ...upgraded, schema_version: 1, work_items: [item()] }, upgraded.version), { code: 'plan-schema-downgrade' });
  assert.equal((await restarted.loadPlan(legacy.id))?.schema_version, 2);
  assert.deepEqual(await readdir(root), ['preview-plans']);
});

test('saving v2 title-only steps and Agent choices does not create execution or model records', async t => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const plans = new TaskOrchestrator(root);
  const created = await plans.createPlan('Task title only', [], undefined, { schemaVersion: 2 });
  const child = item({ assignee: 'agent', agentID: 'codex', expected_result: '' });
  const saved = await plans.savePlan({ ...created, work_items: [child] }, created.version);
  assert.deepEqual(saved.work_items, [child]);
  assert.deepEqual((await new TaskOrchestrator(root).loadPlan(saved.id))?.work_items, [child]);
  assert.deepEqual(await readdir(root), ['preview-plans']);
  await assert.rejects(plans.createPlan('Unsupported version', [], undefined, { schemaVersion: 4 } as never), { code: 'invalid-plan' });
});

test('concurrent plan writers and stale upgrade requests cannot overwrite the winning version', async t => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const first = new TaskOrchestrator(root), second = new TaskOrchestrator(root);
  const created = await first.createPlan('Original', [item()]);
  await second.loadPlan(created.id);
  const writes = await Promise.allSettled([first.savePlan({ ...created, title: 'First choice', schema_version: 2 }, 1), second.savePlan({ ...created, title: 'Second choice', schema_version: 2 }, 1)]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(result => result.status === 'rejected').length, 1);
  const winner = await first.loadPlan(created.id); assert.equal(winner?.version, 2); assert.equal(winner?.schema_version, 2);
  await assert.rejects(second.savePlan({ ...created, title: 'Stale change', schema_version: 2 }, 1), { code: 'plan-conflict' });
  assert.deepEqual(await new TaskOrchestrator(root).loadPlan(created.id), winner);
});


test('v3 task content survives restart and stale local writers cannot overwrite it', async t => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new TaskOrchestrator(root);
  const base = await owner.createPlan('Task module', [], undefined, { schemaVersion: 3 });
  const task = { goal: 'Compare changes', completion_conditions: ['Checks pass'], materials: [{ id: randomUUID(), title: 'Chosen summary', summary: 'Explicit notes', source: { kind: 'note' as const, reference: '', label: 'User notes' } }], chat_refs: [{ source: 'agent' as const, sessionID: randomUUID() }] };
  const saved = await owner.savePlan({ ...base, task }, base.version);
  assert.deepEqual((await new TaskOrchestrator(root).loadPlan(base.id))?.task, task);
  const { task: _task, ...v2 } = saved;
  await assert.rejects(owner.savePlan({ ...v2, schema_version: 2 }, saved.version), { code: 'plan-schema-downgrade' });
  assert.throws(() => validatePreviewPlan({ ...saved, task: { ...task, materials: [task.materials[0]!, task.materials[0]!] } }), { code: 'invalid-task-content' });
  assert.throws(() => validatePreviewPlan({ ...saved, task: { ...task, unrecognized: true } }), { code: 'invalid-task-content' });
  const writes = await Promise.allSettled(['Page', 'Chat', 'Deck'].map(title => owner.savePlan({ ...saved, title }, saved.version)));
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(result => result.status === 'rejected').length, 2);
  assert.equal((await owner.loadPlan(base.id))?.version, 3);
  assert.deepEqual((await owner.loadPlan(base.id))?.task, task);
});
