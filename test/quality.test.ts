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
  for (const type of ['noul','score','choice']) assert.equal(questions.filter(question => question.type === type).length, type === 'noul' ? 38 : 19);
});

test('normalizes independent scores and withholds scores without sufficient context', async () => {
  const response = await baseline();
  response.answers.quality_performance_relevance = { type: 'noul', noul: 0.1 };
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
    calls++; assert.equal(Object.keys(questions).length, 78);
    return typedFixture(questions);
  } });
  assert.equal(calls, 1); assert.equal(report.usage.requests, 1);
  assert.equal(report.usage.inputTokens, 100);
  assert.equal(Object.keys(report.quality!.metrics).length, 19);
  assert.equal(report.decisions[0]!.status, 'supported');
});

test('non-JS context still receives all quality dimensions without source candidates', async () => {
  const plan = planFor();
  plan.candidates = [];
  plan.sources = [{ path: 'a.py', content: 'def add(a,b): return a+b', role: 'changed' }];
  plan.packets = [{ id: 'python', changedPaths: ['a.py'], sourcePaths: ['a.py'], candidateIds: [], limitations: [] }];
  let calls = 0;
  const report = await reviewAll(plan, { async evaluate(_state, questions) { calls++; return typedFixture(questions); } });
  assert.equal(calls, 1); assert.equal(Object.keys(report.quality!.metrics).length, 19);
  assert.ok(!report.limitations.some(value => value.includes('no semantic review')));
});

test('large reviews ask broad questions once and decide every candidate across batches', async () => {
  const plan = planFor();
  plan.candidates = Array.from({ length: 43 }, (_, index) => ({ ...plan.candidates[0]!, id: String(index) }));
  plan.packets[0]!.candidateIds = plan.candidates.map(candidate => candidate.id);
  let broadCalls = 0;
  const report = await reviewAll(plan, { async evaluate(_state, questions) {
    if (Object.keys(questions).some(id => id.startsWith('quality_'))) broadCalls++;
    return typedFixture(questions);
  } });
  assert.equal(broadCalls, 1);
  assert.equal(report.usage.requests, 5);
  assert.equal(report.usage.inputTokens, 500);
  assert.equal(report.decisions.length, 43);
});

test('plans near-limit evidence into bounded evaluator requests without dropping broad or candidate decisions', async () => {
  const plan = planFor();
  plan.sources[0]!.content = `export const evidence = '${'x'.repeat(78_000)}';`;
  plan.candidates = Array.from({ length: 17 }, (_, index) => ({
    ...plan.candidates[0]!, id: `candidate-${index}`, hypothesis: 'detail '.repeat(600),
  }));
  plan.packets[0]!.candidateIds = plan.candidates.map(candidate => candidate.id);
  const calls: string[][] = [];
  const report = await reviewAll(plan, { async evaluate(state, questions) {
    assert.ok(new TextEncoder().encode(JSON.stringify({ state, questions })).byteLength <= 160_000);
    calls.push(Object.keys(questions));
    return typedFixture(questions);
  } });
  const asked = calls.flat();
  for (const candidate of plan.candidates) {
    assert.equal(asked.filter(key => key === `${candidate.id}_assessment`).length, 1);
    assert.equal(asked.filter(key => key === `${candidate.id}_impact`).length, 1);
  }
  for (const key of Object.keys(qualityQuestions())) assert.equal(asked.filter(askedKey => askedKey === key).length, 1);
  const broadRequests = calls.filter(call => call.some(key => key.startsWith('quality_'))).length;
  assert.ok(calls.length > 2);
  assert.ok(calls.some(call => call.filter(key => key.endsWith('_assessment')).length < 10));
  assert.equal(report.usage.requests, calls.length);
  assert.equal(report.quality!.usage.requests, broadRequests);
  assert.equal(report.decisions.length, plan.candidates.length);
});

test('preflights impossible context before calling the typed evaluator', async () => {
  const plan = planFor();
  plan.repositoryContext = 'x'.repeat(200_000);
  let calls = 0;
  await assert.rejects(reviewAll(plan, { async evaluate(_state, questions) {
    calls++;
    return typedFixture(questions);
  } }), /cannot be evaluated without dropping evidence/);
  assert.equal(calls, 0);
});

test('empty evidence is inconclusive without evaluator calls or a numeric quality result', async () => {
  const plan = planFor(' ');
  let calls = 0;
  const report = await reviewAll(plan, { async evaluate(_state, questions) {
    calls++;
    return typedFixture(questions);
  } });
  assert.equal(calls, 0);
  assert.equal(report.quality, undefined);
  assert.equal(report.packetQualities, undefined);
  assert.ok(report.limitations.some(value => value.includes('has no source evidence')));
  assert.equal(report.status, 'inconclusive');
});

