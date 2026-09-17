import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImportIndex } from '../src/import-index.js';

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
