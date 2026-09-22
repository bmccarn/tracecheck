#!/usr/bin/env node
// Creates a disposable Git repository with a committed baseline and an uncommitted change.
// Usage: node .agents/skills/verify-tracecheck/scripts/fixture-repo.mjs <scenario> [--list]
// Prints JSON: { scenario, root, description, changed }. The caller removes `root` when done.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
    move: ['old.ts', 'new.ts'],
    change: { 'new.ts': 'export function ratio(a: number, b: number) {\n  return a / b;\n}\n' },
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
  clean: {
    description: 'Committed baseline with no working-tree change. Preview should report zero packets.',
    baseline: { 'index.ts': 'export const answer = 42;\n' },
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
  if (scenario.move) git('mv', ...scenario.move);
  write(scenario.change);
  const changed = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: gitEnv }).trim().split('\n').filter(Boolean);
  console.log(JSON.stringify({ scenario: scenarioName, root, description: scenario.description, changed }, null, 2));
} catch (error) {
  rmSync(root, { recursive: true, force: true });
  throw error;
}
