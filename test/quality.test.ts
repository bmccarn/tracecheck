import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, qualityQuestions, transformQuality, qualityInputSchema } from '../src/quality.js';
import { dimensions } from '../src/quality/dimensions.js';
import { reviewAll } from '../src/review.js';
import { typedFixture, planFor } from './helpers.js';
import type { TypedEvaluator } from '../src/domain.js';

const baseline = async () => typedFixture(qualityQuestions());

test('retains the complete 19-dimension baseline and four conditional dimensions', () => {
  assert.deepEqual(dimensions.map(item => item.key).sort(), [
    'correctness','cognitiveComplexity','readability','modularity','coupling','changeability','abstractionQuality','projectStructure','duplication','maintainability','testQuality','reliability','security','consistency','documentation','performance','scalability','compatibility','observability',
  ].sort());
  assert.deepEqual(dimensions.filter(item => item.conditional).map(item => item.key), ['performance','scalability','compatibility','observability']);
  const questions = Object.values(qualityQuestions());
  for (const type of ['noul','score','choice']) assert.equal(questions.filter(question => question.type === type).length, 19);
});

test('normalizes independent scores and withholds scores without sufficient context', async () => {
  const response = await baseline();
  response.answers.quality_performance_applicability = { type: 'noul', noul: 0.1 };
  response.answers.quality_correctness_applicability = { type: 'noul', noul: 0.5 };
  const evaluation = transformQuality(response, 'scope', 'snapshot');
  assert.equal(evaluation.metrics.readability!.score, 8);
  assert.equal(evaluation.metrics.performance!.status, 'not_applicable');
  assert.equal(evaluation.metrics.performance!.score, undefined);
  assert.equal(evaluation.metrics.correctness!.status, 'uncertain');
  assert.equal(evaluation.metrics.correctness!.score, undefined);
  assert.equal('overallScore' in evaluation, false);
});

test('an actionable concern survives a high score; confidence controls actionability', async () => {
  const response = await baseline();
  response.answers.quality_security_weakness = { type: 'choice', choice: 'access', confidence: 0.95, probabilities: { access: 0.95, none: 0.05, trust: 0, exposure: 0 } };
  const evaluation = transformQuality(response, 'scope', 'snapshot');
  assert.equal(evaluation.metrics.security!.score, 8);
  assert.equal(evaluation.priorities[0]!.metric, 'security');
  response.answers.quality_security_weakness.confidence = 0.2;
  assert.equal(transformQuality(response, 'scope', 'snapshot').priorities.length, 0);
});

test('compares credible scores and tracks unresolved concerns without sending prior evaluations', async () => {
  const response = await baseline();
  response.answers.quality_security_weakness = { type: 'choice', choice: 'access', confidence: 0.95, probabilities: { access: 1, none: 0, trust: 0, exposure: 0 } };
  const before = transformQuality(response, 'scope', 'before');
  const changed = response.answers.quality_readability_score;
  assert.equal(changed?.type, 'score'); if (changed?.type !== 'score') throw new Error();
  changed.score = 5;
  const evaluator: TypedEvaluator = { async evaluate(state) {
    assert.equal('previousEvaluation' in (state as object), false);
    assert.equal('scope' in (state as object), false);
    return response;
  } };
  const after = await assess({ files: [{ path: 'a.py', content: 'print(1)' }], scope: 'scope', previousEvaluation: before }, evaluator);
  assert.equal(after.comparison.find(item => item.metric === 'readability')!.direction, 'regressed');
  assert.ok(after.unresolvedWeaknesses.includes('security'));
  assert.equal(after.regressions.length, 1);
  const mismatch = transformQuality({ ...response, model: 'new-model' }, 'scope', 'after', before);
  assert.equal(mismatch.comparison.length, 0); assert.equal(mismatch.warnings.length, 1);
});

test('missing typed decisions fail closed and empty manual contexts are rejected', async () => {
  const response = await baseline(); delete response.answers.quality_security_score;
  assert.throws(() => transformQuality(response, 'scope', 'snapshot'), /Incomplete/);
  assert.equal(qualityInputSchema.safeParse({}).success, false);
  assert.equal(qualityInputSchema.safeParse({ files: [{ path: 'empty.ts', content: ' ' }] }).success, false);
});

test('broad review and candidate checks share one request and account usage once', async () => {
  let calls = 0;
  const report = await reviewAll(planFor(), { async evaluate(_state, questions) {
    calls++; assert.equal(Object.keys(questions).length, 59);
    return typedFixture(questions);
  } });
  assert.equal(calls, 1); assert.equal(report.usage.requests, 1);
  assert.equal(report.usage.inputTokens, 100);
  assert.equal(Object.keys(report.quality!.metrics).length, 19);
  assert.equal(report.decisions[0]!.status, 'supported');
});

test('non-JS context still receives all quality dimensions without source candidates', async () => {
  const plan = planFor(); plan.candidates = []; plan.sources = [{ path: 'a.py', content: 'def add(a,b): return a+b', role: 'changed' }];
  let calls = 0;
  const report = await reviewAll(plan, { async evaluate(_state, questions) { calls++; return typedFixture(questions); } });
  assert.equal(calls, 1); assert.equal(Object.keys(report.quality!.metrics).length, 19);
  assert.ok(!report.limitations.some(value => value.includes('no semantic review')));
});

test('large reviews ask the broad questions once and include later source batches', async () => {
  const plan = planFor(); plan.candidates = Array.from({ length: 23 }, (_, index) => ({ ...plan.candidates[0]!, id: String(index) }));
  const sizes: number[] = [];
  const report = await reviewAll(plan, { async evaluate(_state, questions) { sizes.push(Object.keys(questions).length); return typedFixture(questions); } });
  assert.deepEqual(sizes, [77,20,6]);
  assert.equal(report.usage.requests, 3);
  assert.equal(report.usage.inputTokens, 300);
  assert.equal(report.decisions.length, 23);
});
