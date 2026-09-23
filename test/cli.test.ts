import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Question, TypedResponse } from '../src/domain.js';
import { reportSchema } from '../src/schema.js';
import { qualityEvaluationSchema } from '../src/quality.js';
import { judgeNotSupported, repository, typedFixture } from './helpers.js';

const checkout = fileURLToPath(new URL('..', import.meta.url));
// Resolved here so the CLI can run from any working directory.
const tsx = import.meta.resolve('tsx');

/** Runs the CLI from source in a child process in `cwd` with only the given provider environment. */
async function cli(args: string[], env: Record<string, string> = {}, cwd = checkout) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', tsx, join(checkout, 'src/cli.ts'), ...args],
      { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: unknown; stdout: string; stderr: string };
    if (typeof code !== 'number') throw error;
    return { code, stdout, stderr };
  }
}

/** A loopback Jev endpoint that answers every question with the typed fixture, after an optional adjustment. */
async function jevServer(t: TestContext, adjust: (response: TypedResponse, questions: Record<string, Question>) => void = () => { }) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { questions } = JSON.parse(body) as { questions: Record<string, Question> };
    const answer = await typedFixture(questions);
    adjust(answer, questions);
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(answer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const { port } = server.address() as AddressInfo;
  return { env: { JEV_API_KEY: 'fixture-key', TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` }, requests: () => requests };
}

test('an unknown command exits 2 with its name', async () => {
  const result = await cli(['frobnicate']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command: frobnicate/);
});

test('invalid integer flags exit 2 before collection', async () => {
  for (const [flag, value] of [['--index-max-files', '0'], ['--review-timeout-ms', '1.5'], ['--collection-timeout-ms', '-3'], ['--max-requests', '0']]) {
    const result = await cli(['review', '--repo', '/nonexistent-tracecheck-repo', `${flag}=${value}`]);
    assert.equal(result.code, 2, `${flag}=${value}`);
    assert.match(result.stderr, new RegExp(`${flag} must be a positive safe integer`));
  }
});

test('review writes one SARIF result per supported finding', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), [
    'export function average(xs: number[]) {',
    '  return xs.reduce((a, b) => a + b, 0) / xs.length;',
    '}',
    'export function ratio(a: number, b: number) {',
    '  return a / b;',
    '}',
    '',
  ].join('\n'));
  // The ratio candidate is judged with low confidence, so it is uncertain rather than supported.
  const jev = await jevServer(t, (response, questions) => {
    for (const [id, question] of Object.entries(questions)) {
      const answer = response.answers[id];
      if (id.endsWith('_assessment') && question.instructions.includes('average.ts:5-5') && answer?.type === 'choice') answer.confidence = 0.3;
    }
  });
  const sarifPath = join(repo.root, '.out', 'findings.sarif');
  const result = await cli(['review', '--repo', repo.root, '--json', '--sarif', sarifPath], jev.env);
  assert.equal(result.code, 1, result.stderr);
  const report = reportSchema.parse(JSON.parse(result.stdout));
  assert.deepEqual(report.decisions.map(decision => [decision.range.start, decision.status]).sort(), [[2, 'supported'], [5, 'uncertain']]);

  const sarif = JSON.parse(await readFile(sarifPath, 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  const [run] = sarif.runs;
  assert.deepEqual(run.tool.driver.rules.map((rule: { id: string }) => rule.id), ['zero-divisor']);
  assert.equal(run.results.length, 1);
  const [finding] = run.results;
  const supported = report.decisions.find(decision => decision.status === 'supported')!;
  assert.equal(finding.ruleId, 'zero-divisor');
  assert.equal(finding.ruleIndex, 0);
  assert.equal(finding.level, 'warning');
  assert.equal(finding.message.text, supported.hypothesis);
  assert.deepEqual(finding.locations[0].physicalLocation.artifactLocation, { uri: 'average.ts', uriBaseId: 'SRCROOT' });
  assert.deepEqual(finding.locations[0].physicalLocation.region, { startLine: 2, endLine: 2, snippet: { text: supported.quote } });
  assert.equal(finding.properties.impact, 'medium');
  assert.equal(finding.properties.confidence, supported.confidence);
  assert.deepEqual(run.properties.omittedDecisions, { uncertain: 1, needsContext: 0, notSupported: 0 });
});

test('review prints progress to stderr, leaves stdout unchanged, and --quiet silences it', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await mkdir(join(repo.root, 'changes'));
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index + 1};\n`);
  repo.git('add', '.');
  const jev = await jevServer(t);
  const loud = await cli(['review', '--repo', repo.root], jev.env);
  assert.notEqual(loud.code, 2, loud.stderr);
  const requests = jev.requests();
  assert.equal(requests, 2);
  assert.deepEqual(loud.stderr.trimEnd().split('\n'), ['Listing changed files', 'Reading changed files', 'Indexing imports',
    'Assembling change packets', 'Sending 2 provider requests', 'Completed provider request 1 of 2', 'Completed provider request 2 of 2',
    'Checking that the repository did not change', 'Review complete'].map(message => `Tracecheck progress: ${message}`));

  const quiet = await cli(['review', '--repo', repo.root, '--quiet'], jev.env);
  assert.equal(quiet.code, loud.code, quiet.stderr);
  assert.equal(jev.requests(), 2 * requests);
  assert.equal(quiet.stderr, '');
  assert.equal(loud.stdout, quiet.stdout);
  const json = await cli(['review', '--repo', repo.root, '--json'], jev.env);
  assert.equal(reportSchema.parse(JSON.parse(json.stdout)).usage.requests, requests);
  assert.match(json.stderr, /^Tracecheck progress: Review complete$/m);
});

