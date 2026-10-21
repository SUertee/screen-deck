import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskOrchestrator } from '../../src/core/tasks/task-orchestrator.js';
import { TaskContextService } from '../../src/main/task-context-service.js';
import { RecordingStore } from '../../src/main/recording/recording-store.js';
import type { ConfirmTaskContextInput } from '../../src/shared/task-context.js';
import type { PreviewPlan } from '../../src/shared/types.js';
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-context-integration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const plans = new TaskOrchestrator(root), screens = new RecordingStore(root); await screens.initialize();
  const plan = await plans.createPlan('Context task', [], undefined, { schemaVersion: 3 });
  const frame = await screens.add({ appName: 'Synthetic editor', bundleID: 'test.editor', displayID: 1, width: 20, height: 20, text: 'OCR must not be copied by default' }, Buffer.from('synthetic image'));
  const port = { withContextSources: screens.withContextSources.bind(screens), resolveContextSource: (id: string) => { const f = screens.getFrame(id); if (!f) throw new Error('Missing source'); return { kind: 'screen-frame' as const, frameID: f.id, capturedAt: f.timestamp, appName: f.appName, bundleID: f.bundleID, displayID: f.displayID, width: f.width, height: f.height }; } };
  const events: PreviewPlan[] = [];
  const service = new TaskContextService(plans, port, plan => events.push(plan));
  const input: ConfirmTaskContextInput = { schemaVersion: 1, confirmationID: randomUUID(), draftID: randomUUID(), draftRevision: 2, target: { key: `local:${plan.id}`, baseVersion: plan.version }, summary: 'Reviewed summary', clues: [{ source: port.resolveContextSource(frame.id), note: 'User-selected note' }] };
  return { root, plans, screens, plan, frame, service, input, events, port };
}
test('context confirmation persists source/explicit extract once, deduplicates after restart and deletion', async t => {
  const f = await setup(t); f.input.clues[0].excerpt = { kind: 'user-reviewed', text: 'Explicit extract' };
  const results = await Promise.all([f.service.confirm(f.input), f.service.confirm(f.input)]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.events.length, 1);
  const saved = (await f.plans.loadPlan(f.plan.id))!;
  assert.equal(saved.version, 2); assert.equal(saved.task?.materials.length, 1);
  const material = saved.task!.materials[0]!;
  assert.equal(material.screen_clues?.[0].excerpt?.text, 'Explicit extract');
  assert.ok(!material.summary.includes('OCR must not be copied'));
  assert.equal(material.screen_clues?.[0].source.frameID, f.frame.id);
  await assert.rejects(f.plans.savePlan({ ...saved, task: { ...saved.task!, context_receipts: [] } }, saved.version), { code: 'protected-context-receipt' });
  await assert.rejects(f.plans.savePlan({ ...saved, task: { ...saved.task!, materials: [{ ...material, source: { ...material.source, reference: 'forged' } }] } }, saved.version), { code: 'protected-context-source' });
  await f.plans.savePlan({ ...saved, task: { ...saved.task!, materials: [] } }, saved.version);
  await f.screens.delete(f.frame.id);
  const restarted = new TaskContextService(new TaskOrchestrator(f.root), f.port, () => assert.fail('Replay cannot broadcast or save again'));
  assert.deepEqual(await restarted.confirm(f.input), results[0]);
  assert.equal((await f.plans.loadPlan(f.plan.id))?.task?.materials.length, 0);
  await assert.rejects(restarted.confirm({ ...f.input, summary: 'Different' }), { code: 'context-identity' });
});
test('stale task, forged source, oversized context and missing source never save partial materials', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.confirm({ ...f.input, target: { ...f.input.target, baseVersion: 99 } }), { code: 'plan-conflict' });
  await assert.rejects(f.service.confirm({ ...f.input, clues: [{ ...f.input.clues[0], source: { ...f.input.clues[0].source, appName: 'Forged' } }] }), { code: 'context-source' });
  await assert.rejects(f.service.confirm({ ...f.input, summary: '字'.repeat(12000) }), { code: 'context-limit' });
  await f.screens.delete(f.frame.id); await assert.rejects(f.service.confirm(f.input));
  assert.equal((await f.plans.loadPlan(f.plan.id))?.version, 1); assert.equal(f.events.length, 0);
});
test('receipt survives lost acknowledgment without another version or material', async t => {
  const f = await setup(t);
  const failingPublisher = new TaskContextService(f.plans, f.port, () => { throw new Error('Simulated lost update acknowledgment'); });
  const result = await failingPublisher.confirm(f.input);
  assert.equal(result.savedVersion, 2);
  assert.deepEqual(await f.service.confirm(f.input), result);
  assert.equal((await f.plans.loadPlan(f.plan.id))?.version, 2);
});
