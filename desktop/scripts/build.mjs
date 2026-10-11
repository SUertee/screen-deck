import { build as bundle } from 'esbuild';
import { build as render } from 'vite';
await bundle({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false });
await bundle({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false });
await render({ root: 'src/renderer', base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true }, server: { host: '127.0.0.1' } });
