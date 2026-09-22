import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { collect } from '../src/collector.js';
import { findCandidates } from '../src/checks.js';
import type { ReviewPacket, ReviewPlan } from '../src/domain.js';
import { repository } from './helpers.js';

async function writeSeries(root: string, directory: string, prefix: string, suffix: string, count: number, content = 'export {};') {
  await mkdir(join(root, directory), { recursive: true });
  await Promise.all(Array.from({ length: count }, (_value, index) =>
    writeFile(join(root, directory, `${prefix}${String(index).padStart(3, '0')}${suffix}`), content)));
}

function packetBytes(plan: ReviewPlan, packet: ReviewPacket) {
  const sources = packet.sourcePaths.map(path => plan.sources.find(source => source.path === path)!);
  return Buffer.byteLength(JSON.stringify(sources));
}

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

test('borrows tracked dependencies and callers as packet-local support without executing tests', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'helper.ts'), 'export const denominator = 2;');
  await writeFile(join(repo.root, 'caller.ts'), 'import { average } from "./average.js"; export const caller = () => average([1]);');
  await writeFile(join(repo.root, 'average.test.ts'), 'throw new Error("this file must never execute");');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add context');
  await writeFile(join(repo.root, 'average.ts'), 'import { denominator } from "./helper.js";\nexport function average(xs: number[]) { return xs.length / denominator; }');
  const plan = await collect({ repo: repo.root });
  assert.equal(plan.sources.find(source => source.path === 'helper.ts')!.role, 'dependency');
  assert.equal(plan.sources.find(source => source.path === 'caller.ts')!.role, 'caller');
  assert.equal(plan.sources.find(source => source.path === 'average.test.ts')!.role, 'test');
  assert.deepEqual(plan.packets[0]!.sourcePaths, ['average.ts', 'average.test.ts', 'caller.ts', 'helper.ts']);
});

test('retains non-JS source for quality review and binds task context to the snapshot', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'decode.py'), 'import json\ndef decode(text): return json.loads(text)');
  const plan = await collect({ repo: repo.root, includeUntracked: true, task: 'Return None for invalid JSON.' });
  assert.equal(plan.sources[0]!.path, 'decode.py');
  assert.equal(plan.candidates.length, 0);
  const changed = await collect({ repo: repo.root, includeUntracked: true, task: 'Throw for invalid JSON.' });
  assert.notEqual(changed.snapshot, plan.snapshot);
});

test('packs every eligible changed path exactly once across bounded packets', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeSeries(repo.root, 'changes', 'change-', '.ts', 17, 'export const baseline = 1;');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add changed files');
  await writeSeries(repo.root, 'changes', 'change-', '.ts', 17, 'export const changed = (value: number) => value / 2;');
  const plan = await collect({ repo: repo.root });
  assert.equal(plan.packets.length, 3);
  const primaries = plan.packets.flatMap(packet => packet.changedPaths);
  assert.equal(new Set(primaries).size, 17);
  assert.deepEqual(primaries.sort(), Array.from({ length: 17 }, (_value, index) => `changes/change-${String(index).padStart(3, '0')}.ts`));
  for (const packet of plan.packets) {
    assert.ok(packet.changedPaths.length <= 8);
    assert.ok(packet.sourcePaths.length <= 16);
    assert.ok(packet.sourcePaths.reduce((total, path) => {
      const source = plan.sources.find(item => item.path === path)!;
      return total + source.content.length + (source.before?.length ?? 0);
    }, 0) <= 60_000);
    assert.ok(packetBytes(plan, packet) <= 80_000);
  }
});

test('keeps every candidate globally rather than applying the obsolete forty-candidate cutoff', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const baseline = Array.from({ length: 41 }, (_value, index) => `export function value${index}(a: number, b: number) { return a; }`).join('\n');
  const changed = Array.from({ length: 41 }, (_value, index) => `export function value${index}(a: number, b: number) { return a / b; }`).join('\n');
  await writeFile(join(repo.root, 'many.ts'), baseline);
  repo.git('add', 'many.ts'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add candidate fixture');
  await writeFile(join(repo.root, 'many.ts'), changed);
  const plan = await collect({ repo: repo.root });
  assert.equal(plan.candidates.length, 41);
  assert.equal(plan.packets[0]!.candidateIds.length, 41);
});

test('discovers a caller past the old two-hundred-file index cutoff', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeSeries(repo.root, '.', 'noise-', '.ts', 205);
  await writeFile(join(repo.root, 'zz-caller.ts'), 'import { average } from "./average.js"; export const caller = () => average([1]);');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add import graph');
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((total, value) => total + value, 0); }');
  const plan = await collect({ repo: repo.root });
  assert.equal(plan.sources.find(source => source.path === 'zz-caller.ts')!.role, 'caller');
});

