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
  plan.candidates = []; plan.packets[0]!.candidateIds = [];
  const report = await review(plan, { evaluate() { throw new Error('Should not call the provider'); } });
  assert.equal(report.status, 'inconclusive'); assert.equal(report.usage.requests, 0);
});

test('batches every candidate and respects cancellation between packet batches', async () => {
  const plan = planFor();
  plan.candidates = Array.from({ length: 43 }, (_, i) => ({ ...plan.candidates[0]!, id: String(i) }));
  plan.packets[0]!.candidateIds = plan.candidates.map(candidate => candidate.id);
  const report = await review(plan, fixtureEvaluator());
  assert.equal(report.usage.requests, 5); assert.equal(report.decisions.length, 43);
  const controller = new AbortController();
  const evaluator = fixtureEvaluator();
  let calls = 0;
  await assert.rejects(review(plan, { async evaluate(state, questions) {
    calls++; controller.abort(); return evaluator.evaluate(state, questions);
  } }, controller.signal));
  assert.equal(calls, 1);
});

test('plans near-limit source evidence into bounded source-check requests', async () => {
  const plan = planFor();
  plan.sources[0]!.content = `export const evidence = '${'x'.repeat(78_000)}';`;
  plan.candidates = Array.from({ length: 17 }, (_, index) => ({
    ...plan.candidates[0]!, id: `candidate-${index}`, hypothesis: 'detail '.repeat(600),
  }));
  plan.packets[0]!.candidateIds = plan.candidates.map(candidate => candidate.id);
  const calls: string[][] = [];
  const evaluator = fixtureEvaluator();
  const report = await review(plan, { async evaluate(state, questions) {
    assert.ok(Buffer.byteLength(JSON.stringify({ state, questions })) <= 160_000);
    calls.push(Object.keys(questions));
    return evaluator.evaluate(state, questions);
  } });
  const asked = calls.flat();
  for (const candidate of plan.candidates) {
    assert.equal(asked.filter(key => key === `${candidate.id}_assessment`).length, 1);
    assert.equal(asked.filter(key => key === `${candidate.id}_impact`).length, 1);
  }
  assert.ok(calls.some(call => call.filter(key => key.endsWith('_assessment')).length < 10));
  assert.equal(report.usage.requests, calls.length);
  assert.equal(report.decisions.length, plan.candidates.length);
});

test('preflights impossible source-check context before calling its evaluator', async () => {
  const plan = planFor();
  plan.repositoryContext = 'x'.repeat(200_000);
  let calls = 0;
  await assert.rejects(review(plan, { async evaluate() {
    calls++;
    return fixtureEvaluator().evaluate({}, {});
  } }), /cannot be evaluated without dropping evidence/);
  assert.equal(calls, 0);
});

test('empty source-check evidence produces no provider call or decision', async () => {
  const plan = planFor(' ');
  let calls = 0;
  const report = await review(plan, { async evaluate() {
    calls++;
    return fixtureEvaluator().evaluate({}, {});
  } });
  assert.equal(calls, 0);
  assert.deepEqual(report.decisions, []);
  assert.ok(report.limitations.some(value => value.includes('has no source evidence')));
  assert.equal(report.status, 'inconclusive');
});

test('keeps packet evidence local while retaining later-packet findings', async () => {
  const plan = planFor();
  const later = { ...plan.candidates[0]!, id: 'later', path: 'later.ts', quote: 'x / y' };
  plan.sources.push({ path: 'later.ts', content: 'export const later = x / y;', role: 'changed' });
  plan.candidates.push(later);
  plan.packets = [
    { id: 'first', changedPaths: ['example.ts'], sourcePaths: ['example.ts'], candidateIds: [plan.candidates[0]!.id], limitations: ['first limit'] },
    { id: 'later', changedPaths: ['later.ts'], sourcePaths: ['later.ts'], candidateIds: ['later'], limitations: ['later limit'] },
  ];
  const states: Array<{ sources: Array<{ path: string }>; candidates: Array<{ id: string }> }> = [];
  const evaluator = fixtureEvaluator();
  const report = await review(plan, { async evaluate(state, questions) {
    const packetState = state as { sources: Array<{ path: string }>; candidates: Array<{ id: string }> };
    states.push(packetState);
    return evaluator.evaluate(state, questions);
  } });
  assert.deepEqual(states.map(state => state.sources.map(source => source.path)), [['example.ts'], ['later.ts']]);
  assert.deepEqual(states.map(state => state.candidates.map(candidate => candidate.id)), [[plan.candidates[0]!.id], ['later']]);
  assert.ok(report.decisions.some(decision => decision.id === 'later' && decision.status === 'supported'));
  assert.ok(report.limitations.includes('first limit')); assert.ok(report.limitations.includes('later limit'));
});

test('rejects packets with missing, misplaced, or unassigned evidence', async () => {
  const missingEvidence = planFor();
  missingEvidence.packets[0]!.sourcePaths = ['missing.ts'];
  await assert.rejects(review(missingEvidence, fixtureEvaluator()), /references missing source/);
  const misplacedCandidate = planFor();
  misplacedCandidate.candidates[0]!.path = 'elsewhere.ts';
  await assert.rejects(review(misplacedCandidate, fixtureEvaluator()), /missing its source/);
  const unassignedCandidate = planFor();
  unassignedCandidate.packets[0]!.candidateIds = [];
  await assert.rejects(review(unassignedCandidate, fixtureEvaluator()), /is not assigned to a packet/);
  const unassignedChanged = planFor();
  unassignedChanged.sources.push({ path: 'later.ts', content: 'export const later = 1;', role: 'changed' });
  await assert.rejects(review(unassignedChanged, fixtureEvaluator()), /has no primary packet/);
});

test('rejects duplicated candidate and changed-source primary assignments', async () => {
  const duplicateCandidate = planFor();
  duplicateCandidate.packets.push({ ...duplicateCandidate.packets[0]!, id: 'duplicate-candidate', changedPaths: [] });
  await assert.rejects(review(duplicateCandidate, fixtureEvaluator()), /appears in more than one packet/);
  const duplicateChanged = planFor();
  duplicateChanged.packets.push({ ...duplicateChanged.packets[0]!, id: 'duplicate-changed', candidateIds: [] });
  await assert.rejects(review(duplicateChanged, fixtureEvaluator()), /more than one primary packet/);
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
