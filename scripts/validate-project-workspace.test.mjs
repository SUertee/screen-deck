import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { validateWorkspace } from './validate-project-workspace.mjs';

const runProcess = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Use the shipped contract, rather than a second field-definition copy in tests.
const schema = JSON.parse(await readFile(path.join(repo, 'Resources/Schemas/record.schema.json'), 'utf8'));
const projectId = 'project-12345678-1234-1234-1234-123456789abc';
const timestamp = '2026-10-06T10:00:00+08:00';
const taskFile = '.screendeck/tasks/task-001.json';
const runFile = '.screendeck/runs/run-20261006-001.json';

async function put(root, relative, data) {
  await writeFile(path.join(root, relative), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'screendeck-validator-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['tasks', 'runs']) await mkdir(path.join(root, '.screendeck', directory), { recursive: true });
  await put(root, 'README.md', 'Business content is not evaluated or interpreted.');
  const project = {
    schema_version: 1, kind: 'project', project_id: projectId, name: 'Test project',
    created_at: timestamp, timezone: 'Asia/Shanghai', mode: 'manual_pilot',
    references: [{ path: 'README.md', label: 'Project readme' }],
  };
  const task = {
    schema_version: 1, kind: 'task', project_id: projectId, task_id: 'task-001',
    title: 'Validate workspace', goal: 'Create a read-only validator', status: 'awaiting_review',
    plan_version: 2, assignee: 'shared', created_at: timestamp, updated_at: timestamp,
    run_ids: ['run-20261006-001'],
    acceptance: [{ id: 'review', description: 'Human review', verification: 'not_checked', requires_human: true }],
    references: [{ path: 'README.md', label: 'Evidence' }],
  };
  const run = {
    schema_version: 1, kind: 'run', project_id: projectId, task_id: 'task-001',
    run_id: 'run-20261006-001', plan_version: 1, status: 'completed',
    started_at: null, ended_at: timestamp, recorded_at: timestamp,
    executor: { agent: 'Test agent', model: null, effort: null, metadata_source: 'Unknown actual metadata' },
    git: { commit_status: 'none', commit_ids: [], push_status: 'not_pushed' },
    skills: [], summary: 'Synthetic test only', references: [],
  };
  await put(root, '.screendeck/project.json', project);
  await put(root, taskFile, task);
  await put(root, runFile, run);
  return { root, project, task, run };
}

async function expectInvalid(root, pattern, options = {}) {
  const result = await validateWorkspace(root, options);
  assert.ok(result.errors.length, 'Expected explicit validation failure');
  assert.match(result.errors.join('\n'), pattern);
}

async function applicationFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'screendeck-validator-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'Resources/Schemas'), { recursive: true });
  await put(root, 'scripts/validate-project-workspace.mjs', await readFile(path.join(repo, 'scripts/validate-project-workspace.mjs'), 'utf8'));
  await put(root, 'Resources/Schemas/record.schema.json', schema);
  return { root, executable: path.join(root, 'scripts/validate-project-workspace.mjs') };
}

async function migratedFixture(t) {
  const data = await fixture(t);
  const privateRoot = await mkdtemp(path.join(tmpdir(), 'screendeck-validator-private-'));
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const namespace = `projects/${projectId}`;
  for (const directory of ['tasks', 'runs', 'artifacts']) await mkdir(path.join(privateRoot, namespace, directory), { recursive: true });
  await rename(path.join(data.root, taskFile), path.join(privateRoot, namespace, 'tasks/task-001.json'));
  await rename(path.join(data.root, runFile), path.join(privateRoot, namespace, 'runs/run-20261006-001.json'));
  await rm(path.join(data.root, '.screendeck/tasks'), { recursive: true });
  await rm(path.join(data.root, '.screendeck/runs'), { recursive: true });
  const identity = { schema_version: 2, kind: 'project', project_id: projectId, name: data.project.name, created_at: timestamp };
  const history = {
    schema_version: 1, kind: 'project_history', project_id: projectId, source_root: data.root,
    created_at: timestamp, project: structuredClone(data.project),
    migration: { backup_path: path.join(privateRoot, 'backups/project-legacy'), migrated_at: timestamp },
  };
  await put(data.root, '.screendeck/project.json', identity);
  await put(privateRoot, `${namespace}/history.json`, history);
  return { ...data, identity, privateRoot, namespace, history, options: { privateRoot } };
}

