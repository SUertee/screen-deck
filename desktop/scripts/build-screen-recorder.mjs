import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
/** Separate from build-native.mjs: preserve the existing Deck Objective-C++ build. */
export async function buildScreenRecorder() {
  if (process.platform !== 'darwin') return { available: false, reason: 'macOS-only' };
  await mkdir('dist/native', { recursive: true });
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, 'native/ScreenRecorder.swift', 'native/ScreenMetadata.swift', '-o', 'dist/native/ScreenRecorder'], { stdio: 'inherit', env: { ...process.env, CLANG_MODULE_CACHE_PATH: os.tmpdir() + '/screendeck-swift-cache' } });
  return { available: true, path: 'dist/native/ScreenRecorder' };
}
