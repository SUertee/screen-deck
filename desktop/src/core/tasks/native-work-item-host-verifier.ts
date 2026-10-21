import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicReplace, checkDirectories, readBytes, safeRoot, StorageError, withExclusiveLock } from '../storage/private-storage.js';
import { boundedString, canonicalDigest, exactObject } from '../storage/execution-records.js';
import { fileDigest } from '../tools/write.js';
import { isUUID } from '../sessions/session-schema.js';
import { digestString, nativeInvalid } from './native-work-item-durable-schema.js';
import type { NativeHostReport, NativeHostVerifier, NativeWorkItemAttempt } from './native-work-item-contract.js';
export type NativeArtifactCheck = { name: string; path: string } & (
  { kind: 'sha256'; expected: string } | { kind: 'utf8-contains'; expected: string } | { kind: 'json-equals'; pointer: string[]; expected: unknown }
);
export interface NativeEvidenceSelection { artifacts: string[]; checks: NativeArtifactCheck[] }
interface SelectionRecord { schema_version: 1; kind: 'native_host_evidence_selection'; attemptID: string; inputDigest: string; contextDigest: string; workspaceIdentity: { dev: string; ino: string }; selection: NativeEvidenceSelection }
const LIMIT = 256 * 1024, ARTIFACT_LIMIT = 8 * 1024 * 1024;
function pathCheck(v: unknown): asserts v is string {
  if (!boundedString(v, 2048) || isAbsolute(v) || /[\\\x00-\x1f\x7f]/.test(v) || v.split('/').some(p => !p || p === '.' || p === '..')) nativeInvalid('产物必须是工作目录内的相对普通文件。');
}
export function validateNativeEvidenceSelection(value: unknown): NativeEvidenceSelection {
  const v = exactObject(value, ['artifacts', 'checks']);
  if (!Array.isArray(v.artifacts) || !v.artifacts.length || v.artifacts.length > 32 || !Array.isArray(v.checks) || !v.checks.length || v.checks.length > 64) nativeInvalid('需要明确的产物和宿主检查规则。');
  const s = v as unknown as NativeEvidenceSelection;
  s.artifacts.forEach(pathCheck);
  for (const c of s.checks) {
    exactObject(c, c.kind === 'json-equals' ? ['name', 'path', 'kind', 'pointer', 'expected'] : ['name', 'path', 'kind', 'expected']); pathCheck(c.path);
    if (!boundedString(c.name, 200) || c.name.startsWith('artifact:') || !s.artifacts.includes(c.path)) nativeInvalid();
    if (c.kind === 'sha256') { if (!digestString(c.expected)) nativeInvalid(); }
    else if (c.kind === 'utf8-contains') { if (!boundedString(c.expected, 8192)) nativeInvalid(); }
    else if (c.kind === 'json-equals') { if (!Array.isArray(c.pointer) || c.pointer.length > 16 || c.pointer.some(p => !boundedString(p, 200) || ['__proto__', 'prototype', 'constructor'].includes(p))) nativeInvalid(); canonicalDigest(c.expected); }
    else nativeInvalid();
  }
  if (new Set(s.artifacts).size !== s.artifacts.length || new Set(s.checks.map(c => c.name)).size !== s.checks.length) nativeInvalid();
  if (Buffer.byteLength(JSON.stringify(s)) > LIMIT / 2) nativeInvalid();
  return structuredClone(s);
}
/** Read-only verification, not an Agent tool. Reuses private-storage safe reads and fileDigest.
 * No command execution and no "passed" input. Expectations are selected before start approval. */
