import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jev } from '../src/jev.js';
import { questionsFor } from '../src/review.js';
import { fixtureEvaluator, planFor } from './helpers.js';

test('sends a single typed batch and validates responses', async () => {
  const plan = planFor(); const questions = questionsFor(plan.candidates[0]!);
  const response = await fixtureEvaluator().evaluate({}, questions);
  let count = 0;
  const client = new Jev({ apiKey: 'fixture-key', model: 'test-model', fetch: async (url, options) => {
    count++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(JSON.parse(options!.body as string).model, 'test-model');
    assert.deepEqual(JSON.parse(options!.body as string).questions, questions);
    return Response.json(response);
  } });
  await client.evaluate({}, questions); assert.equal(count, 1);
  delete response.answers[Object.keys(questions)[0]!];
  await assert.rejects(client.evaluate({}, questions), /incomplete or invalid/);
});

test('does not echo server bodies or retry authentication errors', async () => {
  let count = 0;
  const client = new Jev({ apiKey: 'fixture-key', fetch: async () => { count++; return new Response('private source and credentials', { status: 401 }); } });
  await assert.rejects(client.evaluate({}, {}), error => error instanceof Error && error.message.includes('401') && !error.message.includes('private'));
  assert.equal(count, 1);
});

test('honors bounded Retry-After and rejects unknown selected options', async () => {
  let count = 0;
  const plan = planFor(); const questions = questionsFor(plan.candidates[0]!);
  const response = await fixtureEvaluator().evaluate({}, questions);
  const client = new Jev({ apiKey: 'fixture-key', fetch: async () => ++count === 1
    ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : Response.json(response) });
  await client.evaluate({}, questions); assert.equal(count, 2);
  response.answers[Object.keys(questions)[0]!]!.choice = 'invented';
  await assert.rejects(client.evaluate({}, questions), /invalid decision/);
});

test('validates native Noul and Score responses and catches out-of-rubric scores', async () => {
  const { qualityQuestions } = await import('../src/quality.js');
  const { typedFixture } = await import('./helpers.js');
  const questions = qualityQuestions();
  const data = await typedFixture(questions);
  const client = new Jev({ apiKey: 'fixture-key', fetch: async () => Response.json(data) });
  const response = await client.evaluate({}, questions);
  assert.equal(response.answers.quality_security_applicability?.type, 'noul');
  const score = data.answers.quality_security_score;
  if (score?.type !== 'score') throw new Error('Fixture score missing');
  score.score = 10;
  await assert.rejects(client.evaluate({}, questions), /invalid decision/);
});

test('turns the provider context-limit code into actionable scope guidance', async () => {
  const client = new Jev({ apiKey: 'fixture-key', fetch: async () => Response.json({ detail: { error_type: 'max_tokens_exceeded', secret: 'must not be echoed' } }, { status: 400 }) });
  await assert.rejects(client.evaluate({}, {}), error => error instanceof Error && /Split the review/.test(error.message) && !/echoed/.test(error.message));
});
