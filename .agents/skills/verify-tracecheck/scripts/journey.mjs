#!/usr/bin/env node
// Scripted end-user journey: installs the packed Tracecheck package the way a user does, creates a realistic
// project with a working-tree change, and drives every CLI command and MCP tool through it with assertions.
// Usage (from the checkout root, after `npm ci && npm run build`):
//   node .agents/skills/verify-tracecheck/scripts/journey.mjs [--provider stand-in|live] [--no-install | --package SPEC] [--out DIR]
// --provider stand-in (default) answers through the loopback stand-in provider: deterministic, no key, no cost.
// --provider live uses the provider variables already in the environment (see doctor.mjs). Most steps accept any
//   judgment there, because model judgments vary; the live outcome steps assert the planted defects and scoring.
// --no-install drives dist/plugin.mjs from the checkout instead of an installed tarball.
// --package SPEC installs a published version from the registry instead, for example @bmccarn/tracecheck@0.3.0,
//   to compare a release with the checkout. This install needs network access.
// Every step is one of three kinds. An outcome check asserts a result the user acts on: an exit code, a refusal, or a
// side effect that must not happen. A plumbing check shows that the parts connect and the output has the expected
// shape; with the stand-in, its judgments are scripted, so it says nothing about review quality. A known-issue check
// asserts the correct outcome for an open issue; its failure is reported and does not fail the journey.
// Evidence goes to .tracecheck/journey/<timestamp>-<provider>/ (JOURNEY.md, summary.json, one record per step)
// and survives cleanup. Exit 0 only when every outcome and plumbing check passes.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const PROVIDER_ENVIRONMENT = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_BASE_URL', 'JEV_MODEL', 'JEV_TIMEOUT_MS', 'JEV_CONCURRENCY'];
const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'stand-in' }, install: { type: 'boolean', default: true }, out: { type: 'string' },
  package: { type: 'string' },
  }, allowNegative: true
});
if (!['stand-in', 'live'].includes(values.provider)) throw new Error('--provider must be stand-in or live.');
const live = values.provider === 'live';
const checkout = process.cwd();
const scripts = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const evidence = resolve(values.out ?? join('.tracecheck', 'journey', `${stamp}-${values.provider}`));
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'tracecheck-journey-'));
const project = join(scratch, 'invoice-service');
const results = [];
const cleanups = [];

// ---- steps ----------------------------------------------------------------------------------------------------
const OUTCOME = 'outcome';
const PLUMBING = 'plumbing';
const KNOWN = 'known issue';
class Check extends Error { }
const expect = (condition, message) => { if (!condition) throw new Check(message); };
const label = (kind, issue) => `[${kind}${issue ? ` #${issue}` : ''}]`;
/** Runs one step of `kind`; `issue` names the issue whose fix the step checks. */
async function step(kind, name, fn, issue) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ kind, step: name, issue, ok: true, ms: Date.now() - started, detail: detail ?? '' });
    console.log(`PASS ${label(kind, issue)} ${name}${detail ? `: ${visible(detail)}` : ''}${kind === KNOWN ? ' (the issue appears fixed; make this an outcome check)' : ''}`);
  } catch (error) {
    results.push({ kind, step: name, issue, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`${kind === KNOWN ? 'KNOWN' : 'FAIL'} ${label(kind, issue)} ${name}: ${visible(error.message)}`);
  }
}
function skip(kind, name, reason, issue) {
  results.push({ kind, step: name, issue, ok: true, skipped: true, ms: 0, detail: reason });
  console.log(`SKIP ${label(kind, issue)} ${name}: ${reason}`);
}

// ---- project -------------------------------------------------------------------------------------------------
const FORMAT = [
  "const SYMBOL = '$';", '',
  '/** Formats integer cents for display, for example 1234 as $12.34. */',
  'export function formatCents(cents: number): string {',
  '  const sign = cents < 0 ? \'-\' : \'\';',
  '  const whole = Math.trunc(Math.abs(cents) / 100);',
  "  const fraction = String(Math.abs(cents) % 100).padStart(2, '0');",
  '  return `${sign}${SYMBOL}${whole}.${fraction}`;',
  '}', '',
  '/** Formats a list of shares, one per line. */',
  'export function formatShares(shares: number[]): string {',
  "  return shares.map(formatCents).join('\\n');",
  '}', '',
].join('\n');
const baseline = {
  'package.json': '{ "name": "invoice-service", "private": true, "type": "module" }\n',
  'tsconfig.json': '{\n  // Path aliases used by every module.\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }\n}\n',
  '.tracecheck.json': JSON.stringify({ task: 'Invoices split a total across payers. An invoice with zero payers must be rejected with a RangeError, and malformed invoice JSON must produce a 400 result, never an exception.' }, null, 2) + '\n',
  'src/lib/money.ts': "export function splitTotal(totalCents: number, payers: number): number {\n  if (payers <= 0) throw new RangeError('An invoice needs at least one payer.');\n  return Math.floor(totalCents / payers);\n}\n",
  'src/lib/format.ts': FORMAT,
  'src/api/parse.ts': 'export type Invoice = { id: string; totalCents: number; payers: number };\n\nexport function parseInvoice(body: string): { ok: true; invoice: Invoice } | { ok: false; status: 400 } {\n  try {\n    return { ok: true, invoice: JSON.parse(body) as Invoice };\n  } catch {\n    return { ok: false, status: 400 };\n  }\n}\n',
  'src/routes/invoice.ts': "import { splitTotal } from '@/lib/money';\nimport { formatCents } from '@/lib/format';\nimport { parseInvoice } from '@/api/parse';\n\nexport function handleInvoice(body: string) {\n  const parsed = parseInvoice(body);\n  if (!parsed.ok) return { status: 400 };\n  const share = splitTotal(parsed.invoice.totalCents, parsed.invoice.payers);\n  return { status: 200, share: formatCents(share) };\n}\n",
  'src/routes/refund.ts': "import { splitTotal } from '@/lib/money';\n\nexport function refundShare(totalCents: number, payers: number) {\n  return splitTotal(totalCents, payers);\n}\n",
  'test/money.test.ts': "import { splitTotal } from '@/lib/money';\n\nif (splitTotal(1000, 4) !== 250) throw new Error('split');\n",
};
// The user's uncommitted change: drops the payer guard, drops the JSON error handling, and renames format.ts.
const change = {
  'src/lib/money.ts': 'export function splitTotal(totalCents: number, payers: number): number {\n  return Math.floor(totalCents / payers);\n}\n',
  'src/api/parse.ts': 'export type Invoice = { id: string; totalCents: number; payers: number };\n\nexport function parseInvoice(body: string): { ok: true; invoice: Invoice } | { ok: false; status: 400 } {\n  return { ok: true, invoice: JSON.parse(body) as Invoice };\n}\n',
  // A one-line edit keeps the rename above Git's 50% similarity threshold, as a typical rename-and-tweak does.
  'src/lib/currency.ts': FORMAT.replace("const SYMBOL = '$';", () => "const SYMBOL = process.env.CURRENCY_SYMBOL ?? '$';"),
  'src/routes/invoice.ts': baseline['src/routes/invoice.ts'].replace("'@/lib/format'", "'@/lib/currency'"),
  'notes/scratch.md': 'Local notes that must not leave this machine.\n',
};
// A change the stand-in judges clean: its only candidate's path gets a not_supported verdict (see startStandIn).
const CLEAN_FILE = 'src/lib/average.ts';
const averageShare = guard => `export function averageShare(totalCents: number, payers: number): number {\n${guard ? "  if (payers <= 0) throw new RangeError('An invoice needs at least one payer.');\n" : ''}  return Math.round(totalCents / ${guard ? 'payers' : 'Math.max(payers, 1)'});\n}\n`;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const gitIn = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv });
const git = (...args) => gitIn(project, ...args);
const writeFilesIn = (dir, files) => { for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); } };
const writeFiles = files => writeFilesIn(project, files);
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  for (const [key, value] of [['user.name', 'Journey user'], ['user.email', 'journey@example.invalid'], ['core.hooksPath', '/dev/null'], ['commit.gpgsign', 'false']]) gitIn(dir, 'config', key, value);
}
function commitAll(dir, message) {
  gitIn(dir, 'add', '-A');
  const commit = gitIn(dir, 'commit', '-q', '-m', message);
  expect(commit.status === 0, `git commit failed in ${relative(scratch, dir)}: ${commit.stderr.trim()}`);
}
/** Creates a repository under the scratch directory with `files` committed on main and `edits` left uncommitted. */
function makeRepo(name, files, edits = {}) {
  const dir = join(scratch, name);
  initRepo(dir);
  writeFilesIn(dir, files);
  commitAll(dir, 'Baseline');
  writeFilesIn(dir, edits);
  return dir;
}