test('preview estimates the review requests, and review refuses a larger plan than its budget before any request', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await mkdir(join(repo.root, 'changes'));
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index + 1};\n`);
  repo.git('add', '.');
  const jev = await jevServer(t);
  const preview = await cli(['preview', '--repo', repo.root, '--json']);
  assert.equal(preview.code, 0, preview.stderr);
  const { estimate } = JSON.parse(preview.stdout) as { estimate: { requests: number; inputBytes: number } };
  assert.equal(estimate.requests, 2);
  assert.ok(estimate.inputBytes > 0);

  const refused = await cli(['review', '--repo', repo.root, '--max-requests', '1'], jev.env);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Review would make 2 provider requests, over the budget of 1/);
  await writeFile(join(repo.root, '.tracecheck.json'), JSON.stringify({ maxRequests: 1 }));
  const lowered = await cli(['review', '--repo', repo.root, '--quiet'], jev.env);
  assert.equal(lowered.code, 2);
  assert.match(lowered.stderr, /over the budget of 1/);
  assert.equal(jev.requests(), 0);

  const flagged = await cli(['review', '--repo', repo.root, '--json', '--quiet', '--max-requests', '2'], jev.env);
  assert.notEqual(flagged.code, 2, flagged.stderr);
  assert.equal(reportSchema.parse(JSON.parse(flagged.stdout)).usage.requests, estimate.requests);
  assert.equal(jev.requests(), estimate.requests);
});

test('preview and review show a task and context from the settings file, labeled as repository-supplied', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }\n');
  await writeFile(join(repo.root, '.tracecheck.json'), JSON.stringify({ task: 'Repository task text', repositoryContext: 'Repository context text' }));
  const labeled = (notes: string[]) => notes.filter(note => note.includes('repository settings file'));
  const labels = ['Task from the repository settings file .tracecheck.json: Repository task text',
    'Repository context from the repository settings file .tracecheck.json: Repository context text'];
  const jev = await jevServer(t);
  const human = await cli(['preview', '--repo', repo.root]);
  for (const label of labels) assert.ok(human.stdout.includes(`Note: ${label}`), human.stdout);
  assert.deepEqual(labeled(JSON.parse((await cli(['preview', '--repo', repo.root, '--json'])).stdout).notes), labels);
  const markdown = await cli(['review', '--repo', repo.root, '--quiet'], jev.env);
  assert.notEqual(markdown.code, 2, markdown.stderr);
  assert.match(markdown.stdout, /## Notes\n\n(- .*\n)*- Task from the repository settings file \.tracecheck\.json: Repository task text\n/);
  const json = await cli(['review', '--repo', repo.root, '--quiet', '--json'], jev.env);
  assert.deepEqual(labeled(reportSchema.parse(JSON.parse(json.stdout)).notes), labels);
  // A flag replaces the file's task, which is then no longer labeled.
  const flagged = await cli(['preview', '--repo', repo.root, '--json', '--task', 'Flag task']);
  assert.deepEqual(labeled(JSON.parse(flagged.stdout).notes), labels.slice(1));
});

test('a settings file that goes beyond a default is rejected before collection, naming each key', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'extra.ts'), 'export const extra = 1;\n');
  await writeFile(join(repo.root, '.tracecheck.json'), JSON.stringify({ includeUntracked: true, base: 'HEAD~1', requestConcurrency: 16, maxRequests: 51 }));
  const jev = await jevServer(t);
  for (const command of ['preview', 'review']) {
    const result = await cli([command, '--repo', repo.root], jev.env);
    assert.equal(result.code, 2, command);
    for (const key of ['includeUntracked', 'base', 'requestConcurrency', 'maxRequests']) assert.match(result.stderr, new RegExp(`"${key}" may`), `${command} ${key}`);
  }
  assert.equal(jev.requests(), 0);
});

test('--previous accepts a review report or an assess evaluation, even for a multi-packet review', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  const jev = await jevServer(t);
  const files = join(repo.root, '.out');
  await mkdir(files);
  const context = join(files, 'context.json');
  await writeFile(context, JSON.stringify({ task: 'Return the mean.', files: [{ path: 'mean.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }] }));
  const evaluationPath = join(files, 'evaluation.json');
  assert.equal((await cli(['assess', '--input', context, '--out', evaluationPath], jev.env)).code, 0);

  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }\n');
  const reportPath = join(files, 'report.json');
  const first = await cli(['review', '--repo', repo.root, '--out', reportPath], jev.env);
  assert.equal(first.code, 1, first.stderr);

  const reviewWithReport = reportSchema.parse(JSON.parse((await cli(['review', '--repo', repo.root, '--json', '--previous', reportPath], jev.env)).stdout));
  assert.equal(reviewWithReport.quality?.comparison.length, 19);
  const reviewWithEvaluation = reportSchema.parse(JSON.parse((await cli(['review', '--repo', repo.root, '--json', '--previous', evaluationPath], jev.env)).stdout));
  assert.match(reviewWithEvaluation.notes.join('\n'), /Previous evaluation was not compared because its scope/);
  const assessWithReport = await cli(['assess', '--input', context, '--json', '--previous', reportPath], jev.env);
  assert.equal(assessWithReport.code, 0, assessWithReport.stderr);
  assert.match(qualityEvaluationSchema.parse(JSON.parse(assessWithReport.stdout)).warnings.join('\n'), /Comparison skipped/);

  const invalid = join(files, 'invalid.json');
  await writeFile(invalid, JSON.stringify({ hello: 'world' }));
  const rejected = await cli(['assess', '--input', context, '--previous', invalid], jev.env);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /neither a report saved by review --out nor an evaluation saved by assess --out/);

  await mkdir(join(repo.root, 'changes'));
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index + 1};\n`);
  repo.git('add', '.');
  const before = jev.requests();
  const multi = await cli(['review', '--repo', repo.root, '--json', '--previous', reportPath], jev.env);
  assert.notEqual(multi.code, 2, multi.stderr);
  const multiReport = reportSchema.parse(JSON.parse(multi.stdout));
  assert.equal(multiReport.packetQualities?.length, 2);
  assert.ok(jev.requests() > before);
  assert.match(multiReport.notes.join('\n'), /Previous evaluation was not compared because this review has multiple packet scopes/);

  const multiReportPath = join(files, 'multi.json');
  await writeFile(multiReportPath, multi.stdout);
  const fromMulti = await cli(['assess', '--input', context, '--previous', multiReportPath], jev.env);
  assert.equal(fromMulti.code, 2);
  assert.match(fromMulti.stderr, /multi-packet review report/);
});

