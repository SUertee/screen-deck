import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../storage/private-storage.js';
import { canonicalDigest, exactObject } from '../storage/execution-records.js';
import { isUUID } from '../sessions/session-schema.js';
import { digestString } from './native-work-item-durable-schema.js';
import type { NativeWorkItemEvidence } from './native-work-item-evidence.js';
const LIMIT = 2 * 1024 * 1024;
/** Immutable observed evidence snapshots. Historical hashes are not proof that current files match. */
export class NativeWorkItemEvidenceStore {
  private root: string;
  constructor(root: string) { this.root = safeRoot(root); }
  async record(input: NativeWorkItemEvidence): Promise<void> {
    const value = this.validate(input), dir = this.directory(value.attemptID), file = join(dir, value.digest + '.json');
    await withExclusiveLock(join(this.root, `.native-evidence-${value.attemptID}.lock`), async () => {
      await checkDirectories(dir, true);
      const old = await readBytes(file, LIMIT);
      if (old) { if (canonicalDigest(this.validate(JSON.parse(old.toString()))) !== canonicalDigest(value)) throw new StorageError('evidence-conflict', '历史证据不可覆盖。'); return; }
      const entries = await readdir(dir, { withFileTypes: true });
      if (entries.length >= 64 || entries.some(e => !e.isFile() || e.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(e.name))) throw new StorageError('evidence-capacity', '证据目录无效或已达到上限。');
      await atomicReplace(file, Buffer.from(JSON.stringify(value)), undefined, LIMIT);
    });
  }
  async load(attemptID: string, digest: string): Promise<NativeWorkItemEvidence | undefined> {
    if (!digestString(digest)) throw new StorageError('invalid-evidence', '证据指纹无效。');
    const bytes = await readBytes(join(this.directory(attemptID), digest + '.json'), LIMIT); if (!bytes) return undefined;
    const evidence = this.validate(JSON.parse(bytes.toString()));
    if (evidence.attemptID !== attemptID || evidence.digest !== digest) throw new StorageError('invalid-evidence', '历史证据绑定不匹配。'); return evidence;
  }
  private directory(attemptID: string): string {
    if (!isUUID(attemptID)) throw new StorageError('invalid-evidence', '尝试标识无效。');
    return join(this.root, 'native-work-item-evidence-snapshots-v1', attemptID);
  }
  private validate(value: unknown): NativeWorkItemEvidence {
    const v = exactObject(value, ['attemptID', 'inputDigest', 'sessionID', 'turnID', 'clientRequestID', 'summary', 'native', 'digest'], ['host']);
    const e = v as unknown as NativeWorkItemEvidence, { digest, ...body } = e;
    if (![e.attemptID, e.sessionID, e.turnID, e.clientRequestID].every(isUUID) || !digestString(e.inputDigest) || !digestString(digest) || canonicalDigest(body) !== digest || typeof e.summary !== 'string' || e.native.sessionID !== e.sessionID || e.native.turnID !== e.turnID || e.native.clientRequestID !== e.clientRequestID) throw new StorageError('invalid-evidence', '历史证据内容或指纹无效。');
    return structuredClone(e);
  }
}
