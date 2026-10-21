import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { OpenCodeBinaryCandidate, OpenCodeInstallation } from '../shared/desktop-api.js';
import { StorageError } from '../core/storage/private-storage.js';
import type { LocalState } from './local-state.js';

export interface OpenCodeDiscoveryOptions {
  home?: string;
  searchPath?: string;
  standardDirectories?: string[];
}
interface BinaryLocation {
  schema_version: 1;
  kind: 'opencode_binary_location';
  binaryPath: string;
}
interface FileCandidate { id: string; path: string }
const STATE_KEY = 'opencode-binary';
const MAX_PATH_BYTES = 4096;
const MAX_SEARCH_BYTES = 64 * 1024;
const MAX_DIRECTORIES = 128;
const validPath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && Buffer.byteLength(value) <= MAX_PATH_BYTES && !/[\u0000-\u001f\u007f]/.test(value);
const unavailable = (error: unknown): boolean => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code ?? '');

/** Finds locations, never runs a binary or checks its version. Runtime owns those checks.
 * The remembered location is non-secret app state; only call remember after a successful
 * explicit runtime start. A manual choice is transient until that start succeeds.
 */
export class OpenCodeDiscovery {
  private readonly directories: Array<{ path: string; source: 'path' | 'standard' }>;
  private manual?: { requestedPath: string; candidate: FileCandidate };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly local: Pick<LocalState, 'read' | 'write'>, options: OpenCodeDiscoveryOptions = {}) {
    const home = options.home ?? homedir();
    const searchPath = options.searchPath ?? process.env.PATH ?? '';
    if (!validPath(home) || typeof searchPath !== 'string' || Buffer.byteLength(searchPath) > MAX_SEARCH_BYTES) throw new StorageError('discovery-input', 'OpenCode 搜索位置无效或超过上限。');
    const standard = options.standardDirectories ?? [
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    if (!Array.isArray(standard) || standard.length > MAX_DIRECTORIES || standard.some(directory => !validPath(directory))) throw new StorageError('discovery-input', 'OpenCode 标准搜索位置无效或超过上限。');
    const entries = searchPath.split(path.delimiter);
    if (entries.length > MAX_DIRECTORIES) throw new StorageError('discovery-limit', 'OpenCode 搜索位置过多，请手动指定程序。');
    const directories = new Map<string, 'path' | 'standard'>();
    // Empty/relative entries never mean the current working directory. No shell expansion.
    for (const directory of entries) if (validPath(directory)) directories.set(path.normalize(directory), 'path');
    for (const directory of standard) if (!directories.has(path.normalize(directory))) directories.set(path.normalize(directory), 'standard');
    if (directories.size > MAX_DIRECTORIES) throw new StorageError('discovery-limit', 'OpenCode 搜索位置过多，请手动指定程序。');
    this.directories = [...directories].map(([directory, source]) => ({ path: directory, source }));
  }

  discover(): Promise<OpenCodeInstallation> { return this.serial(() => this.scan()); }

  choose(binaryPath: string): Promise<OpenCodeBinaryCandidate> {
    return this.serial(async () => {
      if (!validPath(binaryPath)) throw new StorageError('discovery-binary', '请选择有效的 OpenCode 可执行文件。');
      const candidate = await this.file(binaryPath);
      if (!candidate) throw new StorageError('discovery-binary', '所选位置不是可用的普通可执行文件，请重新选择。');
      this.manual = { requestedPath: binaryPath, candidate };
      return { ...candidate, source: 'manual' };
    });
  }

  resolve(candidateID?: string): Promise<string> {
    return this.serial(async () => {
      if (candidateID !== undefined && (typeof candidateID !== 'string' || !/^[a-f0-9]{64}$/.test(candidateID))) throw new StorageError('discovery-candidate', '程序候选无效，请重新检测或手动选择。');
      const installation = await this.scan();
      const selectedID = candidateID ?? installation.preferredID;
      if (!selectedID) {
        if (!installation.candidates.length) throw new StorageError('discovery-missing', '未找到 OpenCode，请安装支持版本或手动选择程序。');
        throw new StorageError('discovery-ambiguous', '检测到多个 OpenCode，请先选择本次使用的程序。');
      }
      const selected = installation.candidates.find(candidate => candidate.id === selectedID);
      if (!selected) throw new StorageError('discovery-changed', '所选程序位置已变化或失效，请重新检测或手动选择。');
      // A selected renderer ID is not a path. Recheck the exact canonical target before handoff.
      const current = await this.file(selected.path);
      if (!current || current.id !== selected.id) throw new StorageError('discovery-changed', '所选程序文件已变化，请重新检测或手动选择。');
      return current.path;
    });
  }

  remember(binaryPath: string): Promise<void> {
    return this.serial(async () => {
      if (!validPath(binaryPath)) throw new StorageError('discovery-binary', '已连接的程序位置无法确认，未保存位置。');
      const candidate = await this.file(binaryPath);
      if (!candidate) throw new StorageError('discovery-binary', '已连接的程序位置已失效，未保存位置。');
      // Read first for LocalState byte CAS, and never replace a malformed/future record.
      await this.location();
      const location: BinaryLocation = { schema_version: 1, kind: 'opencode_binary_location', binaryPath: candidate.path };
      try { await this.local.write(STATE_KEY, location); }
      catch { throw new StorageError('discovery-save', 'OpenCode 已连接，但程序位置未能保存；下次请重新检测。'); }
      this.manual = undefined;
    });
  }

  private async scan(): Promise<OpenCodeInstallation> {
    const location = await this.location();
    const candidates = new Map<string, OpenCodeBinaryCandidate>();
    let rememberedID: string | undefined;
    let manualID: string | undefined;
    const add = (candidate: FileCandidate | undefined, source: OpenCodeBinaryCandidate['source']): string | undefined => {
      if (!candidate) return undefined;
      const existing = candidates.get(candidate.path);
      if (existing && existing.id !== candidate.id) throw new StorageError('discovery-changed', 'OpenCode 程序文件在检测时发生变化，请重新检测。');
      if (!candidates.has(candidate.path)) candidates.set(candidate.path, { ...candidate, source });
      return candidate.id;
    };
    if (location) rememberedID = add(await this.file(location.binaryPath), 'remembered');
    if (this.manual) {
      const current = await this.file(this.manual.requestedPath);
      // A changed symlink or replacement never becomes an implicit new manual choice.
      if (current?.id === this.manual.candidate.id) manualID = add(current, 'manual');
    }
    for (const directory of this.directories) add(await this.file(path.join(directory.path, 'opencode')), directory.source);
    const records = [...candidates.values()];
    const preferredID = manualID ?? rememberedID ?? (records.length === 1 ? records[0]!.id : undefined);
    return { candidates: records, ...(preferredID ? { preferredID } : {}) };
  }

  private async location(): Promise<BinaryLocation | undefined> {
    let value: unknown;
    try { value = await this.local.read<unknown>(STATE_KEY, undefined); }
    catch { throw new StorageError('discovery-state', 'OpenCode 位置记录无法安全读取，未覆盖原记录。'); }
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('discovery-state', 'OpenCode 位置记录格式无效，未覆盖原记录。');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || !Object.keys(record).every(key => ['schema_version', 'kind', 'binaryPath'].includes(key)) || record.schema_version !== 1 || record.kind !== 'opencode_binary_location' || !validPath(record.binaryPath) || path.normalize(record.binaryPath) !== record.binaryPath) throw new StorageError('discovery-state', 'OpenCode 位置记录版本或字段无效，未覆盖原记录。');
    return record as unknown as BinaryLocation;
  }

  private async file(binaryPath: string): Promise<FileCandidate | undefined> {
    if (!validPath(binaryPath)) return undefined;
    try {
      const canonical = await realpath(binaryPath);
      if (!validPath(canonical)) return undefined;
      const before = await lstat(canonical);
      if (!before.isFile() || before.isSymbolicLink()) return undefined;
      await access(canonical, constants.X_OK);
      const after = await lstat(canonical);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(binaryPath) !== canonical) throw new StorageError('discovery-changed', 'OpenCode 程序位置在检测时发生变化，请重新检测。');
      const id = createHash('sha256').update(JSON.stringify({ path: canonical, dev: after.dev, ino: after.ino, size: after.size, modified: after.mtimeMs, changed: after.ctimeMs })).digest('hex');
      return { id, path: canonical };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (unavailable(error)) return undefined;
      throw new StorageError('discovery-read', 'OpenCode 程序位置无法安全检查，请重新检测或手动选择。');
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