test('assess --fail-on-priorities exits 1 only when actionable priorities exist', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  const context = join(repo.root, 'context.json');
  await writeFile(context, JSON.stringify({ task: 'Return the mean.', files: [{ path: 'mean.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }] }));
  const clean = await jevServer(t);
  assert.equal((await cli(['assess', '--input', context, '--fail-on-priorities'], clean.env)).code, 0);

  const concerned = await jevServer(t, (response, questions) => {
    const question = questions.quality_correctness_weakness;
    const answer = response.answers.quality_correctness_weakness;
    assert.ok(question?.type === 'choice' && answer?.type === 'choice');
    const concern = Object.keys(question.criteria).find(key => key !== 'none')!;
    answer.choice = concern;
    answer.probabilities = Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === concern ? 1 : 0]));
  });
  const gated = await cli(['assess', '--input', context, '--json', '--fail-on-priorities'], concerned.env);
  assert.equal(gated.code, 1, gated.stderr);
  assert.deepEqual(qualityEvaluationSchema.parse(JSON.parse(gated.stdout)).priorities.map(priority => priority.metric), ['correctness']);
  assert.equal((await cli(['assess', '--input', context], concerned.env)).code, 0);
});

test('human-readable preview and review print control characters from paths and source as visible escapes', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  const path = 'src/\x1b]0;owned\x07\x1b[2Jevil.ts';
  await mkdir(join(repo.root, 'src'));
  await writeFile(join(repo.root, path), 'export function ratio(a: number, b: number) {\n  return a / (b /* \x1b]52;c;b3duZWQ=\x07 */);\n}\n');
  repo.git('add', '.');
  // The settings file is repository-controlled, and its task is printed as a note.
  await writeFile(join(repo.root, '.tracecheck.json'), JSON.stringify({ task: 'Keep \x1b]0;title\x07 intact\nCoverage gap: none' }));
  const jev = await jevServer(t);
  const preview = await cli(['preview', '--repo', repo.root]);
  const review = await cli(['review', '--repo', repo.root], jev.env);
  assert.equal(review.code, 1, review.stderr);
  // Newline and tab are the only control characters human-readable output keeps.
  for (const output of [preview.stdout, review.stdout, review.stderr]) assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.match(preview.stdout, /^changed: src\/\\x1b\]0;owned\\x07\\x1b\[2Jevil\.ts$/m);
  assert.ok(review.stdout.includes('**src/\\x1b\\]0;owned\\x07\\x1b\\[2Jevil.ts:2-2**'), review.stdout);
  assert.ok(review.stdout.includes('    a / (b /* \\x1b]52;c;b3duZWQ=\\x07 */)'), review.stdout);
  assert.match(preview.stdout, /^Note: Task from the repository settings file \.tracecheck\.json: Keep \\x1b\]0;title\\x07 intact\\x0aCoverage gap: none$/m);
  assert.ok(review.stdout.includes('- Task from the repository settings file .tracecheck.json: Keep \\x1b\\]0;title\\x07 intact\\x0aCoverage gap: none'), review.stdout);
  // JSON output keeps the raw path.
  const plan = JSON.parse((await cli(['preview', '--repo', repo.root, '--json'])).stdout);
  assert.deepEqual(plan.sources.map((source: { path: string }) => source.path), [path]);
});

