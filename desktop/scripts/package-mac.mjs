import { cp, mkdir, readFile, writeFile, access, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeAppIcon } from './app-icon.mjs';
const require = createRequire(import.meta.url);
if (process.platform !== 'darwin') throw new Error('This local preview packager supports macOS only.');
const root = process.cwd();
const output = process.env.SCREENDECK_PACKAGE_DIR ?? path.join(root, 'dist-release');
await mkdir(output, { recursive: true });
const appPath = path.join(output, 'ScreenDeck Preview.app');
try { await access(appPath); throw new Error('Output exists; choose a fresh SCREENDECK_PACKAGE_DIR.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const electronRoot = path.dirname(require.resolve('electron/package.json'));
// ditto preserves the relative framework symlinks required by macOS code signing.
execFileSync('/usr/bin/ditto', [path.join(electronRoot, 'dist', 'Electron.app'), appPath], { stdio: 'pipe' });
await rename(path.join(appPath, 'Contents', 'MacOS', 'Electron'), path.join(appPath, 'Contents', 'MacOS', 'ScreenDeck Preview'));
const resources = path.join(appPath, 'Contents', 'Resources', 'app');
await mkdir(resources, { recursive: true });
await cp(path.join(root, 'dist'), path.join(resources, 'dist'), { recursive: true });
await writeFile(path.join(resources, 'package.json'), JSON.stringify({ name: 'screendeck-desktop', version: '0.2.0', main: 'dist/main.cjs' }));
await writeAppIcon(path.join(appPath, 'Contents', 'Resources', 'ScreenDeck.icns'));
const plistPath = path.join(appPath, 'Contents', 'Info.plist');
let plist = await readFile(plistPath, 'utf8');
for (const [key, value] of Object.entries({ CFBundleExecutable: 'ScreenDeck Preview', CFBundleName: 'ScreenDeck Preview', CFBundleDisplayName: 'ScreenDeck Preview', CFBundleIdentifier: 'com.screendeck.desktop.preview', CFBundleShortVersionString: '0.2.0', CFBundleVersion: '1', CFBundleIconFile: 'ScreenDeck.icns' })) {
  const escaped = value.replaceAll('&', '&amp;');
  const pattern = new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`);
  if (pattern.test(plist)) plist = plist.replace(pattern, `$1<string>${escaped}</string>`);
  else plist = plist.replace('</dict>', `<key>${key}</key><string>${escaped}</string>\n</dict>`);
}
await writeFile(plistPath, plist);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
console.log(`Local ad-hoc signed preview: ${appPath}`);