async function snapshot(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(directory, entry.name), `${relative}/`));
    else result[relative] = (await readFile(path.join(directory, entry.name))).toString('base64');
  }
  return result;
}

test('valid records allow historical plan versions, unknown runtime metadata and pending human review', async t => {
  const { root } = await fixture(t);
  const result = await validateWorkspace(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, { projects: 1, tasks: 1, runs: 1 });
});

test('schema_version is constrained by the single shipped schema', async t => {
  const { root, task } = await fixture(t);
  task.schema_version = 99;
  await put(root, taskFile, task);
  await expectInvalid(root, /schema_version: invalid constant/);
});

test('required fields, enums and additional fields are checked', async t => {
  const { root, task } = await fixture(t);
  delete task.status;
  task.assignee = 'unsupported';
  task.execute_me = 'must not execute';
  await put(root, taskFile, task);
  const result = await validateWorkspace(root);
  assert.match(result.errors.join('\n'), /status: missing required/);
  assert.match(result.errors.join('\n'), /assignee: invalid enum/);
  assert.match(result.errors.join('\n'), /execute_me: unexpected field/);
});

test('integer minimum and bounded string/array fields are checked', async t => {
  const { root, task } = await fixture(t);
  task.plan_version = 0;
  task.title = '';
  task.acceptance = [];
  await put(root, taskFile, task);
  const errors = (await validateWorkspace(root)).errors.join('\n');
  assert.match(errors, /plan_version: below minimum/);
  assert.match(errors, /title: below minLength/);
  assert.match(errors, /acceptance: below minItems/);
});

test('malformed JSON is reported rather than executed', async t => {
  const { root } = await fixture(t);
  await put(root, runFile, '{"run_id":');
  await expectInvalid(root, /runs\/run-20261006-001.json:/);
});

test('invalid calendar dates or missing timezone fail', async t => {
  const { root, task } = await fixture(t);
  task.created_at = '2026-02-30T10:00:00+08:00';
  task.updated_at = '2026-10-06T10:00:00';
  await put(root, taskFile, task);
  assert.equal((await validateWorkspace(root)).errors.filter(error => error.includes('invalid date-time')).length, 2);
});

test('filename must match the record ID and duplicate IDs fail', async t => {
  const { root, task } = await fixture(t);
  await put(root, '.screendeck/tasks/copy.json', task);
  const errors = (await validateWorkspace(root)).errors.join('\n');
  assert.match(errors, /filename must match task_id/);
  assert.match(errors, /duplicate task_id/);
});

test('run IDs in each task must be unique', async t => {
  const { root, task } = await fixture(t);
  task.run_ids.push(task.run_ids[0]);
  await put(root, taskFile, task);
  await expectInvalid(root, /duplicate array item/);
});

test('task references to missing runs fail', async t => {
  const { root } = await fixture(t);
  await rm(path.join(root, runFile));
  await expectInvalid(root, /missing run run-20261006-001/);
});

test('a run without its task fails', async t => {
  const { root } = await fixture(t);
  await rm(path.join(root, taskFile));
  await expectInvalid(root, /missing task task-001/);
});

test('run/task association must be bidirectional', async t => {
  const { root, task } = await fixture(t);
  task.run_ids = [];
  await put(root, taskFile, task);
  await expectInvalid(root, /run absent from task.run_ids/);
});

test('a run claimed by another task fails', async t => {
  const { root, task } = await fixture(t);
  const second = { ...task, task_id: 'task-002' };
  await put(root, '.screendeck/tasks/task-002.json', second);
  await expectInvalid(root, /belongs to another task/);
});

