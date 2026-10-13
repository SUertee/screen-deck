import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectWorkspaceReader, ProjectReadFailure } from '../../src/projects/index.js';
import type { ProjectHistory, ProjectIdentity, ProjectRun, ProjectTask } from '../../src/projects/types.js';

const PROJECT_ID = 'project-12345678-1234-1234-1234-123456789abc';
const TIME = '2026-10-10T20:00:00+08:00';
const identity: ProjectIdentity = { schema_version: 2, kind: 'project', project_id: PROJECT_ID, name: '临时测试项目', created_at: TIME };
const baseTask: ProjectTask = {
  schema_version: 1, kind: 'task', project_id: PROJECT_ID, task_id: 'task-001', title: '只读历史任务', goal: '不改变来源', status: 'running', plan_version: 1, assignee: 'human', created_at: TIME, updated_at: TIME, run_ids: ['run-20261010-001'], acceptance: [{ id: 'source-preserved', description: '原件保持完整', verification: 'not_checked', requires_human: true }], references: [],
};
const baseRun: ProjectRun = {
  schema_version: 1, kind: 'run', project_id: PROJECT_ID, task_id: 'task-001', run_id: 'run-20261010-001', plan_version: 1, status: 'running', started_at: null, ended_at: null, recorded_at: TIME, executor: { agent: 'unknown', model: null, effort: null, metadata_source: 'test fixture' }, skills: [], summary: '历史 running 不代表实时执行', references: [], git: { commit_status: 'none', commit_ids: [], push_status: 'not_pushed' },
};
async function writeJSON(file: string, value: unknown): Promise<void> { await writeFile(file, JSON.stringify(value)); }
async function fixture(t: TestContext, bound = true) {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'screendeck-reader-test-'));
  t.after(async () => { await rm(temp, { recursive: true, force: true }); });
  const root = path.join(temp, 'project');
  const privateRoot = path.join(temp, 'private');
  const namespace = path.join(privateRoot, 'projects', PROJECT_ID);
  await mkdir(path.join(root, '.screendeck'), { recursive: true });
  await writeJSON(path.join(root, '.screendeck', 'project.json'), identity);
  const history: ProjectHistory = {
    schema_version: 1, kind: 'project_history', project_id: PROJECT_ID, source_root: root, created_at: TIME,
    project: { schema_version: 1, kind: 'project', project_id: PROJECT_ID, name: identity.name, created_at: TIME, timezone: 'Asia/Shanghai', mode: 'manual_pilot', references: [] },
    migration: { backup_path: path.join(temp, 'unread-backup'), migrated_at: TIME },
  };
  const task = structuredClone(baseTask);
  const run = structuredClone(baseRun);
  if (bound) {
    for (const folder of ['tasks', 'runs', 'artifacts']) await mkdir(path.join(namespace, folder), { recursive: true });
    await writeJSON(path.join(namespace, 'history.json'), history);
    await writeJSON(path.join(namespace, 'tasks', `${task.task_id}.json`), task);
    await writeJSON(path.join(namespace, 'runs', `${run.run_id}.json`), run);
  }
  const reader = new ProjectWorkspaceReader({ privateRoot });
  return { temp, root, privateRoot, namespace, history, task, run, reader, identityFile: path.join(root, '.screendeck', 'project.json'), taskFile: path.join(namespace, 'tasks', `${task.task_id}.json`), runFile: path.join(namespace, 'runs', `${run.run_id}.json`), historyFile: path.join(namespace, 'history.json') };
}

test('loads strict bound v2 identity and v1 history with explicit historical DTOs', async t => {
  const f = await fixture(t);
  const before = await readFile(f.taskFile);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'ready');
  assert.equal(result.project?.history_bound, true);
  assert.equal(result.project?.readonly, true);
  assert.equal(result.tasks[0].status, 'running');
  assert.equal(result.runs[0].historical, true);
  assert.equal(result.runs[0].is_live, false);
  assert.equal(result.runs[0].executor.model, null);
  assert.deepEqual(await readFile(f.taskFile), before);
  assert.deepEqual((await readdir(f.root)).sort(), ['.screendeck']);
  assert.equal(f.reader.list().length, 1);
});

