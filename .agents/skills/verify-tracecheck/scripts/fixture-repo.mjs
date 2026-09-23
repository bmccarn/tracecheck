#!/usr/bin/env node
// Creates a disposable Git repository with a committed baseline, an optional follow-up commit, and an uncommitted change.
// Usage: node .agents/skills/verify-tracecheck/scripts/fixture-repo.mjs <scenario> [--list]
// Prints JSON: { scenario, root, description, changed }. The caller removes `root` when done.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Credential-shaped values are assembled at runtime so this file never contains a literal secret.
const fakeCredential = ['q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd'].join('');
const ratioModule = (index, guard) => `export function ratio${index}(a: number, b: number): number {\n${guard ? '  if (b === 0) return 0;\n' : ''}  return a / b;\n}\n`;
// `count` modules each lose a zero-divisor guard, and one caller imports all of them.
const multiPacket = count => {
  const paths = Array.from({ length: count }, (_value, index) => `src/ratio${String(index).padStart(2, '0')}.ts`);
  const caller = paths.map((path, index) => `import { ratio${index} } from './${path.slice(4, -3)}.js';\n`).join('')
    + `\nexport const ratios = [${paths.map((_path, index) => `ratio${index}(4, 2)`).join(', ')}];\n`;
  return {
    baseline: { 'src/app.ts': caller, ...Object.fromEntries(paths.map((path, index) => [path, ratioModule(index, true)])) },
    change: Object.fromEntries(paths.map((path, index) => [path, ratioModule(index, false)])),
  };
};
const lexer = extra => `export type TokenKind = 'StringLiteralExpressionToken' | 'NoSubstitutionTemplateLiteral' | 'IdentifierNameToken';\n\nexport function classify(text: string): TokenKind {\n  let token: TokenKind = 'IdentifierNameToken';\n  if (/^["']/.test(text)) token = 'StringLiteralExpressionToken';\n${extra}  return token;\n}\n`;

