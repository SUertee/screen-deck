import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskOrchestrator } from '../../src/core/task-orchestrator.js';
import type { PreviewPlanScope } from '../../src/shared/types.js';

const scope: PreviewPlanScope = { project_id: 'project-abcdef00-0000-0000-0000-000000000000', task_id: 'task-001' };
async function temp(): Promise<string> { return mkdtemp(join(await realpath(tmpdir()), 'screendeck-plan-scope-test-')); }

test('preview plans persist a stable project/task association across restart without writing source task/run records', async () => {
  const root = await temp(); const plans = new TaskOrchestrator(root); const created = await plans.createPlan('Scoped plan', [], scope);
  assert.deepEqual(created.scope, scope);
  const updated = await plans.savePlan({ ...created, title: 'Refined goal' }, created.version);
  assert.equal(updated.version, 2); assert.deepEqual(updated.scope, scope);
  const restarted = new TaskOrchestrator(root); assert.deepEqual((await restarted.loadPlan(created.id))?.scope, scope);
  const wire = JSON.parse(await readFile(join(root, 'preview-plans', `${created.id}.json`), 'utf8'));
  assert.equal(wire.kind, 'electron_preview_plan'); assert.deepEqual(wire.scope, scope); assert.equal(wire.task_id, undefined); assert.equal(wire.run_id, undefined);
});

test('a saved plan cannot be reattached, detached, or attached after independent creation', async () => {
  const root = await temp(); const plans = new TaskOrchestrator(root); const created = await plans.createPlan('Scoped', [], scope);
  for (const change of [undefined, { ...scope, task_id: 'task-002' }, { ...scope, project_id: `project-${randomUUID()}` }]) {
    const altered = { ...created }; if (change) altered.scope = change; else delete altered.scope;
    await assert.rejects(plans.savePlan(altered, created.version), /关联不可/);
  }
  assert.equal((await plans.loadPlan(created.id))?.version, 1); assert.deepEqual((await plans.loadPlan(created.id))?.scope, scope);
  const independent = await plans.createPlan('Independent'); assert.equal(Object.hasOwn(independent, 'scope'), false);
  await assert.rejects(plans.savePlan({ ...independent, scope }, independent.version), /保持独立/);
  const saved = await plans.savePlan({ ...independent, title: 'Still independent' }, independent.version); assert.equal(Object.hasOwn(saved, 'scope'), false);
  assert.equal((await new TaskOrchestrator(root).loadPlan(saved.id))?.scope, undefined);
});

test('preview scope accepts existing numeric task IDs and rejects malformed or extra fields', async () => {
  const plans = new TaskOrchestrator(await temp());
  const valid = await plans.createPlan('Long numeric task ID', [], { ...scope, task_id: 'task-12345' }); assert.equal(valid.scope?.task_id, 'task-12345');
  for (const invalid of [null, {}, { project_id: scope.project_id }, { ...scope, task_id: 'task-1' }, { ...scope, task_id: randomUUID() }, { ...scope, project_id: 'different-project' }, { ...scope, directory: '/arbitrary/path' }]) {
    await assert.rejects(plans.createPlan('Invalid association', [], invalid as PreviewPlanScope), /关联|标识/);
  }
  assert.equal((await plans.listPlans()).length, 1);
});