test('project IDs must match across all records', async t => {
  const { root, run } = await fixture(t);
  run.project_id = 'project-87654321-1234-1234-1234-123456789abc';
  await put(root, runFile, run);
  const errors = (await validateWorkspace(root)).errors.join('\n');
  assert.match(errors, /project_id mismatch/);
  assert.match(errors, /task\/run project_id mismatch/);
});

test('a run cannot claim a future plan version', async t => {
  const { root, run } = await fixture(t);
  run.plan_version = 3;
  await put(root, runFile, run);
  await expectInvalid(root, /run plan_version exceeds/);
});

test('completed task requires verified acceptance but validation never grants permission', async t => {
  const { root, task } = await fixture(t);
  task.status = 'completed';
  await put(root, taskFile, task);
  await expectInvalid(root, /every acceptance item to be verified/);
  task.acceptance[0].verification = 'verified';
  await put(root, taskFile, task);
  assert.deepEqual((await validateWorkspace(root)).errors, []);
});

test('run completion and running states have consistent ended_at', async t => {
  const { root, run } = await fixture(t);
  run.ended_at = null;
  await put(root, runFile, run);
  await expectInvalid(root, /completed run requires ended_at/);
  run.status = 'running';
  run.ended_at = timestamp;
  await put(root, runFile, run);
  await expectInvalid(root, /running run must not have ended_at/);
});

test('duplicate acceptance IDs and reversed execution timestamps fail', async t => {
  const { root, task, run } = await fixture(t);
  task.acceptance.push({ ...task.acceptance[0] });
  run.started_at = '2026-10-06T11:00:00+08:00';
  await put(root, taskFile, task);
  await put(root, runFile, run);
  const errors = (await validateWorkspace(root)).errors.join('\n');
  assert.match(errors, /duplicate acceptance id/);
  assert.match(errors, /ended_at precedes/);
});

test('none or unknown Git states cannot claim commit IDs', async t => {
  const { root, run } = await fixture(t);
  for (const commitStatus of ['none', 'unknown']) {
    run.git = { commit_status: commitStatus, commit_ids: ['a'.repeat(40)], push_status: 'not_pushed' };
    await put(root, runFile, run);
    await expectInvalid(root, /none\/unknown commit_status requires empty commit_ids/);
  }
});

test('committed Git state requires at least one full commit SHA', async t => {
  const { root, run } = await fixture(t);
  run.git = { commit_status: 'committed', commit_ids: [], push_status: 'not_pushed' };
  await put(root, runFile, run);
  await expectInvalid(root, /committed status requires at least one commit_id/);
  for (const sha of ['a'.repeat(40), 'b'.repeat(64)]) {
    run.git.commit_ids = [sha];
    await put(root, runFile, run);
    assert.deepEqual((await validateWorkspace(root)).errors, []);
  }
  for (const sha of ['abc123', 'A'.repeat(40), 'g'.repeat(40)]) {
    run.git.commit_ids = [sha];
    await put(root, runFile, run);
    await expectInvalid(root, /commit_ids\[0\]: pattern mismatch/);
  }
});

test('pushed state requires a committed run and duplicate commit IDs fail', async t => {
  const { root, run } = await fixture(t);
  run.git = { commit_status: 'none', commit_ids: [], push_status: 'pushed' };
  await put(root, runFile, run);
  await expectInvalid(root, /pushed status requires committed status/);
  run.git = { commit_status: 'committed', commit_ids: ['a'.repeat(40)], push_status: 'pushed' };
  await put(root, runFile, run);
  assert.deepEqual((await validateWorkspace(root)).errors, []);
  run.git.commit_ids.push(run.git.commit_ids[0]);
  await put(root, runFile, run);
  await expectInvalid(root, /duplicate array item/);
});

test('missing referenced files fail explicitly', async t => {
  const { root } = await fixture(t);
  await rm(path.join(root, 'README.md'));
  await expectInvalid(root, /reference README.md:/);
});

