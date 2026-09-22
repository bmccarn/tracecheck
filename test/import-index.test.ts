import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImportIndex } from '../src/import-index.js';
import { importsFor } from '../src/evidence.js';

const limits = { indexTimeoutMs: 20_000, collectionTimeoutMs: 120_000 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tracecheck-import-index-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function index(root: string, paths: string[], changedPaths: string[] = [], known = new Set(paths), overrides: Partial<typeof limits> & { maxIndexFiles?: number; maxIndexBytes?: number } = {}) {
  return buildImportIndex({ root, paths, known, changedPaths, limits: { ...limits, ...overrides } });
}

test('indexes callers beyond the former fixed 200-file frontier', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['subject.ts', ...Array.from({ length: 205 }, (_value, index) => `noise-${String(index).padStart(3, '0')}.ts`), 'zz-caller.ts'];
  await Promise.all(paths.map(async path => writeFile(join(repo.root, path), path === 'zz-caller.ts'
    ? 'import { subject } from "./subject.js"; export const caller = subject;'
    : 'export const value = 1;')));
  const result = await index(repo.root, paths, ['subject.ts']);
  assert.deepEqual(result.reverse.get('subject.ts'), ['zz-caller.ts']);
  assert.equal(result.limitations.some(value => /limit|deadline/i.test(value)), false);
});

test('invalidates cached edges when same-length content restores its mtime', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['a.ts', 'b.ts', 'caller.ts'];
  await writeFile(join(repo.root, 'a.ts'), 'export const a = 1;');
  await writeFile(join(repo.root, 'b.ts'), 'export const b = 1;');
  const first = 'import "./a.js";';
  await writeFile(join(repo.root, 'caller.ts'), first);
  const original = await stat(join(repo.root, 'caller.ts'));
  assert.deepEqual((await index(repo.root, paths)).imports.get('caller.ts'), ['a.ts']);
  await writeFile(join(repo.root, 'caller.ts'), 'import "./b.js";');
  await utimes(join(repo.root, 'caller.ts'), original.atime, original.mtime);
  assert.deepEqual((await index(repo.root, paths)).imports.get('caller.ts'), ['b.ts']);
});

test('recomputes resolution when import targets appear and disappear', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'caller.ts'), 'import "./target.js";');
  assert.deepEqual((await index(repo.root, ['caller.ts'])).imports.get('caller.ts'), []);
  await writeFile(join(repo.root, 'target.ts'), 'export const target = 1;');
  assert.deepEqual((await index(repo.root, ['caller.ts', 'target.ts'])).imports.get('caller.ts'), ['target.ts']);
  await unlink(join(repo.root, 'target.ts'));
  assert.deepEqual((await index(repo.root, ['caller.ts'])).imports.get('caller.ts'), []);
});

test('rechecks cached paths for symlink escapes', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['caller.ts', 'target.ts'];
  await writeFile(join(repo.root, 'caller.ts'), 'import "./target.js";');
  await writeFile(join(repo.root, 'target.ts'), 'export const target = 1;');
  assert.deepEqual((await index(repo.root, paths)).imports.get('caller.ts'), ['target.ts']);
  await unlink(join(repo.root, 'caller.ts'));
  await symlink('/etc/hosts', join(repo.root, 'caller.ts'));
  const result = await index(repo.root, paths);
  assert.equal(result.imports.has('caller.ts'), false);
  assert.match(result.limitations.join('\n'), /Import index omitted 1 file\(s\): Symlink or external path \(caller\.ts\)/);
});

test('honors explicit scan budgets and caller cancellation', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['a.ts', 'b.ts', 'changed.ts'];
  await Promise.all(paths.map(path => writeFile(join(repo.root, path), 'export const value = 1;')));
  const limited = await index(repo.root, paths, ['changed.ts'], new Set(paths), { maxIndexFiles: 2, maxIndexBytes: 100 });
  assert.equal(limited.imports.size, 2);
  assert.match(limited.limitations.join('\n'), /Import index file limit reached: 2\/3 eligible files scanned/);
  const byteLimited = await index(repo.root, paths, [], new Set(paths), { maxIndexBytes: 1 });
  assert.equal(byteLimited.imports.size, 0);
  assert.match(byteLimited.limitations.join('\n'), /Import index omitted 3 file\(s\): byte limit/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => buildImportIndex({ root: repo.root, paths, known: new Set(paths), changedPaths: [], signal: controller.signal, limits }), /abort/i);
});