const scenarios = {
  'json-regression': {
    description: 'TS decode() loses its try/catch, so malformed JSON now throws. Expect one unhandled-json candidate.',
    baseline: { 'decode.ts': '// Public API: malformed JSON must return null, never throw.\nexport function decode(input: string) { try { return JSON.parse(input); } catch { return null; } }\n' },
    change: { 'decode.ts': '// Public API: malformed JSON must return null, never throw.\nexport function decode(input: string) { return JSON.parse(input); }\nexport const malformed = decode("{broken");\n' },
  },
  division: {
    description: 'TS mean() loses its empty-input guard; a caller and a test import it. Expect a zero-divisor candidate plus caller and test sources.',
    baseline: {
      'src/stats.ts': 'export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n',
      'src/report.ts': "import { mean } from './stats.js';\n\nexport function summary(values: number[]) {\n  return `mean=${mean(values)}`;\n}\n",
      'test/stats.test.ts': "import { mean } from '../src/stats.js';\n\nif (mean([]) !== 0) throw new Error('empty mean must be 0');\n",
    },
    change: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
  },
  rename: {
    description: 'git mv old.ts new.ts, then delete the divisor guard. The baseline of new.ts should be old.ts.',
    baseline: { 'old.ts': 'export function ratio(a: number, b: number) {\n  if (!b) return 0;\n  return a / b;\n}\n' },
    moves: [['old.ts', 'new.ts']],
    change: { 'new.ts': 'export function ratio(a: number, b: number) {\n  return a / b;\n}\n' },
  },
  'rename-pure': {
    description: 'git mv ratio.ts quotient.ts with no content change. Expect quotient.ts recorded as renamed from ratio.ts, with its baseline and no candidates.',
    baseline: { 'ratio.ts': 'export function ratio(a: number, b: number) {\n  return a / b;\n}\n' },
    moves: [['ratio.ts', 'quotient.ts']],
    change: {},
  },
  'rename-ineligible': {
    description: 'Renames across eligibility: dist/ratio.ts (generated) to ratio.ts with the guard removed, and notes.ts to notes.txt (unsupported). Expect a limitation for each, naming both paths.',
    baseline: {
      'dist/ratio.ts': 'export function ratio(a: number, b: number) {\n  if (!b) return 0;\n  return a / b;\n}\n',
      'notes.ts': Array.from({ length: 12 }, (_value, index) => `export const note${index} = ${index};\n`).join(''),
    },
    moves: [['dist/ratio.ts', 'ratio.ts'], ['notes.ts', 'notes.txt']],
    change: { 'ratio.ts': 'export function ratio(a: number, b: number) {\n  return a / b;\n}\n' },
  },
  'staged-reverted': {
    description: 'mean() loses its empty-input guard and the change is staged, then the working tree restores the guard. Expect no packets, and a note naming src/stats.ts as a staged change the working tree undoes.',
    baseline: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
    change: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
    stage: ['src/stats.ts'],
    unstaged: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
  },
  'rename-unpaired': {
    description: 'git mv ratio.ts quotient.ts, then rewrite quotient.ts so Git no longer pairs it with ratio.ts. Expect quotient.ts without previousPath or baseline, and a note naming the staged rename ratio.ts -> quotient.ts.',
    baseline: { 'ratio.ts': 'export function ratio(a: number, b: number) {\n  if (!b) return 0;\n  return a / b;\n}\n' },
    moves: [['ratio.ts', 'quotient.ts']],
    change: { 'quotient.ts': 'export const quotient = (a: number, b: number) => a / b;\n' },
  },
  'python-import': {
    description: 'Python module changes; a caller imports it with a parenthesized multi-line import and a test imports it plainly.',
    baseline: {
      'pkg/__init__.py': '',
      'pkg/calc.py': 'def mean(values):\n    if not values:\n        return 0\n    return sum(values) / len(values)\n',
      'pkg/report.py': 'from pkg.calc import (\n    mean,\n)\n\n\ndef summary(values):\n    return f"mean={mean(values)}"\n',
      'tests/test_calc.py': 'from pkg.calc import mean\n\n\ndef test_empty():\n    assert mean([]) == 0\n',
    },
    change: { 'pkg/calc.py': 'def mean(values):\n    return sum(values) / len(values)\n' },
  },
  'jsx-js': {
    description: 'React component in a plain .js file loses its zero-total guard. Expect one zero-divisor candidate in Progress and no parse failure.',
    baseline: { 'src/Progress.js': "export function Progress({ done, total }) {\n  if (!total) return <span>none</span>;\n  return <span>{Math.round((done / total) * 100)}%</span>;\n}\n" },
    change: { 'src/Progress.js': "export function Progress({ done, total }) {\n  return <span>{Math.round((done / total) * 100)}%</span>;\n}\n" },
  },
  decorators: {
    description: 'Decorated TS controller (class, method, and parameter decorators plus a <T>value assertion) gains a catch handler that reports success. Expect one swallowed-failure candidate in create and no parse failure.',
    baseline: { 'src/users.controller.ts': "import { Body, Controller, Inject, Post } from '@nestjs/common';\nimport { UsersService, type CreateUser } from './users.service';\n\n@Controller('users')\nexport class UsersController {\n  constructor(@Inject(UsersService) private readonly users: UsersService) {}\n\n  @Post()\n  async create(@Body() body: unknown) {\n    const input = <CreateUser>body;\n    return await this.users.create(input);\n  }\n}\n" },
    change: { 'src/users.controller.ts': "import { Body, Controller, Inject, Post } from '@nestjs/common';\nimport { UsersService, type CreateUser } from './users.service';\n\n@Controller('users')\nexport class UsersController {\n  constructor(@Inject(UsersService) private readonly users: UsersService) {}\n\n  @Post()\n  async create(@Body() body: unknown) {\n    const input = <CreateUser>body;\n    try {\n      return await this.users.create(input);\n    } catch (error) {\n      return { created: true };\n    }\n  }\n}\n" },
  },
  noise: {
    description: 'summarize() gains literal divisors, a rethrowing handler, JSON.parse inside try blocks, a /= division, and a conditional rethrow; an unchanged module-level division sits above it. Expect only the total /= samples.length and conditional-rethrow candidates.',
    baseline: { 'src/metrics.ts': "import { limits } from './limits.js';\n\nexport const perWorker = limits.total / limits.workers;\n\nexport function summarize(samples: number[], raw: string, retry: boolean) {\n  return { count: samples.length, raw, retry };\n}\n" },
    change: { 'src/metrics.ts': "import { limits } from './limits.js';\n\nexport const perWorker = limits.total / limits.workers;\n\nexport function summarize(samples: number[], raw: string, retry: boolean) {\n  let total = samples.reduce((sum, value) => sum + value, 0);\n  const half = total / 2;\n  const percent = Math.round(half * 100) % 100;\n  total /= samples.length;\n  let config;\n  try {\n    config = JSON.parse(raw);\n  } catch (error) {\n    console.error(error);\n    throw error;\n  }\n  try {\n    config = JSON.parse(config.next);\n  } catch (error) {\n    if (!retry) throw error;\n  }\n  return { total, half, percent, config };\n}\n" },
  },
  'parse-error': {
    description: 'TS file with a duplicate declaration that no parser setting accepts. Expect a limitation naming the file and the VarRedeclaration error code, without the identifier.',
    baseline: { 'src/broken.ts': 'export const ready = true;\n' },
    change: { 'src/broken.ts': 'export const ready = true;\nlet hiddenFixtureName = 1;\nlet hiddenFixtureName = 2;\n' },
  },
  'module-paths': {
    description: 'TSX module changes; it imports .mjs, .cjs, and directory specifiers backed by .mts, .cts, and index.tsx sources, plus a stylesheet (a dependency) and an image (no edge). A caller imports it as ./app.jsx.',
    baseline: {
      'src/lib.mts': 'export const scale = 2;\n',
      'src/legacy.cts': 'export const offset = 1;\n',
      'src/widgets/index.tsx': "export const label = 'size';\n",
      'src/logo.png': '\x89PNG\r\n',
      'src/app.css': 'body { margin: 0; }\n',
      'src/app.tsx': "import { scale } from './lib.mjs';\nimport { offset } from './legacy.cjs';\nimport { label } from './widgets';\nimport logo from './logo.png';\nimport './app.css';\n\nexport function size(value: number) {\n  return `${label}=${value * scale + offset} ${logo}`;\n}\n",
      'src/main.ts': "import { size } from './app.jsx';\n\nexport const width = size(1);\n",
    },
    change: { 'src/app.tsx': "import { scale } from './lib.mjs';\nimport { offset } from './legacy.cjs';\nimport { label } from './widgets';\nimport logo from './logo.png';\nimport './app.css';\n\nexport function size(value: number) {\n  return `${label}=${value / scale + offset} ${logo}`;\n}\n" },
  },
  'symbol-focus': {
    description: 'src/pricing.ts changes an `export const` arrow function (applyDiscount stops clamping the percent) next to `export function $round`. The caller src/checkout.ts is over 12,000 characters, with the applyDiscount call on line 302 and the $round call on line 453.',
    baseline: {
      'src/pricing.ts': 'export const applyDiscount = (price: number, percent: number) => price * (1 - Math.min(Math.max(percent, 0), 100) / 100);\n\nexport function $round(value: number) {\n  return Math.round(value * 100) / 100;\n}\n',
      'src/checkout.ts': [
        "import { applyDiscount, $round } from './pricing.js';",
        ...Array.from({ length: 300 }, (_value, index) => `export const SKU_${index} = { id: 'SKU-${index}', cents: ${1000 + index} };`),
        'export const discounted = (price: number, couponPercent: number) => applyDiscount(price, couponPercent);',
        ...Array.from({ length: 150 }, (_value, index) => `export const SKU_${300 + index} = { id: 'SKU-${300 + index}', cents: ${1300 + index} };`),
        'export const total = (prices: number[]) => $round(prices.reduce((sum, price) => sum + price, 0));',
        ...Array.from({ length: 150 }, (_value, index) => `export const SKU_${450 + index} = { id: 'SKU-${450 + index}', cents: ${1450 + index} };`),
      ].join('\n') + '\n',
    },
    change: { 'src/pricing.ts': 'export const applyDiscount = (price: number, percent: number) => price * (1 - percent / 100);\n\nexport function $round(value: number) {\n  return Math.round(value * 100) / 100;\n}\n' },
  },
  'blank-packet': {
    description: 'A new whitespace-only file is staged. Expect one packet with no source evidence, no provider request, and no quality result.',
    baseline: { 'index.ts': 'export const answer = 42;\n' },
    change: { 'blank.ts': '\n\n' },
    stage: ['blank.ts'],
  },
  hunkless: {
    description: 'mode.ts gains the executable bit with no content change, and opaque.ts (marked -diff in .gitattributes) is edited. Expect a limitation naming each file.',
    baseline: { '.gitattributes': 'opaque.ts -diff\n', 'mode.ts': 'export const mode = 1;\n', 'opaque.ts': 'export const opaque = 1;\n' },
    change: { 'opaque.ts': 'export const opaque = 2;\n' },
    chmod: { 'mode.ts': 0o755 },
  },
  'colon-paths': {
    description: 'Two large files whose paths contain a colon each change one line. Expect one grouped limitation: Focused excerpts only for 2 file(s).',
    baseline: Object.fromEntries(['src/a:one.ts', 'src/b:two.ts'].map(path => [path, Array.from({ length: 800 }, (_value, index) => `export const value${index} = ${index};\n`).join('')])),
    change: Object.fromEntries(['src/a:one.ts', 'src/b:two.ts'].map(path => [path, Array.from({ length: 800 }, (_value, index) => `export const value${index} = ${index === 400 ? 0 : index};\n`).join('')])),
  },
  'large-listing': {
    description: 'The division change plus 42,000 committed index-only paths (skip-worktree, about 8.8 MB of `git ls-files -z` output). Expect the division result.',
    baseline: {
      'src/stats.ts': 'export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n',
    },
    indexOnly: Array.from({ length: 42_000 }, (_value, index) => `${'d'.repeat(200)}/${index}.txt`),
    change: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
  },
  'multi-packet-constants': {
    description: 'Nine small modules change their exported constant. Expect two change packets (eight changed paths, then one) with no candidates, so a review returns packetQualities and no decisions.',
    baseline: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`changes/change-${index}.ts`, `export const value${index} = ${index};\n`])),
    change: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`changes/change-${index}.ts`, `export const value${index} = ${index + 1};\n`])),
  },
  credentials: {
    description: 'A lexer with identifier-shaped token-kind literals and two config files that gain unquoted credentials (.env-style shell exports and YAML). Expect src/lexer.ts collected, and deploy/env.sh and config/app.yml omitted with their paths named.',
    baseline: {
      'src/lexer.ts': lexer(''),
      'deploy/env.sh': 'export APP_ENV=production\n',
      'config/app.yml': 'database:\n  host: db.internal\n',
    },
    change: {
      'src/lexer.ts': lexer("  else if (text.startsWith('`')) token = 'NoSubstitutionTemplateLiteral';\n"),
      'deploy/env.sh': `export APP_ENV=production\nexport API_TOKEN=${fakeCredential}\n`,
      'config/app.yml': `database:\n  host: db.internal\n  password: ${fakeCredential}\n`,
    },
  },
  'baseline-credential': {
    description: 'The committed src/client.ts holds a credential; the change reads it from the environment instead and drops the zero-divisor guard in rate(). Expect src/client.ts as changed without before, one zero-divisor candidate, and a limitation naming it as reviewed without a baseline. The credential value never appears in the output.',
    baseline: { 'src/client.ts': `const apiKey = "${fakeCredential}";\n\nexport function rate(total: number, count: number): number {\n  if (count === 0) return 0;\n  return total / count;\n}\n\nexport const auth = () => apiKey;\n` },
    change: { 'src/client.ts': 'const apiKey = process.env.CLIENT_API_KEY;\n\nexport function rate(total: number, count: number): number {\n  return total / count;\n}\n\nexport const auth = () => apiKey;\n' },
  },
  'multi-packet': {
    description: 'Nine TS modules each lose a zero-divisor guard, and src/app.ts calls all nine. Expect two packets (eight changed files and one), nine zero-divisor candidates, and src/app.ts as caller context in both packets.',
    ...multiPacket(9),
  },
  'multi-packet-large': {
    description: 'Forty TS modules each lose a zero-divisor guard, and src/app.ts calls all forty. Expect five packets of eight changed files and forty zero-divisor candidates. Use it with the stand-in provider to time concurrent requests.',
    ...multiPacket(40),
  },
  clean: {
    description: 'Committed baseline with no working-tree change. Preview should report zero packets.',
    baseline: { 'index.ts': 'export const answer = 42;\n' },
    change: {},
  },
  'path-aliases': {
    description: 'mean() in src/lib/stats.ts loses its empty-input guard. A component and a test import it through the @/ paths alias, and it imports a helper through baseUrl. tsconfig.json extends an in-repository base (which declares both), a package, and a path outside the repository; packages/legacy has a malformed tsconfig.json. Expect the aliased caller, test, and dependency, plus limitations for the external extends and the malformed config.',
    baseline: {
      'config/tsconfig.base.json': '{\n  // Shared resolution settings, relative to this file.\n  "compilerOptions": {\n    "baseUrl": "../src",\n    "paths": { "@/*": ["./*"] },\n  },\n}\n',
      'tsconfig.json': '{\n  "extends": ["@tsconfig/strictest/tsconfig.json", "../tracecheck-shared/tsconfig.json", "./config/tsconfig.base.json"],\n  "compilerOptions": { "strict": true }\n}\n',
      'src/utils/round.ts': 'export function round(value: number): number {\n  return Math.round(value * 100) / 100;\n}\n',
      'src/lib/stats.ts': "import { round } from 'utils/round';\n\nexport function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return round(values.reduce((a, b) => a + b, 0) / values.length);\n}\n",
      'src/components/Report.tsx': "import { mean } from '@/lib/stats';\n\nexport function Report({ values }: { values: number[] }) {\n  return <p>mean={mean(values)}</p>;\n}\n",
      'test/empty-input.test.ts': "import { mean } from '@/lib/stats.js';\n\nif (mean([]) !== 0) throw new Error('empty mean must be 0');\n",
      'packages/legacy/tsconfig.json': '{ "compilerOptions": { "baseUrl": "." \n',
      'packages/legacy/index.ts': "export const legacy = true;\n",
    },
    change: { 'src/lib/stats.ts': "import { round } from 'utils/round';\n\nexport function mean(values: number[]): number {\n  return round(values.reduce((a, b) => a + b, 0) / values.length);\n}\n" },
  },
  'project-config': {
    description: 'A committed change removes the empty-input guard from mean(); the working tree is clean. .tracecheck.json sets a task and maxIndexFiles 1. With --base HEAD~1, preview reports src/stats.ts changed; without it, no change.',
    baseline: {
      '.tracecheck.json': JSON.stringify({ task: 'mean() must return 0 for an empty list; report.ts relies on it.', collection: { maxIndexFiles: 1 } }, null, 2) + '\n',
      'src/stats.ts': 'export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n',
      'src/report.ts': "import { mean } from './stats.js';\n\nexport function summary(values: number[]) {\n  return `mean=${mean(values)}`;\n}\n",
    },
    committed: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
    change: {},
  },
  'moved-on-base': {
    description: 'Branch feature removes the empty-input guard from mean() in a commit; after it branched, main hardened src/report.ts and added src/audit.ts. HEAD is feature with a clean working tree. With --base main, preview should report only src/stats.ts changed, compared at the branch point.',
    baseline: {
      'src/stats.ts': 'export function mean(values: number[]): number {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n',
      'src/report.ts': "import { mean } from './stats.js';\n\nexport function summary(values: number[]) {\n  return `mean=${mean(values)}`;\n}\n",
    },
    branch: {
      feature: { 'src/stats.ts': 'export function mean(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n' },
      main: {
        'src/report.ts': "import { mean } from './stats.js';\n\nexport function summary(values: number[]) {\n  if (!Array.isArray(values)) throw new TypeError('values must be an array');\n  return `mean=${mean(values)}`;\n}\n",
        'src/audit.ts': 'export const audited = true;\n',
      },
    },
    change: {},
  },
};

