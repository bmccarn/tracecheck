import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collect } from '../src/collector.js';
import { estimateReview, isIncomplete, review, reviewAll, render } from '../src/review.js';
import { compare } from '../src/history.js';
import { reportSchema } from '../src/schema.js';
import type { Report, ReviewPlan, TypedEvaluator } from '../src/domain.js';
import { fixtureEvaluator, planFor, repository, typedFixture } from './helpers.js';
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
  } }, { signal: controller.signal }));
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

test('history ignores model order and reports newly supported findings', async () => {
  const before = await review(planFor(), fixtureEvaluator('not_supported'));
  const after = await review(planFor(), fixtureEvaluator());
  before.models = ['model-a', 'model-b']; after.models = ['model-b', 'model-a'];
  assert.deepEqual(compare(before, after).map(item => item.status), ['newly_supported']);
  assert.deepEqual(compare(after, after).map(item => item.status), ['still_present']);
});

test('history follows a finding into a renamed file only while its site is unchanged', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const constants = Array.from({ length: 12 }, (_value, index) => `export const unit${index} = 'unit ${index}';\n`).join('');
  const guarded = `export function mean(xs: number[]) {\n  if (!xs.length) return 0;\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n${constants}`;
  await writeFile(join(repo.root, 'stats.ts'), guarded);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add stats');
  await writeFile(join(repo.root, 'stats.ts'), guarded.replace('  if (!xs.length) return 0;\n', ''));
  const before = await review(await collect({ repo: repo.root }), fixtureEvaluator());
  repo.git('mv', 'stats.ts', 'mean.ts');
  const renamed = await review(await collect({ repo: repo.root }), fixtureEvaluator());
  assert.equal(renamed.decisions[0]!.previousPath, 'stats.ts');
  assert.deepEqual(compare(before, renamed).map(({ path, currentPath, status }) => ({ path, currentPath, status })),
    [{ path: 'stats.ts', currentPath: 'mean.ts', status: 'still_present' }]);

  await writeFile(join(repo.root, 'mean.ts'), guarded.replace('  if (!xs.length) return 0;\n', '').replace('/ xs.length', '/ Math.max(xs.length, 1)'));
  const edited = await review(await collect({ repo: repo.root }), fixtureEvaluator());
  assert.equal(edited.decisions[0]!.previousPath, 'stats.ts');
  assert.deepEqual(compare(before, edited).map(item => [item.path, item.status]), [['stats.ts', 'not_reassessed'], ['mean.ts', 'newly_supported']]);
});

/** One changed file and one candidate per packet, so each packet is one provider request. */
function packetPlan(count: number): ReviewPlan {
  const plan = planFor();
  const template = plan.candidates[0]!;
  plan.sources = []; plan.candidates = []; plan.packets = [];
  for (let index = 0; index < count; index++) {
    const path = `ratio-${index}.ts`;
    plan.sources.push({ path, content: `export const ratio${index} = (a: number, b: number) => a / b;`, role: 'changed' });
    plan.candidates.push({ ...template, id: `candidate-${index}`, path });
    plan.packets.push({ id: `packet-${index}`, changedPaths: [path], sourcePaths: [path], candidateIds: [`candidate-${index}`], limitations: [] });
  }
  return plan;
}

const packetOf = (state: unknown) => Number((state as { packetId: string }).packetId.replace('packet-', ''));

test('keeps provider requests in flight within the configured limit', async () => {
  const plan = packetPlan(9);
  for (const [concurrency, expected] of [[1, 1], [3, 3], [undefined, 4]] as const) {
    let active = 0; let peak = 0;
    const report = await reviewAll(plan, { async evaluate(_state, questions) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return typedFixture(questions);
    } }, { concurrency });
    assert.equal(peak, expected, `limit ${concurrency ?? 'default'}`);
    assert.equal(report.usage.requests, 9);
  }
  await assert.rejects(reviewAll(plan, fixtureEvaluator(), { concurrency: 0 }), /positive whole number/);
});

