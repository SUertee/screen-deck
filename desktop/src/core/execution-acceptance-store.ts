import type { AcceptanceRecord, TaskTurnRef } from '../shared/task-execution.js';
import { StorageError } from './private-storage.js';
import { boundedString, canonicalDigest, exactObject, executionRecordID, ExecutionRecordStore, strictDate, validateTaskTurnRef } from './execution-records.js';
import { isUUID } from './session-schema.js';

const targetOf = (turn: TaskTurnRef, resultDigest: string) => ({ turn, resultDigest });
function validate(value: unknown): AcceptanceRecord {
  const record = exactObject(value, ['schema_version', 'kind', 'id', 'turn', 'resultDigest', 'decision', 'decided_by', 'decided_at'], ['comment']);
  validateTaskTurnRef(record.turn);
  if (record.schema_version !== 1 || record.kind !== 'electron_execution_acceptance' || !isUUID(record.id) || typeof record.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.resultDigest) || record.id !== executionRecordID(targetOf(record.turn as TaskTurnRef, record.resultDigest)) || !['accepted', 'rejected'].includes(String(record.decision)) || !boundedString(record.decided_by, 200) || !strictDate(record.decided_at) || record.comment !== undefined && !boundedString(record.comment, 4096)) throw new StorageError('invalid-acceptance', '成果验收记录无效。');
  return record as unknown as AcceptanceRecord;
}

/** The only writer of manual acceptance facts; it never changes source Task or plan status. */
export class ExecutionAcceptanceStore {
  private readonly store: ExecutionRecordStore<AcceptanceRecord>;
  constructor(root: string) { this.store = new ExecutionRecordStore(root, 'execution-acceptances-v1', validate); }
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
