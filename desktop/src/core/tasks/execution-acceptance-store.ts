import { validateFileRef, type FileTurnRef } from '../sessions/file-task-schema.js';
import type { AcceptanceRecord, TaskTurnRef } from '../../shared/task-execution.js';
import { StorageError } from '../storage/private-storage.js';
import { boundedString, canonicalDigest, exactObject, executionRecordID, ExecutionRecordStore, strictDate, validateTaskTurnRef } from '../storage/execution-records.js';
import { isUUID } from '../sessions/session-schema.js';

const targetOf = (turn: TaskTurnRef, resultDigest: string) => ({ turn, resultDigest });
function validate(value: unknown): AcceptanceRecord {
  const record = exactObject(value, ['schema_version', 'kind', 'id', 'turn', 'resultDigest', 'decision', 'decided_by', 'decided_at'], ['comment']);
  validateTaskTurnRef(record.turn);
  if (record.schema_version !== 1 || record.kind !== 'electron_execution_acceptance' || !isUUID(record.id) || typeof record.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.resultDigest) || record.id !== executionRecordID(targetOf(record.turn as TaskTurnRef, record.resultDigest)) || !['accepted', 'rejected'].includes(String(record.decision)) || !boundedString(record.decided_by, 200) || !strictDate(record.decided_at) || record.comment !== undefined && !boundedString(record.comment, 4096)) throw new StorageError('invalid-acceptance', '成果验收记录无效。');
  return record as unknown as AcceptanceRecord;
}

export interface FileAcceptanceRecord {
  schema_version: 2; kind: 'host_file_acceptance'; id: string; turn: FileTurnRef; resultDigest: string;
  decision: 'accepted' | 'rejected'; decided_by: string; decided_at: string; comment?: string;
}
function validateFileAcceptance(value: unknown): FileAcceptanceRecord {
  const r = exactObject(value, ['schema_version', 'kind', 'id', 'turn', 'resultDigest', 'decision', 'decided_by', 'decided_at'], ['comment']);
  validateFileRef(r.turn);
  if (r.schema_version !== 2 || r.kind !== 'host_file_acceptance' || typeof r.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.resultDigest) || r.id !== executionRecordID({ turn: r.turn, resultDigest: r.resultDigest }) || !['accepted', 'rejected'].includes(String(r.decision)) || !boundedString(r.decided_by, 200) || !strictDate(r.decided_at) || r.comment !== undefined && !boundedString(r.comment, 4096)) throw new StorageError('invalid-acceptance', '文件验收记录无效。');
  return value as FileAcceptanceRecord;
}

/** The only writer of manual acceptance facts; it never changes source Task or plan status. */
export class ExecutionAcceptanceStore {
  private readonly fileStore: ExecutionRecordStore<FileAcceptanceRecord>;
  private readonly store: ExecutionRecordStore<AcceptanceRecord>;
  constructor(root: string) { this.store = new ExecutionRecordStore(root, 'execution-acceptances-v1', validate); this.fileStore = new ExecutionRecordStore(root, 'execution-acceptances-v2', validateFileAcceptance); }
  async recordFile(input: { turn: FileTurnRef; resultDigest: string; decision: 'accepted' | 'rejected'; actor: string; now: Date; comment?: string }): Promise<FileAcceptanceRecord> {
    const id = executionRecordID({ turn: input.turn, resultDigest: input.resultDigest });
    const record = validateFileAcceptance({ schema_version: 2, kind: 'host_file_acceptance', id, turn: structuredClone(input.turn), resultDigest: input.resultDigest, decision: input.decision, decided_by: input.actor, decided_at: input.now.toISOString(), ...(input.comment === undefined ? {} : { comment: input.comment }) });
    return this.fileStore.update(id, current => { if (current && (current.decision !== record.decision || canonicalDigest(current.turn) !== canonicalDigest(record.turn) || current.resultDigest !== record.resultDigest)) throw new StorageError('conflict', '该文件成果已有不同决定。'); return current ?? record; });
  }
  findFile(turn: FileTurnRef, resultDigest: string): Promise<FileAcceptanceRecord | undefined> { validateFileRef(turn); return this.fileStore.load(executionRecordID({ turn, resultDigest })); }
  list(): Promise<AcceptanceRecord[]> { return this.store.list(); }
  load(id: string): Promise<AcceptanceRecord | undefined> { return this.store.load(id); }
  find(turn: TaskTurnRef, resultDigest: string): Promise<AcceptanceRecord | undefined> { return this.load(executionRecordID(targetOf(turn, resultDigest))); }
  async record(input: { turn: TaskTurnRef; resultDigest: string; decision: 'accepted' | 'rejected'; actor: string; now: Date; comment?: string }): Promise<AcceptanceRecord> {
    const id = executionRecordID(targetOf(input.turn, input.resultDigest));
    const proposed = validate({ schema_version: 1, kind: 'electron_execution_acceptance', id, turn: structuredClone(input.turn), resultDigest: input.resultDigest, decision: input.decision, decided_by: input.actor, decided_at: input.now.toISOString(), ...(input.comment === undefined ? {} : { comment: input.comment }) });
    return this.store.update(id, current => {
      if (!current) return proposed;
      if (canonicalDigest(targetOf(current.turn, current.resultDigest)) !== canonicalDigest(targetOf(input.turn, input.resultDigest)) || current.decision !== proposed.decision) throw new StorageError('conflict', '该成果已有不同验收决定。');
      return current;
    });
  }
}