test('a review over its request budget is refused before any provider request, and the estimate matches a review within it', async () => {
  // Twelve candidates split the first packet into two requests, so the estimate counts requests, not packets.
  const plan = packetPlan(3);
  const extra = Array.from({ length: 11 }, (_, index) => ({ ...plan.candidates[0]!, id: `candidate-0-${index}` }));
  plan.candidates.push(...extra);
  plan.packets[0]!.candidateIds.push(...extra.map(candidate => candidate.id));
  const estimate = estimateReview(plan);
  assert.equal(estimate.requests, 4);
  let calls = 0;
  const counting: TypedEvaluator = { async evaluate(_state, questions) { calls++; return typedFixture(questions); } };
  await assert.rejects(reviewAll(plan, counting, { maxRequests: estimate.requests - 1 }),
    new RegExp(`^Error: Review would make ${estimate.requests} provider requests, over the budget of ${estimate.requests - 1}`));
  assert.equal(calls, 0);
  const report = await reviewAll(plan, counting, { maxRequests: estimate.requests });
  assert.equal(report.usage.requests, estimate.requests);
  assert.equal(calls, estimate.requests);
});

test('a concurrent review matches the sequential review apart from timings', async () => {
  const plan = packetPlan(6);
  // Later packets answer first, with distinct usage and verdicts, so completion order differs from plan order.
  const evaluator: TypedEvaluator = { async evaluate(state, questions) {
    const packet = packetOf(state);
    await new Promise(resolve => setTimeout(resolve, (6 - packet) * 3));
    const response = await typedFixture(questions);
    response.usage = { input_tokens: 100 + packet, output_tokens: 10 * packet };
    const assessment = response.answers[`candidate-${packet}_assessment`];
    if (packet % 2 && assessment?.type === 'choice') assessment.choice = 'not_supported';
    return response;
  } };
  const normalized = (report: Report) => ({ ...report, id: '', createdAt: '', usage: { ...report.usage, elapsedMs: 0 },
    packetQualities: report.packetQualities?.map(packet => ({ ...packet, evaluation: { ...packet.evaluation, usage: { ...packet.evaluation.usage, elapsedMs: 0 } } })) });
  const sequential = await reviewAll(plan, evaluator, { concurrency: 1 });
  const concurrent = await reviewAll(plan, evaluator, { concurrency: 4 });
  assert.deepEqual(normalized(concurrent), normalized(sequential));
  assert.deepEqual(concurrent.decisions.map(decision => decision.id), plan.candidates.map(candidate => candidate.id));
  assert.equal(concurrent.usage.inputTokens, 615);
});

test('a failed request leaves an inconclusive report that keeps other decisions and names the unevaluated work', async () => {
  const plan = packetPlan(3);
  const failing: TypedEvaluator = { async evaluate(state, questions) {
    if (packetOf(state) === 1) throw new Error('Jev request failed (HTTP 500); no successful review was recorded.');
    return typedFixture(questions);
  } };
  const report = await reviewAll(plan, failing);
  reportSchema.parse(report);
  assert.equal(report.status, 'inconclusive');
  assert.ok(isIncomplete(report));
  assert.deepEqual(report.decisions.map(decision => [decision.id, decision.status]), [['candidate-0', 'supported'], ['candidate-2', 'supported']]);
  assert.deepEqual(report.packetQualities?.map(packet => packet.packetId), ['packet-0', 'packet-2']);
  assert.equal(report.usage.requests, 2);
  const [limitation] = report.limitations.filter(value => value.startsWith('Review incomplete'));
  assert.match(limitation!, /packet packet-1 \(ratio-1\.ts\): Jev request failed \(HTTP 500\)/);
  assert.match(limitation!, /Not evaluated: source check candidate-1 \(.+ at ratio-1\.ts:\d+-\d+\); the broad quality review\.$/);
  assert.match(render(report), /Review incomplete for packet packet-1/);

  // Source-check-only reviews share the loop and the same guarantee.
  const sourceOnly = await review(plan, { async evaluate(state, questions) {
    if (packetOf(state) === 1) throw new Error('Jev request failed (network error); no successful review was recorded.');
    return fixtureEvaluator('not_supported').evaluate(state, questions);
  } });
  assert.equal(sourceOnly.status, 'inconclusive');
  assert.equal(sourceOnly.decisions.length, 2);

  // With nothing completed there is no partial report: the provider's error is the result.
  await assert.rejects(reviewAll(plan, { async evaluate() { throw new Error('Jev request failed (HTTP 401); no successful review was recorded.'); } }), /HTTP 401/);
});

