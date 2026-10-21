import { join } from 'node:path';
import { atomicReplace, readBytes, safeRoot, StorageError, withExclusiveLock } from './private-storage.js';
import { fileDigest } from '../tools/write.js';
import { validateFileRef, type FileMaterialRef, type FileTurnRef, type ArtifactRole } from '../sessions/file-task-schema.js';
const limit = (role: ArtifactRole) => role === 'diff' ? 1024 * 1024 : role === 'proposal' ? 256 * 1024 : 64 * 1024;
const roles: ArtifactRole[] = ['baseline', 'replacement', 'proposal', 'result', 'diff'];
/** Immutable bytes, addressed by original Turn and role; no authority or target writes. */
export class ExecutionArtifactStore {
  constructor(private readonly root: string) { safeRoot(root); }
  private path(ref: FileTurnRef, role: ArtifactRole): string {
    validateFileRef(ref); if (!roles.includes(role)) throw new StorageError('invalid-artifact', '材料角色无效。');
    return join(this.root, 'execution-artifacts-v1', ref.session.sessionID, ref.turnID, `${role}.txt`);
  }
  async put(ref: FileTurnRef, role: ArtifactRole, input: Uint8Array): Promise<FileMaterialRef> {
    const LIMIT = limit(role); const bytes = Buffer.from(input); const file = this.path(ref, role);
    if (bytes.length > LIMIT) throw new StorageError('too-large', '材料超过容量上限。');
    await withExclusiveLock(`${file}.lock`, async () => {
      const current = await readBytes(file, LIMIT);
      if (current) { if (!current.equals(bytes)) throw new StorageError('artifact-conflict', '原材料不可改写。'); return; }
      await atomicReplace(file, bytes, undefined, LIMIT);
    });
    return { role, contentDigest: fileDigest(bytes) };
  }
  async read(ref: FileTurnRef, material: FileMaterialRef): Promise<Uint8Array> {
    const bytes = await readBytes(this.path(ref, material.role), limit(material.role));
    if (!bytes || fileDigest(bytes) !== material.contentDigest) throw new StorageError('artifact-conflict', '材料缺失或摘要不匹配。');
    return bytes;
  }
}