test('valid identity without private root is empty with diagnostic and creates no source', async t => {
  const f = await fixture(t, false);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'empty');
  assert.equal(result.project?.history_bound, false);
  assert.equal(result.diagnostics[0].code, 'no_bound_history');
  assert.deepEqual(await readdir(f.temp), ['project']);
});

test('bound history with no records reports a readable empty diagnostic', async t => {
  const f = await fixture(t);
  await rm(f.taskFile);
  await rm(f.runFile);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'empty');
  assert.equal(result.project?.history_bound, true);
  assert.equal(result.diagnostics[0].code, 'no_records');
});

test('missing identity is an error rather than an initialized project', async t => {
  const f = await fixture(t, false);
  await rm(f.identityFile);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'error');
  assert.equal(result.project, null);
  assert.deepEqual(await readdir(path.dirname(f.identityFile)), []);
});

test('strict identity rejects extra fields and legacy v1 identity', async t => {
  for (const value of [{ ...identity, timezone: 'Asia/Shanghai' }, { ...identity, schema_version: 1 }]) {
    const f = await fixture(t, false);
    await writeJSON(f.identityFile, value);
    const result = await f.reader.read(f.root);
    assert.equal(result.status, 'error');
    assert.equal(result.diagnostics[0].code, 'schema_invalid');
    assert.equal(f.reader.list().length, 0);
  }
});

test('history for same ID at another exact root is rejected', async t => {
  const f = await fixture(t);
  f.history.source_root = path.join(f.temp, 'other');
  await writeJSON(f.historyFile, f.history);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostics[0].code, 'root_binding_mismatch');
});

test('manifest identity mismatch and unexpected fields are rejected', async t => {
  const f = await fixture(t);
  await writeJSON(f.historyFile, { ...f.history, project: { ...f.history.project, created_at: '2026-10-09T20:00:00+08:00' } });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'identity_mismatch');
  await writeJSON(f.historyFile, { ...f.history, unexpected: true });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'schema_invalid');
});

test('unbound private records never become an empty imported library', async t => {
  const f = await fixture(t);
  await rm(f.historyFile);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostics[0].code, 'unbound_history');
  assert.deepEqual(await readFile(f.taskFile, 'utf8'), JSON.stringify(f.task));
});

test('unmigrated project-local history is rejected without fallback', async t => {
  const f = await fixture(t, false);
  await mkdir(path.join(f.root, '.screendeck', 'tasks'));
  await writeJSON(path.join(f.root, '.screendeck', 'tasks', 'task-001.json'), f.task);
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'unmigrated_history');
});

test('one malformed record rejects the complete snapshot', async t => {
  const f = await fixture(t);
  await writeFile(f.runFile, '{');
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.runs, []);
  assert.equal(result.diagnostics[0].code, 'invalid_json');
});

test('failed refresh retains previous snapshot as stale and blocks preview', async t => {
  const f = await fixture(t);
  await f.reader.read(f.root);
  await writeJSON(f.taskFile, { ...f.task, status: 'not-a-status' });
  const result = await f.reader.refresh(PROJECT_ID);
  assert.equal(result.status, 'stale');
  assert.equal(result.tasks[0].status, 'running');
  assert.equal(result.diagnostics[0].code, 'schema_invalid');
  await assert.rejects(f.reader.preview(PROJECT_ID, 'anything'), error => error instanceof ProjectReadFailure && error.code === 'stale_or_unregistered');
});

test('disappeared source keeps only the prior stale memory snapshot', async t => {
  const f = await fixture(t);
  await f.reader.read(f.root);
  await rename(f.root, path.join(f.temp, 'moved-project'));
  const result = await f.reader.refresh(PROJECT_ID);
  assert.equal(result.status, 'stale');
  assert.equal(result.tasks[0].task_id, 'task-001');
  assert.equal(result.diagnostics[0].code, 'missing_source');
  const restarted = new ProjectWorkspaceReader({ privateRoot: f.privateRoot });
  assert.equal((await restarted.read(f.root)).status, 'error');
  assert.deepEqual(restarted.list(), []);
});