test('absolute, traversal, URL, backslash and anchored references are rejected', async t => {
  const { root, task } = await fixture(t);
  task.references = ['/etc/passwd', '../README.md', 'https://example.com', 'docs\\file.md', 'README.md#section']
    .map(reference => ({ path: reference, label: 'Unsafe path' }));
  await put(root, taskFile, task);
  const errors = (await validateWorkspace(root)).errors;
  assert.equal(errors.filter(error => error.includes(`${taskFile}: reference`)).length, 5);
});

test('references refuse symlink files and directory components even inside the project', async t => {
  const { root, task } = await fixture(t);
  await symlink(path.join(root, 'README.md'), path.join(root, 'alias.md'));
  await symlink(path.join(root, '.screendeck'), path.join(root, 'alias-directory'));
  task.references = ['alias.md', 'alias-directory/project.json'].map(reference => ({ path: reference, label: 'Symlink' }));
  await put(root, taskFile, task);
  assert.equal((await validateWorkspace(root)).errors.filter(error => error.includes('symbolic link')).length, 2);
});

test('symlink record directories and shipped schema files are refused', async t => {
  const { root } = await fixture(t);
  await rename(path.join(root, '.screendeck/tasks'), path.join(root, '.screendeck/task-backup'));
  await symlink(path.join(root, '.screendeck/task-backup'), path.join(root, '.screendeck/tasks'));
  await expectInvalid(root, /symbolic link/);
  const app = await applicationFixture(t);
  await rename(path.join(app.root, 'Resources/Schemas/record.schema.json'), path.join(app.root, 'Resources/Schemas/source.json'));
  await symlink(path.join(app.root, 'Resources/Schemas/source.json'), path.join(app.root, 'Resources/Schemas/record.schema.json'));
  await assert.rejects(runProcess(process.execPath, [app.executable, '--root', root]), error => error.code === 1 && /schema: symbolic link/.test(error.stderr));
});

test('missing workspace, project or collection directories fail explicitly', async t => {
  const { root } = await fixture(t);
  await rm(path.join(root, '.screendeck/project.json'));
  await rm(path.join(root, '.screendeck/runs'), { recursive: true });
  let errors = (await validateWorkspace(root)).errors.join('\n');
  assert.match(errors, /project.json:/);
  assert.match(errors, /\.screendeck\/runs:/);
  await rm(path.join(root, '.screendeck'), { recursive: true });
  await expectInvalid(root, /project.json:/);
});

test('unknown shipped schema keywords fail closed, and shipped schema edits drive validation', async t => {
  const { root, task } = await fixture(t);
  const app = await applicationFixture(t);
  const edited = structuredClone(schema);
  edited.$defs.task.properties.title.minLength = 50;
  await put(app.root, 'Resources/Schemas/record.schema.json', edited);
  await assert.rejects(runProcess(process.execPath, [app.executable, '--root', root]), error => error.code === 1 && /title: below minLength/.test(error.stderr));
  edited.$defs.task.properties.title.not = { const: task.title };
  await put(app.root, 'Resources/Schemas/record.schema.json', edited);
  await assert.rejects(runProcess(process.execPath, [app.executable, '--root', root]), error => error.code === 1 && /unsupported keyword not/.test(error.stderr));
});

test('validator does not create, change or delete workspace or reference files', async t => {
  const { root } = await fixture(t);
  await put(root, 'README.md', 'throw new Error("do not execute this");\n{"not":"a record"}');
  async function snapshot(directory, prefix = '') {
    const result = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(directory, entry.name), `${relative}/`));
      else result[relative] = (await readFile(path.join(directory, entry.name))).toString('base64');
    }
    return result;
  }
  const before = await snapshot(root);
  assert.deepEqual((await validateWorkspace(root)).errors, []);
  assert.deepEqual(await snapshot(root), before);
});

