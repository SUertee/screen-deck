import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };
const cachedHeaders = async root => {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map(entry => entry.name).sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
      .slice(0, 32).map(version => path.join(root, version, 'include', 'node'));
  } catch { return []; }
};

/** Offline optional N-API bridge. Build failure never fabricates notch support. */
export async function buildNative({ desktopRoot = sourceRoot, required = false } = {}) {
  const output = path.join(desktopRoot, 'dist', 'native', 'deck-window.node');
  const unavailable = async reason => {
    // Do not package an old binary as the result of a failed current build.
    await rm(output, { force: true });
    if (required) throw new Error(reason);
    console.warn(`Native Deck unavailable: ${reason}`);
    return { available: false, reason };
  };
  if (process.platform !== 'darwin') return unavailable('macOS bridge is not built on this platform.');
  const headers = [
    path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
    // N-API uses a stable ABI: no Electron/V8 headers or module ABI download.
    ...await cachedHeaders(path.join(os.homedir(), 'Library', 'Caches', 'node-gyp')),
    ...await cachedHeaders(path.join(os.homedir(), '.cache', 'node-gyp')),
    ...await cachedHeaders(path.join(os.homedir(), '.electron-gyp')),
  ];
  let include;
  for (const candidate of headers) if (await exists(path.join(candidate, 'node_api.h')) && await exists(path.join(candidate, 'js_native_api.h'))) { include = candidate; break; }
  if (!include) return unavailable('Local Node N-API headers were not found; no dependencies were downloaded.');
  const compiler = spawnSync('/usr/bin/xcrun', ['--find', 'clang++'], { encoding: 'utf8' });
  const sdk = spawnSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (compiler.status !== 0 || sdk.status !== 0) return unavailable('The local macOS SDK/clang++ is unavailable.');
  await mkdir(path.dirname(output), { recursive: true });
  const pending = `${output}.${process.pid}.tmp`;
  const result = spawnSync(compiler.stdout.trim(), [
    '-std=c++17', '-O2', '-fobjc-arc', '-fobjc-exceptions', '-fvisibility=hidden',
    '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=deck_window', '-mmacosx-version-min=12.0',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-isysroot', sdk.stdout.trim(), '-I', include, '-bundle', '-undefined', 'dynamic_lookup',
    '-framework', 'AppKit', '-framework', 'CoreGraphics',
    path.join(desktopRoot, 'native', 'deck-window.mm'), '-o', pending,
  ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    await rm(pending, { force: true });
    return unavailable(`clang++ failed: ${(result.stderr || result.error?.message || 'unknown compiler error').trim()}`);
  }
  await rename(pending, output);
  console.log(`Native Deck built: ${output}`);
  return { available: true, path: output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNative({ required: process.argv.includes('--required') });
