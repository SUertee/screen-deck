import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const files = [];
function scan(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, item.name); if (item.isDirectory()) scan(file); else if (file.endsWith('.test.ts')) files.push(file); } }
scan('tests');
if (!files.length) throw new Error('No tests discovered');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files.sort()], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
