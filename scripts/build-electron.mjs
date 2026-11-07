// Bundles the Electron main process (with the server inside) and the preload script.
import { build } from 'esbuild';
import fs from 'node:fs';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/electron/preload.cjs' });
await build({ ...common, entryPoints: ['electron/preload-setup.ts'], outfile: 'dist/electron/preload-setup.cjs' });
fs.copyFileSync('electron/setup.html', 'dist/electron/setup.html');
