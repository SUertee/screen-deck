import { randomUUID } from 'node:crypto';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { PreviewPlan, TaskMaterial, TaskScreenSource } from '../shared/types.js';
import { StorageError } from '../core/storage/private-storage.js';
import { canonicalDigest } from '../core/storage/execution-records.js';
import { payload, textInput, uuidInput } from './ipc-validation.js';
import type { ConfirmTaskContextInput, ConfirmTaskContextReceipt } from '../shared/task-context.js';
export interface ContextSourcePort {
  withContextSources<T>(ids: string[], operation: () => Promise<T>): Promise<T>;
  resolveContextSource(id: string): TaskScreenSource;
}
function validate(value: unknown): ConfirmTaskContextInput {
  const input = payload(value, ['schemaVersion', 'confirmationID', 'draftID', 'draftRevision', 'target', 'summary', 'clues']);
  const target = payload(input.target, ['key', 'baseVersion']);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 1 || !Number.isSafeInteger(target.baseVersion) || Number(target.baseVersion) < 1 || !Array.isArray(input.clues) || !input.clues.length || input.clues.length > 32) throw new StorageError('context-input', '上下文草稿或版本无效。');
  const key = textInput(target.key, 100);
  if (!key.startsWith('local:')) throw new StorageError('context-target', '请选择可编辑的本地任务。');
  uuidInput(key.slice(6)); uuidInput(input.confirmationID); uuidInput(input.draftID);
  textInput(input.summary, 48000);
  if ((input.summary as string).length > 12000) throw new StorageError('context-input', '上下文摘要过长。');
  const ids = new Set<string>();
  for (const value of input.clues) {
    const clue = payload(value, ['source', 'note', 'excerpt']);
    const source = payload(clue.source, ['kind', 'frameID', 'capturedAt', 'appName', 'bundleID', 'displayID', 'width', 'height']);
    const id = textInput(source.frameID, 100);
    if (source.kind !== 'screen-frame' || !/^\d{13}-[0-9a-f-]{36}$/.test(id) || ids.has(id) || ![source.displayID, source.width, source.height].every(n => Number.isSafeInteger(n) && Number(n) > 0)) throw new StorageError('context-input', '屏幕线索标识或尺寸无效。');
    ids.add(id); textInput(source.capturedAt, 100); textInput(source.appName, 600); textInput(source.bundleID, 600);
    if (textInput(clue.note, 4000).length > 1000) throw new StorageError('context-input', '线索备注过长。');
    if (clue.excerpt !== undefined) { const excerpt = payload(clue.excerpt, ['kind', 'text']); if (excerpt.kind !== 'user-reviewed' || textInput(excerpt.text, 8000).length > 2000) throw new StorageError('context-input', '显式摘录无效或过长。'); }
  }
  return structuredClone(input) as unknown as ConfirmTaskContextInput;
}
/** Confirmation never reads OCR, captures a screen, or sends a model request. */
export class TaskContextService {
  constructor(private plans: Pick<TaskOrchestrator, 'transactPlan'>, private sources: ContextSourcePort, private publish: (plan: PreviewPlan) => void) {}
  async confirm(value: unknown): Promise<ConfirmTaskContextReceipt> {
    const input = validate(value), requestDigest = canonicalDigest(input);
    const replay = async () => (await this.plans.transactPlan(input.target.key.slice(6), async current => {
      if (current.scope) throw new StorageError('context-target', '请选择可编辑的本地任务。');
      const previous = current.task?.context_receipts?.find(receipt => receipt.confirmationID === input.confirmationID);
      if (previous && previous.requestDigest !== requestDigest) throw new StorageError('context-identity', '相同确认标识不能用于不同内容。');
      return { value: previous ? { confirmationID: previous.confirmationID, materialID: previous.materialID, targetKey: input.target.key, savedVersion: previous.savedVersion } : undefined };
    })).value;
    const acknowledged = await replay();
    if (acknowledged) return acknowledged;
    try {
    const result = await this.sources.withContextSources(input.clues.map(c => c.source.frameID), () => this.plans.transactPlan(input.target.key.slice(6), async current => {
      if (current.scope) throw new StorageError('context-target', '项目历史不可直接写入，请选择本地任务。');
      const content = structuredClone(current.task ?? { goal: '', completion_conditions: [], materials: [], chat_refs: [] });
      const previous = content.context_receipts?.find(receipt => receipt.confirmationID === input.confirmationID);
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new StorageError('context-identity', '相同确认标识不能用于不同内容。');
        return { value: { confirmationID: previous.confirmationID, materialID: previous.materialID, targetKey: input.target.key, savedVersion: previous.savedVersion } };
      }
      if (current.version !== input.target.baseVersion) throw new StorageError('plan-conflict', '任务版本已变化，草稿已保留，请刷新任务后重新确认。');
      if ((content.context_receipts?.length ?? 0) >= 1000 || content.materials.length >= 100) throw new StorageError('context-limit', '任务上下文已达容量上限，请整理任务后重试。');
      const clues = input.clues.map(clue => {
        const source = this.sources.resolveContextSource(clue.source.frameID);
        if (canonicalDigest(source) !== canonicalDigest(clue.source)) throw new StorageError('context-source', '屏幕来源已失效或不一致，请重新选择。');
        return { source, note: clue.note, ...(clue.excerpt ? { excerpt: clue.excerpt } : {}) };
      });
      const summary = [input.summary, ...clues.map(clue => [clue.source.appName + ' · ' + clue.source.capturedAt, clue.note, clue.excerpt?.text].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
      if (Buffer.byteLength(summary) > 32768) throw new StorageError('context-limit', '所选内容合计过长，请减少摘要或摘录后重试。');
      const material: TaskMaterial = { id: randomUUID(), title: `屏幕上下文 · ${clues.length} 条线索`, summary, source: { kind: 'screen', reference: `screen-context:${input.confirmationID}`, label: `屏幕线索 · ${clues.length} 条` }, confirmation_id: input.confirmationID, screen_clues: clues };
      const receipt = { confirmationID: input.confirmationID, requestDigest, materialID: material.id, savedVersion: current.version + 1 };
      return { plan: { ...current, schema_version: 3 as const, task: { ...content, materials: [...content.materials, material], context_receipts: [...(content.context_receipts ?? []), receipt] } }, value: { confirmationID: receipt.confirmationID, materialID: receipt.materialID, targetKey: input.target.key, savedVersion: receipt.savedVersion } };
    }));
    if (result.plan) this.publish(result.plan);
    return result.value;
    } catch (error) {
      // Another identical confirmation may have committed while sources were queued for deletion.
      const acknowledged = await replay();
      if (acknowledged) return acknowledged;
      throw error;
    }
  }
}
