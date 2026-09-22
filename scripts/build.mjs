import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (typeof packageJson.version !== 'string') throw new Error('package.json must provide a version.');

// --check builds into a temporary directory and compares with the tracked bundle without replacing it.
const check = process.argv.includes('--check');
const scratch = check ? await mkdtemp(join(tmpdir(), 'tracecheck-build-')) : undefined;
const outfile = scratch ? join(scratch, 'plugin.mjs') : 'dist/plugin.mjs';

await build({
  entryPoints: ['src/cli.ts'], outfile, bundle: true,
  platform: 'node', target: 'node22', format: 'esm', legalComments: 'eof',
  banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" },
  define: { __TRACECHECK_VERSION__: JSON.stringify(packageJson.version) },
});

if (scratch) {
  const tracked = await readFile('dist/plugin.mjs').catch(() => undefined);
  const fresh = await readFile(outfile);
  await rm(scratch, { recursive: true, force: true });
  if (!tracked?.equals(fresh)) {
    console.error('dist/plugin.mjs does not match a fresh build of src/. Run `npm run build`.');
    process.exit(1);
  }
  console.log('dist/plugin.mjs matches a fresh build of src/.');
} else {
  await chmod('dist/plugin.mjs', 0o755);
}