test('CLI supports --root and explicit exit codes without writing files', async t => {
  const { root } = await fixture(t);
  const executable = path.join(repo, 'scripts/validate-project-workspace.mjs');
  const result = await runProcess(process.execPath, [executable, '--root', root]);
  assert.match(result.stdout, /Workspace valid: 1 project, 1 tasks, 1 runs/);
  await assert.rejects(runProcess(process.execPath, [executable, '--fix']), error => error.code === 2 && /Usage:/.test(error.stderr));
  await rm(path.join(root, runFile));
  await assert.rejects(runProcess(process.execPath, [executable, '--root', root]), error => error.code === 1 && /missing run/.test(error.stderr));
});

test('valid migrated history reads private records, private attachments and project-relative documents', async t => {
  const { root, privateRoot, namespace, task, history, options } = await migratedFixture(t);
  await put(privateRoot, `${namespace}/artifacts/report.txt`, 'Synthetic private evidence');
  task.references = [
    { path: `screendeck://${projectId}/artifacts/report.txt`, label: 'Private evidence' },
    { path: `screendeck://${projectId}/runs/run-20261006-001.json`, label: 'Private run' },
    { path: 'README.md', label: 'Project document' },
  ];
  history.project.references.push({ path: `screendeck://${projectId}/tasks/task-001.json`, label: 'Project history reference' });
  await put(privateRoot, `${namespace}/tasks/task-001.json`, task);
  await put(privateRoot, `${namespace}/history.json`, history);
  const result = await validateWorkspace(root, options);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, { projects: 1, tasks: 1, runs: 1 });
});

test('new five-field v2 identities allow absent or empty private history', async t => {
  const { root, privateRoot, namespace, options } = await migratedFixture(t);
  await rm(path.join(privateRoot, namespace), { recursive: true });
  assert.deepEqual(await validateWorkspace(root, options), { root, errors: [], counts: { projects: 1, tasks: 0, runs: 0 } });
  for (const directory of ['tasks', 'runs', 'artifacts']) await mkdir(path.join(privateRoot, namespace, directory), { recursive: true });
  assert.deepEqual((await validateWorkspace(root, options)).errors, []);
  await rm(privateRoot, { recursive: true });
  assert.deepEqual((await validateWorkspace(root, options)).errors, []);
});

test('project identity versions fail closed, and v2 requires exactly its five fields', async t => {
  const { root, identity, options } = await migratedFixture(t);
  identity.schema_version = 3;
  await put(root, '.screendeck/project.json', identity);
  await expectInvalid(root, /unsupported project schema_version/, options);
  identity.schema_version = 2;
  identity.references = [];
  delete identity.created_at;
  await put(root, '.screendeck/project.json', identity);
  const errors = (await validateWorkspace(root, options)).errors.join('\n');
  assert.match(errors, /references: unexpected field/);
  assert.match(errors, /created_at: missing required field/);
});

test('history manifests validate version, kind, migration metadata and unknown fields', async t => {
  const { root, privateRoot, namespace, history, options } = await migratedFixture(t);
  for (const [change, pattern] of [
    [value => { value.schema_version = 2; }, /schema_version: invalid constant/],
    [value => { value.kind = 'project'; }, /kind: invalid constant/],
    [value => { delete value.migration; }, /migration: missing required field/],
    [value => { value.migration.migrated_at = '2026-10-07'; }, /migrated_at: invalid date-time/],
    [value => { value.execute_me = 'No executable authority'; }, /execute_me: unexpected field/],
  ]) {
    const edited = structuredClone(history);
    change(edited);
    await put(privateRoot, `${namespace}/history.json`, edited);
    await expectInvalid(root, pattern, options);
  }
});

test('a copied project identity cannot import private history from another source root', async t => {
  const { root, identity, options } = await migratedFixture(t);
  const clone = await fixture(t);
  await put(clone.root, '.screendeck/project.json', identity);
  const result = await validateWorkspace(clone.root, options);
  assert.match(result.errors.join('\n'), /source_root mismatch/);
  assert.deepEqual(result.counts, { projects: 1, tasks: 0, runs: 0 });
  assert.deepEqual((await validateWorkspace(root, options)).errors, []);
});

