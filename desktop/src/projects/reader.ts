import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { createRecordValidators } from './schema.js';
import { ProjectReadFailure, SafeReadScope, isMissing, normalizedAbsoluteRoot, relativeParts } from './safe-io.js';
import type { ArtifactPreview, ArtifactReferenceDTO, ProjectDiagnostic, ProjectHistory, ProjectIdentity, ProjectReaderLimits, ProjectRun, ProjectTask, ProjectWorkspaceResult, RecordReference } from './types.js';

export const DEFAULT_PROJECT_LIMITS: Readonly<ProjectReaderLimits> = Object.freeze({
  jsonBytes: 2 * 1024 * 1024, tasks: 1000, runs: 1000, totalBytes: 32 * 1024 * 1024,
  directoryEntries: 4096, textPreviewBytes: 1024 * 1024, imagePreviewBytes: 8 * 1024 * 1024,
});
type Snapshot = { result: ProjectWorkspaceResult; root: string; identityHash: string; historyHash: string | null; stale: boolean };
type ResolvedReference = { source: 'project' | 'private'; relative: string };
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const emptyResult = (): ProjectWorkspaceResult => ({ status: 'error', project: null, tasks: [], runs: [], artifact_refs: [], diagnostics: [], loaded_at: null, historical: true });
const issue = (code: string, location: string, message: string) => new ProjectReadFailure(code, location, message);
const diagnostic = (error: unknown): ProjectDiagnostic => error instanceof ProjectReadFailure
  ? { code: error.code, severity: 'error', path: error.location, message: error.message }
  : { code: isMissing(error) ? 'missing_source' : 'read_failed', severity: 'error', path: '项目来源', message: isMissing(error) ? '项目记录暂时无法读取，请重新选择项目。' : '项目来源无法读取；未导入或修改任何来源文件。' };

function resolveReference(reference: RecordReference, projectID: string): ResolvedReference {
  if (reference.path.startsWith('screendeck:')) {
    const prefix = `screendeck://${projectID}/`;
    if (!reference.path.startsWith(prefix)) throw issue('foreign_reference', reference.path, '私人引用不属于当前项目。');
    const relative = reference.path.slice(prefix.length);
    const parts = relativeParts(relative);
    if (parts.length < 2 || !['tasks', 'runs', 'artifacts'].includes(parts[0])) throw issue('unsafe_reference', reference.path, '私人引用必须定位当前项目的 tasks、runs 或 artifacts 内文件。');
    return { source: 'private', relative };
  }
  relativeParts(reference.path);
  return { source: 'project', relative: reference.path };
}

const imageMimes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function previewType(relative: string): ArtifactReferenceDTO['preview_type'] {
  const parts = relativeParts(relative);
  // Preview does not become a credential reader merely because a record declares it.
  if (parts.some(part => /^\.(?:env(?:\..*)?|ssh|aws|gnupg|azure|kube|git|codex|agents)$/.test(part.toLowerCase())) || /(?:^|[-_.])(?:credentials?|secrets?|passwords?|tokens?|auth|api[-_]?keys?|private[-_]?keys?|keys?)(?:[-_.]|$)/i.test(parts.at(-1)!)) return 'unsupported';
  const extension = path.extname(relative).toLowerCase();
  if (Object.hasOwn(imageMimes, extension)) return 'image';
  if (['.md', '.txt', '.log', '.json'].includes(extension)) return 'text';
  return 'unsupported';
}
function assertImageSignature(bytes: Buffer, mime: string, location: string): void {
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw issue('invalid_image', location, '图片内容与允许的预览格式不一致。');
}