test('retains a test caller in a small changed-file frontier', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['src/subject.ts', ...Array.from({ length: 8 }, (_value, index) => `src/noise-${index}.ts`), 'test/subject.test.ts'];
  await Promise.all([
    mkdir(join(repo.root, 'src'), { recursive: true }),
    mkdir(join(repo.root, 'test'), { recursive: true }),
  ]);
  await Promise.all(paths.map(path => writeFile(join(repo.root, path), path === 'test/subject.test.ts'
    ? 'import { subject } from "../src/subject.js"; export const caller = subject;'
    : 'export const subject = 1;')));
  const result = await index(repo.root, paths, ['src/subject.ts'], new Set(paths), { maxIndexFiles: 3 });
  assert.deepEqual(result.reverse.get('src/subject.ts'), ['test/subject.test.ts']);
  assert.equal(result.discovery.scannedFiles, 3);
});

test('rebuilds an explicit pinned partial prefix after cache warming', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  await writeFile(join(repo.root, 'a.ts'), 'export const a = 1;');
  await writeFile(join(repo.root, 'b.ts'), 'import "./a.js";');
  await writeFile(join(repo.root, 'c.ts'), 'import "./b.js";');
  const discovery = { scannedFiles: 2, deadlineLimited: true };
  const first = await buildImportIndex({ root: repo.root, paths, known: new Set(paths), changedPaths: [], discovery, limits });
  const warm = await buildImportIndex({ root: repo.root, paths, known: new Set(paths), changedPaths: [], discovery, limits });
  assert.deepEqual([...warm.imports], [...first.imports]);
  assert.deepEqual(warm.discovery, discovery);
  assert.match(warm.limitations.join('\n'), /Import index deadline reached: 2\/3 eligible files indexed/);
});

test('revalidates changed files in an explicit pinned prefix', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  await writeFile(join(repo.root, 'a.ts'), 'export const a = 1;');
  await writeFile(join(repo.root, 'b.ts'), 'import "./a.js";');
  await writeFile(join(repo.root, 'c.ts'), 'export const c = 1;');
  const discovery = { scannedFiles: 2, deadlineLimited: true };
  await buildImportIndex({ root: repo.root, paths, known: new Set(paths), changedPaths: [], discovery, limits });
  await writeFile(join(repo.root, 'b.ts'), 'import "./c.js";');
  const rebuilt = await buildImportIndex({ root: repo.root, paths, known: new Set(paths), changedPaths: [], discovery, limits });
  assert.deepEqual(rebuilt.imports.get('b.ts'), ['c.ts']);
  assert.deepEqual(rebuilt.discovery, discovery);
});

test('shortens a pinned discovery scope when the path universe shrinks', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['a.ts', 'b.ts'];
  await Promise.all(paths.map(path => writeFile(join(repo.root, path), 'export const value = 1;')));
  const discovery = { scannedFiles: 2, deadlineLimited: true };
  await buildImportIndex({ root: repo.root, paths, known: new Set(paths), changedPaths: [], discovery, limits });
  await unlink(join(repo.root, 'b.ts'));
  const rebuilt = await buildImportIndex({ root: repo.root, paths: ['a.ts'], known: new Set(['a.ts']), changedPaths: [], discovery, limits });
  assert.deepEqual(rebuilt.discovery, { scannedFiles: 1, deadlineLimited: true });
  assert.deepEqual([...rebuilt.imports.keys()], ['a.ts']);
});

test('keeps file and byte caps deterministic with concurrent index I/O', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  const source = 'export const value = 1;\n';
  await Promise.all(paths.map(path => writeFile(join(repo.root, path), source)));
  const fileLimited = await index(repo.root, paths, [], new Set(paths), { maxIndexFiles: 2 });
  assert.deepEqual([...fileLimited.imports.keys()], ['a.ts', 'b.ts']);
  const fileRechecked = await buildImportIndex({
    root: repo.root, paths, known: new Set(paths), changedPaths: [], discovery: fileLimited.discovery,
    limits: { ...limits, maxIndexFiles: 2 },
  });
  assert.deepEqual(fileRechecked.limitations, fileLimited.limitations);
  assert.deepEqual(fileLimited.discovery, { scannedFiles: 2, deadlineLimited: false });
  const byteLimited = await index(repo.root, paths, [], new Set(paths), { maxIndexBytes: Buffer.byteLength(source) * 2 });
  assert.deepEqual([...byteLimited.imports.keys()], ['a.ts', 'b.ts']);
  assert.deepEqual(byteLimited.discovery, { scannedFiles: 3, deadlineLimited: false });
  assert.match(byteLimited.limitations.join('\n'), /Import index omitted 1 file\(s\): byte limit \(c\.ts\)/);
});