const RATIO = 'export function ratio(a: number, b: number) {\n  return a / b;\n}\n';

test('a clean change and an unchanged working tree both exit 0', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), RATIO);
  await writeFile(join(repo.root, 'scratch.txt'), 'untracked and not reviewed\n');
  const jev = await jevServer(t, judgeNotSupported);
  const clean = await cli(['review', '--repo', repo.root, '--json', '--quiet'], jev.env);
  assert.equal(clean.code, 0, clean.stdout);
  const report = reportSchema.parse(JSON.parse(clean.stdout));
  assert.equal(report.status, 'no_findings');
  assert.deepEqual(report.decisions.map(decision => decision.status), ['not_supported']);
  assert.deepEqual(report.limitations, []);
  assert.match(report.notes.join('\n'), /Import\/caller discovery is heuristic/);
  assert.match(report.notes.join('\n'), /1 untracked file\(s\) excluded/);

  repo.git('checkout', '--', 'average.ts');
  const requests = jev.requests();
  const reportPath = join(repo.root, '.out', 'unchanged.json');
  const unchanged = await cli(['review', '--repo', repo.root, '--quiet', '--out', reportPath], jev.env);
  assert.equal(unchanged.code, 0, unchanged.stdout);
  assert.match(unchanged.stdout, /No changes against HEAD; nothing to review\./);
  const empty = reportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
  assert.equal(empty.status, 'no_findings');
  assert.deepEqual(empty.limitations, []);
  assert.equal(empty.usage.requests, 0); assert.equal(jev.requests(), requests);
});

