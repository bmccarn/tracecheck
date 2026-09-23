#!/usr/bin/env node
// Scripted end-user journey: installs the packed Tracecheck package the way a user does, creates a realistic
// project with a working-tree change, and drives every CLI command and MCP tool through it with assertions.
// Usage (from the checkout root, after `npm ci && npm run build`):
//   node .agents/skills/verify-tracecheck/scripts/journey.mjs [--provider stand-in|live] [--no-install | --package SPEC] [--out DIR]
// --provider stand-in (default) answers through the loopback stand-in provider: deterministic, no key, no cost.
// --provider live uses the provider variables already in the environment (see doctor.mjs) and asserts only
//   on structure and exit-code contracts, because model judgments vary.
// --no-install drives dist/plugin.mjs from the checkout instead of an installed tarball.
// --package SPEC installs a published version from the registry instead, for example @bmccarn/tracecheck@0.3.0,
//   to compare a release with the checkout. This install needs network access.
// Evidence goes to .tracecheck/journey/<timestamp>-<provider>/ (JOURNEY.md, summary.json, one record per step)
// and survives cleanup. Exit 0 only when every step passes.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const evidence = resolve(values.out ?? join('.tracecheck', 'journey', `${stamp}-${values.provider}`));
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'tracecheck-journey-'));
const project = join(scratch, 'invoice-service');
const results = [];
const cleanups = [];

class Check extends Error { }
const expect = (condition, message) => { if (!condition) throw new Check(message); };
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - started, detail: detail ?? '' });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    results.push({ step: name, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
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
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const git = (...args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: gitEnv });
const writeFiles = files => { for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), content); } };

// ---- provider -------------------------------------------------------------------------------------------------
async function startStandIn() {
  const child = spawn(process.execPath, [join(checkout, '.agents/skills/verify-tracecheck/scripts/stand-in-provider.mjs'), '--port', '0', '--latency-ms', '50'], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => child.kill('SIGTERM'));
  return new Promise((done, fail) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      appendFileSync(join(evidence, 'stand-in-provider.log'), chunk);
      buffer += chunk;
      const port = buffer.match(/listening (\d+)/)?.[1];
      if (port) done(`http://127.0.0.1:${port}`);
    });
    child.once('exit', code => fail(new Error(`stand-in provider exited with ${code}`)));
  });
}
const providerEnv = {};
const secrets = [];
if (live) {
  for (const name of PROVIDER_ENVIRONMENT) if (process.env[name]) providerEnv[name] = process.env[name];
  for (const name of ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']) if (process.env[name]?.trim()) secrets.push(process.env[name].trim());
  if (!secrets.length) { console.error('--provider live needs JEV_API_KEY, TYPESAFE_API_KEY, or OPENROUTER_API_KEY in the environment.'); process.exit(2); }
}
const userEnv = extra => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...providerEnv, ...extra });