test('manifest project IDs and standardized source roots must match the project identity', async t => {
  const { root, privateRoot, namespace, history, options } = await migratedFixture(t);
  const differentId = 'project-87654321-1234-1234-1234-123456789abc';
  for (const change of [value => { value.project_id = differentId; }, value => { value.project.project_id = differentId; }]) {
    const edited = structuredClone(history);
    change(edited);
    await put(privateRoot, `${namespace}/history.json`, edited);
    await expectInvalid(root, /project_id mismatch/, options);
  }
  for (const sourceRoot of [`${root}/.`, 'relative/project']) {
    await put(privateRoot, `${namespace}/history.json`, { ...history, source_root: sourceRoot });
    await expectInvalid(root, /source_root mismatch or noncanonical/, options);
  }
});

test('private reference URIs reject cross-project, traversal, encoded and noncanonical paths', async t => {
  const { root, privateRoot, namespace, task, options } = await migratedFixture(t);
  const unsafe = [
    `screendeck://project-87654321-1234-1234-1234-123456789abc/artifacts/report.txt`,
    `screendeck://${projectId}/artifacts/../report.txt`,
    `screendeck://${projectId}/artifacts/./report.txt`,
    `screendeck://${projectId}/artifacts//etc/passwd`,
    `screendeck://${projectId}/artifacts/%2e%2e/report.txt`,
    `screendeck://${projectId}/artifacts/report%2ftxt`,
    `screendeck://${projectId}/artifacts/report.txt#anchor`,
    `screendeck://${projectId}/artifacts/report.txt?query`,
    `screendeck://${projectId}/artifacts/docs\\report.txt`,
    `screendeck://${projectId}/artifacts/docs/report:unsafe.txt`,
    `screendeck://${projectId}/unknown/report.txt`,
  ];
  task.references = unsafe.map(reference => ({ path: reference, label: 'Unsafe private reference' }));
  await put(privateRoot, `${namespace}/tasks/task-001.json`, task);
  const errors = (await validateWorkspace(root, options)).errors;
  assert.equal(errors.filter(error => error.includes(': reference ')).length, unsafe.length);
  assert.ok(errors.some(error => error.includes('cross-project')));
});

test('private history reports missing records and attachments explicitly', async t => {
  const { root, privateRoot, namespace, task, options } = await migratedFixture(t);
  task.references = [{ path: `screendeck://${projectId}/artifacts/missing.txt`, label: 'Missing attachment' }];
  await put(privateRoot, `${namespace}/tasks/task-001.json`, task);
  await rm(path.join(privateRoot, namespace, 'runs/run-20261006-001.json'));
  const errors = (await validateWorkspace(root, options)).errors.join('\n');
  assert.match(errors, /missing run run-20261006-001/);
  assert.match(errors, /reference screendeck:.*missing.txt:/);
  await rm(path.join(privateRoot, namespace, 'runs'), { recursive: true });
  await expectInvalid(root, /projects\/.*\/runs:/, options);
});

test('private records and attachment paths refuse symlink directories and files', async t => {
  const { root, privateRoot, namespace, task, options } = await migratedFixture(t);
  await put(privateRoot, `${namespace}/artifacts/report.txt`, 'Synthetic attachment');
  await symlink(path.join(privateRoot, namespace, 'artifacts/report.txt'), path.join(privateRoot, namespace, 'artifacts/alias.txt'));
  await symlink(path.join(privateRoot, namespace, 'artifacts'), path.join(privateRoot, namespace, 'artifacts/alias-directory'));
  task.references = ['alias.txt', 'alias-directory/report.txt'].map(relative => ({ path: `screendeck://${projectId}/artifacts/${relative}`, label: 'Symlink' }));
  await put(privateRoot, `${namespace}/tasks/task-001.json`, task);
  assert.equal((await validateWorkspace(root, options)).errors.filter(error => error.includes('symbolic link')).length, 2);
  await rename(path.join(privateRoot, namespace, 'tasks'), path.join(privateRoot, namespace, 'task-backup'));
  await symlink(path.join(privateRoot, namespace, 'task-backup'), path.join(privateRoot, namespace, 'tasks'));
  await expectInvalid(root, /tasks: symbolic link/, options);
});

