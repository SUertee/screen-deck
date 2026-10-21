import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectWorkspaceReader } from '../../src/projects/index.js';
import { ProjectRegistry } from '../../src/main/project-registry.js';
import { LocalState } from '../../src/main/local-state.js';
import { installDesktopRoutes } from '../../src/main/desktop-routes.js';
import type { SessionManager, TaskOrchestrator } from '../../src/core/index.js';
import type { ElectronHost } from '../../src/main/electron-host.js';
import type { ProviderSettingsStore } from '../../src/main/provider-settings.js';
import type { BootstrapResult, DesktopEvent } from '../../src/shared/desktop-api.js';

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const idOf = (root: string) => createHash('sha256').update(root).digest('hex');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-project-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = new LocalState(join(root, 'local'));
  const projects = new ProjectWorkspaceReader({ privateRoot: join(root, 'private') });
  const registry = new ProjectRegistry(local, projects);
  const file = join(root, 'local', idOf('project-roots') + '.json');
  const makeProject = async (name: string) => {
    const source = join(root, name);
    await mkdir(join(source, '.screendeck'), { recursive: true });
    const identity = { schema_version: 2, kind: 'project', project_id: `project-${randomUUID()}`, name, created_at: '2026-10-19T00:00:00.000Z' };
    await writeFile(join(source, '.screendeck', 'project.json'), JSON.stringify(identity));
    return { source, identity };
  };
  return { root, local, projects, registry, file, makeProject };
}

test('restored missing roots remain registered when another project is selected; only a repaired source clears', async t => {
  const h = await fixture(t);
  const one = join(h.root, 'missing-one'), two = join(h.root, 'missing-two');
  await h.local.write('project-roots', [one, two]);
  const original = await readFile(h.file);
  await h.registry.initialize();
  assert.deepEqual(await readFile(h.file), original, 'Restoration never rewrites the registry.');
  assert.deepEqual(h.projects.list(), []);
  assert.deepEqual(h.registry.diagnostics(), [one, two].map(root => ({ sourceID: idOf(root), label: root === one ? 'missing-one' : 'missing-two', code: 'missing_source', message: '项目记录暂时无法读取，请重新选择项目。' })));
  assert.equal(JSON.stringify(h.registry.diagnostics()).includes(h.root), false);
  const selected = await h.makeProject('selected');
  const identityBefore = await readFile(join(selected.source, '.screendeck', 'project.json'));
  await h.registry.choose(selected.source);
  assert.deepEqual(await h.local.read('project-roots', []), [one, two, selected.source]);
  assert.equal(h.registry.diagnostics().length, 2);
  await h.makeProject('missing-one');
  await h.registry.choose(one);
  assert.deepEqual(h.registry.diagnostics().map(issue => issue.sourceID), [idOf(two)]);
  await h.registry.initialize();
  assert.deepEqual(h.registry.diagnostics().map(issue => issue.sourceID), [idOf(two)], 'Repeated bootstrap initialization cannot resurrect a resolved startup warning.');
  assert.deepEqual(await readFile(join(selected.source, '.screendeck', 'project.json')), identityBefore);
});

test('failed explicit selection is diagnostic-only and concurrent successful selections merge the original array', async t => {
  const h = await fixture(t), missing = join(h.root, 'not-a-project');
  await h.local.write('project-roots', []);
  const failure = await h.registry.choose(missing);
  assert.equal(failure.project, null);
  assert.deepEqual(await h.local.read('project-roots', []), []);
  assert.deepEqual(h.projects.list(), []);
  assert.equal(h.registry.diagnostics()[0]!.sourceID, idOf(missing));
  const one = await h.makeProject('one'), two = await h.makeProject('two');
  await Promise.all([h.registry.choose(one.source), h.registry.choose(two.source)]);
  assert.deepEqual(await h.local.read('project-roots', []), [one.source, two.source]);
  assert.equal(h.registry.diagnostics()[0]!.sourceID, idOf(missing));
  await h.makeProject('not-a-project'); await h.registry.choose(missing);
  assert.deepEqual(h.registry.diagnostics(), []);
});

test('malformed registry stays byte-for-byte intact while explicit project reads remain usable', async t => {
  for (const malformed of ['{broken', JSON.stringify({ roots: [] }), JSON.stringify(['relative/project'])]) {
    const h = await fixture(t);
    await h.local.write('project-roots', []); await writeFile(h.file, malformed);
    await h.registry.initialize();
    assert.equal(h.registry.diagnostics()[0]!.code, 'project_registry_unreadable');
    const project = await h.makeProject('still-readable');
    assert.ok((await h.registry.choose(project.source)).project);
    assert.equal(await readFile(h.file, 'utf8'), malformed);
    assert.equal(h.registry.diagnostics()[0]!.sourceID, 'project-registry');
  }
});

