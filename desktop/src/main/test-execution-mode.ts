import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StorageError } from '../core/private-storage.js';

/** An explicit development fixture mode, unavailable to packaged applications. */
export async function isolatedSimulationEnabled(packaged: boolean, previewRoot: string, requested: string | undefined): Promise<boolean> {
  if (requested === undefined) return false;
  if (packaged || requested !== 'simulation') throw new StorageError('unsupported', '隔离执行测试模式不可用。');
  const root = await realpath(previewRoot);
  const temporaryRoots = await Promise.all([realpath(tmpdir()), realpath('/tmp')]);
  if (!temporaryRoots.some(parent => root.startsWith(`${parent}${path.sep}`))) throw new StorageError('unsupported', '执行测试只能使用独立临时预览目录。');
  return true;
}
