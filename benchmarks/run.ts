import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Jev, jevSettings } from '../src/jev.js';
import { review } from '../src/review.js';
import { hash, POLICY_VERSION, type ReviewPlan } from '../src/domain.js';
import { summarize, type Observation } from '../src/benchmark.js';

const { values } = parseArgs({ options: { repo: { type: 'string' }, live: { type: 'boolean' }, out: { type: 'string', default: '.tracecheck/accuracy.json' }, model: { type: 'string', default: 'jev-1.13.0' } } });
if (!values.repo) throw new Error('Pass --repo /path/to/rapidregs-ingest. Source stays in local ignored reports; the subject repository is never edited.');
const schema = z.object({ revision: z.string(), cases: z.array(z.object({ id: z.string(), family: z.string(), split: z.enum(['development', 'holdout']), expected: z.enum(['supported', 'not_supported']), origin: z.string(), revision: z.string(), path: z.string(), symbol: z.string(), start: z.number(), end: z.number(), quote: z.string(), contract: z.string(), hypothesis: z.string(), focused: z.string(), full: z.string(), oracle: z.object({ passed: z.boolean(), method: z.string() }) })) });
const data = schema.parse(JSON.parse(execFileSync('python3', ['-I', 'benchmarks/rapidregs.py', resolve(values.repo)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })));
if (!values.live) {
  console.log(JSON.stringify({ cases: data.cases.length, families: [...new Set(data.cases.map(item => item.family))], revision: data.revision, executedOracles: 'passed', live: false }, null, 2));
} else {
  const signal = AbortSignal.timeout(180_000);
  const evaluator = new Jev({ ...jevSettings(), model: values.model, signal });
  const results: Array<Observation & { id: string; family: string; split: string; mode: string; model: string; requestHash: string; decision: unknown }> = [];
  // Alternate order to reduce systematic warm-up/order bias. Thresholds frozen before this run.
  for (const [index, item] of data.cases.entries()) {
    for (const mode of index % 2 ? ['focused', 'full'] as const : ['full', 'focused'] as const) {
      const content = item[mode];
      const snapshot = hash({ content, contract: item.contract, hypothesis: item.hypothesis });
      const candidateId = hash([item.family, item.quote]).slice(0, 16);
      const plan: ReviewPlan = { schemaVersion: 1, root: '/benchmark-subject', base: item.revision, head: data.revision, snapshot,
        sources: [{ path: item.path, content, role: 'changed' }], limitations: [], notes: [], task: item.contract,
        packets: [{ id: hash(item.id), changedPaths: [item.path], sourcePaths: [item.path], candidateIds: [candidateId], limitations: [] }],
        candidates: [{ id: candidateId, check: 'supplied-concern', path: item.path, symbol: item.symbol,
          range: { start: item.start, end: item.end }, quote: item.quote, hypothesis: item.hypothesis, verification: 'Evaluate the contract using the offline executable oracle.' }] };
      const report = await review(plan, evaluator, { signal });
      const decision = report.decisions[0]!;
      results.push({ id: item.id, family: item.family, split: item.split, mode, expected: item.expected, actual: decision.status,
        model: report.models[0]!, requestHash: snapshot, decision, elapsedMs: report.usage.elapsedMs, inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens });
      console.log(`${item.id} ${mode}: ${decision.status} (${report.usage.elapsedMs}ms)`);
    }
  }
  const groups = Object.fromEntries(['full', 'focused'].map(mode => [mode, Object.fromEntries(['all', 'development', 'holdout'].map(split => [split, summarize(results.filter(row => row.mode === mode && (split === 'all' || row.split === split)))]))]));
  const output = { createdAt: new Date().toISOString(), subjectRevision: data.revision, policyVersion: POLICY_VERSION, modelRequested: values.model,
    thresholds: { confidence: 0.6, probability: 0.8 }, interpretation: 'Known-concern verification, not automatic defect discovery or calibration of 19 quality scores. Historical pairs plus controlled mutations; comment variants are correlated cases, not independent samples. Holdout families were fixed before inference.', groups, results };
  await mkdir(dirname(resolve(values.out!)), { recursive: true });
  await writeFile(values.out!, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(groups, null, 2));
}