test('an untracked file created during review keeps the report; a reviewed edit marks it stale', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), RATIO);
  // Runs inside the provider request, after collection and before the CLI checks the repository again.
  let duringReview = () => {};
  const jev = await jevServer(t, response => { judgeNotSupported(response); duringReview(); });

  duringReview = () => writeFileSync(join(repo.root, '.average.ts.swp'), 'editor swap file');
  const untracked = await cli(['review', '--repo', repo.root, '--json', '--quiet'], jev.env);
  assert.equal(untracked.code, 0, untracked.stderr);
  assert.equal(reportSchema.parse(JSON.parse(untracked.stdout)).status, 'no_findings');

  duringReview = () => writeFileSync(join(repo.root, 'average.ts'), RATIO.replace('a / b', 'b ? a / b : 0'));
  const reportPath = join(repo.root, '.out', 'stale.json');
  const edited = await cli(['review', '--repo', repo.root, '--json', '--quiet', '--out', reportPath], jev.env);
  assert.equal(edited.code, 4, edited.stderr);
  assert.match(edited.stderr, /report is marked stale/);
  const stale = reportSchema.parse(JSON.parse(edited.stdout));
  assert.equal(stale.status, 'inconclusive');
  assert.ok(stale.limitations.some(value => value.startsWith('Stale report:')), stale.limitations.join('\n'));
  assert.deepEqual(reportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8'))), stale);
});

test('review checks --out and --sarif before collection, and prints the report before writing them', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), RATIO);
  const blocked = join(repo.root, 'blocked');
  await mkdir(blocked);
  const jev = await jevServer(t);
  for (const flags of [['--out', blocked], ['--sarif', join(repo.root, 'average.ts', 'findings.sarif')]]) {
    const refused = await cli(['review', '--repo', repo.root, '--json', ...flags], jev.env);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, new RegExp(`^Tracecheck: ${flags[0]} \\S+ cannot be written: (it is a directory|a parent path is not a directory)\\.\\n$`));
    assert.equal(refused.stdout, '');
  }
  assert.equal(jev.requests(), 0);

  // The destination becomes a directory while the provider answers, so the checked path fails only at the write.
  const out = join(repo.root, 'reports', 'report.json');
  const late = await jevServer(t, () => { mkdirSync(out, { recursive: true }); });
  const result = await cli(['review', '--repo', repo.root, '--json', '--quiet', '--out', out], late.env);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(reportSchema.parse(JSON.parse(result.stdout)).status, 'needs_attention');
  assert.match(result.stderr, /--out \S+report\.json could not be written: it is a directory\.\nThe result printed above is complete\./);
});