test('private manifest and private namespace symlinks fail before reading records', async t => {
  const { root, privateRoot, namespace, options } = await migratedFixture(t);
  await rename(path.join(privateRoot, namespace, 'history.json'), path.join(privateRoot, namespace, 'manifest-source.json'));
  await symlink(path.join(privateRoot, namespace, 'manifest-source.json'), path.join(privateRoot, namespace, 'history.json'));
  let result = await validateWorkspace(root, options);
  assert.match(result.errors.join('\n'), /history.json: symbolic link/);
  assert.equal(result.counts.tasks, 0);
  await rename(path.join(privateRoot, namespace), path.join(privateRoot, 'namespace-backup'));
  await symlink(path.join(privateRoot, 'namespace-backup'), path.join(privateRoot, namespace));
  result = await validateWorkspace(root, options);
  assert.match(result.errors.join('\n'), /symbolic link/);
  assert.equal(result.counts.runs, 0);
});

test('private data without a binding manifest is refused', async t => {
  const { root, privateRoot, namespace, options } = await migratedFixture(t);
  await rm(path.join(privateRoot, namespace, 'history.json'));
  await expectInvalid(root, /private history data requires history.json/, options);
});

test('the shipped schema is used even if a project supplies a malicious schema', async t => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, '.screendeck/schema'), { recursive: true });
  await put(root, '.screendeck/schema/record.schema.json', { execute_me: 'ignored project-local schema', $defs: {} });
  assert.deepEqual((await validateWorkspace(root)).errors, []);
});

test('bound private history ignores stale local task and run collections', async t => {
  const { root, options } = await migratedFixture(t);
  await mkdir(path.join(root, '.screendeck/tasks'), { recursive: true });
  await mkdir(path.join(root, '.screendeck/runs'), { recursive: true });
  await put(root, taskFile, '{"invalid":');
  await put(root, runFile, '{"invalid":');
  const result = await validateWorkspace(root, options);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, { projects: 1, tasks: 1, runs: 1 });
});

test('private history validation preserves both project and private bytes', async t => {
  const { root, privateRoot, options } = await migratedFixture(t);
  const before = { project: await snapshot(root), private: await snapshot(privateRoot) };
  assert.deepEqual((await validateWorkspace(root, options)).errors, []);
  assert.deepEqual({ project: await snapshot(root), private: await snapshot(privateRoot) }, before);
});

test('CLI accepts --private-root in either order and rejects duplicate or incomplete flags', async t => {
  const { root, privateRoot } = await migratedFixture(t);
  const executable = path.join(repo, 'scripts/validate-project-workspace.mjs');
  for (const args of [['--root', root, '--private-root', privateRoot], ['--private-root', privateRoot, '--root', root]]) {
    assert.match((await runProcess(process.execPath, [executable, ...args])).stdout, /Workspace valid: 1 project, 1 tasks, 1 runs/);
  }
  for (const args of [['--root', root, '--root', root], ['--private-root'], ['--root', '--private-root', privateRoot]]) {
    await assert.rejects(runProcess(process.execPath, [executable, ...args]), error => error.code === 2 && /Usage:/.test(error.stderr));
  }
});

test('legacy local records cannot read private URIs even when matching private data exists', async t => {
  const { root, project, task, run, namespace, privateRoot, options } = await migratedFixture(t);
  await mkdir(path.join(root, '.screendeck/tasks'), { recursive: true });
  await mkdir(path.join(root, '.screendeck/runs'), { recursive: true });
  await put(root, '.screendeck/project.json', project);
  await put(privateRoot, `${namespace}/artifacts/existing.txt`, 'This file must not be consumed by legacy reads');
  task.references = [{ path: `screendeck://${projectId}/artifacts/existing.txt`, label: 'Unbound private URI' }];
  await put(root, taskFile, task);
  await put(root, runFile, run);
  const result = await validateWorkspace(root, options);
  assert.match(result.errors.join('\n'), /private reference requires bound migrated history/);
  assert.deepEqual(result.counts, { projects: 1, tasks: 1, runs: 1 });
});

