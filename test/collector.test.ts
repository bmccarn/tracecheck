import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { collect } from '../src/collector.js';
import { findCandidates } from '../src/checks.js';
import { repository } from './helpers.js';

test('collects a guard removal, retains old code, and changes snapshot when context changes', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const content = 'export function average(xs: number[]) { return xs.reduce((a,b) => a+b, 0) / xs.length; }\n';
  await writeFile(join(repo.root, 'average.ts'), content);
  const plan = await collect({ repo: repo.root });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0]!.symbol, 'average');
  assert.match(plan.sources[0]!.before!, /if \(!xs.length\)/);
  assert.equal(plan.candidates[0]!.quote, 'xs.reduce((a,b) => a+b, 0) / xs.length');
  await writeFile(join(repo.root, 'average.ts'), content + '// changed\n');
  assert.notEqual((await collect({ repo: repo.root })).snapshot, plan.snapshot);
});

test('untracked files require opt-in; secrets, deleted files and symlinks are visible omissions', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'new.ts'), 'export const ratio = (a: number,b: number) => a/b;');
  await writeFile(join(repo.root, 'secret.ts'), 'const apiKey = "abcdefghijklmnopqrstuvwxyz123456";');
  await symlink('/etc/hosts', join(repo.root, 'outside.ts'));
  const preview = await collect({ repo: repo.root });
  assert.equal(preview.candidates.length, 0);
  assert.match(preview.limitations.join('\n'), /untracked/);
  const included = await collect({ repo: repo.root, includeUntracked: true });
  assert.equal(included.candidates.length, 1);
  assert.ok(!JSON.stringify(included).includes('abcdefghijklmnopqrstuvwxyz123456'));
  assert.match(included.limitations.join('\n'), /potential secret-bearing/);
  assert.match(included.limitations.join('\n'), /Symlink/);
  repo.git('rm', 'average.ts');
  assert.match((await collect({ repo: repo.root })).limitations.join('\n'), /Deleted/);
});

test('finds candidates in changed functions without flagging unrelated functions', () => {
  const code = 'function untouched(a: number, b: number) { return a/b; }\nfunction changed(a: number, b: number) {\n return a/b;\n}\n';
  const candidates = findCandidates('a.ts', code, [{ start: 3, end: 3 }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.symbol, 'changed');
  assert.equal(candidates[0]!.range.start, 3);
  const shifted = findCandidates('a.ts', '\n' + code, [{ start: 4, end: 4 }]);
  assert.equal(shifted[0]!.id, candidates[0]!.id);
});

test('loads tracked relative imports and related tests without executing them', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'helper.ts'), 'export const denominator = 2;');
  await writeFile(join(repo.root, 'average.test.ts'), 'throw new Error("this file must never execute");');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add context');
  await writeFile(join(repo.root, 'average.ts'), 'import { denominator } from "./helper.js";\nexport function average(xs: number[]) { return xs.length / denominator; }');
  const plan = await collect({ repo: repo.root });
  assert.equal(plan.sources.find(source => source.path === 'helper.ts')!.role, 'dependency');
  assert.equal(plan.sources.find(source => source.path === 'average.test.ts')!.role, 'test');
});

test('retains non-JS source for quality review and binds task context to the snapshot', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'decode.py'), 'import json\ndef decode(text): return json.loads(text)');
  const plan = await collect({ repo: repo.root, includeUntracked: true, task: 'Return None for invalid JSON.' });
  assert.equal(plan.sources[0]!.path, 'decode.py');
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(plan.limitations, ['Import/caller discovery is heuristic; unresolved imports, aliases, dynamic imports, and external contracts may be missing.']);
  const changed = await collect({ repo: repo.root, includeUntracked: true, task: 'Throw for invalid JSON.' });
  assert.notEqual(changed.snapshot, plan.snapshot);
});
