#!/usr/bin/env node
// Read-only validator for the explicitly bounded schema subset in record.schema.json.
// It never interprets references, summaries, or JSON fields as executable instructions.
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORTED = new Set(['$schema', '$defs', '$ref', 'title', 'description', 'oneOf',
  'type', 'const', 'enum', 'minimum', 'minLength', 'maxLength', 'minItems',
  'maxItems', 'uniqueItems', 'pattern', 'format', 'required', 'properties',
  'items', 'additionalProperties']);

function assertSchema(schema, root, trail = 'schema', refs = new Set()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${trail}: only object schemas are supported`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`${trail}: unsupported keyword ${key}`);
  }
  for (const key of ['$defs', 'properties']) {
    if (schema[key] !== undefined && !matchesType(schema[key], 'object')) throw new Error(`${trail}: invalid ${key}`);
  }
  for (const key of ['oneOf', 'enum', 'required']) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].length)) {
      throw new Error(`${trail}: invalid ${key}`);
    }
  }
  if (schema.required && (schema.required.some(item => typeof item !== 'string')
    || new Set(schema.required).size !== schema.required.length)) throw new Error(`${trail}: invalid required`);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) {
      throw new Error(`${trail}: invalid ${key}`);
    }
  }
  if (schema.minimum !== undefined && (typeof schema.minimum !== 'number' || !Number.isFinite(schema.minimum))) {
    throw new Error(`${trail}: invalid minimum`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') throw new Error(`${trail}: invalid uniqueItems`);
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') throw new Error(`${trail}: invalid pattern`);
  if (schema.format !== undefined && schema.format !== 'date-time') {
    throw new Error(`${trail}: unsupported format ${schema.format}`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`${trail}: only additionalProperties:false is supported`);
  }
  if (schema.$ref !== undefined) {
    if (refs.has(schema.$ref)) throw new Error(`${trail}: cyclic schema reference`);
    assertSchema(resolveRef(root, schema.$ref), root, trail, new Set([...refs, schema.$ref]));
  }
  for (const [key, child] of Object.entries(schema.$defs ?? {})) {
    assertSchema(child, root, `${trail}.$defs.${key}`, refs);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    assertSchema(child, root, `${trail}.properties.${key}`, refs);
  }
  for (const child of schema.oneOf ?? []) assertSchema(child, root, `${trail}.oneOf`, refs);
  if (schema.items !== undefined) assertSchema(schema.items, root, `${trail}.items`, refs);
  if (schema.pattern !== undefined) new RegExp(schema.pattern, 'u');
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (schema.type !== undefined && !types.length || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) {
    throw new Error(`${trail}: unsupported type`);
  }
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !/^#\/\$defs\/[^/]+$/.test(ref)) {
    throw new Error(`unsupported schema reference ${ref}`);
  }
  const schema = root.$defs?.[ref.slice('#/$defs/'.length)];
  if (!schema) throw new Error(`missing schema reference ${ref}`);
  return schema;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

// Require a real calendar date and explicit timezone; Date.parse alone normalizes bad dates.
function isDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return false;
  if (m[7] !== 'Z' && (Number(m[7].slice(1, 3)) > 23 || Number(m[7].slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function validateValue(value, schema, root, trail, errors) {
  if (schema.$ref) validateValue(value, resolveRef(root, schema.$ref), root, trail, errors);
  if (schema.oneOf) {
    const candidates = schema.oneOf.map(child => {
      const issues = [];
      validateValue(value, child, root, trail, issues);
      return issues;
    });
    if (candidates.filter(issues => issues.length === 0).length !== 1) {
      errors.push(`${trail}: must match exactly one record schema`);
      const best = candidates.reduce((a, b) => a.length <= b.length ? a : b);
      errors.push(...best);
    }
  }
  if (schema.type !== undefined && ![].concat(schema.type).some(type => matchesType(value, type))) {
    errors.push(`${trail}: expected ${[].concat(schema.type).join('|')}`);
    return;
  }
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) errors.push(`${trail}: invalid constant`);
  if (schema.enum && !schema.enum.some(option => isDeepStrictEqual(option, value))) errors.push(`${trail}: invalid enum value`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${trail}: below minimum ${schema.minimum}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${trail}: below minLength`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${trail}: above maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${trail}: pattern mismatch`);
    if (schema.format === 'date-time' && !isDateTime(value)) errors.push(`${trail}: invalid date-time with timezone`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${trail}: below minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${trail}: above maxItems`);
    if (schema.uniqueItems && value.some((item, i) => value.slice(0, i).some(other => isDeepStrictEqual(item, other)))) {
      errors.push(`${trail}: duplicate array item`);
    }
    if (schema.items) value.forEach((item, i) => validateValue(item, schema.items, root, `${trail}[${i}]`, errors));
  }
  if (matchesType(value, 'object')) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${trail}.${key}: missing required field`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        validateValue(item, schema.properties[key], root, `${trail}.${key}`, errors);
      } else if (schema.additionalProperties === false) errors.push(`${trail}.${key}: unexpected field`);
    }
  }
}

function pathParts(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || /[\\\0#?%]/u.test(relative) || /^[a-z][a-z0-9+.-]*:/iu.test(relative)) {
    throw new Error('expected a project-relative path without anchors or URLs');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '..' || part === '.')) throw new Error('path traversal or noncanonical path');
  return parts;
}

async function checkedDirectory(root) {
  let absolute = path.resolve(root);
  // Only verified macOS system aliases may occur above the scoped root.
  // User-controlled ancestors must not redirect either project or private reads.
  if (process.platform === 'darwin') {
    for (const alias of ['var', 'tmp']) {
      if (absolute === `/${alias}` || absolute.startsWith(`/${alias}/`)) {
        const target = await readlink(`/${alias}`);
        if (![ `private/${alias}`, `/private/${alias}` ].includes(target)) throw new Error('invalid system directory alias');
        absolute = `/private${absolute}`;
        break;
      }
    }
  }
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('symbolic link is not allowed in root or its ancestors');
    if (!stat.isDirectory()) throw new Error('root and its ancestors must be real directories');
  }
  return current;
}

async function safeStat(root, relative) {
  const parts = pathParts(relative);
  let current = await checkedDirectory(root);
  let stat;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('symbolic link is not allowed');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('parent is not a directory');
  }
  return { fullPath: current, stat };
}

async function readJSON(root, relative) {
  const { fullPath, stat } = await safeStat(root, relative);
  if (!stat.isFile()) throw new Error('expected a regular JSON file');
  if (stat.size > MAX_JSON_BYTES) throw new Error('JSON exceeds the 2 MiB limit');
  // O_NOFOLLOW also guards a leaf that is replaced by a symlink after lstat.
  const file = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > MAX_JSON_BYTES) throw new Error('invalid JSON file size/type');
    return JSON.parse(await file.readFile({ encoding: 'utf8' }));
  } finally { await file.close(); }
}

export async function validateWorkspace(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const privateRoot = path.resolve(options.privateRoot ?? path.join(homedir(), '.screendeck'));
  const errors = [];
  const counts = { projects: 0, tasks: 0, runs: 0 };
  try {
    await checkedDirectory(root);
  } catch (error) {
    return { root, errors: [`root: ${error.message}`], counts };
  }
  let schema;
  try {
    schema = await readJSON(APP_ROOT, 'Resources/Schemas/record.schema.json');
    assertSchema(schema, schema);
    for (const kind of ['project', 'project_identity', 'project_history', 'task', 'run']) {
      if (!schema.$defs?.[kind]) throw new Error(`missing ${kind} definition`);
    }
  } catch (error) {
    return { root, errors: [`schema: ${error.message}`], counts };
  }
  async function readRecord(storageRoot, relative, expectedKind, file = relative) {
    try {
      const value = await readJSON(storageRoot, relative);
      const issues = [];
      validateValue(value, schema.$defs[expectedKind], schema, file, issues);
      errors.push(...issues);
      return issues.length ? null : { value, file };
    } catch (error) { errors.push(`${file}: ${error.message}`); return null; }
  }
  let project;
  let identity;
  const identityFile = '.screendeck/project.json';
  try {
    identity = await readJSON(root, identityFile);
    if (![1, 2].includes(identity.schema_version)) throw new Error('unsupported project schema_version');
    const issues = [];
    validateValue(identity, schema.$defs[identity.schema_version === 1 ? 'project' : 'project_identity'], schema, identityFile, issues);
    errors.push(...issues);
    if (!issues.length) project = { value: identity, file: identityFile };
  } catch (error) { errors.push(`${identityFile}: ${error.message}`); }
  if (project) counts.projects = 1;
  let storageRoot = root;
  let collectionPrefix = '.screendeck';
  let historicalProject;
  if (identity?.schema_version === 2) {
    if (!project) return { root, errors, counts };
    storageRoot = privateRoot;
    collectionPrefix = `projects/${identity.project_id}`;
    const historyFile = `${collectionPrefix}/history.json`;
    let historyStat;
    try { historyStat = await safeStat(storageRoot, historyFile); }
    catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${historyFile}: ${error.message}`);
    }
    if (!historyStat) {
      // A freshly initialized identity has no history. Existing private data must
      // have a manifest binding it to this root before any records are consumed.
      for (const directory of ['.screendeck/tasks', '.screendeck/runs']) {
        try {
          const local = await safeStat(root, directory);
          if (!local.stat.isDirectory()) throw new Error('expected a directory');
          if ((await readdir(local.fullPath)).length) throw new Error('v2 identity cannot read unmigrated local history');
        } catch (error) {
          if (error.code !== 'ENOENT') errors.push(`${directory}: ${error.message}`);
        }
      }
      if (!errors.length) {
        try {
          const namespace = await safeStat(storageRoot, collectionPrefix);
          if (!namespace.stat.isDirectory()) throw new Error('expected a directory');
          for (const name of await readdir(namespace.fullPath)) {
            const entry = await safeStat(storageRoot, `${collectionPrefix}/${name}`);
            if (!['tasks', 'runs', 'artifacts'].includes(name) || !entry.stat.isDirectory()
              || (await readdir(entry.fullPath)).length) throw new Error('private history data requires history.json');
          }
        } catch (error) {
          if (error.code !== 'ENOENT') errors.push(`${historyFile}: ${error.message}`);
        }
      }
      return { root, errors, counts };
    }
    const history = await readRecord(storageRoot, historyFile, 'project_history');
    if (!history) return { root, errors, counts };
    if (history.value.project_id !== identity.project_id || history.value.project.project_id !== identity.project_id) {
      errors.push(`${historyFile}: project_id mismatch`);
    }
    if (!path.isAbsolute(history.value.source_root) || history.value.source_root === path.parse(history.value.source_root).root
      || path.resolve(history.value.source_root) !== history.value.source_root
      || history.value.source_root !== root) errors.push(`${historyFile}: source_root mismatch or noncanonical path`);
    if (history.value.project.created_at !== identity.created_at) errors.push(`${historyFile}.project.created_at: identity created_at mismatch`);
    const backup = history.value.migration.backup_path;
    if (!path.isAbsolute(backup) || backup === path.parse(backup).root || backup.includes('\0') || path.resolve(backup) !== backup) {
      errors.push(`${historyFile}.migration.backup_path: expected a canonical absolute nonroot path`);
    }
    if (errors.length) return { root, errors, counts };
    historicalProject = { value: history.value.project, file: `${historyFile}.project` };
    try {
      const artifacts = await safeStat(storageRoot, `${collectionPrefix}/artifacts`);
      if (!artifacts.stat.isDirectory()) throw new Error('expected a directory');
    } catch (error) { errors.push(`${collectionPrefix}/artifacts: ${error.message}`); }
  } else if (identity && identity.schema_version !== 1) return { root, errors, counts };
  async function readCollection(directory, kind) {
    const records = new Map();
    try {
      const { fullPath, stat } = await safeStat(storageRoot, directory);
      if (!stat.isDirectory()) throw new Error('expected a directory');
      const names = (await readdir(fullPath)).sort();
      for (const name of names) {
        const relative = `${directory}/${name}`;
        const child = await safeStat(storageRoot, relative);
        if (!child.stat.isFile() || !name.endsWith('.json')) {
          errors.push(`${relative}: only regular .json records are allowed`);
          continue;
        }
        const record = await readRecord(storageRoot, relative, kind);
        if (!record) continue;
        counts[`${kind}s`] += 1;
        const id = record.value[`${kind}_id`];
        if (name !== `${id}.json`) errors.push(`${relative}: filename must match ${kind}_id`);
        if (records.has(id)) errors.push(`${relative}: duplicate ${kind}_id ${id}`);
        else records.set(id, record);
      }
    } catch (error) { errors.push(`${directory}: ${error.message}`); }
    return records;
  }
  const tasks = await readCollection(`${collectionPrefix}/tasks`, 'task');
  const runs = await readCollection(`${collectionPrefix}/runs`, 'run');
  const records = [historicalProject ?? project, ...tasks.values(), ...runs.values()].filter(Boolean);
  for (const { value, file } of records) {
    if (project && value.project_id !== project.value.project_id) errors.push(`${file}: project_id mismatch`);
    for (const reference of value.references ?? []) {
      try {
        let referenceRoot = root;
        let relative = reference.path;
        if (reference.path.startsWith('screendeck://')) {
          if (!historicalProject) throw new Error('private reference requires bound migrated history');
          const uri = /^screendeck:\/\/([^/]+)\/(tasks|runs|artifacts)\/(.+)$/u.exec(reference.path);
          if (!uri) throw new Error('invalid private reference URI');
          if (!project || uri[1] !== project.value.project_id) throw new Error('cross-project private reference is not allowed');
          if (uri[3].includes(':')) throw new Error('noncanonical private reference path');
          pathParts(uri[3]);
          referenceRoot = privateRoot;
          relative = `projects/${uri[1]}/${uri[2]}/${uri[3]}`;
        }
        const { stat } = await safeStat(referenceRoot, relative);
        if (!stat.isFile()) throw new Error('reference must identify a regular file');
      } catch (error) { errors.push(`${file}: reference ${reference.path}: ${error.message}`); }
    }
  }
  for (const { value: task, file } of tasks.values()) {
    if (new Set(task.acceptance.map(item => item.id)).size !== task.acceptance.length) errors.push(`${file}: duplicate acceptance id`);
    if (task.status === 'completed' && task.acceptance.some(item => item.verification !== 'verified')) {
      errors.push(`${file}: completed task requires every acceptance item to be verified`);
    }
    if (Date.parse(task.updated_at) < Date.parse(task.created_at)) errors.push(`${file}: updated_at precedes created_at`);
    for (const id of task.run_ids) {
      const run = runs.get(id)?.value;
      if (!run) errors.push(`${file}: missing run ${id}`);
      else if (run.task_id !== task.task_id) errors.push(`${file}: run ${id} belongs to another task`);
    }
  }
  for (const { value: run, file } of runs.values()) {
    const task = tasks.get(run.task_id)?.value;
    if (!task) errors.push(`${file}: missing task ${run.task_id}`);
    else {
      if (!task.run_ids.includes(run.run_id)) errors.push(`${file}: run absent from task.run_ids`);
      if (run.plan_version > task.plan_version) errors.push(`${file}: run plan_version exceeds task plan_version`);
      if (run.project_id !== task.project_id) errors.push(`${file}: task/run project_id mismatch`);
    }
    if (run.status === 'completed' && run.ended_at === null) errors.push(`${file}: completed run requires ended_at`);
    if (run.status === 'running' && run.ended_at !== null) errors.push(`${file}: running run must not have ended_at`);
    if (run.started_at !== null && run.ended_at !== null && Date.parse(run.ended_at) < Date.parse(run.started_at)) {
      errors.push(`${file}: ended_at precedes started_at`);
    }
    if (run.git.commit_status !== 'committed' && run.git.commit_ids.length !== 0) {
      errors.push(`${file}: none/unknown commit_status requires empty commit_ids`);
    }
    if (run.git.commit_status === 'committed' && run.git.commit_ids.length === 0) {
      errors.push(`${file}: committed status requires at least one commit_id`);
    }
    if (run.git.push_status === 'pushed' && run.git.commit_status !== 'committed') {
      errors.push(`${file}: pushed status requires committed status`);
    }
  }
  return { root, errors, counts };
}

export async function main(args = process.argv.slice(2)) {
  let root = APP_ROOT;
  let privateRoot;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--root', '--private-root'].includes(flag) || seen.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('Usage: node scripts/validate-project-workspace.mjs [--root <project-dir>] [--private-root <private-dir>]');
      return 2;
    }
    seen.add(flag);
    if (flag === '--root') root = args[i + 1];
    else privateRoot = args[i + 1];
  }
  const result = await validateWorkspace(root, { privateRoot });
  if (result.errors.length) {
    console.error(`Workspace invalid (${result.errors.length} issues):`);
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }
  console.log(`Workspace valid: ${result.counts.projects} project, ${result.counts.tasks} tasks, ${result.counts.runs} runs. Read-only check; not an execution or approval.`);
  return 0;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
