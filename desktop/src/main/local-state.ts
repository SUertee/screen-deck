import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { atomicReplace, checkDirectories, readBytes, StorageError, withExclusiveLock } from '../core/private-storage.js';

/** Bounded preview-only settings/drafts. No writes to existing project/task history. */
export class LocalState {
  private queue: Promise<unknown> = Promise.resolve();
  private observed = new Map<string, Buffer | undefined>();
  constructor(private readonly root: string) {}
  async read<T>(name: string, fallback: T): Promise<T> {
    await this.queue;
    await checkDirectories(this.root, true);
    const filename = this.filename(name);
    const bytes = await readBytes(path.join(this.root, filename), 256 * 1024);
    this.observed.set(filename, bytes);
    if (!bytes) return fallback;
    try { return JSON.parse(bytes.toString('utf8')) as T; } catch { throw new StorageError('state-invalid', '预览本地记录无法读取，原记录未覆盖。'); }
  }
  write(name: string, value: unknown): Promise<void> {
    const operation = this.queue.then(async () => {
      await checkDirectories(this.root, true);
      const basename = this.filename(name);
      const filename = path.join(this.root, basename);
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 256 * 1024) throw new StorageError('state-limit', '本地草稿超过容量限制。');
      await withExclusiveLock(path.join(this.root, 'directory.lock'), async () => {
        const entries = await readdir(this.root);
        const records = entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry));
        if (records.length + (records.includes(basename) ? 0 : 1) > 1000) throw new StorageError('state-limit', '本地草稿份数达到上限。');
        let total = bytes.length;
        for (const record of records) {
          if (record === basename) continue;
          total += (await readBytes(path.join(this.root, record), 256 * 1024))?.length ?? 0;
          if (total > 2 * 1024 * 1024) throw new StorageError('state-limit', '本地草稿总容量达到上限。');
        }
        await atomicReplace(filename, bytes, this.observed.get(basename), 256 * 1024);
        this.observed.set(basename, bytes);
      });
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
  flush(): Promise<unknown> { return this.queue; }
  private filename(name: string): string {
    if (!name || name.length > 512 || name.includes('\0')) throw new StorageError('state-key', '本地记录标识无效。');
    return `${createHash('sha256').update(name).digest('hex')}.json`;
  }
}
