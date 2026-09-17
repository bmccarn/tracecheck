import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readGitChangeContext } from '../src/git-context.js';
import type { GitChange } from '../src/git-context.js';
import { repository } from './helpers.js';

async function contextFor(root: string, base: string, paths: string[]) {
  const values = new Map<string, { change: GitChange; before?: string }>();
  await readGitChangeContext({ root, base, paths, signal: new AbortController().signal,
    onBaseline: (path, change, before) => { values.set(path, { change, before }); } });
  return values;
}

test('streams current and base ranges and baseline bytes for additions, deletions, and renames', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'modified.ts'), 'one\ntwo\nthree\n');
  await writeFile(join(repo.root, 'deleted.ts'), 'gone\nnow\n');
  await writeFile(join(repo.root, 'renamed.ts'), 'old name\n');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add context fixtures');
  const base = repo.git('rev-parse', 'HEAD').trim();
  await writeFile(join(repo.root, 'modified.ts'), 'one\nTWO\nthree\n');
  await writeFile(join(repo.root, 'added.ts'), 'added\n');
  repo.git('add', 'added.ts');
  repo.git('rm', 'deleted.ts');
  repo.git('mv', 'renamed.ts', 'moved.ts');
  const paths = ['modified.ts', 'added.ts', 'deleted.ts', 'renamed.ts', 'moved.ts'];
  const values = await contextFor(repo.root, base, paths);

  assert.deepEqual(values.get('modified.ts')!.change.ranges, [{ start: 2, end: 2 }]);
  assert.deepEqual(values.get('modified.ts')!.change.beforeRanges, [{ start: 2, end: 2 }]);
  assert.equal(values.get('modified.ts')!.before, 'one\ntwo\nthree\n');
  assert.deepEqual(values.get('added.ts')!.change.ranges, [{ start: 1, end: 1 }]);
  assert.equal(values.get('added.ts')!.before, undefined);
  assert.deepEqual(values.get('deleted.ts')!.change.ranges, [{ start: 1, end: 1 }]);
  assert.deepEqual(values.get('deleted.ts')!.change.beforeRanges, [{ start: 1, end: 2 }]);
  assert.equal(values.get('deleted.ts')!.before, 'gone\nnow\n');
  assert.deepEqual(values.get('renamed.ts')!.change.ranges, [{ start: 1, end: 1 }]);
  assert.equal(values.get('renamed.ts')!.before, 'old name\n');
  assert.deepEqual(values.get('moved.ts')!.change.ranges, [{ start: 1, end: 1 }]);
  assert.equal(values.get('moved.ts')!.before, undefined);
});
test('attributes both patch sections of a type change to the same path', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await symlink('target.ts', join(repo.root, 'changed.ts'));
  repo.git('add', 'changed.ts'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add symlink');
  const base = repo.git('rev-parse', 'HEAD').trim();
  await rm(join(repo.root, 'changed.ts'));
  await writeFile(join(repo.root, 'changed.ts'), 'export const changed = true;\n');
  const values = await contextFor(repo.root, base, ['changed.ts']);

  assert.equal(values.get('changed.ts')!.before, 'target.ts');
  assert.deepEqual(values.get('changed.ts')!.change.ranges, [{ start: 1, end: 1 }, { start: 1, end: 1 }]);
  assert.deepEqual(values.get('changed.ts')!.change.beforeRanges, [{ start: 1, end: 1 }, { start: 1, end: 1 }]);
});


test('attributes quoted filenames and header-like added source only to requested paths', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const unusual = 'dir/white space\tquote"é\nline.ts';
  const plain = 'plain file.ts';
  const literal = 'brackets[1].ts';
  await mkdir(join(repo.root, 'dir'));
  await writeFile(join(repo.root, unusual), 'before\n');
  await writeFile(join(repo.root, plain), 'before\n');
  await writeFile(join(repo.root, literal), 'before\n');
  await writeFile(join(repo.root, 'headers.ts'), 'before\n');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add quoted names');
  const base = repo.git('rev-parse', 'HEAD').trim();
  repo.git('config', 'core.quotePath', 'false');
  repo.git('config', 'diff.srcPrefix', 'hostile/');
  repo.git('config', 'diff.dstPrefix', 'hostile/');
  await writeFile(join(repo.root, unusual), 'after\n');
  await writeFile(join(repo.root, plain), 'after\n');
  await writeFile(join(repo.root, literal), 'after\n');
  await writeFile(join(repo.root, 'headers.ts'), '+++ b/not-a-header\n@@ -1 +1 @@\ndiff --git a/fake b/fake\n');
  const values = await contextFor(repo.root, base, [unusual, plain, literal, 'headers.ts']);

  assert.deepEqual(values.get(unusual)!.change.ranges, [{ start: 1, end: 1 }]);
  assert.equal(values.get(unusual)!.before, 'before\n');
  assert.deepEqual(values.get(plain)!.change.ranges, [{ start: 1, end: 1 }]);
  assert.equal(values.get(plain)!.before, 'before\n');
  assert.deepEqual(values.get(literal)!.change.ranges, [{ start: 1, end: 1 }]);
  assert.equal(values.get(literal)!.before, 'before\n');
  assert.deepEqual(values.get('headers.ts')!.change.ranges, [{ start: 1, end: 3 }]);
  assert.equal(values.get('headers.ts')!.before, 'before\n');
});

test('omits binary and oversized baselines without poisoning other files', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'binary.ts'), Buffer.from([0, 1, 2]));
  await writeFile(join(repo.root, 'oversized.ts'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  const fakeHeader = `${'a'.repeat(40)} blob 7\nbefore\n`;
  await writeFile(join(repo.root, 'normal.ts'), fakeHeader);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add baseline limits');
  const base = repo.git('rev-parse', 'HEAD').trim();
  await writeFile(join(repo.root, 'binary.ts'), 'current\n');
  await writeFile(join(repo.root, 'oversized.ts'), 'current\n');
  await writeFile(join(repo.root, 'normal.ts'), `${'a'.repeat(40)} blob 7\nafter\n`);
  const values = await contextFor(repo.root, base, ['binary.ts', 'oversized.ts', 'normal.ts']);

  assert.equal(values.get('binary.ts')!.before, undefined);
  assert.ok(values.get('binary.ts')!.change.error);
  assert.equal(values.get('oversized.ts')!.before, undefined);
  assert.ok(values.get('oversized.ts')!.change.error);
  assert.equal(values.get('normal.ts')!.before, fakeHeader);
  assert.deepEqual(values.get('normal.ts')!.change.ranges, [{ start: 2, end: 2 }]);
});
