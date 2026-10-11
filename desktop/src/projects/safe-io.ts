import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, readlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export class ProjectReadFailure extends Error {
  constructor(public readonly code: string, public readonly location: string, message: string) { super(message); this.name = 'ProjectReadFailure'; }
}

type Signature = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint };
const signature = (info: BigIntStats): Signature => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, mode: info.mode });
const equal = (left: Signature, right: Signature) => Object.keys(left).every(key => left[key as keyof Signature] === right[key as keyof Signature]);
const directoryIdentity = (left: Signature, right: Signature) => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
const failure = (code: string, location: string, message: string) => new ProjectReadFailure(code, location, message);
export const isMissing = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export function normalizedAbsoluteRoot(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || !path.isAbsolute(value) || value === '/') {
    throw failure('invalid_root', '项目目录', '请选择确切的本机项目文件夹。');
  }
  const trimmed = value.replace(/\/+$/, '');
  if (path.resolve(trimmed) !== trimmed) throw failure('invalid_root', '项目目录', '项目根必须是无越界组件的规范绝对路径。');
  return trimmed;
}

async function systemAliasRoot(value: string): Promise<string> {
  const checked = normalizedAbsoluteRoot(value);
  for (const alias of ['tmp', 'var']) {
    if (checked === `/${alias}` || checked.startsWith(`/${alias}/`)) {
      const target = await readlink(`/${alias}`).catch(() => '');
      if (target !== `private/${alias}` && target !== `/private/${alias}`) throw failure('unsafe_root', '项目目录', '系统目录别名无效。');
      return `/private${checked}`;
    }
  }
  return checked;
}

