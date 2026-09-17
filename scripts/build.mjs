import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/plugin.mjs', bundle: true,
  platform: 'node', target: 'node22', format: 'esm', legalComments: 'eof',
  banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" },
});

await chmod('dist/plugin.mjs', 0o755);
