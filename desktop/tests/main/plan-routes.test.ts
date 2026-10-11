import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskOrchestrator, type SessionManager } from '../../src/core/index.js';
import type { PreviewPlan, PreviewPlanScope } from '../../src/shared/types.js';
import type { ProjectWorkspaceReader } from '../../src/projects/index.js';
import type { ProjectWorkspaceResult } from '../../src/projects/types.js';
import { installDesktopRoutes } from '../../src/main/desktop-routes.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { ProviderSettingsStore } from '../../src/main/provider-settings.js';
import type { LocalState } from '../../src/main/local-state.js';

const scope: PreviewPlanScope = { project_id: 'project-abcdef00-0000-0000-0000-000000000000', task_id: 'task-001' };
const fixture = (): ProjectWorkspaceResult => ({
  status: 'ready', project: { schema_version: 2, kind: 'project', project_id: scope.project_id, name: 'Fixture project', created_at: '2026-10-10T08:00:00.000Z', root_path: '/temporary/fixture-project', history_bound: true, readonly: true },
  tasks: [{ schema_version: 1, kind: 'task', project_id: scope.project_id, task_id: scope.task_id, title: 'Fixture task', goal: 'Review a goal', status: 'draft', plan_version: 1, assignee: 'human', created_at: '2026-10-10T08:00:00.000Z', updated_at: '2026-10-10T08:00:00.000Z', run_ids: [], acceptance: [], references: [], historical: true, is_live: false }],
  runs: [], artifact_refs: [], diagnostics: [], loaded_at: '2026-10-10T08:00:00.000Z', historical: true,
});
async function harness() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-plan-routes-test-'));
  const handlers = new Map<string, (input: unknown) => unknown>(); const registered = new Map<string, ProjectWorkspaceResult>();
  const host = { handle: (channel: string, handler: (input: unknown) => unknown) => handlers.set(channel, handler) } as unknown as ElectronHost;
  const projects = { get: (id: string) => registered.get(id) } as unknown as ProjectWorkspaceReader;
  const plans = new TaskOrchestrator(root);
  installDesktopRoutes({ host, projects, plans, settings: {} as ProviderSettingsStore, manager: {} as SessionManager, local: {} as LocalState, diagnostics: [], previewRoot: root, withSettingsSnapshot: (_snapshot, operation) => operation() });
  const invoke = async (channel: string, input: unknown): Promise<unknown> => handlers.get(channel)!(input);
  return { registered, plans, invoke };
}

test('create-plan IPC accepts an explicit object and persists only a registered current task scope', async () => {
  const { registered, plans, invoke } = await harness(); registered.set(scope.project_id, fixture());
  const scoped = await invoke('create-plan', { title: 'Task-specific discussion', scope }) as PreviewPlan; assert.deepEqual(scoped.scope, scope);
  const independent = await invoke('create-plan', { title: 'Independent plan' }) as PreviewPlan; assert.equal(Object.hasOwn(independent, 'scope'), false);
  await assert.rejects(invoke('create-plan', 'Old string payload'), /参数无效/);
  await assert.rejects(invoke('create-plan', { title: 'Unexpected data', scope, destination: '/outside' }), /参数无效/);
  assert.equal((await plans.listPlans()).length, 2);
});

test('create-plan IPC rejects unregistered, missing, malformed, stale and error task associations before writing', async () => {
  const { registered, plans, invoke } = await harness();
  await assert.rejects(invoke('create-plan', { title: 'Unknown project', scope }), /尚未明确关联/);
  const current = fixture(); registered.set(scope.project_id, current);
  await assert.rejects(invoke('create-plan', { title: 'Missing task', scope: { ...scope, task_id: 'task-002' } }), /未确认|失效/);
  await assert.rejects(invoke('create-plan', { title: 'Bad scope', scope: { ...scope, task_id: 'not-a-task' } }), /标识/);
  await assert.rejects(invoke('create-plan', { title: 'Null scope', scope: null }), /关联无效/);
  for (const status of ['stale', 'error'] as const) { current.status = status; await assert.rejects(invoke('create-plan', { title: 'Stale task', scope }), /失效/); }
  assert.equal((await plans.listPlans()).length, 0);
});

test('scoped plan edits and recommendations reject a stale source, and save never retargets its task', async () => {
  const { registered, plans, invoke } = await harness(); const current = fixture(); registered.set(scope.project_id, current);
  const created = await invoke('create-plan', { title: 'Scoped plan', scope }) as PreviewPlan;
  current.status = 'stale';
  await assert.rejects(invoke('save-plan', { plan: { ...created, title: 'Edited with stale source' }, expectedVersion: created.version }), /失效/);
  await assert.rejects(invoke('recommendations', created.id), /失效/);
  assert.equal((await plans.loadPlan(created.id))?.version, 1);
  current.status = 'ready'; current.tasks.push({ ...current.tasks[0]!, task_id: 'task-002' });
  await assert.rejects(invoke('save-plan', { plan: { ...created, scope: { ...scope, task_id: 'task-002' } }, expectedVersion: created.version }), /关联不可/);
  const saved = await invoke('save-plan', { plan: { ...created, title: 'Same task, refined goal' }, expectedVersion: created.version }) as PreviewPlan;
  assert.equal(saved.version, 2); assert.deepEqual(saved.scope, scope);
});
