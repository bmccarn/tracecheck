#!/usr/bin/env node
import { verify } from './verify.js';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collect } from './collector.js';
import { jevFromEnv } from './jev.js';
import { deadline } from './deadline.js';
import { reviewAll, render } from './review.js';
import { ASSESS_TIMEOUT_MS, assess, previousEvaluationSchema, qualityInputSchema, renderQuality } from './quality.js';
import { compare } from './history.js';
import { reportSchema } from './schema.js';
import { collectionOptionsSchema, reviewTimeoutSchema, VERIFY_TIMEOUT_MS, type CollectionOptions } from './collection-options.js';

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

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, base: { type: 'string', default: 'HEAD' },
    'include-untracked': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    out: { type: 'string' }, current: { type: 'string' }, previous: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    input: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' },
    'index-max-files': { type: 'string' }, 'index-max-bytes': { type: 'string' },
    'index-timeout-ms': { type: 'string' }, 'collection-timeout-ms': { type: 'string' },
    'review-timeout-ms': { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Tracecheck — evidence-backed review powered by Jev

  tracecheck preview --repo PATH [--base HEAD] [--include-untracked] [collection limits] [--json]
  tracecheck review  --repo PATH [--base HEAD] [collection limits] [--review-timeout-ms N] [--json] [--out report.json]
  tracecheck verify  --input evidence.json [--repo PATH] [--out result.json]
  tracecheck assess  --input context.json [--previous evaluation.json] [--out evaluation.json]
  tracecheck compare --previous old.json --current current.json
  tracecheck mcp     --repo PATH

Collection limits: --index-max-files N, --index-max-bytes N,
--index-timeout-ms N (default 20000), --collection-timeout-ms N (default 120000).
All values are positive safe integers. Review timeout defaults to 300000 ms.

Preview is local. Review sends bounded evidence for all change packets to Jev and requires
JEV_API_KEY or TYPESAFE_API_KEY (TypeSafe), or OPENROUTER_API_KEY (OpenRouter). Optional
TYPESAFE_BASE_URL overrides the endpoint base URL. Optional JEV_MODEL selects the model
(default: jev-latest). Optional JEV_TIMEOUT_MS limits each Jev request (default: 45000).
Exit codes: 0 no findings, 1 supported findings, 2 error, 3 inconclusive.
Each change packet receives an individual bounded quality assessment. Automatic
source-anchored checks cover three JS/TS patterns; no code or tests are executed.
Packet evidence is bounded and does not establish repository-wide semantic completeness.
Use --task and --context to supply requirements and repository facts.`);
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
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(values.out, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = output.report.status === 'needs_attention' ? 1 : output.report.status === 'inconclusive' ? 3 : 0;
    return;
  }
  if (command === 'assess') {
    if (!values.input) throw new Error('assess requires --input context.json');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ASSESS_TIMEOUT_MS)]);
    const input = qualityInputSchema.parse(JSON.parse(await readFile(values.input, 'utf8')));
    if (values.previous) input.previousEvaluation = previousEvaluationSchema.parse(JSON.parse(await readFile(values.previous, 'utf8')));
    const evaluation = await assess(input, jevFromEnv(signal), signal);
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(values.out, JSON.stringify(evaluation, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(values.json ? JSON.stringify(evaluation, null, 2) : renderQuality(evaluation));
    return;
  }
  if (!['preview', 'review'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const collection = collectionOptions(values);
  const reviewTimeoutMs = reviewTimeoutSchema.parse(positiveSafeInteger(values['review-timeout-ms'], '--review-timeout-ms'));
  const collectionRequest = { base: values.base, includeUntracked: values['include-untracked'], task: values.task,
    repositoryContext: values.context, collection };
  const plan = await collect({ repo: values.repo ?? '.', ...collectionRequest, signal: controller.signal });
  if (command === 'preview') {
    const packets = plan.packets.map(packet => `${packet.id}: ${packet.changedPaths.join(', ')}`).join('\n');
    console.log(values.json ? JSON.stringify(plan, null, 2) : `Tracecheck preview (local only)\nSnapshot: ${plan.snapshot}\n${plan.packets.length} change packets · ${plan.sources.length} files · ${plan.candidates.length} candidates\nReview implication: ${plan.packets.length} independently scoped assessment packet(s); each nonempty packet may require multiple quality requests, and empty-evidence packets are not sent.\n${packets}\n${plan.sources.map(source => `${source.role}: ${source.path}`).join('\n')}\n${plan.limitations.map(item => `Coverage gap: ${item}`).join('\n')}`);
    return;
  }
  const reviewSignal = AbortSignal.any([controller.signal,
    deadline(reviewTimeoutMs, `Review timed out after ${reviewTimeoutMs} ms. Raise --review-timeout-ms to allow more time.`)]);
  if (values.previous && plan.packets.length > 1) throw new Error('Previous evaluation comparison is supported only for a single change packet.');
  const previousReport = values.previous ? reportSchema.parse(JSON.parse(await readFile(values.previous, 'utf8'))) : undefined;
  if (values.previous && !previousReport?.quality) throw new Error('Previous report has no single-packet quality evaluation to compare.');
  const previous = previousReport?.quality;
  const report = await reviewAll(plan, jevFromEnv(reviewSignal), { signal: reviewSignal, previousEvaluation: previous });
  reviewSignal.throwIfAborted();
  const current = await collect({ repo: plan.root, ...collectionRequest, discovery: plan.discovery, signal: reviewSignal });
  if (current.snapshot !== plan.snapshot) throw new Error('Repository changed during review. Run review again.');
  if (values.out) {
    const destination = resolve(values.out);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : render(report));
  process.exitCode = report.status === 'needs_attention' ? 1 : report.status === 'inconclusive' ? 3 : 0;
}

main().catch(error => {
  console.error(`Tracecheck: ${error instanceof Error ? error.message : 'Unexpected failure'}`);
  process.exitCode = 2;
});
