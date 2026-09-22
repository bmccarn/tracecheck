#!/usr/bin/env node
// Read-only readiness check for driving Tracecheck from a checkout.
// Usage: node .agents/skills/verify-tracecheck/scripts/doctor.mjs   (run from the checkout root)
// Prints JSON. Exit 0 when the checkout can be driven; 1 otherwise. Never prints key values.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
add('checkout', pkg.name === '@bmccarn/tracecheck', `cwd ${process.cwd()}; package ${pkg.name ?? 'missing'} ${pkg.version ?? ''}`.trim());

const [major, minor] = process.versions.node.split('.').map(Number);
add('node', major > 22 || (major === 22 && minor >= 18), `node ${process.versions.node}; package requires >=22.18.0`);

add('dependencies', existsSync('node_modules/@modelcontextprotocol/client') && existsSync('node_modules/esbuild'), 'run `npm ci` when false');

let gitVersion = null;
try { gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { }
add('git', gitVersion !== null, gitVersion ?? 'git is not on PATH');

const bundle = 'dist/plugin.mjs';
if (!existsSync(bundle)) {
  add('bundle-fresh', false, `${bundle} is missing; run \`npm run build\``);
} else {
  // Rebuilds into a temporary directory and compares bytes; dist/ is left untouched.
  try {
    execFileSync(process.execPath, ['scripts/build.mjs', '--check'], { stdio: 'pipe', timeout: 60_000 });
    add('bundle-fresh', true, `${bundle} matches a fresh build of src/`);
  } catch {
    add('bundle-fresh', false, `${bundle} differs from a fresh build of src/; run \`npm run build\``);
  }
  try {
    execFileSync(process.execPath, [bundle, '--help'], { stdio: 'pipe', timeout: 20_000 });
    add('bundle-runs', true, `node ${bundle} --help exited 0`);
  } catch {
    add('bundle-runs', false, `node ${bundle} --help failed`);
  }
}

const keys = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'].filter(name => process.env[name]?.trim());
const baseUrl = process.env.TYPESAFE_BASE_URL?.trim() || (keys.length === 1 && keys[0] === 'OPENROUTER_API_KEY' ? 'https://openrouter.ai/api (implied by OPENROUTER_API_KEY)' : 'https://api.typesafe.ai (default)');
const ready = checks.every(check => check.ok);
console.log(JSON.stringify({
  ready,
  live: keys.length > 0,
  providerKeys: keys.length ? `${keys.join(', ')} set (values not shown)` : 'none set; only preview, offline tests, and the demo can run',
  baseUrl,
  model: process.env.JEV_MODEL?.trim() || 'jev-latest (default)',
  checks,
}, null, 2));
process.exitCode = ready ? 0 : 1;
