#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collect } from './collector.js';
import { Jev } from './jev.js';
import { reviewAll, render } from './review.js';
import { assess, qualityInputSchema, qualityEvaluationSchema, renderQuality } from './quality.js';
import { compare } from './history.js';
import { reportSchema } from './schema.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, base: { type: 'string', default: 'HEAD' },
    'include-untracked': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    out: { type: 'string' }, current: { type: 'string' }, previous: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    input: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Tracecheck — evidence-backed review powered by Jev

  tracecheck preview --repo PATH [--base HEAD] [--include-untracked] [--json]
  tracecheck review  --repo PATH [--base HEAD] [--json] [--out report.json]
  tracecheck assess  --input context.json [--previous evaluation.json] [--out evaluation.json]
  tracecheck compare --previous old.json --current current.json
  tracecheck mcp     --repo PATH

Preview is local. Review sends bounded source context to TypeSafe and requires
JEV_API_KEY or TYPESAFE_API_KEY. Optional JEV_MODEL selects the model (default: jev-latest).
Exit codes: 0 no findings, 1 supported findings, 2 error, 3 inconclusive.
Broad review covers 19 quality dimensions in any supplied language. Automatic
source-anchored checks cover three JS/TS patterns; no code or tests are executed.
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
  if (command === 'assess') {
    if (!values.input) throw new Error('assess requires --input context.json');
    const input = qualityInputSchema.parse(JSON.parse(await readFile(values.input, 'utf8')));
    if (values.previous) input.previousEvaluation = qualityEvaluationSchema.parse(JSON.parse(await readFile(values.previous, 'utf8')));
    const evaluation = await assess(input, new Jev({ apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '', model: process.env.JEV_MODEL }));
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(values.out, JSON.stringify(evaluation, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(values.json ? JSON.stringify(evaluation, null, 2) : renderQuality(evaluation));
    return;
  }
  if (!['preview', 'review'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const plan = await collect({ repo: values.repo ?? '.', base: values.base, includeUntracked: values['include-untracked'], task: values.task, repositoryContext: values.context });
  if (command === 'preview') {
    console.log(values.json ? JSON.stringify(plan, null, 2) : `Tracecheck preview (local only)\nSnapshot: ${plan.snapshot}\n${plan.sources.length} files · ${plan.candidates.length} candidates\n${plan.sources.map(source => `${source.role}: ${source.path}`).join('\n')}\n${plan.limitations.map(item => `Coverage gap: ${item}`).join('\n')}`);
    return;
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const previous = values.previous ? reportSchema.parse(JSON.parse(await readFile(values.previous, 'utf8'))).quality : undefined;
  const report = await reviewAll(plan, new Jev({ apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '', model: process.env.JEV_MODEL, signal: controller.signal }), { signal: controller.signal, previousEvaluation: previous });
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