test('links wrapped, comma-separated, and aliased Python imports', () => {
  const known = new Set(['pkg/__init__.py', 'pkg/calc.py', 'pkg/fmt.py', 'pkg/sub/__init__.py', 'pkg/sub/deep.py', 'other/mod.py', 'src/lib/core.py']);
  const edges = (path: string, content: string) => importsFor(path, content, known).sort();
  assert.deepEqual(edges('app.py', 'from pkg import (\n    calc,  # stats\n    fmt as f,\n    missing,\n)\n'), ['pkg/__init__.py', 'pkg/calc.py', 'pkg/fmt.py']);
  assert.deepEqual(edges('app.py', 'from pkg.calc import (\n    mean,\n)\n'), ['pkg/calc.py']);
  assert.deepEqual(edges('app.py', 'import pkg.calc, other.mod\n'), ['other/mod.py', 'pkg/calc.py']);
  assert.deepEqual(edges('app.py', 'import pkg.calc as c, other.mod\n'), ['other/mod.py', 'pkg/calc.py']);
  assert.deepEqual(edges('app.py', 'from pkg import calc, \\\n    fmt\n'), ['pkg/__init__.py', 'pkg/calc.py', 'pkg/fmt.py']);
  assert.deepEqual(edges('app.py', 'from lib.core import run\n'), ['src/lib/core.py']);
  assert.deepEqual(edges('pkg/sub/deep.py', 'from . import calc\nfrom .. import fmt\nfrom ..calc import (\n    mean,\n)\n'),
    ['pkg/__init__.py', 'pkg/calc.py', 'pkg/fmt.py', 'pkg/sub/__init__.py']);
});

test('resolves NodeNext module specifiers to TypeScript sources and links only reviewable files', () => {
  const known = new Set(['y.mts', 'y.cts', 'z.tsx', 'a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.ts', 'e.js', 'plain.mjs', 'common.cjs',
    'dir/index.tsx', 'jsx/index.jsx', 'mod/index.mts', 'ts/index.ts', 'js/index.js', 'logo.png', 'styles.css', 'data.json', 'vendor/lib.js']);
  const cases: Array<[string, string[]]> = [
    ['./y.mjs', ['y.mts']], ['./y.cjs', ['y.cts']], ['./z.jsx', ['z.tsx']], ['./dir', ['dir/index.tsx']],
    ['./jsx', ['jsx/index.jsx']], ['./mod', ['mod/index.mts']], ['./ts', ['ts/index.ts']], ['./js/', ['js/index.js']],
    ['./a', ['a.ts']], ['./a.js', ['a.ts']], ['./b.js', ['b.tsx']], ['./c', ['c.js']], ['./c.js', ['c.js']], ['./d', ['d.jsx']],
    ['./e.js', ['e.js', 'e.ts']], ['./y.mts', ['y.mts']], ['./plain.mjs', ['plain.mjs']], ['./common.cjs', ['common.cjs']],
    ['./styles.css', ['styles.css']], ['./data.json', ['data.json']], ['./logo.png', []], ['./vendor/lib.js', []],
  ];
  for (const [specifier, expected] of cases) {
    assert.deepEqual(importsFor('main.mts', `import value from '${specifier}';`, known).sort(), expected, specifier);
  }
  assert.deepEqual(importsFor('lib/main.cts', "const y = require('../y.cjs'); import '../logo.png';", known), ['y.cts']);
});

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return Object.keys(files).filter(path => !path.startsWith('../'));
}

