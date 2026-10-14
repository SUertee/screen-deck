import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isolatedSimulationEnabled } from '../../src/main/test-execution-mode.js';

test('simulation has no implicit fallback and only accepts explicit non-packaged temporary fixtures', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'screendeck-mode-test-'));
  assert.equal(await isolatedSimulationEnabled(false, '/not-read-or-created', undefined), false);
  assert.equal(await isolatedSimulationEnabled(false, root, 'simulation'), true);
  await assert.rejects(isolatedSimulationEnabled(true, root, 'simulation'), { code: 'unsupported' });
  await assert.rejects(isolatedSimulationEnabled(false, root, 'external'), { code: 'unsupported' });
  await assert.rejects(isolatedSimulationEnabled(false, '/', 'simulation'), { code: 'unsupported' });
  await assert.rejects(isolatedSimulationEnabled(false, await realpath(tmpdir()), 'simulation'), { code: 'unsupported' });
});