const [scenarioName] = process.argv.slice(2);
if (!scenarioName || scenarioName === '--list' || !scenarios[scenarioName]) {
  console.log(JSON.stringify(Object.fromEntries(Object.entries(scenarios).map(([name, value]) => [name, value.description])), null, 2));
  process.exit(scenarioName && scenarioName !== '--list' ? 1 : 0);
}

const scenario = scenarios[scenarioName];
const root = mkdtempSync(join(tmpdir(), `tracecheck-verify-${scenarioName}-`));
// Variables that would redirect Git to another repository are removed.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(name)));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: gitEnv });
const write = files => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
try {
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.name', 'Tracecheck fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  write(scenario.baseline);
  git('add', '-A');
  git('commit', '-q', '-m', 'Fixture baseline');
  if (scenario.indexOnly) {
    // Index entries without working files: skip-worktree keeps them out of the diff while ls-files lists them.
    const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf8', env: gitEnv }).trim();
    execFileSync('git', ['-C', root, 'update-index', '-z', '--index-info'], { input: scenario.indexOnly.map(path => `100644 ${blob}\t${path}\0`).join(''), env: gitEnv });
    execFileSync('git', ['-C', root, 'update-index', '-z', '--skip-worktree', '--stdin'], { input: scenario.indexOnly.map(path => `${path}\0`).join(''), env: gitEnv });
    git('commit', '-q', '-m', 'Index-only paths');
  }
  if (scenario.committed) { write(scenario.committed); git('add', '-A'); git('commit', '-q', '-m', 'Fixture follow-up'); }
  if (scenario.branch) {
    git('checkout', '-q', '-b', 'feature');
    write(scenario.branch.feature); git('add', '-A'); git('commit', '-q', '-m', 'Feature change');
    git('checkout', '-q', 'main');
    write(scenario.branch.main); git('add', '-A'); git('commit', '-q', '-m', 'Main moves on');
    git('checkout', '-q', 'feature');
  }
  for (const [from, to] of scenario.moves ?? []) git('mv', from, to);
  write(scenario.change);
  for (const [path, mode] of Object.entries(scenario.chmod ?? {})) chmodSync(join(root, path), mode);
  if (scenario.stage) git('add', '--', ...scenario.stage);
  if (scenario.unstaged) write(scenario.unstaged);
  const changed = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: gitEnv }).trim().split('\n').filter(Boolean);
  console.log(JSON.stringify({ scenario: scenarioName, root, description: scenario.description, changed }, null, 2));
} catch (error) {
  rmSync(root, { recursive: true, force: true });
  throw error;
}
