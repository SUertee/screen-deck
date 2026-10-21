import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { checkDirectories, safeRoot, StorageError, isMissing } from '../storage/private-storage.js';

export const FILE_WRITE_LIMIT = 64 * 1024;
export interface FsIdentity { device: string; inode: string }
export interface FileWriteTarget {
  workspaceRoot: string; workspaceIdentity: FsIdentity; leafName: string;
  baseIdentity: FsIdentity; expectedBaseDigest: string;
}
export interface HostWriteIntent { stagedName: string; stagedIdentity: FsIdentity }
export type FileWriteEffect =
  | { status: 'applied'; observedIdentity: FsIdentity; bytes: Uint8Array }
  | { status: 'not-applied' | 'unknown'; reason: string };
declare const handleBrand: unique symbol;
export interface FileWriteHandle { readonly [handleBrand]: true }
export const fileDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string): never => { throw new StorageError(code, `文件工具检查失败（${code}）。`); };
export function validateDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid-digest');
}
export function validateIdentity(value: unknown): asserts value is FsIdentity {
  const v = value as FsIdentity;
  if (!v || Object.keys(v).sort().join(',') !== 'device,inode' || !/^\d+$/.test(v.device) || !/^\d+$/.test(v.inode) || typeof v.device !== 'string' || typeof v.inode !== 'string') fail('invalid-identity');
}
export const sameIdentity = (a: FsIdentity, b: FsIdentity): boolean => a.device === b.device && a.inode === b.inode;
export const identityOf = (stat: { dev: bigint; ino: bigint }): FsIdentity => ({ device: String(stat.dev), inode: String(stat.ino) });
export function validateLeaf(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value === '.' || value.includes('..') || /[/\\\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 200) fail('invalid-leaf');
}
export function validateFileTarget(target: FileWriteTarget): void {
  if (!target || Object.keys(target).sort().join(',') !== 'baseIdentity,expectedBaseDigest,leafName,workspaceIdentity,workspaceRoot') fail('invalid-target');
  if (safeRoot(target.workspaceRoot) !== target.workspaceRoot) fail('invalid-root');
  validateLeaf(target.leafName); validateIdentity(target.workspaceIdentity); validateIdentity(target.baseIdentity); validateDigest(target.expectedBaseDigest);
}
export function validateTextBytes(input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array) || input.byteLength > FILE_WRITE_LIMIT) fail('invalid-text');
  const bytes = Buffer.from(input);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid-utf8'); }
  if (bytes.includes(0)) fail('invalid-text');
  return bytes;
}
export async function syncFileDirectory(root: string): Promise<void> {
  const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function rootMatches(target: FileWriteTarget): Promise<void> {
  if (!await checkDirectories(target.workspaceRoot)) fail('missing-workspace');
  const stat = await lstat(target.workspaceRoot, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identityOf(stat), target.workspaceIdentity)) fail('workspace-changed');
}
async function readFileEvidence(file: string): Promise<{ bytes: Buffer; identity: FsIdentity }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(FILE_WRITE_LIMIT)) fail('unsafe-file');
    const bytes = Buffer.alloc(FILE_WRITE_LIMIT + 1); let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break; size += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (size > FILE_WRITE_LIMIT || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size) fail('file-changed');
    const linked = await lstat(file, { bigint: true });
    if (!linked.isFile() || linked.nlink !== 1n || !sameIdentity(identityOf(after), identityOf(linked))) fail('file-changed');
    return { bytes: validateTextBytes(bytes.subarray(0, size)), identity: identityOf(after) };
  } finally { await handle.close(); }
}
export async function inspectFileTarget(target: FileWriteTarget): Promise<Uint8Array> {
  validateFileTarget(target); await rootMatches(target);
  const observed = await readFileEvidence(join(target.workspaceRoot, target.leafName));
  if (!sameIdentity(observed.identity, target.baseIdentity) || fileDigest(observed.bytes) !== target.expectedBaseDigest) fail('baseline-changed');
  return observed.bytes;
}
interface Staged { target: FileWriteTarget; bytes: Buffer; digest: string; intent: HostWriteIntent; consumed: boolean }
/** Main-internal I/O only. The caller owns durable claims, approval and the workspace lock. */
export class FileWriteTool {
  private readonly handles = new WeakMap<FileWriteHandle, Staged>();
  constructor(private readonly io: { rename?: typeof rename; syncDirectory?: typeof syncFileDirectory } = {}) {}
  async stage(target: FileWriteTarget, replacement: { bytes: Uint8Array; contentDigest: string }): Promise<{ handle: FileWriteHandle; intent: HostWriteIntent }> {
    const frozen = structuredClone(target); validateFileTarget(frozen);
    const bytes = validateTextBytes(replacement.bytes); validateDigest(replacement.contentDigest);
    if (fileDigest(bytes) !== replacement.contentDigest) fail('replacement-changed');
    const base = await inspectFileTarget(frozen);
    if (Buffer.from(base).equals(bytes)) fail('no-change');
    const stagedName = `.sd-${randomUUID()}.tmp`, file = join(frozen.workspaceRoot, stagedName);
    if (stagedName === frozen.leafName) fail('invalid-leaf');
    const stream = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let completed = false;
    try {
      await stream.writeFile(bytes); await stream.sync();
      const stat = await stream.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.dev.toString() !== frozen.workspaceIdentity.device) fail('unsafe-stage');
      const intent = { stagedName, stagedIdentity: identityOf(stat) };
      await (this.io.syncDirectory ?? syncFileDirectory)(frozen.workspaceRoot);
      const handle = Object.freeze({}) as FileWriteHandle;
      this.handles.set(handle, { target: frozen, bytes, digest: replacement.contentDigest, intent, consumed: false });
      completed = true; return { handle, intent: structuredClone(intent) };
    } finally {
      const original = identityOf(await stream.stat({ bigint: true })); await stream.close();
      if (!completed) {
        const current = await lstat(file, { bigint: true }).catch(() => undefined);
        if (current?.isFile() && sameIdentity(identityOf(current), original)) await unlink(file);
      }
    }
  }
  async commit(handle: FileWriteHandle, check: () => undefined): Promise<FileWriteEffect> {
    const staged = this.handles.get(handle);
    // Reserve synchronously before the first await: concurrent calls cannot both pass validation.
    if (!staged || staged.consumed) return fail('handle-consumed');
    staged.consumed = true; let dispatched = false;
    try {
      await inspectFileTarget(staged.target);
      const observed = await readFileEvidence(join(staged.target.workspaceRoot, staged.intent.stagedName));
      if (!sameIdentity(observed.identity, staged.intent.stagedIdentity) || fileDigest(observed.bytes) !== staged.digest) fail('stage-changed');
      await rootMatches(staged.target);
      if (check() !== undefined) fail('invalid-gate');
      dispatched = true;
      const pending = (this.io.rename ?? rename)(join(staged.target.workspaceRoot, staged.intent.stagedName), join(staged.target.workspaceRoot, staged.target.leafName));
      await pending;
      await (this.io.syncDirectory ?? syncFileDirectory)(staged.target.workspaceRoot);
      return await this.inspect(staged.target, staged.digest, staged.intent, 'stopped');
    } catch (error) {
      return { status: dispatched ? 'unknown' : 'not-applied', reason: error instanceof StorageError ? error.code : 'file-io-failed' };
    }
  }
  async inspect(target: FileWriteTarget, replacementDigest: string, intent: HostWriteIntent, writerState: 'stopped' | 'unknown'): Promise<FileWriteEffect> {
    if (writerState !== 'stopped') return { status: 'unknown', reason: 'writer-unconfirmed' };
    try {
      validateFileTarget(target); validateDigest(replacementDigest); validateIdentity(intent.stagedIdentity);
      if (Object.keys(intent).sort().join(',') !== 'stagedIdentity,stagedName' || !/^\.sd-[0-9a-f-]{36}\.tmp$/.test(intent.stagedName) || intent.stagedName === target.leafName) fail('invalid-intent');
      await rootMatches(target);
      const actual = await readFileEvidence(join(target.workspaceRoot, target.leafName));
      if (sameIdentity(actual.identity, intent.stagedIdentity) && fileDigest(actual.bytes) === replacementDigest) return { status: 'applied', observedIdentity: actual.identity, bytes: actual.bytes };
      const stage = await readFileEvidence(join(target.workspaceRoot, intent.stagedName)).catch(error => { if (isMissing(error)) return undefined; throw error; });
      if (stage && sameIdentity(stage.identity, intent.stagedIdentity) && fileDigest(stage.bytes) === replacementDigest && sameIdentity(actual.identity, target.baseIdentity) && fileDigest(actual.bytes) === target.expectedBaseDigest) return { status: 'not-applied', reason: 'original-unchanged' };
      return { status: 'unknown', reason: 'evidence-mismatch' };
    } catch { return { status: 'unknown', reason: 'evidence-unavailable' }; }
  }
}