test('resolves tsconfig paths and baseUrl aliases through an in-repository extends chain', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = await writeFiles(repo.root, {
    // JSONC: comments and trailing commas, as TypeScript accepts.
    'config/tsconfig.base.json': '{\n  // Shared settings\n  "compilerOptions": {\n    "baseUrl": "../src", /* relative to this file */\n    "paths": { "@/*": ["./*", "../generated/*"], "#config": ["../app.config.ts"], },\n  },\n}\n',
    'tsconfig.json': '{ "extends": "./config/tsconfig.base", "compilerOptions": { "strict": true } }',
    'src/components/Button.tsx': 'export const Button = 1;',
    'src/lib/format.ts': 'export const format = 1;',
    'src/widgets/index.ts': 'export const widgets = 1;',
    'generated/api.ts': 'export const api = 1;',
    'app.config.ts': 'export const config = 1;',
    'src/app.ts': "import { Button } from '@/components/Button';\nimport { format } from '@/lib/format.js';\nimport { widgets } from 'widgets';\nimport { api } from '@/api';\nimport config from '#config';\nimport React from 'react';\n",
  });
  const result = await index(repo.root, paths, ['src/components/Button.tsx']);
  assert.deepEqual(result.imports.get('src/app.ts'), ['app.config.ts', 'generated/api.ts', 'src/components/Button.tsx', 'src/lib/format.ts', 'src/widgets/index.ts']);
  assert.deepEqual(result.reverse.get('src/components/Button.tsx'), ['src/app.ts']);
  assert.equal(result.limitations.some(value => /TypeScript config/.test(value)), false);
});

test('uses the nearest config, resolving paths without baseUrl from the declaring config', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = await writeFiles(repo.root, {
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./shared/*"] } } }',
    'packages/web/jsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    'packages/web/src/view.js': 'export const view = 1;',
    'packages/web/src/page.js': "import { view } from '@/view';",
    'shared/view.ts': 'export const view = 1;',
    'tools/run.ts': "import { view } from '@/view';",
  });
  const result = await index(repo.root, paths);
  assert.deepEqual(result.imports.get('packages/web/src/page.js'), ['packages/web/src/view.js']);
  assert.deepEqual(result.imports.get('tools/run.ts'), ['shared/view.ts']);
});

test('does not follow extends outside the repository and reports it', async t => {
  const outer = await fixture(); t.after(outer.cleanup);
  const root = join(outer.root, 'repo');
  await writeFiles(outer.root, { 'shared/tsconfig.json': '{ "compilerOptions": { "baseUrl": "../repo/src" } }' });
  const paths = await writeFiles(root, {
    'tsconfig.json': '{ "extends": ["@tsconfig/node22/tsconfig.json", "../shared/tsconfig.json"] }',
    'src/util.ts': 'export const util = 1;',
    'src/main.ts': "import { util } from 'util';",
  });
  const result = await index(root, paths);
  assert.deepEqual(result.imports.get('src/main.ts'), []);
  assert.match(result.limitations.join('\n'), /TypeScript config extends targets outside the repository were not followed \(tsconfig\.json -> \.\.\/shared\/tsconfig\.json, tsconfig\.json -> @tsconfig\/node22\/tsconfig\.json\)/);
});

test('reports a malformed tsconfig and keeps indexing', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = await writeFiles(repo.root, {
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": "." ',
    'lib.ts': 'export const lib = 1;',
    'main.ts': "import { lib } from './lib.js'; import { other } from 'lib';",
  });
  const result = await index(repo.root, paths);
  assert.deepEqual(result.imports.get('main.ts'), ['lib.ts']);
  assert.match(result.limitations.join('\n'), /TypeScript config could not be parsed; its path aliases are ignored \(tsconfig\.json\)/);
});

test('re-resolves cached edges when alias settings change', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = await writeFiles(repo.root, {
    'tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./a/*"] } } }',
    'a/value.ts': 'export const value = 1;',
    'b/value.ts': 'export const value = 2;',
    'main.ts': "import { value } from '~/value';",
  });
  assert.deepEqual((await index(repo.root, paths)).imports.get('main.ts'), ['a/value.ts']);
  await writeFile(join(repo.root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "~/*": ["./b/*"] } } }');
  assert.deepEqual((await index(repo.root, paths)).imports.get('main.ts'), ['b/value.ts']);
});

test('stops a circular extends chain with a limitation', async t => {
  const repo = await fixture(); t.after(repo.cleanup);
  const paths = await writeFiles(repo.root, {
    'tsconfig.json': '{ "extends": "./base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    'base.json': '{ "extends": "./tsconfig.json", "compilerOptions": { "baseUrl": "./src" } }',
    'src/util.ts': 'export const util = 1;',
    'src/main.ts': "import { util } from '@/util'; import { again } from 'util';",
  });
  const result = await index(repo.root, paths);
  assert.deepEqual(result.imports.get('src/main.ts'), ['src/util.ts']);
  assert.match(result.limitations.join('\n'), /TypeScript config extends chain is circular or deeper than 8 levels \(base\.json -> \.\/tsconfig\.json\)/);
});