export function relativeParts(value: string): string[] {
  if (!value || Buffer.byteLength(value) > 4096 || /[\\\0%?#:]/.test(value) || value.startsWith('/')) {
    throw failure('unsafe_reference', value, '引用必须是受控目录内的规范相对路径，不支持 URL、编码或参数。');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw failure('unsafe_reference', value, '拒绝越界或非规范引用路径。');
  return parts;
}

/**
 * Guarded native Node reads. O_NOFOLLOW protects leaf files; directory identities
 * and complete before/after signatures reject changed snapshots. Node has no
 * openat: this is not an OS sandbox or equivalent to descriptor-relative openat
 * against a malicious process racing ancestor-directory replacements.
 */
export class SafeReadScope {
  private directories = new Map<string, { expected: Signature; handle: FileHandle }>();
  private files = new Map<string, Signature>();
  private missing = new Set<string>();
  private listings = new Map<string, { names: string[]; maximum: number }>();
  private constructor(public readonly root: string) {}

  static async create(root: string): Promise<SafeReadScope> {
    const scope = new SafeReadScope(await systemAliasRoot(root));
    try { await scope.directoryAbsolute(scope.root); return scope; }
    catch (error) { await scope.close(); throw error; }
  }

  private async directoryAbsolute(absolute: string): Promise<void> {
    let current = '/';
    for (const part of absolute.split('/').filter(Boolean)) {
      current = path.join(current, part);
      if (this.directories.has(current)) continue;
      let handle: FileHandle | undefined;
      try {
        const before = await lstat(current, { bigint: true });
        if (before.isSymbolicLink() || !before.isDirectory()) throw failure('unsafe_path', current, '目录不存在、类型错误或含符号链接。');
        handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isDirectory() || !directoryIdentity(signature(before), signature(opened))) throw failure('source_changed', current, '读取期间目录位置发生变化，请刷新重试。');
        this.directories.set(current, { expected: signature(opened), handle });
        handle = undefined;
      } finally { await handle?.close(); }
    }
  }

  private resolve(relative: string): string { return path.join(this.root, ...relativeParts(relative)); }

  async inspect(relative: string, directory = false): Promise<Signature> {
    const absolute = this.resolve(relative);
    await this.directoryAbsolute(directory ? absolute : path.dirname(absolute));
    const info = await lstat(absolute, { bigint: true });
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw failure('unsafe_path', relative, '引用或记录必须是普通文件，不能使用符号链接。');
    const expected = signature(info);
    const previous = this.files.get(absolute);
    if (previous && !equal(previous, expected)) throw failure('source_changed', relative, '读取期间文件位置或内容发生变化，请刷新重试。');
    if (!directory) this.files.set(absolute, expected);
    return expected;
  }

  async exists(relative: string, directory = false): Promise<boolean> {
    try { await this.inspect(relative, directory); return true; }
    catch (error) { if (isMissing(error)) { this.missing.add(this.resolve(relative)); return false; } throw error; }
  }

  async entries(relative: string, maximum: number): Promise<string[]> {
    await this.inspect(relative, true);
    const absolute = this.resolve(relative);
    const names = await this.directoryNames(absolute, maximum);
    const previous = this.listings.get(absolute);
    if (previous && JSON.stringify(previous.names) !== JSON.stringify(names)) throw failure('source_changed', relative, '读取期间记录目录发生变化，请刷新重试。');
    this.listings.set(absolute, { names, maximum });
    await this.recheckDirectories();
    return names;
  }

  private async directoryNames(absolute: string, maximum: number): Promise<string[]> {
    const names: string[] = [];
    const directory = await opendir(absolute);
    for await (const entry of directory) {
      if (names.length >= maximum) throw failure('entry_limit', absolute, `目录超过 ${maximum} 条目上限。`);
      if (entry.isSymbolicLink()) throw failure('unsafe_path', `${absolute}/${entry.name}`, '目录包含符号链接。');
      names.push(entry.name);
    }
    return names.sort();
  }

  async read(relative: string, maximum: number): Promise<Buffer> {
    const absolute = this.resolve(relative);
    const expected = await this.inspect(relative);
    if (expected.size > BigInt(maximum)) throw failure('file_size_limit', relative, `文件超过 ${maximum} 字节上限。`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !equal(expected, signature(before))) throw failure('source_changed', relative, '文件位置或内容发生变化，请刷新重试。');
      await this.recheckDirectories();
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maximum) throw failure('file_size_limit', relative, `文件超过 ${maximum} 字节上限。`);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const data = Buffer.concat(chunks, total);
      if (BigInt(data.length) !== expected.size || !equal(expected, signature(await handle.stat({ bigint: true })))) throw failure('source_changed', relative, '读取期间文件发生变化，请刷新重试。');
      await this.recheckDirectories();
      const current = await lstat(absolute, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile() || !equal(expected, signature(current))) throw failure('source_changed', relative, '读取期间文件位置或内容发生变化，请刷新重试。');
      return data;
    } finally { await handle?.close(); }
  }

  private async recheckDirectories(): Promise<void> {
    for (const [location, { expected, handle }] of this.directories) {
      const current = await lstat(location, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || !directoryIdentity(expected, signature(current)) || !directoryIdentity(expected, signature(await handle.stat({ bigint: true })))) {
        throw failure('source_changed', location, '读取期间目录位置发生变化，请刷新重试。');
      }
    }
  }

  async recheck(): Promise<void> {
    await this.recheckDirectories();
    for (const [location, expected] of this.files) {
      const current = await lstat(location, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile() || !equal(expected, signature(current))) throw failure('source_changed', location, '读取期间文件位置或内容发生变化，请刷新重试。');
    }
    for (const location of this.missing) {
      try { await lstat(location); }
      catch (error) { if (isMissing(error)) continue; throw error; }
      throw failure('source_changed', location, '读取期间原先缺失的来源出现，请刷新重试。');
    }
    for (const [location, { names, maximum }] of this.listings) {
      if (JSON.stringify(names) !== JSON.stringify(await this.directoryNames(location, maximum))) throw failure('source_changed', location, '读取期间记录目录发生变化，请刷新重试。');
    }
  }

  async close(): Promise<void> { await Promise.allSettled([...this.directories.values()].map(({ handle }) => handle.close())); this.directories.clear(); }
}