test('extra positional arguments are rejected with the command usage', async () => {
  const result = await cli(['review', 'src/foo.ts', '--repo', '/nonexistent-tracecheck-repo']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unexpected argument: src\/foo\.ts\. tracecheck review takes no positional arguments\. It has no path filter/);
  assert.match(result.stderr, /Usage:\n {2}tracecheck review {2}\[--repo PATH\]/);
});

test('input file errors name the file and list validation issues by field', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tracecheck-inputs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'broken.json'), '{"task": ');
  await writeFile(join(dir, 'context.json'), JSON.stringify({ task: 7, extra: true }));
  await writeFile(join(dir, 'evidence.json'), JSON.stringify({ hypothesis: 'h', contract: 'c', target: { evidenceId: 'e', start: 1, end: 1, quote: 'q' },
    evidence: [{ id: 'e', path: 'a.ts', startLine: 'one', content: 'q', role: 'implementation' }] }));
  await writeFile(join(dir, 'report.json'), JSON.stringify({ schemaVersion: 1 }));
  const cases: Array<[string[], RegExp]> = [
    [['assess', '--input', 'broken.json'], /^Tracecheck: --input broken\.json is not valid JSON: /],
    [['verify', '--input', 'missing.json'], /^Tracecheck: --input missing\.json cannot be read: no such file or directory\.\n$/],
    [['assess', '--input', 'context.json'], /^Tracecheck: --input context\.json is not valid assess context:\n {2}task: Invalid input: expected string, received number\n {2}Unrecognized key: "extra"\n/],
    [['verify', '--input', 'evidence.json'], /^Tracecheck: --input evidence\.json is not valid verify evidence:\n {2}evidence\[0\]\.startLine: Invalid input: expected number, received string\n$/],
    [['compare', '--previous', 'report.json', '--current', 'report.json'], /^Tracecheck: --previous report\.json is not a report saved by review --out:\n {2}id: /],
    [['review', '--review-timeout-ms', '3600001'], /^Tracecheck: --review-timeout-ms is out of range:\n {2}Too big/],
  ];
  for (const [args, expected] of cases) {
    const result = await cli(args, {}, dir);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, expected, args.join(' '));
    assert.doesNotMatch(result.stderr, /"code"|\[\s*\{|tracecheck-inputs-/, args.join(' '));
  }
});

test('review checks for a provider key before collection, with a message that names only real commands', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), RATIO);
  // Collection resolves --base, so a bogus base shows whether collection ran before the key check.
  const result = await cli(['review', '--repo', repo.root, '--base', 'no-such-ref']);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'Tracecheck: Set JEV_API_KEY, TYPESAFE_API_KEY, or OPENROUTER_API_KEY to run review, verify, or assess. Preview works without a key.\n');
});

test('SIGINT stops a review with exit code 130', async t => {
  const repo = await repository();
  t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), RATIO);
  // A provider that never answers keeps the review waiting until the interrupt.
  const server = createServer(() => { });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const { port } = server.address() as AddressInfo;
  const child = spawn(process.execPath, ['--import', tsx, join(checkout, 'src/cli.ts'), 'review', '--repo', repo.root], { cwd: checkout,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JEV_API_KEY: 'fixture-key', TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` } });
  let stderr = '';
  let interrupted = false;
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
    if (interrupted || !stderr.includes('Tracecheck progress: Sending')) return;
    interrupted = true;
    child.kill('SIGINT');
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 130, stderr);
  assert.match(stderr, /Tracecheck: interrupted\.\n$/);
});
