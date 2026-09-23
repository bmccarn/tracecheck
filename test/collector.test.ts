import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { chmod, mkdir, realpath, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { collect } from '../src/collector.js';
import { resolveSettings } from '../src/project-config.js';
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

test('untracked files require opt-in; credentials, deleted files and symlinks are visible omissions', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  // Assembled at runtime so the repository never contains a literal secret.
  const credential = ['q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd'].join('');
  await writeFile(join(repo.root, 'new.ts'), 'export const ratio = (a: number,b: number) => a/b;');
  await writeFile(join(repo.root, 'secret.ts'), `const apiKey = "${credential}";`);
  await writeFile(join(repo.root, 'deploy.sh'), `export API_TOKEN=${credential}\n`);
  await writeFile(join(repo.root, 'config.yml'), `database:\n  password: ${credential}\n`);
  await writeFile(join(repo.root, 'settings.toml'), `api_key = ${credential}\n`);
  await writeFile(join(repo.root, 'lexer.ts'), "export const token = 'StringLiteralExpressionToken';\n");
  await symlink('/etc/hosts', join(repo.root, 'outside.ts'));
  const preview = await collect({ repo: repo.root });
  assert.equal(preview.candidates.length, 0);
  assert.match(preview.limitations.join('\n'), /untracked/);
  const included = await collect({ repo: repo.root, includeUntracked: true });
  assert.equal(included.candidates.length, 1);
  assert.ok(!JSON.stringify(included).includes(credential));
  // Every credential omission is named, not only the first three samples.
  assert.match(included.limitations.join('\n'), /omitted 4 file\(s\): File with a potential credential omitted \(config\.yml, deploy\.sh, secret\.ts, settings\.toml\)/);
  assert.equal(included.sources.find(source => source.path === 'lexer.ts')?.role, 'changed');
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

test('focuses a large caller on call sites of const arrow and $-named exports', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const filler = (from: number, count: number) => Array.from({ length: count }, (_value, index) => `export const filler${from + index} = ${from + index};`);
  const caller = ['import { ratio, $pick } from "./math.js";', ...filler(0, 400),
    'export const scaled = ratio(4, 2);', ...filler(400, 200), 'export const first = $pick([1, 2]);', ...filler(600, 200)].join('\n');
  assert.ok(caller.length > 12_000);
  await writeFile(join(repo.root, 'math.ts'), 'export const ratio = (a: number, b: number) => b ? a / b : 0;\nexport function $pick(xs: number[]) { return xs[0]; }\n');
  await writeFile(join(repo.root, 'caller.ts'), caller);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add math');
  await writeFile(join(repo.root, 'math.ts'), 'export const ratio = (a: number, b: number) => a / b;\nexport function $pick(xs: number[]) { return xs[0]; }\n');
  const source = (await collect({ repo: repo.root })).sources.find(item => item.path === 'caller.ts')!;
  assert.equal(source.role, 'caller');
  assert.equal(source.evidence!.complete, false);
  assert.match(source.content, /^402: export const scaled = ratio\(4, 2\);$/m);
  assert.match(source.content, /^603: export const first = \$pick\(\[1, 2\]\);$/m);
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

test('collects Python callers and tests that use wrapped or comma-separated imports', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await mkdir(join(repo.root, 'pkg')); await mkdir(join(repo.root, 'tests'));
  await writeFile(join(repo.root, 'pkg/__init__.py'), '');
  await writeFile(join(repo.root, 'pkg/calc.py'), 'def mean(values):\n    if not values:\n        return 0\n    return sum(values) / len(values)\n');
  await writeFile(join(repo.root, 'pkg/report.py'), 'from pkg.calc import (\n    mean,\n)\n\n\ndef summary(values):\n    return mean(values)\n');
  await writeFile(join(repo.root, 'tests/test_summary.py'), 'import pkg.report, pkg.calc as calc\n\n\ndef test_empty():\n    assert calc.mean([]) == 0\n');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add package');
  await writeFile(join(repo.root, 'pkg/calc.py'), 'def mean(values):\n    return sum(values) / len(values)\n');
  const plan = await collect({ repo: repo.root });
  assert.deepEqual(plan.sources.map(source => [source.path, source.role]),
    [['pkg/calc.py', 'changed'], ['pkg/report.py', 'caller'], ['tests/test_summary.py', 'test']]);
});

test('links NodeNext module specifiers and stylesheets but not images', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'lib.mts'), 'export const scale = 2;');
  await writeFile(join(repo.root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(repo.root, 'app.css'), 'body { margin: 0; }');
  await writeFile(join(repo.root, 'app.tsx'), 'import { scale } from "./lib.mjs";\nimport logo from "./logo.png";\nimport "./app.css";\nexport const size = (value: number) => value * scale + logo.length;');
  await writeFile(join(repo.root, 'main.ts'), 'import { size } from "./app.jsx"; export const width = size(1);');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add app');
  await writeFile(join(repo.root, 'app.tsx'), 'import { scale } from "./lib.mjs";\nimport logo from "./logo.png";\nimport "./app.css";\nexport const size = (value: number) => value / scale + logo.length;');
  const plan = await collect({ repo: repo.root });
  assert.deepEqual(plan.sources.map(source => [source.path, source.role]).sort(),
    [['app.css', 'dependency'], ['app.tsx', 'changed'], ['lib.mts', 'dependency'], ['main.ts', 'caller']]);
  assert.doesNotMatch([...plan.limitations, ...plan.packets.flatMap(packet => packet.limitations)].join('\n'), /logo\.png/);
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
  // Assembled at runtime so the repository never contains a literal secret.
  const credential = ['q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd'].join('');
  await writeFile(join(repo.root, 'credentials.ts'), `${padding('key')}const apiKey = "${credential}";\n`);
  const plan = await collect({ repo: repo.root });
  const limitations = plan.limitations.join('\n');

  const fromGenerated = plan.sources.find(item => item.path === 'ratio.ts')!;
  assert.equal(fromGenerated.previousPath, 'dist/ratio.ts');
  assert.equal(fromGenerated.before, undefined);
  assert.match(limitations, /Renamed from unsupported or generated path dist\/ratio\.ts; reviewed without a baseline \(ratio\.ts\)/);
  assert.match(limitations, /Unsupported or generated file \(notes\.ts -> notes\.txt\)/);
  assert.match(limitations, /File with a potential credential omitted \(keys\.ts -> credentials\.ts\)/);
  assert.ok(!JSON.stringify(plan).includes(credential));
});