// ---- provider -------------------------------------------------------------------------------------------------
/** Starts a stand-in provider logging to stand-in-<name>.log; `stats()` reads its request count as requests arrive. */
async function startStandIn(name, args) {
  const child = spawn(process.execPath, [join(scripts, 'stand-in-provider.mjs'), '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => child.kill('SIGTERM'));
  const url = await new Promise((done, fail) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      appendFileSync(join(evidence, `stand-in-${name}.log`), chunk);
      buffer += chunk;
      const port = buffer.match(/listening (\d+)/)?.[1];
      if (port) done(`http://127.0.0.1:${port}`);
    });
    child.once('exit', code => fail(new Error(`stand-in provider exited with ${code}`)));
  });
  return { url, stats: async () => (await fetch(`${url}/stats`)).json() };
}
const providerEnv = {};
const secrets = [];
if (live) {
  for (const name of PROVIDER_ENVIRONMENT) if (process.env[name]) providerEnv[name] = process.env[name];
  for (const name of ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']) if (process.env[name]?.trim()) secrets.push(process.env[name].trim());
  if (!secrets.length) { console.error('--provider live needs JEV_API_KEY, TYPESAFE_API_KEY, or OPENROUTER_API_KEY in the environment.'); process.exit(2); }
}
const userEnv = extra => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...providerEnv, ...extra });
// Stand-in providers, set once the project exists: `standIn` answers quickly, `slowStandIn` leaves time to change the
// repository while a review waits on it. In live mode both stay undefined and the live provider answers.
let standIn;
let slowStandIn;
const slowEnv = () => userEnv(slowStandIn ? { TYPESAFE_BASE_URL: slowStandIn.url } : {});
const providerRequests = async () => standIn ? (await standIn.stats()).received : undefined;

// ---- CLI runner -----------------------------------------------------------------------------------------------
let bundle;
let packageRoot;
let tarball;
let binShim;
let runs = 0;
const EXIT_CODES = { no_findings: 0, needs_attention: 1, inconclusive: 3 };
function record(name, shown, { status, stdout, stderr }) {
  const file = join(evidence, 'cli', `${String(++runs).padStart(2, '0')}-${name}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.cmd`, `${shown}\n`);
  writeFileSync(`${file}.stdout`, stdout ?? '');
  writeFileSync(`${file}.stderr`, stderr ?? '');
  writeFileSync(`${file}.exit`, `${status}\n`);
  return { code: status, stdout: stdout ?? '', stderr: stderr ?? '' };
}
function execute(name, command, args, { env = userEnv(), cwd = project, shown = [command, ...args].join(' ') } = {}) {
  return record(name, shown, spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 600_000 }));
}
const cli = (name, args, options = {}) => execute(name, process.execPath, [bundle, ...args], { shown: `tracecheck ${args.join(' ')}`, ...options });
/** Runs a CLI review and calls `during` with the child process once, when its progress says it is sending provider requests. */
async function reviewWhile(name, args, { env = userEnv(), cwd = project, during }) {
  let acted = false;
  let failure;
  const result = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      if (acted || !stderr.includes('Tracecheck progress: Sending')) return;
      acted = true;
      try { during(child); } catch (error) { failure = error; }
    });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', status => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
  if (failure) throw failure;
  const outcome = record(name, `tracecheck ${args.join(' ')}`, result);
  expect(acted, `the review never sent provider requests: ${lastLine(outcome.stderr)}`);
  return outcome;
}
const json = text => { try { return JSON.parse(text); } catch { throw new Check('stdout is not JSON'); } };
const lastLine = text => text.trim().split('\n').pop() ?? '';
const exitsIn = (actual, allowed, what) => expect(allowed.includes(actual), `${what} exited ${actual}, expected ${allowed.join(' or ')}`);
// C0 and C1 control characters other than tab and newline: what a terminal acts on instead of printing.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const visible = text => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);

// ---- MCP ------------------------------------------------------------------------------------------------------
let mcpCalls = 0;
/** Calls `tool` through `client` and saves the call as mcp/NN-<session>-<tool>.json. */
async function callTool(client, session, tool, args, options = {}) {
  const result = await client.callTool({ name: tool, arguments: args }, { timeout: 600_000, ...options });
  const call = { tool, arguments: args, isError: Boolean(result.isError), structuredContent: result.structuredContent ?? null, text: result.content?.map(item => item.text) ?? [] };
  mkdirSync(join(evidence, 'mcp'), { recursive: true });
  writeFileSync(join(evidence, 'mcp', `${String(++mcpCalls).padStart(2, '0')}-${session}-${tool}.json`), JSON.stringify(call, null, 2));
  return call;
}
/** Starts an MCP server over stdio as `launch` describes, passes `use` a call function and the client, then closes it. */
async function mcpSession(session, launch, use) {
  const client = new Client({ name: 'tracecheck-journey', version: '1.0.0' });
  const log = [];
  const transport = new StdioClientTransport({ env: userEnv(), stderr: 'pipe', ...launch });
  transport.stderr?.on('data', chunk => log.push(String(chunk)));
  try {
    await client.connect(transport);
    return await use((tool, args, options) => callTool(client, session, tool, args, options), client);
  } finally {
    await client.close().catch(() => { });
    writeFileSync(join(evidence, `mcp-${session}-stderr.log`), log.join(''));
  }
}
const boundServer = repo => ({ command: process.execPath, args: [bundle, 'mcp', '--repo', repo] });