/** Constructing this reader does not inspect projects or the private history root. */
export class ProjectWorkspaceReader {
  private readonly privateRoot: string;
  private readonly limits: ProjectReaderLimits;
  private readonly validators = createRecordValidators();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly roots = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { privateRoot?: string; limits?: Partial<ProjectReaderLimits> } = {}) {
    this.privateRoot = options.privateRoot ?? path.join(os.homedir(), '.screendeck');
    this.limits = { ...DEFAULT_PROJECT_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_PROJECT_LIMITS[name as keyof ProjectReaderLimits]) throw new Error(`Invalid bounded reader limit: ${name}`);
    }
  }

  /** Main-process only: supply the exact root chosen by a native directory dialog. */
  read(rootPath: string): Promise<ProjectWorkspaceResult> {
    return this.serial(async () => {
      let root: string | undefined;
      try {
        root = normalizedAbsoluteRoot(rootPath);
        const snapshot = await this.readSnapshot(root);
        const projectID = snapshot.result.project!.project_id;
        const existingID = this.roots.get(root);
        if (existingID && existingID !== projectID) throw issue('identity_changed', '.screendeck/project.json', '同一注册位置声明了不同的 project_id；旧快照失效。');
        const existing = this.snapshots.get(projectID);
        if (existing && existing.root !== root) throw issue('duplicate_project_id', '.screendeck/project.json', '此 project_id 已注册在另一确切根目录，不能自动继承历史或信任。');
        this.snapshots.set(projectID, snapshot);
        this.roots.set(root, projectID);
        return structuredClone(snapshot.result);
      } catch (error) {
        const priorID = root ? this.roots.get(root) : undefined;
        const prior = priorID ? this.snapshots.get(priorID) : undefined;
        const result = prior ? structuredClone(prior.result) : emptyResult();
        result.status = prior ? 'stale' : 'error';
        result.diagnostics = [diagnostic(error)];
        if (prior) { prior.stale = true; prior.result = structuredClone(result); }
        return result;
      }
    });
  }

  async refresh(projectID: string): Promise<ProjectWorkspaceResult> {
    const snapshot = this.snapshots.get(projectID);
    if (!snapshot) return { ...emptyResult(), diagnostics: [diagnostic(issue('unregistered_project', '项目', '项目尚未通过明确选择注册。'))] };
    return this.read(snapshot.root);
  }

  list(): ProjectWorkspaceResult[] { return structuredClone([...this.snapshots.values()].map(snapshot => snapshot.result)); }
  get(projectID: string): ProjectWorkspaceResult | null { const snapshot = this.snapshots.get(projectID); return snapshot ? structuredClone(snapshot.result) : null; }
  forget(projectID: string): void { const snapshot = this.snapshots.get(projectID); if (snapshot) this.roots.delete(snapshot.root); this.snapshots.delete(projectID); }

  preview(projectID: string, referenceID: string): Promise<ArtifactPreview> {
    return this.serial(async () => {
      const snapshot = this.snapshots.get(projectID);
      if (!snapshot || snapshot.stale) throw issue('stale_or_unregistered', '产物', '项目来源未注册或快照已失效，请先刷新。');
      const reference = snapshot.result.artifact_refs.find(item => item.reference_id === referenceID);
      if (!reference) throw issue('undeclared_reference', '产物', '引用未声明在当前注册快照中。');
      if (reference.preview_type === 'unsupported') throw issue('unsupported_preview', reference.path, '此扩展或位置不允许内嵌预览。');
      const resolved = resolveReference(reference, projectID);
      let rootScope: SafeReadScope | undefined;
      let historyScope: SafeReadScope | undefined;
      try {
        rootScope = await SafeReadScope.create(snapshot.root);
        if (sha256(await rootScope.read('.screendeck/project.json', this.limits.jsonBytes)) !== snapshot.identityHash) throw issue('identity_changed', '.screendeck/project.json', '项目身份发生变化，请先刷新。');
        if (snapshot.historyHash !== null) {
          historyScope = await SafeReadScope.create(this.privateRoot);
          if (sha256(await historyScope.read(`projects/${projectID}/history.json`, this.limits.jsonBytes)) !== snapshot.historyHash) throw issue('binding_changed', 'history.json', '私人历史绑定发生变化，请先刷新。');
        }
        const scope = resolved.source === 'project' ? rootScope : historyScope;
        if (!scope) throw issue('unbound_reference', reference.path, '私人引用缺少已验证的历史绑定。');
        const relative = resolved.source === 'project' ? resolved.relative : `projects/${projectID}/${resolved.relative}`;
        const bytes = await scope.read(relative, reference.preview_type === 'text' ? this.limits.textPreviewBytes : this.limits.imagePreviewBytes);
        await rootScope.recheck();
        await historyScope?.recheck();
        if (reference.preview_type === 'image') {
          const mime = imageMimes[path.extname(resolved.relative).toLowerCase()];
          assertImageSignature(bytes, mime, reference.path);
          return { type: 'image', reference_id: referenceID, label: reference.label, base64: bytes.toString('base64'), mime_type: mime, byte_length: bytes.length };
        }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw issue('invalid_text', reference.path, '预览只支持有效的 UTF-8 文本。'); }
        if (text.includes('\0')) throw issue('invalid_text', reference.path, '二进制文件不能作为文本预览。');
        return { type: 'text', reference_id: referenceID, label: reference.label, text, mime_type: 'text/plain', byte_length: bytes.length };
      } catch (error) {
        // A failed preview never releases bytes. Identity/path errors invalidate access.
        snapshot.stale = true;
        snapshot.result.status = 'stale';
        snapshot.result.diagnostics = [diagnostic(error)];
        throw error;
      } finally { await rootScope?.close(); await historyScope?.close(); }
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result; }

  private async readSnapshot(root: string): Promise<Snapshot> {
    let rootScope: SafeReadScope | undefined;
    let historyScope: SafeReadScope | undefined;
    let totalBytes = 0;
    const parse = <T>(bytes: Buffer, kind: keyof typeof this.validators, location: string): T => {
      totalBytes += bytes.length;
      if (totalBytes > this.limits.totalBytes) throw issue('total_size_limit', location, `记录总量超过 ${this.limits.totalBytes} 字节上限。`);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw issue('invalid_json', location, 'JSON 损坏或不是有效的 UTF-8 文本。'); }
      const validate = this.validators[kind];
      if (!validate(value)) {
        const reasons = (validate.errors ?? []).slice(0, 4).map(error => `${error.instancePath || '/'} ${error.message}`).join('；');
        throw issue('schema_invalid', location, `记录不符合严格 ${kind} 契约：${reasons}`);
      }
      return value as T;
    };
    try {
      rootScope = await SafeReadScope.create(root);
      const identityBytes = await rootScope.read('.screendeck/project.json', this.limits.jsonBytes);
      const identity = parse<ProjectIdentity>(identityBytes, 'project_identity', '.screendeck/project.json');
      const projectID = identity.project_id;
      const namespace = `projects/${projectID}`;
      // v2 never falls back to unbound project-local task/run records.
      for (const folder of ['tasks', 'runs']) {
        const relative = `.screendeck/${folder}`;
        if (await rootScope.exists(relative, true) && (await rootScope.entries(relative, this.limits.directoryEntries)).length) throw issue('unmigrated_history', relative, 'v2 身份不能读取未迁移的项目内历史。');
      }
      let history: ProjectHistory | null = null;
      let historyHash: string | null = null;
      try { historyScope = await SafeReadScope.create(this.privateRoot); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (historyScope && await historyScope.exists(namespace, true)) {
        if (await historyScope.exists(`${namespace}/history.json`)) {
          const bytes = await historyScope.read(`${namespace}/history.json`, this.limits.jsonBytes);
          history = parse<ProjectHistory>(bytes, 'project_history', 'history.json');
          historyHash = sha256(bytes);
          if (history.project_id !== projectID || history.project.project_id !== projectID || history.project.created_at !== identity.created_at) throw issue('identity_mismatch', 'history.json', '私人历史清单与已选择项目身份不一致。');
          if (normalizedAbsoluteRoot(history.source_root) !== root || history.source_root !== root) throw issue('root_binding_mismatch', 'history.json.source_root', '私人历史属于另一确切项目根，不能仅凭相同 ID 读取。');
          normalizedAbsoluteRoot(history.migration.backup_path); // Provenance only; never open the backup path.
          for (const folder of ['tasks', 'runs', 'artifacts']) await historyScope.inspect(`${namespace}/${folder}`, true);
        } else {
          const entries = await historyScope.entries(namespace, this.limits.directoryEntries);
          for (const entry of entries) {
            if (!['tasks', 'runs', 'artifacts'].includes(entry)) throw issue('unbound_history', 'history.json', '私人历史已有内容却缺少 history.json 绑定清单。');
            const relative = `${namespace}/${entry}`;
            if ((await historyScope.entries(relative, this.limits.directoryEntries)).length) throw issue('unbound_history', relative, '私人历史已有内容却缺少 history.json 绑定清单。');
          }
        }
      }
      const tasks: ProjectTask[] = [];
      const runs: ProjectRun[] = [];
      const taskIDs = new Set<string>();
      const runIDs = new Set<string>();
      let taskNames: string[] = [];
      let runNames: string[] = [];
      if (history && historyScope) {
        taskNames = await historyScope.entries(`${namespace}/tasks`, this.limits.tasks);
        runNames = await historyScope.entries(`${namespace}/runs`, this.limits.runs);
        for (const name of taskNames) {
          if (!name.endsWith('.json')) throw issue('unexpected_record', `${namespace}/tasks/${name}`, '记录目录只允许普通 .json 文件。');
          const task = parse<ProjectTask>(await historyScope.read(`${namespace}/tasks/${name}`, this.limits.jsonBytes), 'task', `tasks/${name}`);
          if (taskIDs.has(task.task_id)) throw issue('duplicate_task_id', `tasks/${name}`, 'task_id 重复。');
          taskIDs.add(task.task_id);
          if (name !== `${task.task_id}.json`) throw issue('record_filename_mismatch', `tasks/${name}`, '文件名必须与 task_id 一致。');
          tasks.push(task);
        }
        for (const name of runNames) {
          if (!name.endsWith('.json')) throw issue('unexpected_record', `${namespace}/runs/${name}`, '记录目录只允许普通 .json 文件。');
          const run = parse<ProjectRun>(await historyScope.read(`${namespace}/runs/${name}`, this.limits.jsonBytes), 'run', `runs/${name}`);
          if (runIDs.has(run.run_id)) throw issue('duplicate_run_id', `runs/${name}`, 'run_id 重复。');
          runIDs.add(run.run_id);
          if (name !== `${run.run_id}.json`) throw issue('record_filename_mismatch', `runs/${name}`, '文件名必须与 run_id 一致。');
          runs.push(run);
        }
      }
      this.validateRelationships(projectID, tasks, runs);
      const artifactRefs: ArtifactReferenceDTO[] = [];
      const groups: Array<{ kind: 'project' | 'task' | 'run'; id: string; references: RecordReference[] }> = [
        { kind: 'project', id: projectID, references: history?.project.references ?? [] },
        ...tasks.map(task => ({ kind: 'task' as const, id: task.task_id, references: task.references })),
        ...runs.map(run => ({ kind: 'run' as const, id: run.run_id, references: run.references })),
      ];
      for (const group of groups) {
        for (const [index, reference] of group.references.entries()) {
          const resolved = resolveReference(reference, projectID);
          const scope = resolved.source === 'project' ? rootScope : historyScope;
          if (!scope || (resolved.source === 'private' && !history)) throw issue('unbound_reference', reference.path, '私人引用缺少历史绑定。');
          await scope.inspect(resolved.source === 'project' ? resolved.relative : `${namespace}/${resolved.relative}`);
          artifactRefs.push({ reference_id: `ref-${sha256(Buffer.from(`${group.kind}\0${group.id}\0${index}\0${reference.path}\0${reference.label}`)).slice(0, 32)}`, project_id: projectID, owner_kind: group.kind, owner_id: group.id, label: reference.label, path: reference.path, source: resolved.source, preview_type: resolved.source === 'private' && !resolved.relative.startsWith('artifacts/') ? 'unsupported' : previewType(resolved.relative) });
        }
      }
      if (historyScope && history) {
        if (JSON.stringify(taskNames) !== JSON.stringify(await historyScope.entries(`${namespace}/tasks`, this.limits.tasks)) || JSON.stringify(runNames) !== JSON.stringify(await historyScope.entries(`${namespace}/runs`, this.limits.runs))) throw issue('source_changed', namespace, '读取期间记录目录发生变化，请刷新重试。');
      }
      await rootScope.recheck();
      await historyScope?.recheck();
      const result: ProjectWorkspaceResult = {
        status: tasks.length || runs.length ? 'ready' : 'empty',
        project: { ...identity, root_path: root, history_bound: history !== null, readonly: true },
        tasks: tasks.map(task => ({ ...task, historical: true, is_live: false })), runs: runs.map(run => ({ ...run, historical: true, is_live: false })), artifact_refs: artifactRefs,
        diagnostics: !history ? [{ code: 'no_bound_history', severity: 'info', path: 'history.json', message: '项目身份有效；尚无绑定的私人任务历史。读取不会创建身份、记录或迁移数据。' }]
          : !tasks.length && !runs.length ? [{ code: 'no_records', severity: 'info', path: 'tasks/runs', message: '身份与私人历史绑定有效；目前没有任务和执行记录。' }] : [],
        loaded_at: new Date().toISOString(), historical: true,
      };
      return { result, root, identityHash: sha256(identityBytes), historyHash, stale: false };
    } finally { await rootScope?.close(); await historyScope?.close(); }
  }

  private validateRelationships(projectID: string, tasks: ProjectTask[], runs: ProjectRun[]): void {
    const taskMap = new Map(tasks.map(task => [task.task_id, task]));
    const runMap = new Map(runs.map(run => [run.run_id, run]));
    for (const task of tasks) {
      const location = `tasks/${task.task_id}.json`;
      if (task.project_id !== projectID) throw issue('identity_mismatch', location, '任务 project_id 与项目身份不一致。');
      if (new Set(task.acceptance.map(item => item.id)).size !== task.acceptance.length) throw issue('duplicate_acceptance_id', location, '验收项 id 重复。');
      if (task.status === 'completed' && task.acceptance.some(item => item.verification !== 'verified')) throw issue('invalid_completed_task', location, 'completed 任务的所有验收项必须 verified。');
      if (Date.parse(task.updated_at) < Date.parse(task.created_at)) throw issue('invalid_timestamp_order', location, 'updated_at 早于 created_at。');
      for (const runID of task.run_ids) {
        const run = runMap.get(runID);
        if (!run || run.task_id !== task.task_id) throw issue('broken_run_link', location, `缺少匹配任务的执行记录 ${runID}。`);
      }
    }
    for (const run of runs) {
      const location = `runs/${run.run_id}.json`;
      if (run.project_id !== projectID) throw issue('identity_mismatch', location, '执行 project_id 与项目身份不一致。');
      const task = taskMap.get(run.task_id);
      if (!task || !task.run_ids.includes(run.run_id)) throw issue('broken_task_link', location, '执行记录缺少任务或未列入任务 run_ids。');
      if (run.plan_version > task.plan_version) throw issue('invalid_plan_version', location, '执行 plan_version 超过任务版本。');
      if (run.status === 'completed' && run.ended_at === null || run.status === 'running' && run.ended_at !== null) throw issue('invalid_run_end', location, '执行状态与 ended_at 不一致。');
      if (run.started_at !== null && run.ended_at !== null && Date.parse(run.ended_at) < Date.parse(run.started_at)) throw issue('invalid_timestamp_order', location, 'ended_at 早于 started_at。');
      if (run.git.commit_status === 'committed' && !run.git.commit_ids.length || run.git.commit_status !== 'committed' && run.git.commit_ids.length || run.git.push_status === 'pushed' && run.git.commit_status !== 'committed') throw issue('invalid_git_state', location, 'git 状态与本次提交记录不一致。');
    }
  }
}
