import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { recordSchema, isStrictTimestamp } from './record-schema.js';

export { projectIDPattern, recordSchema, isStrictTimestamp } from './record-schema.js';

export function createRecordValidators(): Record<'project_identity' | 'project_history' | 'task' | 'run', ValidateFunction> {
  const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false, allowUnionTypes: true });
  ajv.addFormat('date-time', { type: 'string', validate: isStrictTimestamp });
  ajv.addSchema(recordSchema);
  return Object.fromEntries(['project_identity', 'project_history', 'task', 'run'].map(name => [name, ajv.compile({ $ref: `screendeck-project-records#/$defs/${name}` })])) as ReturnType<typeof createRecordValidators>;
}