test('before-only evidence is evaluated rather than treated as an empty packet', async () => {
  const plan = planFor();
  plan.sources[0]!.before = plan.sources[0]!.content;
  plan.sources[0]!.content = ' ';
  let calls = 0;
  const report = await reviewAll(plan, { async evaluate(_state, questions) {
    calls++;
    return typedFixture(questions);
  } });
  assert.equal(calls, 1);
  assert.equal(report.quality!.usage.requests, 1);
  assert.ok(Object.values(report.quality!.metrics).every(metric => metric.status === 'assessed'));
});

test('skips an empty packet while retaining the nonempty packet review', async () => {
  const plan = planFor();
  plan.sources.push({ path: 'empty.ts', content: ' ', role: 'changed' });
  plan.packets.push({ id: 'empty', changedPaths: ['empty.ts'], sourcePaths: ['empty.ts'], candidateIds: [], limitations: [] });
  let calls = 0;
  const report = await reviewAll(plan, { async evaluate(_state, questions) {
    calls++;
    return typedFixture(questions);
  } });
  assert.equal(calls, 1);
  assert.equal(report.decisions.length, 1);
  assert.equal(report.quality, undefined);
  assert.deepEqual(report.packetQualities?.map(packet => packet.packetId), ['packet-1']);
  assert.ok(report.limitations.some(value => value.includes('Packet empty has no source evidence; no provider review was performed.')));
});

test('publishes independent packet qualities without inventing an aggregate quality', async () => {
  const plan = planFor();
  const later = { ...plan.candidates[0]!, id: 'later', path: 'later.ts', quote: 'x / y' };
  plan.sources.push({ path: 'later.ts', content: 'export const later = x / y;', role: 'changed' });
  plan.candidates.push(later);
  plan.packets = [
    { id: 'first', changedPaths: ['example.ts'], sourcePaths: ['example.ts'], candidateIds: [plan.candidates[0]!.id], limitations: [] },
    { id: 'later', changedPaths: ['later.ts'], sourcePaths: ['later.ts'], candidateIds: ['later'], limitations: [] },
  ];
  const states: Array<{ sources: Array<{ path: string }> }> = [];
  const report = await reviewAll(plan, { async evaluate(state, questions) {
    const packetState = state as { sources: Array<{ path: string }> };
    states.push(packetState);
    return typedFixture(questions);
  } });
  assert.equal(report.quality, undefined);
  assert.deepEqual(report.packetQualities?.map(packet => packet.changedPaths), [['example.ts'], ['later.ts']]);
  assert.deepEqual(states.map(state => state.sources.map(source => source.path)), [['example.ts'], ['later.ts']]);
  assert.equal(report.usage.requests, 2); assert.equal(report.usage.inputTokens, 200);
});

test('a supplied previous evaluation is compared or leaves a note saying why not', async () => {
  const evaluator: TypedEvaluator = { evaluate: async (_state, questions) => typedFixture(questions) };
  const previous = (await reviewAll(planFor(), evaluator)).quality!;
  const notCompared = (report: { notes: string[] }) => report.notes.filter(value => value.startsWith('Previous evaluation was not compared'));

  const comparable = await reviewAll(planFor(), evaluator, { previousEvaluation: previous });
  assert.equal(comparable.quality!.comparison.length, 19);
  assert.deepEqual(notCompared(comparable), []);

  const otherModel = await reviewAll(planFor(), evaluator, { previousEvaluation: { ...previous, model: 'other-model' } });
  assert.equal(otherModel.quality!.comparison.length, 0);
  assert.match(notCompared(otherModel).join('\n'), /scope, model, or rubric version differs/);

  const empty = await reviewAll(planFor(' '), evaluator, { previousEvaluation: previous });
  assert.equal(empty.quality, undefined);
  assert.match(notCompared(empty).join('\n'), /produced no quality result/);

  const plan = planFor();
  plan.sources.push({ path: 'later.ts', content: 'export const later = 1;', role: 'changed' });
  plan.packets.push({ id: 'later', changedPaths: ['later.ts'], sourcePaths: ['later.ts'], candidateIds: [], limitations: [] });
  const multiple = await reviewAll(plan, evaluator, { previousEvaluation: previous });
  assert.equal(multiple.packetQualities?.length, 2);
  assert.match(notCompared(multiple).join('\n'), /multiple packet scopes/);
});
