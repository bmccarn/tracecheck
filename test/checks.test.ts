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

test('reports a parse failure by file and error code without quoting source', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'let hiddenSourceName = 1;\nlet hiddenSourceName = 2;\n');
  const plan = await collect({ repo: repo.root });
  const limitations = [...plan.limitations, ...plan.packets.flatMap(packet => packet.limitations)].join('\n');
  assert.match(limitations, /Source could not be parsed \(VarRedeclaration\); no candidates collected: average\.ts/);
  assert.doesNotMatch(limitations, /hiddenSourceName/);
});