test('changing identity at registered root retains old stale snapshot', async t => {
  const f = await fixture(t, false);
  await f.reader.read(f.root);
  await writeJSON(f.identityFile, { ...identity, project_id: 'project-99999999-1234-1234-1234-123456789abc' });
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'stale');
  assert.equal(result.project?.project_id, PROJECT_ID);
  assert.equal(result.diagnostics[0].code, 'identity_changed');
});

test('a duplicate identity at a second root does not register a second project', async t => {
  const f = await fixture(t, false);
  await f.reader.read(f.root);
  const other = path.join(f.temp, 'other');
  await mkdir(path.join(other, '.screendeck'), { recursive: true });
  await writeJSON(path.join(other, '.screendeck', 'project.json'), identity);
  const result = await f.reader.read(other);
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostics[0].code, 'duplicate_project_id');
  assert.equal(f.reader.list().length, 1);
});

test('returned DTO changes do not mutate trusted registry', async t => {
  const f = await fixture(t);
  const result = await f.reader.read(f.root);
  result.tasks[0].title = 'renderer mutation';
  result.project!.name = 'renderer mutation';
  assert.equal(f.reader.get(PROJECT_ID)?.tasks[0].title, f.task.title);
  assert.equal(f.reader.get(PROJECT_ID)?.project?.name, identity.name);
});

test('rejects duplicate task IDs before any publication', async t => {
  const f = await fixture(t);
  await writeJSON(path.join(f.namespace, 'tasks', 'task-002.json'), f.task);
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostics[0].code, 'duplicate_task_id');
});

test('rejects duplicate run IDs before any publication', async t => {
  const f = await fixture(t);
  await writeJSON(path.join(f.namespace, 'runs', 'run-20261010-002.json'), f.run);
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'duplicate_run_id');
});

test('task/run reference links must be present and bidirectional', async t => {
  const f = await fixture(t);
  await writeJSON(f.taskFile, { ...f.task, run_ids: ['run-20261010-002'] });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'broken_run_link');
  await writeJSON(f.taskFile, { ...f.task, run_ids: [] });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'broken_task_link');
});

test('strict task/run schema rejects unknown properties, invalid dates, and null omissions', async t => {
  const f = await fixture(t);
  for (const value of [{ ...f.task, extra: true }, { ...f.task, created_at: '2026-02-30T10:00:00Z' }, { ...f.task, schema_version: 2 }, { ...f.task, run_ids: ['run-20261010-001', 'run-20261010-001'] }, { ...f.task, plan_version: 1.5 }]) {
    await writeJSON(f.taskFile, value);
    assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'schema_invalid');
  }
  await writeJSON(f.taskFile, f.task);
  const { started_at: _ignored, ...omitted } = f.run;
  for (const value of [{ ...f.run, executor: { ...f.run.executor, model: '' } }, { ...f.run, ended_at: '2026-10-10T20:00:00' }, omitted]) {
    await writeJSON(f.runFile, value);
    assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'schema_invalid');
  }
});

test('business consistency checks reject completed without acceptance and false git facts', async t => {
  const f = await fixture(t);
  await writeJSON(f.taskFile, { ...f.task, status: 'completed' });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'invalid_completed_task');
  await writeJSON(f.taskFile, f.task);
  await writeJSON(f.runFile, { ...f.run, git: { commit_status: 'none', commit_ids: [], push_status: 'pushed' } });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'invalid_git_state');
});

test('relative traversal, arbitrary file URLs, encoded paths, and cross-project URIs are rejected', async t => {
  const f = await fixture(t);
  for (const ref of ['../outside.txt', 'file:///etc/hosts', '/etc/hosts', 'artifacts/%2e%2e/file.txt', `screendeck://project-99999999-1234-1234-1234-123456789abc/artifacts/a.txt`]) {
    await writeJSON(f.taskFile, { ...f.task, references: [{ path: ref, label: 'unsafe' }] });
    const result = await f.reader.read(f.root);
    assert.equal(result.status, 'error');
    assert.ok(['unsafe_reference', 'foreign_reference'].includes(result.diagnostics[0].code));
  }
});