test('registry write conflict preserves external bytes and retries merge only through a fresh observation', async t => {
  const h = await fixture(t);
  await h.local.write('project-roots', []); await h.registry.initialize();
  const project = await h.makeProject('selected');
  const externalRoot = join(h.root, 'externally-registered-missing');
  const write = h.local.write.bind(h.local), external = JSON.stringify([externalRoot]);
  h.local.write = async (name, value) => { await writeFile(h.file, external); return write(name, value); };
  const selected = await h.registry.choose(project.source);
  assert.ok(selected.project);
  assert.equal(await readFile(h.file, 'utf8'), external);
  assert.equal(h.registry.diagnostics()[0]!.code, 'project_registry_write_failed');
  h.local.write = write;
  await h.registry.choose(project.source);
  assert.deepEqual(await h.local.read('project-roots', []), [externalRoot, project.source]);
  assert.deepEqual(h.registry.diagnostics(), []);
});

test('known failed refresh stays in the original stale snapshot, without duplicating a source warning', async t => {
  const h = await fixture(t), project = await h.makeProject('known');
  const selected = await h.registry.choose(project.source);
  const identity = join(project.source, '.screendeck', 'project.json');
  await rename(identity, identity + '.held');
  const stale = await h.registry.refresh(selected.project!.project_id);
  assert.equal(stale.status, 'stale'); assert.ok(stale.project);
  assert.equal(stale.diagnostics[0]!.code, 'missing_source');
  assert.deepEqual(h.registry.diagnostics(), []);
  await rename(identity + '.held', identity);
  assert.equal((await h.registry.refresh(selected.project!.project_id)).status, 'empty');
  assert.deepEqual(h.registry.diagnostics(), []);
});

async function routes(t: TestContext) {
  const h = await fixture(t), missing = join(h.root, 'missing-startup');
  await h.local.write('project-roots', [missing]); await h.registry.initialize();
  const handlers = new Map<string, (input: unknown) => unknown>(), events: DesktopEvent[] = [];
  let selected: string | null = null;
  let planRead = async () => [];
  const host = { handle: (name: string, action: (input: unknown) => unknown) => handlers.set(name, action), broadcast: (event: DesktopEvent) => events.push(event), chooseProject: async () => selected } as unknown as ElectronHost;
  const manager = { listSessions: async () => ({ records: [], diagnostics: [{ filename: 'fixture.json', reason: 'history fixture warning' }] }) } as unknown as SessionManager;
  const settings = { publicSettings: () => ({ baseURL: 'https://example.invalid/v1', modelID: 'fixture', hasKey: false, credentialStorage: 'none' }), diagnostics: ['provider fixture warning'] } as unknown as ProviderSettingsStore;
  const plans = { listPlans: () => planRead() } as unknown as TaskOrchestrator;
  installDesktopRoutes({ settings, manager, host, projects: h.projects, projectRegistry: h.registry, plans, local: h.local, diagnostics: ['other fixture warning'], previewRoot: h.root, withSettingsSnapshot: (_snapshot, action) => action() });
  const invoke = async <T>(name: string, input?: unknown): Promise<T> => handlers.get(name)!(input) as Promise<T>;
  return { ...h, missing, events, invoke, select: (root: string | null) => { selected = root; }, pausePlans: (read: typeof planRead) => { planRead = read; } };
}

test('bootstrap separates typed project diagnostics and retains unrelated provider/history warnings', async t => {
  const h = await routes(t);
  const data = await h.invoke<BootstrapResult>('bootstrap');
  assert.deepEqual(data.diagnostics, ['other fixture warning', 'provider fixture warning', 'history fixture warning']);
  assert.equal(data.projectDiagnostics?.[0]!.code, 'missing_source');
  assert.equal(data.projectDiagnostics?.[0]!.label, 'missing-startup');
  const before = await readFile(h.file);
  assert.equal(await h.invoke('choose-project'), null);
  assert.equal(h.events.length, 0); assert.deepEqual(await readFile(h.file), before);
  const missing = join(h.root, 'failed-selection'); h.select(missing);
  const failure = await h.invoke<{ project: unknown }>('choose-project');
  assert.equal(failure.project, null);
  assert.equal(h.events.at(-1)!.type, 'project-diagnostics-updated');
  assert.equal((h.events.at(-1) as Extract<DesktopEvent, { type: 'project-diagnostics-updated' }>).diagnostics.length, 2);
  assert.deepEqual(await readFile(h.file), before);
});

test('a suspended bootstrap projects the latest registry after a successful chooser event', async t => {
  const h = await routes(t), entered = gate(), release = gate();
  h.pausePlans(async () => { entered.release(); await release.promise; return []; });
  const bootstrapping = h.invoke<BootstrapResult>('bootstrap');
  await entered.promise;
  await h.makeProject('missing-startup'); h.select(h.missing);
  const selected = await h.invoke<{ project: { project_id: string } }>('choose-project');
  const event = h.events.at(-1) as Extract<DesktopEvent, { type: 'project-diagnostics-updated' }>;
  assert.deepEqual(event.diagnostics, []);
  release.release();
  const bootstrap = await bootstrapping;
  assert.deepEqual(bootstrap.projectDiagnostics, []);
  assert.equal(bootstrap.projects[0]!.project!.project_id, selected.project.project_id);
});