test('reviews a change whose base version held a credential without that baseline', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  // Assembled at runtime so the repository never contains a literal secret.
  const credential = ['q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd'].join('');
  const client = (key: string, guard: string) =>
    `const apiKey = ${key};\n\nexport function rate(total: number, count: number) {\n${guard}  return total / count;\n}\n\nexport const auth = () => apiKey;\n`;
  await writeFile(join(repo.root, 'client.ts'), client(`"${credential}"`, '  if (count === 0) return 0;\n'));
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add client');
  await writeFile(join(repo.root, 'client.ts'), client('process.env.CLIENT_API_KEY', ''));
  const plan = await collect({ repo: repo.root });

  assert.ok(!JSON.stringify(plan).includes(credential));
  const source = plan.sources.find(item => item.path === 'client.ts')!;
  assert.equal(source.role, 'changed');
  assert.match(source.content, /process\.env\.CLIENT_API_KEY/);
  assert.equal(source.before, undefined);
  assert.deepEqual(plan.candidates.map(candidate => [candidate.check, candidate.symbol]), [['zero-divisor', 'rate']]);
  const reason = 'Base version with a potential credential omitted; reviewed without a baseline';
  assert.ok(plan.limitations.some(limitation => limitation.includes(`${reason} (client.ts)`)), plan.limitations.join('\n'));
  assert.deepEqual(plan.packets.map(packet => packet.limitations.filter(limitation => limitation.includes('credential'))), [[`${reason}: client.ts`]]);
});

test('reads and screens each changed and supporting file once per collection', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const modules = Array.from({ length: 9 }, (_value, index) => `lib/m${index}.ts`);
  const guarded = (index: number, guard: string) => `export function m${index}(a: number, b: number) {\n${guard}  return a / b;\n}\n`;
  await mkdir(join(repo.root, 'lib'));
  await writeFile(join(repo.root, 'app.ts'), modules.map((_path, index) => `import { m${index} } from './lib/m${index}.js';\n`).join('')
    + `export const all = [${modules.map((_path, index) => `m${index}(4, 2)`).join(', ')}];\n`);
  for (const [index, path] of modules.entries()) await writeFile(join(repo.root, path), guarded(index, '  if (!b) return 0;\n'));
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Guarded modules');
  for (const [index, path] of modules.entries()) await writeFile(join(repo.root, path), guarded(index, ''));
  // The first collection fills the import index cache, whose own reads are not part of the collector's.
  await collect({ repo: repo.root });
  const root = await realpath(repo.root);
  const opened = new Map<string, number>();
  const open = fsPromises.open;
  mock.method(fsPromises, 'open', (path: string, ...rest: [number, number?]) => {
    const key = relative(root, path);
    opened.set(key, (opened.get(key) ?? 0) + 1);
    return open(path, ...rest);
  });
  syncBuiltinESMExports();
  let plan: ReviewPlan;
  try { plan = await collect({ repo: repo.root }); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  // Nine changed files make two packets, and both use app.ts as caller context.
  assert.equal(plan.packets.length, 2);
  assert.ok(plan.packets.every(packet => packet.sourcePaths.includes('app.ts')));
  assert.deepEqual([...opened.keys()].sort(), ['app.ts', ...modules].sort());
  assert.deepEqual(Object.fromEntries(opened), Object.fromEntries([...opened.keys()].map(path => [path, 1])));
});

