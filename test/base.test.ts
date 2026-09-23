import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../src/collector.js';
import { resolveSettings } from '../src/project-config.js';
import type { ReviewPlan } from '../src/domain.js';
import { repository } from './helpers.js';

const changedPaths = (plan: ReviewPlan) => plan.sources.filter(source => source.role === 'changed').map(source => source.path).sort();

/** A repository whose feature branch adds feature.ts while main, after the branch point, hardens average.ts and adds audit.ts. */
async function divergedRepository() {
  const repo = await repository();
  const commit = (message: string) => { repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
  const branchPoint = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', '-b', 'feature');
  await writeFile(join(repo.root, 'feature.ts'), 'export function share(total: number, payers: number) { return total / payers; }\n');
  commit('Add share');
  repo.git('checkout', '-q', 'main');
  await writeFile(join(repo.root, 'audit.ts'), 'export const audited = true;\n');
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { if (!xs.length) throw new RangeError("empty"); return xs.reduce((a,b) => a+b, 0) / xs.length; }\n');
  commit('Harden average and add auditing on main');
  repo.git('checkout', '-q', 'feature');
  return { ...repo, branchPoint };
}

const withoutGitCommandLine = (message: string) => !/Command failed|rev-parse|merge-base|fatal:/.test(message);

test('a base branch that has moved on is compared at its merge base, so only the branch\'s changes are reviewed', async t => {
  const repo = await divergedRepository(); t.after(repo.cleanup);
  const plan = await collect({ repo: repo.root, base: 'main' });
  assert.deepEqual(changedPaths(plan), ['feature.ts']);
  assert.equal(plan.base, repo.branchPoint);
  assert.equal(plan.baseRef, 'main');
  assert.ok(plan.notes.some(note => note.includes(`merge base ${repo.branchPoint.slice(0, 12)}`)), plan.notes.join('\n'));

  // A base that HEAD's history contains is compared as named, with no merge-base note.
  const own = await collect({ repo: repo.root });
  assert.equal(own.base, repo.git('rev-parse', 'HEAD').trim());
  assert.equal(own.baseRef, 'HEAD');
  assert.ok(!own.notes.some(note => note.includes('merge base')), own.notes.join('\n'));
  const ancestor = await collect({ repo: repo.root, base: repo.branchPoint });
  assert.deepEqual(changedPaths(ancestor), ['feature.ts']);
  assert.notEqual(ancestor.snapshot, plan.snapshot, 'the requested ref is part of the snapshot');
});

test('repository and base errors say what to do, without a Git command line', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const failure = async (base: string, expected: RegExp) => {
    await assert.rejects(collect({ repo: repo.root, base }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.ok(withoutGitCommandLine(error.message), error.message);
      return true;
    });
  };
  await failure('no-such-branch', /^Base no-such-branch was not found in this repository\. Check the name, or fetch it first with git fetch and run Tracecheck again\.$/);
  repo.git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
  await failure('origin/release', /^Base origin\/release was not found in this repository\. .*git fetch origin release/);
  repo.git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  await failure('develop', /^Base develop was not found in this repository, but origin\/develop was\. Use origin\/develop as the base\.$/);
  await failure('HEAD:average.ts', /^Base HEAD:average\.ts does not name a commit\.$/);
  repo.git('checkout', '-q', '--orphan', 'unrelated');
  repo.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Unrelated root');
  await failure('main', /^HEAD and main share no history/);

  const empty = await mkdtemp(join(tmpdir(), 'tracecheck-test-')); t.after(() => rm(empty, { recursive: true, force: true }));
  for (const open of [() => collect({ repo: empty }), () => resolveSettings(empty, {})]) {
    await assert.rejects(open(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Cannot open .+ as a Git working tree: not a git repository/);
      assert.ok(withoutGitCommandLine(error.message), error.message);
      return true;
    });
  }
  execFileSync('git', ['-C', empty, 'init', '-q', '-b', 'main']);
  for (const base of [undefined, 'main']) {
    await assert.rejects(collect({ repo: empty, base }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^The current branch has no commits yet, so there is nothing to compare against\./);
      assert.ok(withoutGitCommandLine(error.message), error.message);
      return true;
    });
  }
});

test('a shallow clone explains the history it needs for the base', async t => {
  const source = await divergedRepository(); t.after(source.cleanup);
  const scratch = await mkdtemp(join(tmpdir(), 'tracecheck-test-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const clone = (name: string, ...args: string[]) => {
    const root = join(scratch, name);
    execFileSync('git', ['clone', '-q', '--depth', '1', ...args, `file://${source.root}`, root]);
    return root;
  };

  // Both tips are fetched, but one commit deep: their merge base is missing.
  const both = clone('both', '--no-single-branch', '--branch', 'feature');
  await assert.rejects(collect({ repo: both, base: 'origin/main' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Cannot find the commit where HEAD's history meets origin\/main: this is a shallow clone.*fetch-depth: 0/);
    assert.ok(withoutGitCommandLine(error.message), error.message);
    return true;
  });

  // A single-branch clone never fetched the base branch.
  const single = clone('single', '--branch', 'feature');
  await assert.rejects(collect({ repo: single, base: 'origin/main' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Base origin\/main was not found in this repository\. .*git fetch origin main.*shallow clone.*fetch-depth: 0/);
    assert.ok(withoutGitCommandLine(error.message), error.message);
    return true;
  });
});
