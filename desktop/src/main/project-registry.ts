import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectWorkspaceReader } from '../projects/index.js';
import type { ProjectWorkspaceResult } from '../projects/types.js';
import type { ProjectSourceDiagnostic } from '../shared/desktop-api.js';
import { StorageError } from '../core/storage/private-storage.js';
import type { LocalState } from './local-state.js';

const KEY = 'project-roots';
const sourceID = (root: string) => createHash('sha256').update(path.resolve(root)).digest('hex');
const label = (root: string) => path.basename(path.resolve(root)) || '项目';
const validRoots = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100 || value.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || Buffer.byteLength(root) > 4096)) throw new StorageError('project-registry-invalid', '项目列表暂时无法读取，原登记记录未覆盖。');
  return value;
};

/** Owns preview project registration and its recovery diagnostics, never project records. */
export class ProjectRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  private restored = false;
  private blocked = false;
  private indexIssue?: ProjectSourceDiagnostic;
  private readonly sourceIssues = new Map<string, ProjectSourceDiagnostic>();
  private readonly saveIssues = new Map<string, ProjectSourceDiagnostic>();

  constructor(private readonly local: Pick<LocalState, 'read' | 'write'>, private readonly projects: Pick<ProjectWorkspaceReader, 'read' | 'refresh' | 'get'>) {}

  initialize(initialRoot?: string): Promise<void> {
    return this.serial(async () => {
      await this.restore();
      if (initialRoot) await this.chooseInside(initialRoot);
    });
  }

  diagnostics(): ProjectSourceDiagnostic[] {
    const issues = new Map(this.saveIssues);
    for (const [id, issue] of this.sourceIssues) issues.set(id, issue);
    return structuredClone([...(this.indexIssue ? [this.indexIssue] : []), ...issues.values()]);
  }

  choose(root: string): Promise<ProjectWorkspaceResult> {
    return this.serial(async () => { await this.restore(); return this.chooseInside(root); });
  }

  refresh(projectID: string): Promise<ProjectWorkspaceResult> {
    return this.serial(async () => {
      await this.restore();
      const root = this.projects.get(projectID)?.project?.root_path;
      const result = await this.projects.refresh(projectID);
      if (root) this.observe(root, result);
      return result;
    });
  }

  private async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    let roots: string[];
    try { roots = await this.readRoots(); }
    catch { this.blockIndex(); return; }
    for (const root of roots) this.observe(root, await this.projects.read(root));
  }

  private async chooseInside(root: string): Promise<ProjectWorkspaceResult> {
    const result = await this.projects.read(root);
    this.observe(root, result);
    if (!result.project || result.status === 'stale' || result.status === 'error' || this.blocked) return result;
    const selectedRoot = result.project.root_path;
    const id = sourceID(selectedRoot);
    let roots: string[];
    try { roots = await this.readRoots(); }
    catch { this.blockIndex(); return result; }
    // Merge into the stored array, retaining registrations whose source cannot currently be read.
    const next = [...roots.filter(value => sourceID(value) !== id), selectedRoot];
    try {
      if (next.length > 100) throw new StorageError('project-registry-limit', '项目登记数量已达上限。');
      if (JSON.stringify(next) !== JSON.stringify(roots)) await this.local.write(KEY, next);
      this.saveIssues.delete(id);
    } catch {
      this.saveIssues.set(id, { sourceID: id, label: label(selectedRoot), code: 'project_registry_write_failed', message: '项目已读取，但项目列表未能保存；下次启动可能需要重新选择。' });
    }
    return result;
  }

  private observe(root: string, result: ProjectWorkspaceResult): void {
    const id = sourceID(root);
    if (result.project) { this.sourceIssues.delete(id); return; }
    const issue = result.diagnostics[0];
    this.sourceIssues.set(id, { sourceID: id, label: label(root), code: issue?.code ?? 'read_failed', message: issue?.message ?? '项目记录暂时无法读取，请重新选择项目。' });
  }

  private readRoots(): Promise<string[]> { return this.local.read<unknown>(KEY, []).then(validRoots); }
  private blockIndex(): void {
    this.blocked = true;
    this.indexIssue = { sourceID: 'project-registry', label: '项目列表', code: 'project_registry_unreadable', message: '项目列表暂时无法读取，原登记记录未覆盖。' };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}