test('reuses constrained discovery scope without pinning collected evidence', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'caller.ts'), 'import { average } from "./average.js"; export const caller = () => average([1]);');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add caller');
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((total, value) => total + value, 0); }');

  const options = { repo: repo.root, collection: { maxIndexFiles: 1 } };
  const initial = await collect(options);
  assert.deepEqual(initial.discovery, { scannedFiles: 1, deadlineLimited: false });

  const revalidated = await collect({ ...options, discovery: initial.discovery });
  assert.equal(revalidated.snapshot, initial.snapshot);
  assert.deepEqual(revalidated.sources, initial.sources);
  assert.deepEqual(revalidated.packets, initial.packets);
  assert.deepEqual(revalidated.limitations, initial.limitations);

  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((total, value) => total + value + 1, 0); }');
  const mutated = await collect({ ...options, discovery: initial.discovery });
  assert.notEqual(mutated.snapshot, initial.snapshot);
  assert.match(mutated.sources.find(source => source.path === 'average.ts')!.content, /\+ 1/);
});

test('round-robins packet support so fan-in does not crowd out another change context', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'first.ts'), 'export const first = () => 1;');
  await writeFile(join(repo.root, 'second-dependency.ts'), 'export const dependency = 2;');
  await writeFile(join(repo.root, 'second.ts'), 'import { dependency } from "./second-dependency.js"; export const second = () => dependency;');
  await writeFile(join(repo.root, 'second.test.ts'), 'import { second } from "./second.js"; void second;');
  await writeSeries(repo.root, 'first-callers', 'caller-', '.ts', 15, 'import { first } from "../first.js"; export const caller = () => first();');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add packet support graph');

  await writeFile(join(repo.root, 'first.ts'), 'export const first = (value: number) => value / 2;');
  await writeFile(join(repo.root, 'second.ts'), 'import { dependency } from "./second-dependency.js"; export const second = () => dependency / 2;');
  const plan = await collect({ repo: repo.root });

  assert.equal(plan.packets.length, 1);
  assert.ok(plan.packets[0]!.sourcePaths.includes('second.test.ts'));
  assert.ok(plan.packets[0]!.sourcePaths.includes('second-dependency.ts'));
});

const ratioModule = 'export function ratio(a: number, b: number) {\n  if (!b) return 0;\n  return a / b;\n}\n\nexport function half(value: number, parts: number) {\n  return value / parts;\n}\n';

test('reviews a renamed and edited file against the base content of its old path', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const oldPath = 'src/old [name]\tfile.ts';
  const newPath = 'lib/new "name" é.ts';
  await mkdir(join(repo.root, 'src'));
  await mkdir(join(repo.root, 'lib'));
  await writeFile(join(repo.root, oldPath), ratioModule);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add ratio');
  repo.git('mv', oldPath, newPath);
  await writeFile(join(repo.root, newPath), ratioModule.replace('  if (!b) return 0;\n', ''));
  const plan = await collect({ repo: repo.root });

  const source = plan.sources.find(item => item.path === newPath)!;
  assert.equal(source.previousPath, oldPath);
  assert.equal(source.before, ratioModule);
  assert.deepEqual(plan.candidates.map(candidate => [candidate.path, candidate.symbol]), [[newPath, 'ratio']]);
  assert.ok(!plan.sources.some(item => item.path === oldPath));
});

test('records a pure rename without changed ranges or candidates', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'ratio.ts'), ratioModule);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add ratio');
  repo.git('mv', 'ratio.ts', 'quotient.ts');
  const plan = await collect({ repo: repo.root });

  const source = plan.sources.find(item => item.path === 'quotient.ts')!;
  assert.equal(source.role, 'changed');
  assert.equal(source.previousPath, 'ratio.ts');
  assert.equal(source.before, ratioModule);
  assert.equal(plan.candidates.length, 0);
});

test('reports renames that cross into or out of ineligible paths', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const padding = (name: string) => Array.from({ length: 12 }, (_value, index) => `export const ${name}${index} = ${index};\n`).join('');
  await mkdir(join(repo.root, 'dist'));
  await writeFile(join(repo.root, 'dist/ratio.ts'), ratioModule);
  await writeFile(join(repo.root, 'notes.ts'), padding('note'));
  await writeFile(join(repo.root, 'keys.ts'), padding('key'));
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add rename sources');
  repo.git('mv', 'dist/ratio.ts', 'ratio.ts');
  await writeFile(join(repo.root, 'ratio.ts'), ratioModule.replace('  if (!b) return 0;\n', ''));
  repo.git('mv', 'notes.ts', 'notes.txt');
  repo.git('mv', 'keys.ts', 'credentials.ts');
  await writeFile(join(repo.root, 'credentials.ts'), `${padding('key')}const apiKey = "abcdefghijklmnopqrstuvwxyz123456";\n`);
  const plan = await collect({ repo: repo.root });
  const limitations = plan.limitations.join('\n');

  const fromGenerated = plan.sources.find(item => item.path === 'ratio.ts')!;
  assert.equal(fromGenerated.previousPath, 'dist/ratio.ts');
  assert.equal(fromGenerated.before, undefined);
  assert.match(limitations, /Renamed from unsupported or generated path dist\/ratio\.ts; reviewed without a baseline \(ratio\.ts\)/);
  assert.match(limitations, /Unsupported or generated file \(notes\.ts -> notes\.txt\)/);
  assert.match(limitations, /potential secret-bearing file omitted \(keys\.ts -> credentials\.ts\)/);
  assert.ok(!JSON.stringify(plan).includes('abcdefghijklmnopqrstuvwxyz123456'));
});
