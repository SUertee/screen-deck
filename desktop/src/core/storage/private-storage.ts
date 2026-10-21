import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class StorageError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'StorageError'; }
}
export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export function safeRoot(root: string): string {
  if (!isAbsolute(root) || root.includes('\0') || resolve(root) === parse(root).root) throw new StorageError('invalid-root', '存储目录无效。');
  return resolve(root);
}

/** Checking ancestors also rejects a symlink placed above a private data root. */
export async function checkDirectories(directory: string, create = false): Promise<boolean> {
  const absolute = safeRoot(directory);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!isMissing(error)) throw new StorageError('read-failed', '无法检查存储目录。');
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw new StorageError('write-failed', '无法创建存储目录。'); }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError('unsafe-path', '存储路径包含符号链接或非目录。');
  }
  return true;
}

export async function readBytes(file: string, limit: number): Promise<Buffer | undefined> {
  if (!(await checkDirectories(dirname(file)))) return undefined;
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new StorageError('unsafe-file', '无法安全读取记录文件。');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new StorageError('unsafe-file', '记录位置不是普通文件。');
    if (before.size > limit) throw new StorageError('too-large', '记录超过容量上限。');
    const chunks: Buffer[] = []; let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new StorageError('too-large', '记录超过容量上限。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat();
    if (bytes.byteLength > limit) throw new StorageError('too-large', '记录超过容量上限。');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new StorageError('revision-changed', '读取期间记录发生变化。');
    return bytes;
  } finally { await handle.close(); }
}

export async function withExclusiveLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await checkDirectories(dirname(file), true);
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new StorageError('locked', '记录正在由另一写入者保存；未覆盖或移除锁。'); }
  const token = randomUUID();
  try {
    await handle.writeFile(token); await handle.sync();
    return await operation();
  } finally {
    const original = await handle.stat();
    await handle.close();
    try {
      const current = await lstat(file);
      if (current.ino === original.ino && current.dev === original.dev && current.isFile() && !current.isSymbolicLink()) await unlink(file);
    } catch (error) { if (!isMissing(error)) throw new StorageError('lock-cleanup', '保存锁释放失败，需要人工检查。'); }
  }
}

/** Cooperating writers hold the lock; compare the exact previously observed bytes. */
export async function atomicReplace(file: string, bytes: Buffer, expected: Buffer | undefined, limit: number): Promise<void> {
  if (bytes.byteLength > limit) throw new StorageError('too-large', '待保存记录超过容量上限，原文件未覆盖。');
  await checkDirectories(dirname(file), true);
  const current = await readBytes(file, limit);
  if (expected === undefined ? current !== undefined : current === undefined || !expected.equals(current)) {
    throw new StorageError('revision-changed', '记录已由其他写入者修改，原文件未覆盖。');
  }
  const temporary = join(dirname(file), `.${file.slice(file.lastIndexOf('/') + 1)}.${randomUUID()}.tmp`);
  let handle;
  let replaced = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    const latest = await readBytes(file, limit);
    if (expected === undefined ? latest !== undefined : latest === undefined || !expected.equals(latest)) throw new StorageError('revision-changed', '保存期间记录发生变化，原文件未覆盖。');
    await checkDirectories(dirname(file));
    await rename(temporary, file); replaced = true;
    const directory = await open(dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(replaced ? 'write-uncertain' : 'write-failed', replaced ? '记录已替换，但持久化结果需重新读取核对。' : '记录保存失败，原文件未覆盖。');
  } finally {
    if (handle) await handle.close();
    if (!replaced) { try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw new StorageError('temporary-cleanup', '临时记录清理失败。'); } }
  }
}
