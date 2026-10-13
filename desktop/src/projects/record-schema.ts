export const projectIDPattern = '^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const taskIDPattern = '^task-[0-9]{3,}$';
const runIDPattern = '^run-[0-9]{8}-[0-9]{3,}$';
const str = (maxLength: number, extra: Record<string, unknown> = {}) => ({ type: 'string', minLength: 1, maxLength, ...extra });
const nullableString = (maxLength: number) => ({ type: ['string', 'null'], minLength: 1, maxLength });
const enumeration = (...values: string[]) => ({ enum: values });
const object = (properties: Record<string, unknown>) => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const array = (items: unknown, maxItems: number, extra: Record<string, unknown> = {}) => ({ type: 'array', maxItems, items, ...extra });
const timestamp = { type: 'string', format: 'date-time' };
const projectID = { type: 'string', pattern: projectIDPattern };
const taskID = { type: 'string', pattern: taskIDPattern };
const runID = { type: 'string', pattern: runIDPattern };
const recordBase = { schema_version: { const: 1 }, project_id: projectID };

// Single source for project record fields and timestamp validation.
// Pure, erasable TypeScript: imported by the desktop build and the read-only Node CLI.
// v1 project is only accepted inside history.json by the desktop reader.
export const recordSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'screendeck-project-records',
  $defs: {
    reference: object({ path: str(600), label: str(150) }),
    acceptance: object({ id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, description: str(1000), verification: enumeration('not_checked', 'verified', 'failed'), requires_human: { type: 'boolean' } }),
    executor: object({ agent: str(100), model: nullableString(150), effort: nullableString(100), metadata_source: str(300) }),
    git: object({ commit_status: enumeration('none', 'committed', 'unknown'), commit_ids: array({ type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' }, 32, { uniqueItems: true }), push_status: enumeration('not_pushed', 'pushed', 'unknown') }),
    project: object({ ...recordBase, kind: { const: 'project' }, name: str(150), created_at: timestamp, timezone: { const: 'Asia/Shanghai' }, mode: { const: 'manual_pilot' }, references: array(ref('reference'), 64) }),
    project_identity: object({ schema_version: { const: 2 }, kind: { const: 'project' }, project_id: projectID, name: str(150), created_at: timestamp }),
    project_history: object({ ...recordBase, kind: { const: 'project_history' }, source_root: str(4096), created_at: timestamp, project: ref('project'), migration: object({ backup_path: str(4096), migrated_at: timestamp }) }),
    task: object({ ...recordBase, kind: { const: 'task' }, task_id: taskID, title: str(200), goal: str(2000), status: enumeration('draft', 'ready', 'running', 'awaiting_approval', 'verifying', 'awaiting_review', 'completed', 'failed', 'cancelled'), plan_version: { type: 'integer', minimum: 1 }, assignee: enumeration('human', 'agent', 'shared'), created_at: timestamp, updated_at: timestamp, run_ids: array(runID, 1000, { uniqueItems: true }), acceptance: array(ref('acceptance'), 32, { minItems: 1 }), references: array(ref('reference'), 64) }),
    run: object({ ...recordBase, kind: { const: 'run' }, task_id: taskID, run_id: runID, plan_version: { type: 'integer', minimum: 1 }, status: enumeration('running', 'completed', 'failed', 'interrupted'), started_at: { type: ['string', 'null'], format: 'date-time' }, ended_at: { type: ['string', 'null'], format: 'date-time' }, recorded_at: timestamp, executor: ref('executor'), skills: array(str(150), 64, { uniqueItems: true }), summary: str(2000), references: array(ref('reference'), 64), git: ref('git') }),
  },
};

export function isStrictTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
