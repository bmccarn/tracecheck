#!/usr/bin/env node
import { verify } from './verify.js';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collect } from './collector.js';
import { Jev, jevFromEnv, jevSettings } from './jev.js';
import { deadline } from './deadline.js';
import { reviewAll, render } from './review.js';
import { ASSESS_TIMEOUT_MS, assess, previousEvaluationSchema, qualityInputSchema, renderQuality, type PreviousEvaluation } from './quality.js';
import { compare } from './history.js';
import { reportSchema } from './schema.js';
import { toSarif } from './sarif.js';
import { collectionOptionsSchema, reviewTimeoutSchema, VERIFY_TIMEOUT_MS, type CollectionOptions } from './collection-options.js';
import { CONFIG_FILE, resolveSettings } from './project-config.js';
import { ReviewProgress } from './progress.js';
import type { Report } from './domain.js';

/** Exit codes for review and verify statuses, as the help text documents them. */
const EXIT_CODES = { needs_attention: 1, inconclusive: 3, no_findings: 0 } as const satisfies Record<Report['status'], number>;

function positiveSafeInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive safe integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer.`);
  return parsed;
}
function collectionOptions(values: {
  'index-max-files'?: string;
  'index-max-bytes'?: string;
  'index-timeout-ms'?: string;
  'collection-timeout-ms'?: string;
}): CollectionOptions {
  return collectionOptionsSchema.parse({
    maxIndexFiles: positiveSafeInteger(values['index-max-files'], '--index-max-files'),
    maxIndexBytes: positiveSafeInteger(values['index-max-bytes'], '--index-max-bytes'),
    indexTimeoutMs: positiveSafeInteger(values['index-timeout-ms'], '--index-timeout-ms'),
    collectionTimeoutMs: positiveSafeInteger(values['collection-timeout-ms'], '--collection-timeout-ms'),
  });
}

/** Saves `value` as JSON that only the owner can read, creating the parent directory. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const destination = resolve(file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

/** Reads the quality evaluation to compare with from a saved review report or an assess evaluation. */
async function readPrevious(file: string): Promise<PreviousEvaluation> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`--previous ${file} is not a readable JSON file.`, { cause: error }); }
  const report = reportSchema.safeParse(value);
  if (report.success) {
    if (report.data.quality) return report.data.quality;
    throw new Error(report.data.packetQualities?.length
      ? `--previous ${file} is a multi-packet review report; only a single-packet report has one quality evaluation to compare.`
      : `--previous ${file} is a review report without a quality evaluation to compare.`);
  }
  const evaluation = previousEvaluationSchema.safeParse(value);
  if (evaluation.success) return evaluation.data;
  throw new Error(`--previous ${file} is neither a report saved by review --out nor an evaluation saved by assess --out.`);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, allowNegative: true, options: {
    repo: { type: 'string' }, base: { type: 'string' },
    'include-untracked': { type: 'boolean' }, json: { type: 'boolean', default: false },
    out: { type: 'string' }, current: { type: 'string' }, previous: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    input: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' },
    'index-max-files': { type: 'string' }, 'index-max-bytes': { type: 'string' },
    'index-timeout-ms': { type: 'string' }, 'collection-timeout-ms': { type: 'string' },
    'review-timeout-ms': { type: 'string' },
    sarif: { type: 'string' }, 'fail-on-priorities': { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Tracecheck: evidence-backed review powered by Jev

Usage:
  tracecheck preview [--repo PATH] [--base REF] [--[no-]include-untracked] [--task TEXT]
                     [--context TEXT] [collection limits] [--json]
  tracecheck review  [--repo PATH] [--base REF] [--[no-]include-untracked] [--task TEXT]
                     [--context TEXT] [collection limits] [--review-timeout-ms N]
                     [--previous FILE] [--json] [--out FILE] [--sarif FILE] [--quiet]
  tracecheck verify  --input FILE [--repo PATH] [--out FILE]
  tracecheck assess  --input FILE [--previous FILE] [--json] [--out FILE] [--fail-on-priorities]
  tracecheck compare --previous FILE --current FILE
  tracecheck mcp     [--repo PATH]

Options:
  --repo PATH                 Git repository to collect; defaults to the current directory. verify
                              matches excerpts against it; mcp uses it when a call names none.
  --base REF                  Git baseline (default: HEAD).
  --include-untracked         Include supported, non-ignored untracked files.
  --no-include-untracked      Exclude untracked files even when the config file includes them.
  --task TEXT                 Requested behavior or acceptance criteria.
  --context TEXT              Repository facts, contracts, or observed test results.
  --review-timeout-ms N       Review deadline (default: 300000).
  --input FILE                verify: evidence JSON. assess: context JSON.
  --previous FILE             review and assess: a report saved by review --out or an evaluation
                              saved by assess --out; its quality evaluation is compared with this
                              run. compare: the earlier review report.
  --current FILE              compare: the later review report.
  --json                      Print JSON instead of Markdown (preview, review, assess).
  --out FILE                  Save the review report, verification result, or evaluation as JSON.
  --sarif FILE                review: also write supported findings as SARIF 2.1.0.
  -q, --quiet                 review: do not print progress lines to stderr. Progress never goes
                              to stdout, so the report is the same either way.
  --fail-on-priorities        assess: exit 1 when the evaluation lists actionable quality priorities.
  -h, --help                  Show this help.

Collection limits (preview and review): --index-max-files N, --index-max-bytes N,
--index-timeout-ms N (default 20000), --collection-timeout-ms N (default 120000).
All N values are positive safe integers.

Exit codes:
  0  Success. review and verify found nothing that needs attention; assess never fails on
     its results unless --fail-on-priorities is set.
  1  review: supported findings or quality priorities. verify: the hypothesis is supported.
     assess --fail-on-priorities: actionable quality priorities.
  2  Execution or input error.
  3  review or verify is inconclusive.

Preview and compare are local. Review, verify, and assess send bounded evidence to Jev and
require JEV_API_KEY or TYPESAFE_API_KEY (TypeSafe), or OPENROUTER_API_KEY (OpenRouter). Optional
TYPESAFE_BASE_URL overrides the endpoint base URL. Optional JEV_MODEL selects the model
(default: jev-latest). Optional JEV_TIMEOUT_MS limits each Jev request (default: 45000).
Optional JEV_CONCURRENCY sets how many review requests run at once (default: 4, at most 16).
Each change packet receives an individual bounded quality assessment. Automatic
source-anchored checks cover three JS/TS patterns; no code or tests are executed.
Packet evidence is bounded and does not establish repository-wide semantic completeness.
Use --task and --context to supply requirements and repository facts.

Preview and review read optional defaults from ${CONFIG_FILE} at the repository root: base,
includeUntracked, task, repositoryContext, collection, reviewTimeoutMs, model,
requestTimeoutMs, and requestConcurrency. Flags override the file, and JEV_MODEL,
JEV_TIMEOUT_MS, and JEV_CONCURRENCY override its model, requestTimeoutMs, and
requestConcurrency. The file cannot hold credentials or the endpoint.`);
    return;
  }
  if (command === 'mcp') {
    const { serve } = await import('./mcp.js');
    await serve(values.repo ? resolve(values.repo) : undefined);
    return;
  }
  if (command === 'compare') {
    if (!values.previous || !values.current) throw new Error('compare requires --previous old.json --current current.json');
    const previous = reportSchema.parse(JSON.parse(await readFile(values.previous, 'utf8')));
    const current = reportSchema.parse(JSON.parse(await readFile(values.current, 'utf8')));
    console.log(JSON.stringify(compare(previous, current), null, 2));
    return;
  }
  if (command === 'verify') {
    if (!values.input) throw new Error('verify requires --input evidence.json');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const signal = AbortSignal.any([controller.signal, deadline(VERIFY_TIMEOUT_MS, `Verification timed out after ${VERIFY_TIMEOUT_MS} ms.`)]);
    const input = JSON.parse(await readFile(values.input, 'utf8'));
    const output = await verify({ ...input, ...(values.repo ? { repo: values.repo } : {}) }, jevFromEnv(signal), signal);
    if (values.out) await writeJson(values.out, output);
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = EXIT_CODES[output.report.status];
    return;
  }
  if (command === 'assess') {
    if (!values.input) throw new Error('assess requires --input context.json');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const signal = AbortSignal.any([controller.signal, deadline(ASSESS_TIMEOUT_MS, `Assessment timed out after ${ASSESS_TIMEOUT_MS} ms.`)]);
    const input = qualityInputSchema.parse(JSON.parse(await readFile(values.input, 'utf8')));
    if (values.previous) input.previousEvaluation = await readPrevious(values.previous);
    const evaluation = await assess(input, jevFromEnv(signal), signal);
    if (values.out) await writeJson(values.out, evaluation);
    console.log(values.json ? JSON.stringify(evaluation, null, 2) : renderQuality(evaluation));
    if (values['fail-on-priorities'] && evaluation.priorities.length) process.exitCode = 1;
    return;
  }
  if (!['preview', 'review'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const settings = await resolveSettings(values.repo ?? '.', { base: values.base, includeUntracked: values['include-untracked'],
    task: values.task, repositoryContext: values.context, collection: collectionOptions(values),
    reviewTimeoutMs: reviewTimeoutSchema.optional().parse(positiveSafeInteger(values['review-timeout-ms'], '--review-timeout-ms')) }, controller.signal);
  const { reviewTimeoutMs, request: collectionRequest } = settings;
  const progress = command === 'review' && !values.quiet ? new ReviewProgress(update => console.error(`Tracecheck progress: ${update.message}`)) : undefined;
  const plan = await collect({ repo: settings.root, ...collectionRequest, signal: controller.signal, onPhase: progress?.phase });
  if (command === 'preview') {
    const packets = plan.packets.map(packet => `${packet.id}: ${packet.changedPaths.join(', ')}`).join('\n');
    console.log(values.json ? JSON.stringify(plan, null, 2) : `Tracecheck preview (local only)\n${collectionRequest.projectConfig ? `Settings: ${CONFIG_FILE}\n` : ''}Snapshot: ${plan.snapshot}\n${plan.packets.length} change packets · ${plan.sources.length} files · ${plan.candidates.length} candidates\nReview implication: ${plan.packets.length} independently scoped assessment packet(s); each nonempty packet may require multiple quality requests, and empty-evidence packets are not sent.\n${packets}\n${plan.sources.map(source => `${source.role}: ${source.path}${source.previousPath ? ` (renamed from ${source.previousPath})` : ''}`).join('\n')}\n${plan.limitations.map(item => `Coverage gap: ${item}`).join('\n')}`);
    return;
  }
  const reviewSignal = AbortSignal.any([controller.signal,
    deadline(reviewTimeoutMs, `Review timed out after ${reviewTimeoutMs} ms. Raise --review-timeout-ms to allow more time.`)]);
  const previous = values.previous ? await readPrevious(values.previous) : undefined;
  const provider = jevSettings(process.env, settings.provider);
  const report = await reviewAll(plan, new Jev({ ...provider, signal: reviewSignal }),
    { signal: reviewSignal, concurrency: provider.concurrency, previousEvaluation: previous, onProgress: progress?.requests });
  reviewSignal.throwIfAborted();
  progress?.checking();
  const current = await collect({ repo: plan.root, ...collectionRequest, discovery: plan.discovery, signal: reviewSignal });
  if (current.snapshot !== plan.snapshot) throw new Error('Repository changed during review. Run review again.');
  progress?.finished();
  if (values.out) await writeJson(values.out, report);
  if (values.sarif) await writeJson(values.sarif, toSarif(report));
  console.log(values.json ? JSON.stringify(report, null, 2) : render(report));
  process.exitCode = EXIT_CODES[report.status];
}

main().catch(error => {
  console.error(`Tracecheck: ${error instanceof Error ? error.message : 'Unexpected failure'}`);
  process.exitCode = 2;
});
