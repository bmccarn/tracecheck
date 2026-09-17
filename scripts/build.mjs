import { chmod, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (typeof packageJson.version !== 'string') throw new Error('package.json must provide a version.');

await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/plugin.mjs', bundle: true,
  platform: 'node', target: 'node22', format: 'esm', legalComments: 'eof',
  banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" },
  define: { __TRACECHECK_VERSION__: JSON.stringify(packageJson.version) },
});

await chmod('dist/plugin.mjs', 0o755);