test('manifest original created_at must match the identity exactly', async t => {
  const { root, privateRoot, namespace, history, options } = await migratedFixture(t);
  for (const createdAt of ['2026-10-06T11:00:00+08:00', '2026-10-06T02:00:00Z']) {
    history.project.created_at = createdAt;
    await put(privateRoot, `${namespace}/history.json`, history);
    const result = await validateWorkspace(root, options);
    assert.match(result.errors.join('\n'), /identity created_at mismatch/);
    assert.equal(result.counts.tasks, 0);
  }
});

test('manifest backup paths must be canonical absolute paths below the filesystem root', async t => {
  const { root, privateRoot, namespace, history, options } = await migratedFixture(t);
  for (const backupPath of ['', '/', 'relative/backup', '/private/tmp/../backup', '/private/tmp//backup', '/private/tmp/backup/', '/private/tmp/backup\0unsafe']) {
    history.migration.backup_path = backupPath;
    await put(privateRoot, `${namespace}/history.json`, history);
    const result = await validateWorkspace(root, options);
    assert.match(result.errors.join('\n'), /backup_path:/);
    assert.equal(result.counts.runs, 0);
  }
});

test('v2 identities without manifests refuse unmigrated local task and run records', async t => {
  const { root, privateRoot, namespace, task, run, options } = await migratedFixture(t);
  await rm(path.join(privateRoot, namespace), { recursive: true });
  await mkdir(path.join(root, '.screendeck/tasks'), { recursive: true });
  await mkdir(path.join(root, '.screendeck/runs'), { recursive: true });
  await put(root, taskFile, task);
  await put(root, runFile, run);
  let result = await validateWorkspace(root, options);
  assert.equal(result.errors.filter(error => error.includes('unmigrated local history')).length, 2);
  assert.deepEqual(result.counts, { projects: 1, tasks: 0, runs: 0 });
  await rm(path.join(root, taskFile));
  await rm(path.join(root, runFile));
  assert.deepEqual((await validateWorkspace(root, options)).errors, []);
  await rename(path.join(root, '.screendeck/tasks'), path.join(root, '.screendeck/task-source'));
  await symlink(path.join(root, '.screendeck/task-source'), path.join(root, '.screendeck/tasks'));
  result = await validateWorkspace(root, options);
  assert.match(result.errors.join('\n'), /tasks: symbolic link/);
});

test('project and private root ancestors reject arbitrary symlinks', async t => {
  const { root, privateRoot, options } = await migratedFixture(t);
  await symlink(path.dirname(root), path.join(root, 'project-ancestor-alias'));
  const aliasRoot = path.join(root, 'project-ancestor-alias', path.basename(root));
  const projectResult = await validateWorkspace(aliasRoot, options);
  assert.match(projectResult.errors.join('\n'), /root: symbolic link is not allowed in root or its ancestors/);
  assert.deepEqual(projectResult.counts, { projects: 0, tasks: 0, runs: 0 });
  await symlink(path.dirname(privateRoot), path.join(root, 'private-ancestor-alias'));
  const aliasPrivateRoot = path.join(root, 'private-ancestor-alias', path.basename(privateRoot));
  const privateResult = await validateWorkspace(root, { privateRoot: aliasPrivateRoot });
  assert.match(privateResult.errors.join('\n'), /history.json: symbolic link is not allowed in root or its ancestors/);
  assert.deepEqual(privateResult.counts, { projects: 1, tasks: 0, runs: 0 });
});

test('bound history requires a real private artifacts directory even without attachment references', async t => {
  const { root, privateRoot, namespace, options } = await migratedFixture(t);
  await rm(path.join(privateRoot, namespace, 'artifacts'), { recursive: true });
  await expectInvalid(root, /projects\/.*\/artifacts:/, options);
  await put(privateRoot, `${namespace}/artifacts`, 'A file cannot replace the artifacts directory');
  await expectInvalid(root, /artifacts: expected a directory/, options);
});