test('missing declared reference rejects snapshot instead of partial artifact listing', async t => {
  const f = await fixture(t);
  await writeJSON(f.taskFile, { ...f.task, references: [{ path: 'missing.md', label: 'missing' }] });
  assert.equal((await f.reader.read(f.root)).status, 'error');
  assert.equal(f.reader.list().length, 0);
});

test('symlinked project root, identity directory, private root, and reference leaf are rejected', async t => {
  const f = await fixture(t);
  const alias = path.join(f.temp, 'project-alias');
  await symlink(f.root, alias);
  assert.equal((await f.reader.read(alias)).diagnostics[0].code, 'unsafe_path');
  await rename(path.join(f.root, '.screendeck'), path.join(f.root, 'identity-real'));
  await symlink(path.join(f.root, 'identity-real'), path.join(f.root, '.screendeck'));
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'unsafe_path');
  await rm(path.join(f.root, '.screendeck'));
  await rename(path.join(f.root, 'identity-real'), path.join(f.root, '.screendeck'));
  const privateAlias = path.join(f.temp, 'private-alias');
  await symlink(f.privateRoot, privateAlias);
  assert.equal((await new ProjectWorkspaceReader({ privateRoot: privateAlias }).read(f.root)).diagnostics[0].code, 'unsafe_path');
  await writeFile(path.join(f.temp, 'outside.md'), 'outside');
  await symlink(path.join(f.temp, 'outside.md'), path.join(f.root, 'inside.md'));
  await writeJSON(f.taskFile, { ...f.task, references: [{ path: 'inside.md', label: 'symlink' }] });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'unsafe_path');
});

test('symbolic link in artifact ancestor cannot escape private namespace', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.temp, 'outside'));
  await writeFile(path.join(f.temp, 'outside', 'doc.md'), 'outside');
  await symlink(path.join(f.temp, 'outside'), path.join(f.namespace, 'artifacts', 'linked'));
  await writeJSON(f.taskFile, { ...f.task, references: [{ path: `screendeck://${PROJECT_ID}/artifacts/linked/doc.md`, label: 'unsafe' }] });
  assert.equal((await f.reader.read(f.root)).diagnostics[0].code, 'unsafe_path');
});

test('record file, record count, and total byte limits reject whole snapshot', async t => {
  const f = await fixture(t);
  assert.equal((await new ProjectWorkspaceReader({ privateRoot: f.privateRoot, limits: { jsonBytes: 32 } }).read(f.root)).diagnostics[0].code, 'file_size_limit');
  await writeJSON(path.join(f.namespace, 'tasks', 'task-002.json'), { ...f.task, task_id: 'task-002', run_ids: [] });
  assert.equal((await new ProjectWorkspaceReader({ privateRoot: f.privateRoot, limits: { tasks: 1 } }).read(f.root)).diagnostics[0].code, 'entry_limit');
  assert.equal((await new ProjectWorkspaceReader({ privateRoot: f.privateRoot, limits: { totalBytes: 200 } }).read(f.root)).diagnostics[0].code, 'total_size_limit');
});

test('known project and private artifact previews return bounded data, no file URLs', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'docs'));
  await writeFile(path.join(f.root, 'docs', 'result.md'), '# 安全正文');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(path.join(f.namespace, 'artifacts', 'result.png'), png);
  await writeJSON(f.taskFile, { ...f.task, references: [{ path: 'docs/result.md', label: '报告' }, { path: `screendeck://${PROJECT_ID}/artifacts/result.png`, label: '图片' }] });
  const result = await f.reader.read(f.root);
  assert.equal(result.artifact_refs.length, 2);
  const text = await f.reader.preview(PROJECT_ID, result.artifact_refs[0].reference_id);
  assert.equal(text.type, 'text');
  if (text.type === 'text') assert.equal(text.text, '# 安全正文');
  const image = await f.reader.preview(PROJECT_ID, result.artifact_refs[1].reference_id);
  assert.equal(image.type, 'image');
  if (image.type === 'image') assert.deepEqual(Buffer.from(image.base64, 'base64'), png);
  await assert.rejects(f.reader.preview(PROJECT_ID, 'docs/result.md'), error => error instanceof ProjectReadFailure && error.code === 'undeclared_reference');
});

