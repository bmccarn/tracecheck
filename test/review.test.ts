import { test } from 'node:test';
import assert from 'node:assert/strict';
import { review, render } from '../src/review.js';
import { compare } from '../src/history.js';
import { reportSchema } from '../src/schema.js';
import { fixtureEvaluator, planFor } from './helpers.js';
import { cases, casePlan } from '../examples/cases.js';

test('each live benchmark fixture exercises exactly one supported check candidate', () => {
  for (const fixture of cases) assert.equal(casePlan(fixture).candidates.length, 1, fixture.id);
});

test('supported findings retain exact evidence and do not claim an executed reproduction', async () => {
  const report = await review(planFor(), fixtureEvaluator());
  reportSchema.parse(report);
  assert.equal(report.status, 'needs_attention');
  assert.equal(report.decisions[0]!.quote, 'a / b');
  assert.match(render(report), /not executed reproductions/);
});

test('uncertain negatives and missing context cannot produce a no-findings result', async () => {
  assert.equal((await review(planFor(), fixtureEvaluator('not_supported', 0.3))).status, 'inconclusive');
  assert.equal((await review(planFor(), fixtureEvaluator('needs_context'))).status, 'inconclusive');
  assert.equal((await review(planFor(), fixtureEvaluator('not_supported'))).status, 'no_findings');
});

test('omitted context and zero candidates do not create a clean bill of health', async () => {
  const plan = planFor(); plan.limitations.push('File budget exhausted: caller.ts');
  assert.equal((await review(plan, fixtureEvaluator('not_supported'))).status, 'inconclusive');
  plan.candidates = [];
  const report = await review(plan, { evaluate() { throw new Error('Should not call the provider'); } });
  assert.equal(report.status, 'inconclusive'); assert.equal(report.usage.requests, 0);
});

test('batches questions and respects cancellation between batches', async () => {
  const plan = planFor();
  plan.candidates = Array.from({ length: 23 }, (_, i) => ({ ...plan.candidates[0]!, id: String(i) }));
  const report = await review(plan, fixtureEvaluator());
  assert.equal(report.usage.requests, 3);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(review(plan, fixtureEvaluator(), controller.signal));
});

test('history never calls a disappeared candidate fixed', async () => {
  const before = await review(planFor(), fixtureEvaluator());
  const after = await review(planFor(), fixtureEvaluator('not_supported'));
  assert.equal(compare(before, after)[0]!.status, 'no_longer_supported');
  after.decisions = [];
  assert.equal(compare(before, after)[0]!.status, 'not_reassessed');
  after.models = ['different-model'];
  assert.throws(() => compare(before, after), /cannot be compared/);
});
