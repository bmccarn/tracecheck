import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jev, jevSettings, providerEnvironment } from '../src/jev.js';
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

test('selects TypeSafe or OpenRouter from the configured credentials', () => {
  assert.deepEqual(jevSettings({ OPENROUTER_API_KEY: 'or-key' }), { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api', model: 'jev-latest' });
  // A TypeSafe key wins when both are present, and keeps the TypeSafe endpoint.
  assert.deepEqual(jevSettings({ TYPESAFE_API_KEY: 'ts-key', OPENROUTER_API_KEY: 'or-key' }), { apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' });
  assert.equal(jevSettings({ JEV_API_KEY: ' jev-key ', TYPESAFE_API_KEY: 'ts-key' }).apiKey, 'jev-key');
  // OpenRouter's documented setup reuses TYPESAFE_API_KEY with an explicit base URL.
  assert.deepEqual(jevSettings({ TYPESAFE_API_KEY: 'or-key', TYPESAFE_BASE_URL: 'https://openrouter.ai/api', JEV_MODEL: 'jev-1.13' }),
    { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api', model: 'jev-1.13' });
  assert.deepEqual(providerEnvironment({ OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: '', HOME: '/home/user' }), { OPENROUTER_API_KEY: 'or-key' });
});

test('sends requests to the OpenRouter System One endpoint and accepts its extra response fields', async () => {
  const plan = planFor(); const questions = questionsFor(plan.candidates[0]!);
  const response = await fixtureEvaluator().evaluate({}, questions);
  const client = new Jev({ ...jevSettings({ OPENROUTER_API_KEY: 'or-key' }), fetch: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/systemone');
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer or-key');
    return Response.json({ ...response, id: 'gen-dec-1', provider: 'TypeSafe', model: 'typesafe/jev-1.13-20260917', usage: { ...response.usage, cost: 0.00002 } });
  } });
  const result = await client.evaluate({}, questions);
  assert.equal(result.model, 'typesafe/jev-1.13-20260917');
  assert.equal(new Jev({ apiKey: 'key', baseUrl: 'http://localhost:8080/proxy/' }).endpoint, 'http://localhost:8080/proxy/v1/systemone');
});

test('refuses base URLs that would expose the API key', () => {
  assert.throws(() => new Jev({ apiKey: 'key', baseUrl: 'http://openrouter.ai/api' }), /HTTPS/);
  assert.throws(() => new Jev({ apiKey: 'key', baseUrl: 'https://user:pass@example.com' }), /credentials/);
  assert.throws(() => new Jev({ apiKey: 'key', baseUrl: 'https://openrouter.ai/api/alpha/decisions#' }), /fragment/);
  assert.throws(() => new Jev({ apiKey: 'key', baseUrl: 'openrouter.ai/api' }), /absolute URL/);
});