try {
  await step(PLUMBING, 'install the package', async () => {
    if (!values.install) { bundle = join(checkout, 'dist/plugin.mjs'); packageRoot = checkout; return 'skipped by --no-install; using dist/plugin.mjs'; }
    const prefix = join(scratch, 'user');
    tarball = values.package;
    if (!tarball) {
      const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: checkout, encoding: 'utf8' });
      expect(pack.status === 0, `npm pack failed: ${pack.stderr.slice(-300)}`);
      tarball = join(scratch, JSON.parse(pack.stdout)[0].filename);
    }
    const install = spawnSync('npm', ['install', '--prefix', prefix, ...(values.package ? [] : ['--offline']), '--ignore-scripts', '--no-audit', '--no-fund', tarball], { encoding: 'utf8' });
    expect(install.status === 0, `install failed: ${install.stderr.slice(-300)}`);
    packageRoot = join(prefix, 'node_modules/@bmccarn/tracecheck');
    bundle = join(packageRoot, 'dist/plugin.mjs');
    binShim = join(prefix, 'node_modules/.bin/tracecheck');
    const help = spawnSync(process.execPath, [bundle, '--help'], { encoding: 'utf8', env: userEnv() });
    expect(help.status === 0 && help.stdout.includes('tracecheck review'), '--help from the installed package failed');
    const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    return values.package ? `installed ${values.package} (${version}) from the registry` : `installed the packed checkout (${version}) with no network and no dependencies`;
  });

  await step(PLUMBING, 'create the project and the working-tree change', async () => {
    initRepo(project);
    writeFiles(baseline);
    commitAll(project, 'Invoice service baseline');
    expect(git('mv', 'src/lib/format.ts', 'src/lib/currency.ts').status === 0, 'git mv failed');
    writeFiles(change);
    const status = git('status', '--porcelain').stdout.trim().split('\n');
    return status.join('; ');
  });

  if (!live) {
    standIn = await startStandIn('provider', ['--latency-ms', '50', '--verdict', `^${CLEAN_FILE.replaceAll('.', '\\.')}$=not_supported`]);
    slowStandIn = await startStandIn('slow', ['--latency-ms', '1500']);
    Object.assign(providerEnv, { TYPESAFE_API_KEY: 'stand-in-placeholder', TYPESAFE_BASE_URL: standIn.url });
  }

  let snapshot;
  await step(OUTCOME, 'preview shows the change, its baseline, and related files', async () => {
    const run = cli('preview', ['preview', '--json']);
    exitsIn(run.code, [0], 'preview');
    const plan = json(run.stdout);
    snapshot = plan.snapshot;
    const role = path => plan.sources.find(source => source.path === path)?.role;
    expect(role('src/lib/money.ts') === 'changed' && plan.sources.find(s => s.path === 'src/lib/money.ts').before?.includes('RangeError'), 'money.ts is not collected with its baseline guard');
    const renamed = plan.sources.find(source => source.path === 'src/lib/currency.ts');
    expect(renamed?.previousPath === 'src/lib/format.ts' && renamed.before, 'the renamed file lost its baseline');
    expect(role('src/routes/refund.ts') === 'caller', 'the aliased caller src/routes/refund.ts was not collected');
    expect(role('test/money.test.ts') === 'test', 'the aliased test was not collected');
    expect(!plan.sources.some(source => source.path.startsWith('notes/')), 'an untracked file was collected without --include-untracked');
    expect(plan.task?.includes('zero payers'), 'the .tracecheck.json task was not applied');
    const checks = plan.candidates.map(candidate => `${candidate.check}@${candidate.symbol}`).sort();
    expect(checks.includes('zero-divisor@splitTotal') && checks.includes('unhandled-json@parseInvoice'), `unexpected candidates ${checks}`);
    expect(!checks.some(check => check.includes('formatCents')), 'the literal divisor in formatCents was selected');
    const human = cli('preview-human', ['preview']);
    expect(human.code === 0 && human.stdout.includes('renamed from src/lib/format.ts'), 'human preview does not show the rename');
    return `${plan.packets.length} packet(s), ${plan.sources.length} sources, candidates ${checks.join(', ')}`;
  });

  const INSTALLED_ENTRY_POINTS = 'the installed bin shim and npx run the CLI in the project';
  if (!values.install) skip(OUTCOME, INSTALLED_ENTRY_POINTS, 'needs an installed package; --no-install uses dist/plugin.mjs');
  else await step(OUTCOME, INSTALLED_ENTRY_POINTS, async () => {
    const help = execute('bin-help', binShim, ['--help'], { shown: 'node_modules/.bin/tracecheck --help' });
    expect(help.code === 0 && help.stdout.includes('tracecheck review'), `node_modules/.bin/tracecheck --help exited ${help.code}: ${lastLine(help.stderr)}`);
    // A private npm cache keeps npx from reading or filling the user's cache.
    const npxEnv = userEnv({ npm_config_cache: join(scratch, 'npm-cache'), npm_config_update_notifier: 'false' });
    const args = [...(values.package ? [] : ['--offline']), '--package', tarball, 'tracecheck', 'preview', '--json'];
    const npx = execute('npx-preview', 'npx', args, { env: npxEnv, shown: `npx ${args.join(' ').replace(tarball, values.package ?? '<packed tarball>')}` });
    expect(npx.code === 0, `npx tracecheck preview exited ${npx.code}: ${lastLine(npx.stderr)}`);
    expect(json(npx.stdout).snapshot === snapshot, 'npx preview reported a different snapshot from the installed CLI');
    return `bin shim --help exit 0; npx ${values.package ? '' : '--offline '}preview matches snapshot ${snapshot.slice(0, 12)}`;
  });

  let firstReport;
  await step(PLUMBING, 'review reports findings, writes SARIF, and shows progress', async () => {
    const run = cli('review', ['review', '--json', '--out', join(evidence, 'report-1.json'), '--sarif', join(evidence, 'report-1.sarif')]);
    exitsIn(run.code, live ? [0, 1, 3] : [1], 'review');
    firstReport = json(run.stdout);
    const expected = { 0: 'no_findings', 1: 'needs_attention', 3: 'inconclusive' }[run.code];
    expect(firstReport.status === expected, `exit ${run.code} does not match status ${firstReport.status}`);
    expect(firstReport.snapshot === snapshot, 'the review snapshot differs from the preview snapshot');
    expect(firstReport.decisions.length === 2 && firstReport.models.length > 0 && firstReport.usage.requests > 0, 'report is missing decisions, models, or usage');
    expect(firstReport.quality || firstReport.packetQualities?.length, 'report has no quality evaluation');
    const sarif = JSON.parse(readFileSync(join(evidence, 'report-1.sarif'), 'utf8'));
    const supported = firstReport.decisions.filter(decision => decision.status === 'supported').length;
    expect(sarif.version === '2.1.0' && sarif.runs[0].results.length === supported, 'SARIF results do not match supported findings');
    expect(/Tracecheck progress:/.test(run.stderr), 'no progress on stderr');
    if (!live) expect(firstReport.decisions.every(decision => decision.status === 'supported'), 'stand-in decisions should all be supported');
    const quiet = cli('review-quiet', ['review', '--quiet']);
    expect(quiet.stderr === '', '--quiet still printed to stderr');
    return `status ${firstReport.status}, ${supported}/2 supported, ${firstReport.usage.requests} request(s), models ${firstReport.models.join(', ')}`;
  });

  let fixedReport;
  await step(PLUMBING, 'after the user fixes the JSON handling, compare tracks the finding', async () => {
    writeFileSync(join(project, 'src/api/parse.ts'), baseline['src/api/parse.ts']);
    const run = cli('review-after-fix', ['review', '--json', '--quiet', '--out', join(evidence, 'report-2.json')]);
    exitsIn(run.code, live ? [0, 1, 3] : [1], 'review after fix');
    fixedReport = json(run.stdout);
    expect(!fixedReport.decisions.some(decision => decision.check === 'unhandled-json'), 'the fixed JSON.parse is still a candidate');
    const compared = cli('compare', ['compare', '--previous', join(evidence, 'report-1.json'), '--current', join(evidence, 'report-2.json')]);
    exitsIn(compared.code, [0], 'compare');
    const history = json(compared.stdout);
    const state = check => history.find(item => item.check === check)?.status;
    const earlier = check => firstReport.decisions.find(decision => decision.check === check)?.status;
    expect(earlier('unhandled-json') !== 'supported' || state('unhandled-json') === 'not_reassessed', `JSON finding state is ${state('unhandled-json')}`);
    const divisorNow = fixedReport.decisions.find(decision => decision.check === 'zero-divisor')?.status;
    expect(earlier('zero-divisor') !== 'supported' || divisorNow !== 'supported' || state('zero-divisor') === 'still_present', `the divisor finding supported in both reports is ${state('zero-divisor')}`);
    expect(!history.some(item => /fixed/.test(item.status)), 'compare claimed a verified fix');
    return history.map(item => `${item.check}: ${item.status}`).join(', ') || 'no earlier supported findings';
  });

  if (live) {
    await step(OUTCOME, 'live: the planted defects are supported, and the unfixed one stays supported', async () => {
      const status = (report, check) => report?.decisions.find(decision => decision.check === check)?.status ?? 'missing';
      const observed = `first review: zero-divisor ${status(firstReport, 'zero-divisor')}, unhandled-json ${status(firstReport, 'unhandled-json')}; after the JSON fix: zero-divisor ${status(fixedReport, 'zero-divisor')}`;
      expect(status(firstReport, 'zero-divisor') === 'supported' && status(firstReport, 'unhandled-json') === 'supported'
        && status(fixedReport, 'zero-divisor') === 'supported', observed);
      return observed;
    });
    await step(OUTCOME, 'live: the review scores at least one quality dimension', async () => {
      const metrics = Object.values(firstReport?.quality?.metrics ?? firstReport?.packetQualities?.[0]?.evaluation.metrics ?? {});
      const counts = Object.entries(Object.groupBy(metrics, metric => metric.status)).map(([state, items]) => `${items.length} ${state}`).join(', ');
      const scored = metrics.filter(metric => metric.status === 'assessed').length;
      expect(scored > 0, `${scored}/${metrics.length} dimensions scored (${counts || 'no quality result'})`);
      return `${scored}/${metrics.length} dimensions scored (${counts})`;
    }, 59);
  } else {
    skip(OUTCOME, 'live: the planted defects are supported, and the unfixed one stays supported', 'needs --provider live');
    skip(OUTCOME, 'live: the review scores at least one quality dimension', 'needs --provider live', 59);
  }

  const money = readFileSync(join(project, 'src/lib/money.ts'), 'utf8');
  const evidenceInput = {
    hypothesis: 'splitTotal divides by payers without a guard, so an invoice with zero payers returns Infinity instead of throwing a RangeError.',
    contract: 'An invoice with zero payers must be rejected with a RangeError.',
    evidence: [{ id: 'split', path: 'src/lib/money.ts', startLine: 1, role: 'implementation', content: money }],
    target: { evidenceId: 'split', start: 2, end: 2, quote: money.split('\n')[1] },
  };
  writeFileSync(join(evidence, 'verify-input.json'), JSON.stringify(evidenceInput, null, 2));
  await step(PLUMBING, 'verify checks agent evidence against local files', async () => {
    const run = cli('verify', ['verify', '--input', join(evidence, 'verify-input.json'), '--repo', project]);
    exitsIn(run.code, live ? [0, 1, 3] : [1], 'verify');
    const output = json(run.stdout);
    expect(output.provenance === 'local_files_checked', `provenance ${output.provenance}`);
    const stale = { ...evidenceInput, target: { ...evidenceInput.target, quote: '  return totalCents;' } };
    writeFileSync(join(evidence, 'verify-bad-anchor.json'), JSON.stringify(stale));
    const bad = cli('verify-bad-anchor', ['verify', '--input', join(evidence, 'verify-bad-anchor.json'), '--repo', project]);
    expect(bad.code === 2 && /quote/i.test(bad.stderr), 'a wrong quote was not rejected locally');
    return `status ${output.report.status}, next action ${output.nextAction}`;
  });

  await step(OUTCOME, 'verify names a missing evidence file by ID and repository-relative path, before any provider request', async () => {
    const missingInput = { ...evidenceInput, evidence: [{ ...evidenceInput.evidence[0], path: 'src/lib/missing.ts' }] };
    writeFileSync(join(evidence, 'verify-missing-file.json'), JSON.stringify(missingInput, null, 2));
    const expected = 'Evidence split (src/lib/missing.ts) was not found in the repository.';
    const before = await providerRequests();
    const run = cli('verify-missing-file', ['verify', '--input', join(evidence, 'verify-missing-file.json'), '--repo', project]);
    expect(run.code === 2 && run.stderr.includes(expected), `CLI verify exited ${run.code}: ${lastLine(run.stderr)}`);
    const mcp = await mcpSession('verify-missing-file', boundServer(project), call => call('tracecheck_verify', missingInput));
    const text = mcp.text.join(' ');
    expect(mcp.isError && text.includes(expected), `bound MCP verify returned ${text.slice(0, 200)}`);
    // The scratch directory's own name also catches a resolved (realpath) form of the project path.
    const leaked = [run.stderr, text].find(output => output.includes(relative(tmpdir(), scratch)) || /ENOENT|realpath/.test(output));
    expect(!leaked, `an error quotes an absolute path or system error text: ${leaked}`);
    const after = await providerRequests();
    expect(after === before, `the stand-in received ${after - before} request(s)`);
    return `CLI exit 2 and a bound MCP error, both: ${expected}${standIn ? ' The stand-in received no request.' : ''}`;
  }, 50);

  const assessInput = { task: JSON.parse(baseline['.tracecheck.json']).task, files: [{ path: 'src/lib/money.ts', content: money }] };
  writeFileSync(join(evidence, 'assess-input.json'), JSON.stringify(assessInput, null, 2));
  await step(PLUMBING, 'assess evaluates supplied files and gates on priorities', async () => {
    const run = cli('assess', ['assess', '--input', join(evidence, 'assess-input.json'), '--json', '--fail-on-priorities', '--out', join(evidence, 'evaluation.json')]);
    const evaluation = json(run.stdout);
    expect(Object.keys(evaluation.metrics).length === 19, 'expected 19 quality dimensions');
    exitsIn(run.code, [evaluation.priorities.length ? 1 : 0], 'assess --fail-on-priorities');
    return `${evaluation.priorities.length} priorit${evaluation.priorities.length === 1 ? 'y' : 'ies'}, exit ${run.code}`;
  });

  await step(OUTCOME, 'clear errors without a key or with an insecure endpoint', async () => {
    const noKey = cli('no-key', ['assess', '--input', join(evidence, 'assess-input.json')], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    expect(noKey.code === 2 && noKey.stderr.includes('OPENROUTER_API_KEY'), 'missing-key error is unclear');
    const insecure = cli('insecure-endpoint', ['assess', '--input', join(evidence, 'assess-input.json')], { env: userEnv({ TYPESAFE_API_KEY: 'placeholder', TYPESAFE_BASE_URL: 'http://example.com/api' }) });
    expect(insecure.code === 2 && insecure.stderr.includes('HTTPS'), 'plain-HTTP endpoint was not refused');
    return 'exit 2 with actionable messages';
  });

  await step(OUTCOME, 'argument, input-file, and missing-key errors name the input and stop before collection', async () => {
    const extra = cli('review-extra-argument', ['review', 'src/lib/money.ts', '--quiet']);
    expect(extra.code === 2 && extra.stderr.startsWith('Tracecheck: Unexpected argument: src/lib/money.ts.') && extra.stderr.includes('Usage:\n  tracecheck review'),
      `review with a path exited ${extra.code}: ${lastLine(extra.stderr)}`);
    // Input files are named as the user typed them, relative to where the command runs.
    writeFileSync(join(evidence, 'broken-input.json'), '{"task": ');
    const broken = cli('assess-broken-json', ['assess', '--input', 'broken-input.json'], { cwd: evidence });
    expect(broken.code === 2 && broken.stderr.startsWith('Tracecheck: --input broken-input.json is not valid JSON: '), `broken JSON exited ${broken.code}: ${lastLine(broken.stderr)}`);
    writeFileSync(join(evidence, 'verify-wrong-field.json'), JSON.stringify({ ...evidenceInput, evidence: [{ ...evidenceInput.evidence[0], startLine: 'one' }] }));
    const invalid = cli('verify-invalid-field', ['verify', '--input', 'verify-wrong-field.json'], { cwd: evidence });
    expect(invalid.code === 2 && invalid.stderr === 'Tracecheck: --input verify-wrong-field.json is not valid verify evidence:\n  evidence[0].startLine: Invalid input: expected number, received string\n',
      `invalid verify evidence exited ${invalid.code}: ${invalid.stderr.slice(0, 300)}`);
    const compared = cli('compare-not-a-report', ['compare', '--previous', 'assess-input.json', '--current', 'assess-input.json'], { cwd: evidence });
    expect(compared.code === 2 && compared.stderr.startsWith('Tracecheck: --previous assess-input.json is not a report saved by review --out:\n  ') && !compared.stderr.includes('"code"'),
      `compare of a non-report exited ${compared.code}: ${compared.stderr.slice(0, 300)}`);
    // A bogus base fails in collection, so its absence shows the key was checked first.
    const noKey = cli('review-no-key', ['review', '--base', 'no-such-ref'], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    expect(noKey.code === 2 && noKey.stderr.includes('Preview works without a key') && !/demo|no-such-ref/.test(noKey.stderr),
      `review without a key exited ${noKey.code}: ${lastLine(noKey.stderr)}`);
    return 'exit 2 for an extra argument, broken JSON, an invalid field, a non-report, and a missing key';
  }, 61);

  // ---- outcomes a user relies on beyond the main path --------------------------------------------------------
  const CLEAN_CHANGE = 'a change the provider judges clean exits 0 with no findings through the CLI and MCP';
  if (live) skip(OUTCOME, CLEAN_CHANGE, 'needs the stand-in verdicts; a live model judges the change itself', 52);
  else {
    await step(OUTCOME, CLEAN_CHANGE, async () => {
      const repo = makeRepo('clean-change', { ...baseline, [CLEAN_FILE]: averageShare(false) }, { [CLEAN_FILE]: averageShare(true) });
      const run = cli('review-clean-change', ['review', '--json', '--quiet'], { cwd: repo });
      const report = run.stdout.trim() ? json(run.stdout) : undefined;
      const decisions = report?.decisions.map(decision => `${decision.check} ${decision.status}`).join(', ') || 'none';
      expect(run.code === 0 && report?.status === 'no_findings', `review exited ${run.code} with status ${report?.status ?? 'none'}; decisions ${decisions}; limitations: ${report?.limitations.join(' | ') || 'none'}`);
      expect(report.decisions.length > 0 && report.decisions.every(decision => decision.status === 'not_supported'), `decisions ${decisions}`);
      const mcpStatus = await mcpSession('clean-change', boundServer(repo), async call => {
        const preview = await call('tracecheck_preview', {});
        expect(!preview.isError, `MCP preview failed: ${preview.text.join(' ')}`);
        const review = await call('tracecheck_review', { snapshot: preview.structuredContent.snapshot });
        expect(!review.isError, `MCP review failed: ${review.text.join(' ').slice(0, 300)}`);
        return review.structuredContent.report.status;
      });
      expect(mcpStatus === 'no_findings', `MCP review status ${mcpStatus}`);
      return `CLI exit 0 and MCP status ${mcpStatus}; decisions ${decisions}; ${report.notes?.length ?? 0} note(s), ${report.limitations.length} limitation(s)`;
    }, 52);
  }

  await step(OUTCOME, 'a review with nothing to review exits 0 and says so', async () => {
    const repo = makeRepo('no-changes', baseline);
    const run = cli('review-no-changes', ['review', '--json', '--quiet'], { cwd: repo });
    const report = run.stdout.trim() ? json(run.stdout) : undefined;
    expect(run.code === 0 && report?.status === 'no_findings', `review exited ${run.code} with status ${report?.status ?? 'none'}: ${report?.limitations.join(' | ') || lastLine(run.stderr)}`);
    expect(report.usage.requests === 0, `a review with no changes made ${report.usage.requests} provider request(s)`);
    expect(/nothing to review/i.test(run.stdout), 'the report does not say there is nothing to review');
    return `exit 0, 0 requests: ${[...(report.notes ?? []), ...report.limitations].find(item => /nothing to review/i.test(item))}`;
  }, 52);

  await step(OUTCOME, 'an untracked file created during a CLI review does not discard the report', async () => {
    const swap = join(project, 'src/lib/.money.ts.swp');
    try {
      const run = await reviewWhile('review-untracked-during', ['review', '--json'], { env: slowEnv(), during: () => writeFileSync(swap, 'editor swap file\n') });
      expect(run.code !== 2 && run.stdout.trim(), `review exited ${run.code} and printed no report: ${lastLine(run.stderr)}`);
      const report = json(run.stdout);
      exitsIn(run.code, [EXIT_CODES[report.status]], `review with status ${report.status}`);
      return `exit ${run.code}, status ${report.status}, report printed`;
    } finally {
      rmSync(swap, { force: true });
    }
  }, 53);

  await step(OUTCOME, 'a reviewed file edited during a CLI review yields a report marked stale', async () => {
    const path = join(project, 'src/lib/money.ts');
    const original = readFileSync(path, 'utf8');
    try {
      const run = await reviewWhile('review-edited-during', ['review', '--json'], { env: slowEnv(), during: () => writeFileSync(path, `${original}// edited during the review\n`) });
      expect(run.stdout.trim(), `review exited ${run.code} and printed no report: ${lastLine(run.stderr)}`);
      const report = json(run.stdout);
      const stale = report.limitations.find(item => item.startsWith('Stale report:'));
      expect(run.code === 4 && stale, `review exited ${run.code}${stale ? '' : ' with no "Stale report:" limitation'}`);
      expect(/marked stale/.test(run.stderr), 'stderr does not say the report is marked stale');
      return `exit 4, status ${report.status}: ${stale}`;
    } finally {
      writeFileSync(path, original);
    }
  }, 53);

  await step(OUTCOME, 'review refuses an unwritable --out before collection, and a failed write keeps the printed report', async () => {
    const before = await providerRequests();
    const refused = cli('review-out-directory', ['review', '--quiet', '--out', 'src']);
    expect(refused.code === 2 && refused.stderr === 'Tracecheck: --out src cannot be written: it is a directory.\n' && !refused.stdout,
      `review --out src exited ${refused.code}: ${lastLine(refused.stderr)}`);
    const after = await providerRequests();
    expect(before === after, `the refused review made ${after - before} provider request(s)`);
    // The destination becomes a directory while the review waits on the provider, so only the final write fails.
    const out = join(scratch, 'late-report.json');
    try {
      const run = await reviewWhile('review-out-fails-late', ['review', '--json', '--out', out], { env: slowEnv(), during: () => mkdirSync(out) });
      expect(run.code === 2 && /could not be written: it is a directory\.\nThe result printed above is complete\.\n$/.test(run.stderr),
        `review exited ${run.code}: ${lastLine(run.stderr)}`);
      const report = json(run.stdout);
      return `refused with exit 2 and no provider request; after a failed write, exit 2 with the ${report.status} report printed`;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 61);

  await step(OUTCOME, 'Ctrl-C during a review exits 130 with a short message', async () => {
    const run = await reviewWhile('review-interrupted', ['review', '--json'], { env: slowEnv(), during: child => child.kill('SIGINT') });
    expect(run.code === 130 && run.stderr.endsWith('Tracecheck: interrupted.\n') && !run.stdout.trim(), `review exited ${run.code}: ${lastLine(run.stderr)}`);
    return 'exit 130: Tracecheck: interrupted.';
  }, 61);

  await step(OUTCOME, 'a file name and source with terminal control sequences print no control characters', async () => {
    const hostile = 'src/\u001b]0;owned\u0007\u001b[2Jratio.ts';
    const ratio = guard => `export function ratio(a: number, b: number): number {\n${guard ? '  if (b === 0) return 0;\n' : ''}  return a / b; // \u001b]52;c;b3duZWQ=\u0007\u001b[2J\u009b31m\r\n}\n`;
    const repo = makeRepo('control-characters', { 'package.json': baseline['package.json'], [hostile]: ratio(true) }, { [hostile]: ratio(false) });
    const plan = cli('preview-control-json', ['preview', '--json'], { cwd: repo });
    expect(plan.code === 0 && json(plan.stdout).sources.some(source => source.path === hostile && source.role === 'changed'), 'preview --json does not report the file under its exact name');
    const preview = cli('preview-control', ['preview'], { cwd: repo });
    const review = cli('review-control', ['review'], { cwd: repo });
    const outputs = { 'preview Markdown': preview.stdout, 'review Markdown': review.stdout, 'review stderr': review.stderr };
    const raw = Object.entries(outputs).filter(([, text]) => CONTROL.test(text)).map(([name, text]) => `${name} has ${visible(text.match(CONTROL)[0])}`);
    expect(!raw.length, raw.join('; '));
    if (!live) expect(review.stdout.includes('zero-divisor'), 'the review Markdown has no finding, so the quoted source was not printed');
    return 'no raw control characters in preview or review Markdown; preview --json keeps the exact name';
  }, 54);

  await step(OUTCOME, 'a repository-local core.fsmonitor command never runs', async () => {
    const repo = makeRepo('fsmonitor', baseline, { 'src/lib/money.ts': change['src/lib/money.ts'] });
    const marker = join(scratch, 'fsmonitor-ran');
    const hook = join(scratch, 'fsmonitor-hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    gitIn(repo, 'config', 'core.fsmonitor', hook);
    const ran = [];
    const observe = async (name, action) => {
      rmSync(marker, { force: true });
      await action();
      if (existsSync(marker)) ran.push(name);
    };
    await observe('preview', () => cli('preview-fsmonitor', ['preview', '--json'], { cwd: repo }));
    await observe('review', () => cli('review-fsmonitor', ['review', '--json', '--quiet'], { cwd: repo }));
    await observe('MCP preview', () => mcpSession('fsmonitor', boundServer(repo), call => call('tracecheck_preview', {})));
    expect(!ran.length, `the fsmonitor command ran during ${ran.join(', ')}`);
    return 'no marker after preview, review, or MCP preview';
  }, 55);

  await step(OUTCOME, 'a project settings file cannot widen collection, raise limits, or move the base', async () => {
    const { '.tracecheck.json': _settings, ...files } = baseline;
    const repo = makeRepo('settings-file', files);
    const older = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeFilesIn(repo, { 'src/routes/refund.ts': `${baseline['src/routes/refund.ts']}\nexport const REFUND_WINDOW_DAYS = 30;\n` });
    commitAll(repo, 'Add a refund window');
    writeFilesIn(repo, { 'src/lib/money.ts': change['src/lib/money.ts'], 'src/local-only.ts': 'export const localOnly = true;\n' });
    const raises = {
      includeUntracked: { includeUntracked: true },
      base: { base: older },
      requestConcurrency: { requestConcurrency: 16 },
      reviewTimeoutMs: { reviewTimeoutMs: 3_600_000 },
      'collection.collectionTimeoutMs': { collection: { collectionTimeoutMs: 3_600_000 } },
      maxRequests: { maxRequests: 100 },
    };
    const accepted = [];
    for (const [key, settings] of Object.entries(raises)) {
      writeFileSync(join(repo, '.tracecheck.json'), JSON.stringify(settings));
      const run = cli(`preview-settings-${key}`, ['preview', '--json'], { cwd: repo });
      if (run.code === 2 && run.stderr.includes(`"${key}"`) && /may (?:not exceed|only be) the default/.test(run.stderr)) continue;
      accepted.push(`${key} (exit ${run.code}${run.code === 0 ? ', applied' : `: ${lastLine(run.stderr)}`})`);
    }
    expect(!accepted.length, `not refused: ${accepted.join('; ')}`);
    writeFileSync(join(repo, '.tracecheck.json'), JSON.stringify({ requestConcurrency: 2, maxRequests: 10, task: 'Refunds must never divide by zero payers.' }));
    const tightened = cli('preview-settings-tightened', ['preview'], { cwd: repo });
    expect(tightened.code === 0, `lower limits were refused: ${lastLine(tightened.stderr)}`);
    expect(tightened.stdout.includes('Task from the repository settings file .tracecheck.json:'), 'preview does not show the task that came from the settings file');
    return `refused ${Object.keys(raises).join(', ')}; lower limits accepted and the file's task shown`;
  }, 57);

  await step(OUTCOME, 'a review over the request budget is refused before any provider request', async () => {
    const ratios = guard => Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`src/ratios/ratio${index}.ts`,
    `export function ratio${index}(a: number, b: number): number {\n${guard ? "  if (b === 0) throw new RangeError('b must not be zero');\n" : ''}  return a / b;\n}\n`]));
    const repo = makeRepo('request-budget', { 'package.json': baseline['package.json'], ...ratios(true) }, ratios(false));
    const preview = cli('preview-budget', ['preview', '--json'], { cwd: repo });
    exitsIn(preview.code, [0], 'preview');
    const { estimate, snapshot: budgetSnapshot } = json(preview.stdout);
    expect(Number.isInteger(estimate?.requests) && estimate.requests >= 2 && estimate.inputBytes > 0, `preview estimate is ${JSON.stringify(estimate)}`);
    const refusal = `Review would make ${estimate.requests} provider requests, over the budget of 1`;
    const before = await providerRequests();
    const run = cli('review-over-budget', ['review', '--json', '--quiet', '--max-requests', '1'], { cwd: repo });
    expect(run.code === 2 && run.stderr.includes(refusal), `review --max-requests 1 exited ${run.code}: ${lastLine(run.stderr)}`);
    const mcp = await mcpSession('request-budget', boundServer(repo), async call => {
      const mcpPreview = await call('tracecheck_preview', {});
      expect(!mcpPreview.isError && mcpPreview.structuredContent.snapshot === budgetSnapshot, 'MCP preview failed or differs from the CLI preview');
      return call('tracecheck_review', { snapshot: budgetSnapshot, maxRequests: 1 });
    });
    expect(mcp.isError && mcp.text.join(' ').includes(refusal), `MCP review with maxRequests 1 was not refused: ${mcp.text.join(' ').slice(0, 200)}`);
    const after = await providerRequests();
    expect(after === before, `the stand-in received ${after - before} request(s)`);
    return `estimate ${estimate.requests} requests, ${estimate.inputBytes} bytes; CLI and MCP refused${standIn ? '; the stand-in received no request' : ''}`;
  }, 57);

  // A feature branch whose base branch, main, has moved on: main hardened parse.ts and added audit.ts after the branch.
  let baseBranch;
  const baseBranchRepo = () => baseBranch ??= (() => {
    const repo = makeRepo('base-branch', baseline);
    gitIn(repo, 'checkout', '-q', '-b', 'feature');
    writeFilesIn(repo, { 'src/routes/refund.ts': baseline['src/routes/refund.ts'].replace('return splitTotal(totalCents, payers);', 'return Math.max(0, splitTotal(totalCents, payers));') });
    commitAll(repo, 'Never refund a negative share');
    const branchPoint = gitIn(repo, 'rev-parse', 'main').stdout.trim();
    gitIn(repo, 'checkout', '-q', 'main');
    writeFilesIn(repo, { 'src/lib/audit.ts': 'export const audited = true;\n', 'src/api/parse.ts': baseline['src/api/parse.ts'].replace('  try {', "  if (body.length > 65_536) return { ok: false, status: 400 };\n  try {") });
    commitAll(repo, 'Harden parsing and add auditing on main');
    gitIn(repo, 'checkout', '-q', 'feature');
    return { repo, branchPoint };
  })();

  await step(OUTCOME, 'a --base branch that has moved on compares only the feature branch\'s changes', async () => {
    const { repo, branchPoint } = baseBranchRepo();
    const run = cli('preview-base-branch', ['preview', '--base', 'main', '--json'], { cwd: repo });
    exitsIn(run.code, [0], 'preview --base main');
    const plan = json(run.stdout);
    const changed = [...new Set(plan.packets.flatMap(packet => packet.changedPaths))].sort();
    const mainOnly = plan.limitations.filter(item => item.includes('src/lib/audit.ts'));
    expect(changed.join(', ') === 'src/routes/refund.ts' && !mainOnly.length, `changed ${changed.join(', ')}${mainOnly.length ? `; ${mainOnly.join(' ')}` : ''}`);
    expect(plan.base === branchPoint && plan.baseRef === 'main', `CLI preview compared ${plan.baseRef} at ${plan.base}, expected main at the merge base ${branchPoint}`);
    const human = cli('preview-base-branch-text', ['preview', '--base', 'main'], { cwd: repo });
    exitsIn(human.code, [0], 'preview --base main');
    expect(human.stdout.includes(`Base: ${branchPoint.slice(0, 12)} (from main)`), 'the human preview does not name the compared commit');
    const mcp = await mcpSession('base-branch', boundServer(repo), call => call('tracecheck_preview', { base: 'main' }));
    const mcpChanged = mcp.isError ? [] : [...new Set(mcp.structuredContent.packets.flatMap(packet => packet.changedPaths))].sort();
    expect(!mcp.isError && mcpChanged.join(', ') === 'src/routes/refund.ts' && mcp.structuredContent.base === branchPoint && mcp.structuredContent.snapshot === plan.snapshot,
      `MCP preview with base main: ${mcp.isError ? mcp.text.join(' ').slice(0, 200) : `changed ${mcpChanged.join(', ')} at ${mcp.structuredContent.base}`}`);
    const review = cli('review-base-branch', ['review', '--base', 'main', '--json', '--quiet'], { cwd: repo });
    exitsIn(review.code, [0, 1, 3], 'review --base main');
    const report = json(review.stdout);
    expect(report.base === branchPoint && report.baseRef === 'main' && report.snapshot === plan.snapshot, `the review report compared ${report.baseRef} at ${report.base}`);
    return `CLI preview, MCP preview, and CLI review changed ${changed.join(', ')}, compared at merge base ${branchPoint.slice(0, 12)}`;
  }, 58);

  await step(OUTCOME, 'an unknown or unfetched --base is refused with advice, not a Git command line', async () => {
    const { repo } = baseBranchRepo();
    const rawGit = /Command failed|rev-parse|fatal:/;
    const bogus = cli('preview-bogus-base', ['preview', '--base', 'no-such-branch'], { cwd: repo });
    expect(bogus.code === 2 && bogus.stderr.includes('Base no-such-branch was not found') && bogus.stderr.includes('git fetch') && !rawGit.test(bogus.stderr),
      `preview --base no-such-branch exited ${bogus.code}: ${lastLine(bogus.stderr)}`);
    const mcp = await mcpSession('bogus-base', boundServer(repo), call => call('tracecheck_preview', { base: 'no-such-branch' }));
    const mcpText = mcp.text.join(' ');
    expect(mcp.isError && mcpText.includes('Base no-such-branch was not found') && !rawGit.test(mcpText), `MCP preview with an unknown base: ${mcpText.slice(0, 200)}`);
    // A CI-style checkout: one commit deep and only the feature branch, so origin/main was never fetched.
    const shallow = join(scratch, 'base-branch-shallow');
    const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${repo}`, shallow], { encoding: 'utf8', env: gitEnv });
    expect(cloned.status === 0, `git clone --depth 1 failed: ${cloned.stderr.trim()}`);
    const unfetched = cli('preview-shallow-base', ['preview', '--base', 'origin/main'], { cwd: shallow });
    expect(unfetched.code === 2 && unfetched.stderr.includes('git fetch origin main') && unfetched.stderr.includes('fetch-depth: 0') && !rawGit.test(unfetched.stderr),
      `preview --base origin/main in a shallow clone exited ${unfetched.code}: ${lastLine(unfetched.stderr)}`);
    return 'CLI and MCP name the ref; the shallow clone is told to fetch origin main with fetch-depth: 0';
  }, 58);

  await step(OUTCOME, 'compare follows a finding into a file the user renames', async () => {
    const repo = makeRepo('rename-history', baseline, { 'src/lib/money.ts': change['src/lib/money.ts'] });
    const first = cli('review-before-rename', ['review', '--json', '--quiet', '--out', join(evidence, 'report-before-rename.json')], { cwd: repo });
    exitsIn(first.code, live ? [0, 1, 3] : [1], 'review before the rename');
    expect(gitIn(repo, 'mv', 'src/lib/money.ts', 'src/lib/split.ts').status === 0, 'git mv failed');
    const second = cli('review-after-rename', ['review', '--json', '--quiet', '--out', join(evidence, 'report-after-rename.json')], { cwd: repo });
    exitsIn(second.code, live ? [0, 1, 3] : [1], 'review after the rename');
    const renamed = json(second.stdout).decisions.find(decision => decision.check === 'zero-divisor');
    expect(renamed?.path === 'src/lib/split.ts' && renamed.previousPath === 'src/lib/money.ts', `the divisor decision after the rename is at ${renamed?.path} with previousPath ${renamed?.previousPath}`);
    const compared = cli('compare-rename', ['compare', '--previous', join(evidence, 'report-before-rename.json'), '--current', join(evidence, 'report-after-rename.json')]);
    exitsIn(compared.code, [0], 'compare across the rename');
    const history = json(compared.stdout);
    const states = history.map(item => `${item.path}${item.currentPath ? ` -> ${item.currentPath}` : ''}: ${item.status}`).join(', ') || 'no earlier supported findings';
    const wasSupported = json(first.stdout).decisions.some(decision => decision.check === 'zero-divisor' && decision.status === 'supported');
    expect(!wasSupported || history.some(item => item.path === 'src/lib/money.ts' && item.currentPath === 'src/lib/split.ts' && item.status !== 'not_reassessed'), states);
    expect(!wasSupported || !history.some(item => item.status === 'newly_supported' && item.path === 'src/lib/split.ts'), states);
    return states;
  }, 63);

  await step(OUTCOME, 'preview names a staged change the working tree undoes and a staged rename Git cannot pair, through the CLI and MCP', async () => {
    const repo = makeRepo('staged-only', baseline);
    writeFilesIn(repo, { 'src/lib/money.ts': change['src/lib/money.ts'] });
    expect(gitIn(repo, 'add', 'src/lib/money.ts').status === 0 && gitIn(repo, 'mv', 'src/lib/format.ts', 'src/lib/currency.ts').status === 0, 'staging failed');
    writeFilesIn(repo, { 'src/lib/money.ts': baseline['src/lib/money.ts'], 'src/lib/currency.ts': 'export const currency = (cents: number) => `${cents} cents`;\n' });
    const reverted = note => /^1 staged change\(s\) .*: src\/lib\/money\.ts\./.test(note);
    const unpaired = note => /^1 staged rename\(s\) .*: src\/lib\/format\.ts -> src\/lib\/currency\.ts\.$/.test(note);
    const run = cli('preview-staged-only', ['preview', '--json'], { cwd: repo });
    exitsIn(run.code, [0], 'preview');
    const plan = json(run.stdout);
    expect(plan.notes.some(reverted) && plan.notes.some(unpaired), `CLI preview notes: ${plan.notes.join(' | ')}`);
    expect(!plan.packets.some(packet => packet.changedPaths.includes('src/lib/money.ts')), 'the undone staged change was reviewed');
    const human = cli('preview-staged-only-text', ['preview'], { cwd: repo });
    exitsIn(human.code, [0], 'human preview');
    expect(human.stdout.includes('Note: 1 staged change(s)') && human.stdout.includes('Note: 1 staged rename(s)'), 'the human preview does not show the staged-change notes');
    const mcp = await mcpSession('staged-only', boundServer(repo), call => call('tracecheck_preview', {}));
    const mcpNotes = mcp.isError ? [] : mcp.structuredContent.notes;
    expect(mcpNotes.some(reverted) && mcpNotes.some(unpaired), `MCP preview: ${mcp.isError ? mcp.text.join(' ').slice(0, 200) : mcpNotes.join(' | ')}`);
    return `CLI JSON, human, and MCP preview: ${plan.notes.filter(note => reverted(note) || unpaired(note)).join(' | ')}`;
  }, 63);

  // ---- MCP, the way an agent client connects to the plugin --------------------------------------------------
  const client = new Client({ name: 'tracecheck-journey', version: '1.0.0' });
  const serverLog = [];
  const transport = new StdioClientTransport({ ...boundServer(project), env: userEnv(), stderr: 'pipe' });
  transport.stderr?.on('data', chunk => serverLog.push(String(chunk)));
  const call = (tool, args, options) => callTool(client, 'main', tool, args, options);
  try {
    await step(PLUMBING, 'MCP server starts and lists four tools', async () => {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name).sort();
      expect(names.join(',') === 'tracecheck_assess,tracecheck_preview,tracecheck_review,tracecheck_verify', `tools: ${names}`);
      return names.join(', ');
    });
    let mcpSnapshot;
    await step(PLUMBING, 'MCP preview and review with progress, then a cached repeat', async () => {
      const preview = await call('tracecheck_preview', {});
      expect(!preview.isError, preview.text.join(' '));
      mcpSnapshot = preview.structuredContent.snapshot;
      expect(preview.structuredContent.files.some(file => file.previousPath === 'src/lib/format.ts'), 'MCP preview lost the rename');
      const progress = [];
      const review = await call('tracecheck_review', { snapshot: mcpSnapshot }, { onprogress: update => progress.push(update.progress) });
      expect(!review.isError, review.text.join(' ').slice(0, 300));
      expect(review.structuredContent.cached === false && review.structuredContent.report.decisions.length >= 1, 'first review is cached or empty');
      expect(progress.length > 0 && progress.every((value, index) => index === 0 || value > progress[index - 1]), `progress not increasing: ${progress}`);
      const repeat = await call('tracecheck_review', { snapshot: mcpSnapshot });
      expect(repeat.structuredContent?.cached === true && repeat.structuredContent.report.id === review.structuredContent.report.id, 'repeat review was not served from the cache');
      return `${progress.length} progress notifications, ${review.structuredContent.report.usage.requests} request(s), repeat cached`;
    });
    await step(PLUMBING, 'MCP verify and assess', async () => {
      const verified = await call('tracecheck_verify', { ...evidenceInput, repo: project });
      expect(!verified.isError && verified.structuredContent.provenance === 'local_files_checked', verified.text.join(' ').slice(0, 300));
      const assessed = await call('tracecheck_assess', assessInput);
      expect(!assessed.isError && Object.keys(assessed.structuredContent.metrics).length === 19, assessed.text.join(' ').slice(0, 300));
      return `verify ${verified.structuredContent.report.status}, assess ${assessed.structuredContent.priorities.length} priorities`;
    });
    await step(OUTCOME, 'MCP review accepts its snapshot after an unrelated untracked file appears', async () => {
      const preview = await call('tracecheck_preview', {});
      expect(!preview.isError, preview.text.join(' '));
      const swap = join(project, 'src/lib/.money.ts.swp');
      writeFileSync(swap, 'editor swap file\n');
      try {
        const review = await call('tracecheck_review', { snapshot: preview.structuredContent.snapshot });
        expect(!review.isError, `the snapshot was rejected: ${review.text.join(' ').slice(0, 200)}`);
        return `status ${review.structuredContent.report.status}, cached ${review.structuredContent.cached}`;
      } finally {
        rmSync(swap, { force: true });
      }
    }, 53);
    await step(OUTCOME, 'MCP review rejects a snapshot after the user edits a file', async () => {
      const path = join(project, 'src/lib/money.ts');
      writeFileSync(path, readFileSync(path, 'utf8') + '// edited after preview\n');
      const stale = await call('tracecheck_review', { snapshot: mcpSnapshot });
      expect(stale.isError && /changed/i.test(stale.text.join(' ')), 'a stale snapshot was accepted');
      return 'rejected before inference';
    });
  } finally {
    await client.close().catch(() => { });
    writeFileSync(join(evidence, 'mcp-server-stderr.log'), serverLog.join(''));
  }

  await step(OUTCOME, 'MCP server starts as each plugin manifest launches it and asks for a repository', async () => {
    const launched = [];
    for (const manifest of ['.mcp.json', 'mcp.json']) {
      const server = JSON.parse(readFileSync(join(packageRoot, manifest), 'utf8')).mcpServers.tracecheck;
      const args = server.args.map(arg => arg.replace(/\$\{\w*PLUGIN_ROOT\}/g, packageRoot));
      expect(!args.some(arg => arg.includes('${')), `${manifest} has an unresolved variable: ${args.join(' ')}`);
      // Without a cwd the client starts the server in its own working directory, which for a user is the project.
      const cwd = server.cwd === undefined ? project : resolve(packageRoot, server.cwd);
      await mcpSession(manifest.replace(/^\./, 'dot-'), { command: server.command, args, cwd }, async (call, client) => {
        const tools = (await client.listTools()).tools;
        expect(tools.length === 4, `${manifest}: ${tools.length} tools`);
        const bare = await call('tracecheck_preview', {});
        expect(bare.isError && /Supply repo or launch the server with --repo/.test(bare.text.join(' ')), `${manifest}: preview with no repo returned ${bare.text.join(' ').slice(0, 200)}`);
        const named = await call('tracecheck_preview', { repo: project });
        expect(!named.isError && named.structuredContent.packets.length > 0, `${manifest}: preview with repo failed: ${named.text.join(' ').slice(0, 200)}`);
      });
      launched.push(`${manifest}: ${server.command} ${args.join(' ').replaceAll(packageRoot, '<package root>')} in ${cwd === project ? 'the project' : '<package root>'}`);
    }
    return `${launched.join('; ')}; without repo each asks for one`;
  });

  await step(OUTCOME, 'no provider key appears in the evidence', async () => {
    if (!secrets.length) return 'stand-in run; no real key used';
    const files = readdirSync(evidence, { recursive: true }).map(String);
    const leaked = files.filter(file => { try { const text = readFileSync(join(evidence, file), 'utf8'); return secrets.some(secret => text.includes(secret)); } catch { return false; } });
    expect(!leaked.length, `key found in ${leaked.join(', ')}`);
    return `${files.length} evidence files scanned`;
  });
} finally {
  for (const cleanup of cleanups) cleanup();
  rmSync(scratch, { recursive: true, force: true });
  const tally = kind => {
    const checked = results.filter(result => result.kind === kind && !result.skipped);
    return { passed: checked.filter(result => result.ok).length, total: checked.length };
  };
  const outcome = tally(OUTCOME);
  const plumbing = tally(PLUMBING);
  const known = results.filter(result => result.kind === KNOWN).map(result => ({ issue: result.issue, step: result.step, present: !result.ok }));
  const skipped = results.filter(result => result.skipped).length;
  const gating = results.filter(result => result.kind !== KNOWN && !result.skipped);
  const passed = gating.filter(result => result.ok).length;
  const packageLabel = values.package ?? (values.install ? 'packed checkout, installed offline' : 'checkout dist/plugin.mjs');
  const knownLine = known.map(item => `#${item.issue} ${item.present ? 'still present' : 'appears fixed'}`).join(', ') || 'none';
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({
    provider: values.provider, package: packageLabel, passed, total: gating.length,
    outcome, plumbing, knownIssues: known, skipped, results
  }, null, 2) + '\n');
  const resultText = result => result.skipped ? 'skipped' : result.kind === KNOWN ? (result.ok ? 'passes; make it an outcome check' : 'still present') : result.ok ? 'pass' : 'FAIL';
  writeFileSync(join(evidence, 'JOURNEY.md'), [`# Tracecheck end-user journey (${values.provider})`, '',
  `Package: ${packageLabel}.`, '',
  `- Outcome checks: ${outcome.passed}/${outcome.total} passed. Each asserts a result the user acts on: an exit code, a refusal, or a side effect that must not happen.`,
  `- Plumbing checks: ${plumbing.passed}/${plumbing.total} passed. Each shows that the parts connect and the output has the expected shape.${live ? '' : ' The stand-in provider scripts every judgment, so these say nothing about review quality.'}`,
  `- Known issues: ${knownLine}. A known-issue check asserts the correct outcome for an open issue; it does not fail the journey.`,
  ...(skipped ? [`- Skipped: ${skipped}.`] : []), '',
    '| Kind | Step | Result | Detail |', '| --- | --- | --- | --- |',
  ...results.map(result => `| ${result.kind}${result.issue ? ` (#${result.issue})` : ''} | ${result.step} | ${resultText(result)} | ${visible(String(result.detail)).replaceAll('|', '/').replaceAll('\\x0a', ' ')} |`), ''].join('\n'));
  console.log(`\nOutcome checks: ${outcome.passed}/${outcome.total} passed. Plumbing checks: ${plumbing.passed}/${plumbing.total} passed. Known issues: ${knownLine}.${skipped ? ` Skipped: ${skipped}.` : ''}\nEvidence: ${evidence}`);
  process.exitCode = passed === gating.length && gating.length > 0 ? 0 : 1;
}
