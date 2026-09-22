import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collect } from '../src/collector.js';
import { findCandidates } from '../src/checks.js';
import { repository } from './helpers.js';

const everything = [{ start: 1, end: 1_000 }];
const found = (path: string, code: string, changed = everything) =>
  findCandidates(path, code, changed).map(candidate => `${candidate.check} ${candidate.symbol}: ${candidate.quote}`);

test('parses JSX in plain JavaScript modules', () => {
  const code = 'export function Ratio({ a, b }) {\n  return <span>{a / b}</span>;\n}\n';
  for (const path of ['view.js', 'view.mjs', 'view.cjs']) assert.deepEqual(found(path, code), ['zero-divisor Ratio: a / b'], path);
});

test('parses decorators without enabling JSX in TypeScript', () => {
  const code = [
    '@Injectable()',
    'export class Service {',
    '  constructor(@Inject(TOKEN) private readonly store: Store) {}',
    '  @Get()',
    '  load(raw: unknown) {',
    '    const size = <number>raw;',
    '    try { return this.store.read(size); } catch (error) { return null; }',
    '  }',
    '}',
  ].join('\n');
  for (const path of ['service.ts', 'service.mts', 'service.cts']) {
    assert.deepEqual(found(path, code, [{ start: 7, end: 7 }]), ['swallowed-failure load: catch (error) { return null; }'], path);
  }
  assert.deepEqual(found('model.mjs', 'export @observable class Model {\n  ratio(a, b) { return a / b; }\n}\n'), ['zero-divisor ratio: a / b']);
});

test('selects sites in decorator arguments on parameter properties', () => {
  const code = 'class Service {\n  constructor(@Inject(JSON.parse(raw)) private readonly store: Store, @Limit(b / c) size: number) {}\n}\n';
  assert.deepEqual(found('service.ts', code), ['unhandled-json constructor: JSON.parse(raw)', 'zero-divisor constructor: b / c']);
});

test('reports a parse failure by file and error code without quoting source', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'let hiddenSourceName = 1;\nlet hiddenSourceName = 2;\n');
  const plan = await collect({ repo: repo.root });
  const limitations = [...plan.limitations, ...plan.packets.flatMap(packet => packet.limitations)].join('\n');
  assert.match(limitations, /Source could not be parsed \(VarRedeclaration\); no candidates collected: average\.ts/);
  assert.doesNotMatch(limitations, /hiddenSourceName/);
});

test('skips literal non-zero divisors but keeps variable and zero divisors', () => {
  const code = [
    'export function scale(x: number, y: number, n: bigint, total: number, count: number, size: number) {',
    '  const skipped = [x / 2, x % 2.5, n % 100n, n / 0x10n];',
    '  const kept = [x / y, x / 0, x % 0.0, n % 0n];',
    '  total /= count;',
    '  n %= size;',
    '  total /= 4;',
    '  return [skipped, kept, total, n];',
    '}',
  ].join('\n');
  assert.deepEqual(found('scale.ts', code), [
    'zero-divisor scale: x / y', 'zero-divisor scale: x / 0', 'zero-divisor scale: x % 0.0', 'zero-divisor scale: n % 0n',
    'zero-divisor scale: total /= count', 'zero-divisor scale: n %= size',
  ]);
});

test('skips catch handlers that always rethrow but keeps conditional rethrows', () => {
  const code = [
    'export async function save(write: () => Promise<void>, retry: boolean) {',
    '  try { await write(); } catch (error) { console.error(error); throw error; }',
    '  try { await write(); } catch (error) { if (!retry) throw error; }',
    '  try { await write(); } catch { return false; }',
    '}',
  ].join('\n');
  assert.deepEqual(found('save.ts', code), [
    'swallowed-failure save: catch (error) { if (!retry) throw error; }',
    'swallowed-failure save: catch { return false; }',
  ]);
});

test('skips JSON.parse only inside the protected block of a try with a handler', () => {
  const code = [
    'export function read(raw: string) {',
    '  try { return JSON.parse(raw); } catch { return undefined; }',
    '}',
    'export function unguarded(raw: string) {',
    '  try { return JSON.parse(raw); } finally { done(); }',
    '}',
    'export function inHandler(raw: string) {',
    '  try { return load(); } catch { return JSON.parse(raw); }',
    '}',
    'export function deferred(raw: string) {',
    '  try { return () => JSON.parse(raw); } catch { return undefined; }',
    '}',
  ].join('\n');
  assert.deepEqual(found('read.ts', code).filter(candidate => candidate.startsWith('unhandled-json')), [
    'unhandled-json unguarded: JSON.parse(raw)',
    'unhandled-json inHandler: JSON.parse(raw)',
    'unhandled-json <anonymous-or-module>: JSON.parse(raw)',
  ]);
});

test('scopes module-level candidates to their top-level statement', () => {
  const code = [
    'export const ratio = total / count;',
    'export const settings = {',
    '  share: part / whole,',
    '};',
    'export function changed(a: number, b: number) {',
    '  return a + b;',
    '}',
  ].join('\n');
  assert.deepEqual(found('module.ts', code, [{ start: 6, end: 6 }]), []);
  assert.deepEqual(found('module.ts', code, [{ start: 2, end: 2 }]), ['zero-divisor <anonymous-or-module>: part / whole']);
  assert.deepEqual(found('module.ts', code, [{ start: 1, end: 1 }]), ['zero-divisor <anonymous-or-module>: total / count']);
});

test('keeps the IDs of candidates that are still selected', () => {
  const code = [
    'export const ratio = total / count;',
    'export function parse(raw: string) {',
    '  try { return JSON.parse(raw); } catch { return undefined; }',
    '}',
    'export function load(raw: string) {',
    '  try { JSON.parse(raw); } catch (error) { throw error; }',
    '  return JSON.parse(raw);',
    '}',
  ].join('\n');
  // IDs produced for these sites before skipped sites were filtered out.
  assert.deepEqual(findCandidates('ids.ts', code, everything).map(candidate => [candidate.id, candidate.range.start]), [
    ['00adda2c67a9a7dd5512e696', 1],
    ['f9816bff8f2c46ad9a7b9e5f', 3],
    ['92471f8dd6e6f1f3e4733021', 7],
  ]);
});
