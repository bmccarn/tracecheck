import { jevFromEnv } from '../src/jev.js';
import { review } from '../src/review.js';
import { cases, casePlan } from './cases.js';

if (!process.argv.includes('--live')) {
  console.log('Six synthetic labeled cases are ready. Run npm run benchmark -- --live with JEV_API_KEY to measure Jev. This makes paid API calls using only synthetic source.');
  process.exit(0);
}

const evaluator = jevFromEnv();
const results = [];
for (const fixture of cases) {
  // The expected answer is never sent to the provider.
  const report = await review(casePlan(fixture), evaluator);
  results.push({ id: fixture.id, expected: fixture.expected, observed: report.decisions[0]?.status ?? 'not_evaluated',
    models: report.models, usage: report.usage, decisions: report.decisions,
    correct: report.decisions[0]?.status === fixture.expected });
}
const tp = results.filter(row => row.expected === 'supported' && row.observed === 'supported').length;
const fp = results.filter(row => row.expected === 'not_supported' && row.observed === 'supported').length;
const positives = results.filter(row => row.expected === 'supported').length;
console.log(JSON.stringify({ benchmark: 'synthetic-v1', cases: results.length,
  precision: tp + fp ? tp / (tp + fp) : null, recall: tp / positives,
  abstentions: results.filter(row => !['supported', 'not_supported'].includes(row.observed)).length,
  correct: results.filter(row => row.correct).length,
  warning: 'Six synthetic cases are a smoke benchmark, not an estimate of real-world review accuracy.', results }, null, 2));
process.exitCode = results.every(row => row.correct) ? 0 : 1;
