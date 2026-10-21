import { access, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
/** Resolve the official npm wrapper to its bundled native CLI; GUI PATH may not contain Node. */
export async function resolveCodexExecutable(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) throw new Error('请选择 Codex 可执行文件。');
  const binary = await realpath(candidate); await access(binary, constants.X_OK);
  if (binary.endsWith('/@openai/codex/bin/codex.js')) {
    const target = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : process.platform === 'linux' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl` : undefined;
    if (target) {
      const pkg = path.resolve(path.dirname(binary), '..');
      for (const vendor of [path.join(pkg, 'node_modules/@openai', `codex-${process.platform}-${process.arch}`, 'vendor'), path.join(pkg, 'vendor')]) {
        const native = path.join(vendor, target, 'bin/codex');
        try { await access(native, constants.X_OK); return await realpath(native); } catch { /* Other official package layout. */ }
      }
    }
  }
  return binary;
}
/** Finite metadata lookup; no shell, version probe, account or user configuration reads. */
export async function findCodexBinary(): Promise<string | undefined> {
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(value => path.isAbsolute(value)).slice(0, 64).map(dir => path.join(dir, 'codex'));
  for (const dir of [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) candidates.push(path.join(dir, 'codex'));
  try {
    const root = path.join(os.homedir(), '.nvm/versions/node');
    const versions = (await readdir(root)).filter(value => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 16);
    for (const version of versions) candidates.push(path.join(root, version, 'bin/codex'));
  } catch { /* Optional installation location. */ }
  for (const candidate of new Set(candidates)) { try { return await resolveCodexExecutable(candidate); } catch { /* Try next known location. */ } }
  return undefined;
}