export class FileNativeHostVerifier implements NativeHostVerifier {
  private root: string;
  constructor(root: string) { this.root = safeRoot(root); }
  async bindSelection(a: NativeWorkItemAttempt, input: NativeEvidenceSelection): Promise<void> {
    const selection = validateNativeEvidenceSelection(input), file = this.file(a.id);
    await withExclusiveLock(file + '.lock', async () => {
      const old = await readBytes(file, LIMIT);
      if (old) {
        const previous = this.decode(old, a);
        if (canonicalDigest(previous.selection) !== canonicalDigest(selection)) throw new StorageError('evidence-selection-conflict', '已确认的验收范围不能修改，请新建尝试。');
        return;
      }
      if (a.status !== 'prepared' || !a.sessionID) nativeInvalid('只能为尚未开始的尝试确认验收范围。');
      const workspace = safeRoot(a.input.context.workspace.path);
      if (!await checkDirectories(workspace)) nativeInvalid('工作目录不存在。');
      const stat = await lstat(workspace, { bigint: true });
      const record: SelectionRecord = { schema_version: 1, kind: 'native_host_evidence_selection', attemptID: a.id, inputDigest: a.inputDigest, contextDigest: canonicalDigest(a.input.context), workspaceIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, selection };
      await atomicReplace(file, Buffer.from(JSON.stringify(record)), undefined, LIMIT);
    });
  }
  async readSelection(a: Readonly<NativeWorkItemAttempt>): Promise<NativeEvidenceSelection> {
    const bytes = await readBytes(this.file(a.id), LIMIT);
    if (!bytes) throw new StorageError('missing-evidence-selection', '尚未确认产物规则。');
    return structuredClone(this.decode(bytes, a).selection);
  }
  async selectionDigest(a: NativeWorkItemAttempt): Promise<string> {
    const bytes = await readBytes(this.file(a.id), LIMIT); if (!bytes) throw new StorageError('missing-evidence-selection', '尚未确认宿主产物与检查规则。');
    return canonicalDigest(this.decode(bytes!, a));
  }
  async inspect(a: Readonly<NativeWorkItemAttempt>): Promise<NativeHostReport> {
    const bytes = await readBytes(this.file(a.id), LIMIT);
    const report: NativeHostReport = { verifier: 'screendeck-file-host-v1', artifacts: [], checks: [] };
    if (!bytes) return report;
    const r = this.decode(bytes, a);
    const workspace = safeRoot(a.input.context.workspace.path);
    let workspaceValid = false;
    if (await checkDirectories(workspace)) {
      const stat = await lstat(workspace, { bigint: true }); workspaceValid = stat.isDirectory() && String(stat.dev) === r.workspaceIdentity.dev && String(stat.ino) === r.workspaceIdentity.ino;
    }
    const content = new Map<string, Buffer>();
    for (const path of r.selection.artifacts) {
      const file = resolve(workspace, path);
      if (relative(workspace, file).startsWith('..') || file === workspace || !workspaceValid) continue;
      try {
        const observed = await readBytes(file, ARTIFACT_LIMIT);
        if (observed) { content.set(path, observed); report.artifacts.push({ reference: `workspace:${path}`, sha256: fileDigest(observed), bytes: observed.length }); }
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        // Unsafe/missing/changed bytes are unknown, never a successful check.
      }
    }
    for (const path of r.selection.artifacts) {
      const data = content.get(path);
      report.checks.push({ name: `artifact:${canonicalDigest(path)}`, outcome: data ? 'passed' : 'unknown', outputDigest: canonicalDigest({ selectionDigest: canonicalDigest(r), path, observedDigest: data ? fileDigest(data) : null }) });
    }
    for (const c of r.selection.checks) {
      const data = content.get(c.path); let outcome: 'passed' | 'failed' | 'unknown' = 'unknown';
      if (data) {
        try {
          if (c.kind === 'sha256') outcome = fileDigest(data) === c.expected ? 'passed' : 'failed';
          else {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
            if (c.kind === 'utf8-contains') outcome = text.includes(c.expected) ? 'passed' : 'failed';
            else {
              let value: unknown = JSON.parse(text); let exists = true;
              for (const key of c.pointer) {
                if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { exists = false; break; }
                value = (value as Record<string, unknown>)[key];
              }
              outcome = exists && canonicalDigest(value) === canonicalDigest(c.expected) ? 'passed' : 'failed';
            }
          }
        } catch { outcome = 'failed'; }
      }
      report.checks.push({ name: c.name, outcome, outputDigest: canonicalDigest({ selectionDigest: canonicalDigest(r), rule: c, observedDigest: data ? fileDigest(data) : null, outcome }) });
    }
    return report;
  }
  async verify(a: Readonly<NativeWorkItemAttempt>, report: Readonly<NativeHostReport>): Promise<void> {
    const current = await this.inspect(a);
    if (!current.artifacts.length || current.checks.some(c => c.outcome !== 'passed') || !current.checks.length || canonicalDigest(current) !== canonicalDigest(report)) throw new StorageError('host-evidence-changed', '实际产物缺失、检查未通过或证据已变化。');
  }
  private file(id: string): string { if (!isUUID(id)) nativeInvalid(); return join(this.root, 'native-work-item-evidence-v1', id + '.json'); }
  private decode(bytes: Buffer, a: Readonly<NativeWorkItemAttempt>): SelectionRecord {
    const v = exactObject(JSON.parse(bytes.toString()), ['schema_version', 'kind', 'attemptID', 'inputDigest', 'contextDigest', 'workspaceIdentity', 'selection']);
    const identity = exactObject(v.workspaceIdentity, ['dev', 'ino']);
    if (v.schema_version !== 1 || v.kind !== 'native_host_evidence_selection' || v.attemptID !== a.id || v.inputDigest !== a.inputDigest || v.contextDigest !== canonicalDigest(a.input.context) || typeof identity.dev !== 'string' || typeof identity.ino !== 'string' || !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino)) nativeInvalid();
    validateNativeEvidenceSelection(v.selection); return v as unknown as SelectionRecord;
  }
}