test('binding changes, replaced symlinks, and oversized previews never return content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'report.md'), 'initial');
  await writeJSON(f.taskFile, { ...f.task, references: [{ path: 'report.md', label: '报告' }] });
  const result = await f.reader.read(f.root);
  await writeJSON(f.historyFile, { ...f.history, source_root: path.join(f.temp, 'other') });
  await assert.rejects(f.reader.preview(PROJECT_ID, result.artifact_refs[0].reference_id), error => error instanceof ProjectReadFailure && error.code === 'binding_changed');
  assert.equal(f.reader.get(PROJECT_ID)?.status, 'stale');
  await writeJSON(f.historyFile, f.history);
  await f.reader.refresh(PROJECT_ID);
  await rm(path.join(f.root, 'report.md'));
  await symlink('/etc/hosts', path.join(f.root, 'report.md'));
  await assert.rejects(f.reader.preview(PROJECT_ID, result.artifact_refs[0].reference_id), error => error instanceof ProjectReadFailure && error.code === 'unsafe_path');
  await rm(path.join(f.root, 'report.md'));
  await writeFile(path.join(f.root, 'report.md'), 'more than four bytes');
  const bounded = new ProjectWorkspaceReader({ privateRoot: f.privateRoot, limits: { textPreviewBytes: 4 } });
  const boundedResult = await bounded.read(f.root);
  await assert.rejects(bounded.preview(PROJECT_ID, boundedResult.artifact_refs[0].reference_id), error => error instanceof ProjectReadFailure && error.code === 'file_size_limit');
});

test('credential files, SVG/HTML, and private task JSON are not previewable', async t => {
  const f = await fixture(t);
  const names = ['credentials.json', 'api-key.json', 'auth.json', '.env.txt', 'index.html', 'image.svg'];
  for (const name of names) await writeFile(path.join(f.root, name), 'do not preview');
  await writeJSON(f.taskFile, { ...f.task, references: [...names.map(name => ({ path: name, label: name })), { path: `screendeck://${PROJECT_ID}/tasks/task-001.json`, label: 'task reference' }] });
  const result = await f.reader.read(f.root);
  assert.equal(result.status, 'ready');
  for (const ref of result.artifact_refs) {
    assert.equal(ref.preview_type, 'unsupported');
    await assert.rejects(f.reader.preview(PROJECT_ID, ref.reference_id), error => error instanceof ProjectReadFailure && error.code === 'unsupported_preview');
  }
});

test('invalid UTF-8 and misleading image signatures are rejected', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'binary.txt'), Buffer.from([255, 0]));
  await writeFile(path.join(f.root, 'fake.png'), '<svg></svg>');
  await writeJSON(f.taskFile, { ...f.task, references: [{ path: 'binary.txt', label: 'binary' }, { path: 'fake.png', label: 'fake' }] });
  const result = await f.reader.read(f.root);
  await assert.rejects(f.reader.preview(PROJECT_ID, result.artifact_refs[0].reference_id), error => error instanceof ProjectReadFailure && error.code === 'invalid_text');
  await f.reader.refresh(PROJECT_ID);
  await assert.rejects(f.reader.preview(PROJECT_ID, result.artifact_refs[1].reference_id), error => error instanceof ProjectReadFailure && error.code === 'invalid_image');
});

test('rejects global roots, non-canonical paths, and remote URL inputs', async t => {
  const f = await fixture(t);
  for (const value of ['/', `${f.root}/../project`, 'file:///tmp/project', 'https://example.invalid', `${f.root}\0`]) {
    const result = await f.reader.read(value);
    assert.equal(result.status, 'error');
    assert.equal(result.diagnostics[0].code, 'invalid_root');
  }
});