test('a partial multi-packet report counts every packet, lists the unevaluated work first, and nests its headings', async () => {
  const report = await reviewAll(packetPlan(3), { async evaluate(state, questions) {
    if (packetOf(state) === 1) throw new Error('Jev request failed (HTTP 500); no successful review was recorded.');
    return typedFixture(questions);
  } });
  const markdown = render(report);
  assert.match(markdown, /^\*\*inconclusive\*\* · 3 packets, 1 incomplete · /m);
  const headings = [...markdown.matchAll(/^(#+) (.+)$/gm)].map(match => ({ level: match[1]!.length, text: match[2]! }));
  assert.equal(headings[0]!.level, 1);
  for (const [index, heading] of headings.entries()) {
    if (index) assert.ok(heading.level <= headings[index - 1]!.level + 1, `${heading.text} skips a level after ${headings[index - 1]!.text}`);
  }
  assert.deepEqual(headings.filter(heading => heading.text === 'Quality dimensions').map(heading => heading.level), [4, 4]);
  const position = (text: string) => headings.findIndex(heading => heading.text === text);
  assert.ok(position('Incomplete review') > 0 && position('Incomplete review') < position('Packet broad reviews'));
  assert.ok(position('Packet broad reviews') < position('Source-anchored findings'));
  // The unevaluated work is listed once, in its own section, not again among the coverage gaps.
  assert.equal(markdown.split('Review incomplete for packet packet-1').length, 2);
  assert.ok(markdown.indexOf('Review incomplete for packet packet-1') < markdown.indexOf('## Packet broad reviews'));
});

test('cancellation aborts every in-flight request and starts no further request', async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const pending = reviewAll(packetPlan(9), { evaluate(_state, _questions, signal) {
    signals.push(signal!);
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  } }, { signal: controller.signal, concurrency: 3 });
  assert.equal(signals.length, 3);
  controller.abort(new Error('Review timed out after 5 ms.'));
  await assert.rejects(pending, { message: 'Review timed out after 5 ms.' });
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
});

test('planning serializes each part of a near-limit packet once rather than per shrink step', async () => {
  const plan = planFor();
  plan.sources[0]!.content = `export const evidence = '${'x'.repeat(78_000)}';`;
  plan.candidates = Array.from({ length: 34 }, (_, index) => ({ ...plan.candidates[0]!, id: `candidate-${index}`, hypothesis: 'detail '.repeat(600) }));
  plan.packets[0]!.candidateIds = plan.candidates.map(candidate => candidate.id);
  const requests: Array<{ state: unknown; questions: unknown }> = [];
  const stringify = JSON.stringify;
  let serialized = 0;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    const text = stringify(...args);
    serialized += text?.length ?? 0;
    return text;
  }) as typeof stringify;
  try {
    await reviewAll(plan, { async evaluate(state, questions) { requests.push({ state, questions }); return typedFixture(questions); } });
  } finally { JSON.stringify = stringify; }
  const sent = requests.reduce((total, request) => total + JSON.stringify(request).length, 0);
  assert.ok(requests.length > 3);
  // Re-serializing the packet for every candidate batch size costs several times the bytes actually sent.
  assert.ok(serialized < sent, `${serialized} bytes serialized for ${sent} bytes sent`);
});