test('streams a tracked-file listing larger than the old 8 MiB output buffer', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  // About 8.8 MB of paths, recorded in the index only and marked skip-worktree so no files are written.
  const blob = execFileSync('git', ['-C', repo.root, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf8' }).trim();
  const paths = Array.from({ length: 42_000 }, (_value, index) => `${'d'.repeat(200)}/${index}.txt`);
  execFileSync('git', ['-C', repo.root, 'update-index', '-z', '--index-info'], { input: paths.map(path => `100644 ${blob}\t${path}\0`).join('') });
  execFileSync('git', ['-C', repo.root, 'update-index', '-z', '--skip-worktree', '--stdin'], { input: paths.map(path => `${path}\0`).join('') });
  repo.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Add many paths');
  assert.ok(execFileSync('git', ['-C', repo.root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }).length > 8 * 1024 * 1024);
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((a,b) => a+b, 0) / xs.length; }\n');

  const plan = await collect({ repo: repo.root });
  assert.deepEqual(plan.packets.flatMap(packet => packet.changedPaths), ['average.ts']);
  assert.equal(plan.candidates.length, 1);
});

test('collects the requested repository when Git environment variables name another one', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const other = await repository(); t.after(other.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((a,b) => a+b, 0) / xs.length; }\n');
  await writeFile(join(other.root, 'other.ts'), 'export const other = 1;\n');
  other.git('add', 'other.ts');
  const redirect = { GIT_DIR: join(other.root, '.git'), GIT_WORK_TREE: other.root, GIT_INDEX_FILE: join(other.root, '.git', 'index') };
  const saved = Object.fromEntries(Object.keys(redirect).map(name => [name, process.env[name]]));
  Object.assign(process.env, redirect);
  let plan: ReviewPlan;
  let settingsRoot: string;
  try {
    settingsRoot = (await resolveSettings(repo.root, {})).root;
    plan = await collect({ repo: repo.root });
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  assert.equal(settingsRoot, await realpath(repo.root));
  assert.equal(plan.root, await realpath(repo.root));
  assert.deepEqual(plan.sources.map(source => source.path), ['average.ts']);
});

test('records a limitation for changed files without textual hunks', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, '.gitattributes'), 'opaque.ts -diff\n');
  await writeFile(join(repo.root, 'mode.ts'), 'export const mode = 1;\n');
  await writeFile(join(repo.root, 'opaque.ts'), 'export const opaque = 1;\n');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add hunkless fixtures');
  await chmod(join(repo.root, 'mode.ts'), 0o755);
  await writeFile(join(repo.root, 'opaque.ts'), 'export const opaque = 2;\n');
  const plan = await collect({ repo: repo.root });
  const limitations = plan.limitations.join('\n');

  assert.deepEqual(plan.sources.map(source => source.path), ['mode.ts', 'opaque.ts']);
  assert.match(limitations, /File mode changed without a content change; no changed lines to review \(mode\.ts\)/);
  assert.match(limitations, /Git reported no textual diff \(binary or -diff attribute\); changed lines are unknown \(opaque\.ts\)/);
});

test('counts source limitations for paths containing colons under one reason', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const large = (name: string) => Array.from({ length: 800 }, (_value, index) => `export const ${name}${index} = ${index};\n`).join('');
  await mkdir(join(repo.root, 'src'));
  await writeFile(join(repo.root, 'src/a:one.ts'), large('one'));
  await writeFile(join(repo.root, 'src/b:two.ts'), large('two'));
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add colon paths');
  await writeFile(join(repo.root, 'src/a:one.ts'), large('one').replace('one400 = 400', 'one400 = 0'));
  await writeFile(join(repo.root, 'src/b:two.ts'), large('two').replace('two400 = 400', 'two400 = 0'));
  const plan = await collect({ repo: repo.root });

  assert.ok(plan.limitations.includes('Collected source limitation for 2 file(s): Focused excerpts only; omitted lines are not reviewed (src/a:one.ts, src/b:two.ts).'), plan.limitations.join('\n'));
  assert.ok(plan.packets[0]!.limitations.includes('Focused excerpts only; omitted lines are not reviewed: src/a:one.ts'));
});