// ---- CLI runner -----------------------------------------------------------------------------------------------
let bundle;
let runs = 0;
function cli(name, args, { env = userEnv(), cwd = project } = {}) {
  const result = spawnSync(process.execPath, [bundle, ...args], { cwd, env, encoding: 'utf8', timeout: 600_000 });
  const file = join(evidence, 'cli', `${String(++runs).padStart(2, '0')}-${name}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.cmd`, `tracecheck ${args.join(' ')}\n`);
  writeFileSync(`${file}.stdout`, result.stdout ?? '');
  writeFileSync(`${file}.stderr`, result.stderr ?? '');
  writeFileSync(`${file}.exit`, `${result.status}\n`);
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
const json = text => { try { return JSON.parse(text); } catch { throw new Check('stdout is not JSON'); } };
const exitsIn = (actual, allowed, what) => expect(allowed.includes(actual), `${what} exited ${actual}, expected ${allowed.join(' or ')}`);

try {
  await step('install the package', async () => {
    if (!values.install) { bundle = join(checkout, 'dist/plugin.mjs'); return 'skipped by --no-install; using dist/plugin.mjs'; }
    const prefix = join(scratch, 'user');
    let source = values.package;
    if (!source) {
      const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: checkout, encoding: 'utf8' });
      expect(pack.status === 0, `npm pack failed: ${pack.stderr.slice(-300)}`);
      source = join(scratch, JSON.parse(pack.stdout)[0].filename);
    }
    const install = spawnSync('npm', ['install', '--prefix', prefix, ...(values.package ? [] : ['--offline']), '--ignore-scripts', '--no-audit', '--no-fund', source], { encoding: 'utf8' });
    expect(install.status === 0, `install failed: ${install.stderr.slice(-300)}`);
    bundle = join(prefix, 'node_modules/@bmccarn/tracecheck/dist/plugin.mjs');
    const help = spawnSync(process.execPath, [bundle, '--help'], { encoding: 'utf8', env: userEnv() });
    expect(help.status === 0 && help.stdout.includes('tracecheck review'), '--help from the installed package failed');
    const version = JSON.parse(readFileSync(join(prefix, 'node_modules/@bmccarn/tracecheck/package.json'), 'utf8')).version;
    return values.package ? `installed ${values.package} (${version}) from the registry` : `installed the packed checkout (${version}) with no network and no dependencies`;
  });

  await step('create the project and the working-tree change', async () => {
    mkdirSync(project, { recursive: true });
    git('-c', 'init.defaultBranch=main', 'init', '-q');
    for (const [key, value] of [['user.name', 'Journey user'], ['user.email', 'journey@example.invalid'], ['core.hooksPath', '/dev/null'], ['commit.gpgsign', 'false']]) git('config', key, value);
    writeFiles(baseline);
    git('add', '-A'); git('commit', '-q', '-m', 'Invoice service baseline');
    expect(git('mv', 'src/lib/format.ts', 'src/lib/currency.ts').status === 0, 'git mv failed');
    writeFiles(change);
    const status = git('status', '--porcelain').stdout.trim().split('\n');
    return status.join('; ');
  });

  if (!live) {
    const url = await startStandIn();
    Object.assign(providerEnv, { TYPESAFE_API_KEY: 'stand-in-placeholder', TYPESAFE_BASE_URL: url });
  }

  let snapshot;
  await step('preview shows the change, its baseline, and related files', async () => {
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

  let firstReport;
  await step('review reports findings, writes SARIF, and shows progress', async () => {
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

  await step('after the user fixes the JSON handling, compare tracks the finding', async () => {
    writeFileSync(join(project, 'src/api/parse.ts'), baseline['src/api/parse.ts']);
    const run = cli('review-after-fix', ['review', '--json', '--quiet', '--out', join(evidence, 'report-2.json')]);
    exitsIn(run.code, live ? [0, 1, 3] : [1], 'review after fix');
    const after = json(run.stdout);
    expect(!after.decisions.some(decision => decision.check === 'unhandled-json'), 'the fixed JSON.parse is still a candidate');
    const compared = cli('compare', ['compare', '--previous', join(evidence, 'report-1.json'), '--current', join(evidence, 'report-2.json')]);
    exitsIn(compared.code, [0], 'compare');
    const history = json(compared.stdout);
    const jsonFinding = history.find(item => item.check === 'unhandled-json');
    const earlierJson = firstReport.decisions.find(decision => decision.check === 'unhandled-json')?.status === 'supported';
    expect(!earlierJson || jsonFinding?.status === 'not_reassessed', `JSON finding state is ${jsonFinding?.status}`);
    expect(!history.some(item => /fixed/.test(item.status)), 'compare claimed a verified fix');
    return history.map(item => `${item.check}: ${item.status}`).join(', ') || 'no earlier supported findings';
  });

  const money = readFileSync(join(project, 'src/lib/money.ts'), 'utf8');
  const evidenceInput = {
    hypothesis: 'splitTotal divides by payers without a guard, so an invoice with zero payers returns Infinity instead of throwing a RangeError.',
    contract: 'An invoice with zero payers must be rejected with a RangeError.',
    evidence: [{ id: 'split', path: 'src/lib/money.ts', startLine: 1, role: 'implementation', content: money }],
    target: { evidenceId: 'split', start: 2, end: 2, quote: money.split('\n')[1] },
  };
  writeFileSync(join(evidence, 'verify-input.json'), JSON.stringify(evidenceInput, null, 2));
  await step('verify checks agent evidence against local files', async () => {
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

  const assessInput = { task: JSON.parse(baseline['.tracecheck.json']).task, files: [{ path: 'src/lib/money.ts', content: money }] };
  writeFileSync(join(evidence, 'assess-input.json'), JSON.stringify(assessInput, null, 2));
  await step('assess evaluates supplied files and gates on priorities', async () => {
    const run = cli('assess', ['assess', '--input', join(evidence, 'assess-input.json'), '--json', '--fail-on-priorities', '--out', join(evidence, 'evaluation.json')]);
    const evaluation = json(run.stdout);
    expect(Object.keys(evaluation.metrics).length === 19, 'expected 19 quality dimensions');
    exitsIn(run.code, [evaluation.priorities.length ? 1 : 0], 'assess --fail-on-priorities');
    return `${evaluation.priorities.length} priorit${evaluation.priorities.length === 1 ? 'y' : 'ies'}, exit ${run.code}`;
  });

  await step('clear errors without a key or with an insecure endpoint', async () => {
    const noKey = cli('no-key', ['assess', '--input', join(evidence, 'assess-input.json')], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    expect(noKey.code === 2 && noKey.stderr.includes('OPENROUTER_API_KEY'), 'missing-key error is unclear');
    const insecure = cli('insecure-endpoint', ['assess', '--input', join(evidence, 'assess-input.json')], { env: userEnv({ TYPESAFE_API_KEY: 'placeholder', TYPESAFE_BASE_URL: 'http://example.com/api' }) });
    expect(insecure.code === 2 && insecure.stderr.includes('HTTPS'), 'plain-HTTP endpoint was not refused');
    return 'exit 2 with actionable messages';
  });

  // ---- MCP, the way an agent client connects to the plugin --------------------------------------------------
  const client = new Client({ name: 'tracecheck-journey', version: '1.0.0' });
  const serverLog = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp', '--repo', project], env: userEnv(), stderr: 'pipe' });
  transport.stderr?.on('data', chunk => serverLog.push(String(chunk)));
  let calls = 0;
  const call = async (tool, args, options = {}) => {
    const result = await client.callTool({ name: tool, arguments: args }, { timeout: 600_000, ...options });
    const record = { tool, arguments: args, isError: Boolean(result.isError), structuredContent: result.structuredContent ?? null, text: result.content?.map(item => item.text) ?? [] };
    mkdirSync(join(evidence, 'mcp'), { recursive: true });
    writeFileSync(join(evidence, 'mcp', `${String(++calls).padStart(2, '0')}-${tool}.json`), JSON.stringify(record, null, 2));
    return record;
  };
  try {
    await step('MCP server starts and lists four tools', async () => {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name).sort();
      expect(names.join(',') === 'tracecheck_assess,tracecheck_preview,tracecheck_review,tracecheck_verify', `tools: ${names}`);
      return names.join(', ');
    });
    let mcpSnapshot;
    await step('MCP preview and review with progress, then a cached repeat', async () => {
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
    await step('MCP verify and assess', async () => {
      const verified = await call('tracecheck_verify', { ...evidenceInput, repo: project });
      expect(!verified.isError && verified.structuredContent.provenance === 'local_files_checked', verified.text.join(' ').slice(0, 300));
      const assessed = await call('tracecheck_assess', assessInput);
      expect(!assessed.isError && Object.keys(assessed.structuredContent.metrics).length === 19, assessed.text.join(' ').slice(0, 300));
      return `verify ${verified.structuredContent.report.status}, assess ${assessed.structuredContent.priorities.length} priorities`;
    });
    await step('MCP review rejects a snapshot after the user edits a file', async () => {
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

  await step('no provider key appears in the evidence', async () => {
    if (!secrets.length) return 'stand-in run; no real key used';
    const files = readdirSync(evidence, { recursive: true }).map(String);
    const leaked = files.filter(file => { try { const text = readFileSync(join(evidence, file), 'utf8'); return secrets.some(secret => text.includes(secret)); } catch { return false; } });
    expect(!leaked.length, `key found in ${leaked.join(', ')}`);
    return `${files.length} evidence files scanned`;
  });
} finally {
  for (const cleanup of cleanups) cleanup();
  rmSync(scratch, { recursive: true, force: true });
  const passed = results.filter(result => result.ok).length;
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ provider: values.provider, package: values.package ?? (values.install ? 'packed checkout' : 'dist/plugin.mjs'), passed, total: results.length, results }, null, 2) + '\n');
  writeFileSync(join(evidence, 'JOURNEY.md'), [`# Tracecheck end-user journey (${values.provider})`, '',
  `${passed}/${results.length} steps passed. Package: ${values.package ?? (values.install ? 'packed checkout, installed offline' : 'checkout dist/plugin.mjs')}.`, '',
    '| Step | Result | Detail |', '| --- | --- | --- |',
  ...results.map(result => `| ${result.step} | ${result.ok ? 'pass' : 'FAIL'} | ${String(result.detail).replaceAll('|', '/').replaceAll('\n', ' ')} |`), ''].join('\n'));
  console.log(`\n${passed}/${results.length} steps passed. Evidence: ${evidence}`);
  process.exitCode = passed === results.length && results.length > 0 ? 0 : 1;
}
