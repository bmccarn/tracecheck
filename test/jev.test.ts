import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jev, jevSettings, providerEnvironment } from '../src/jev.js';
import { deadline } from '../src/deadline.js';
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
  // OpenRouter relays the same code inside its own envelope (body captured from a live over-limit request).
  const relayed = new Jev({ apiKey: 'fixture-key', baseUrl: 'https://openrouter.ai/api', fetch: async () => Response.json({ error: { message: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}', code: 400 } }, { status: 400 }) });
  await assert.rejects(relayed.evaluate({}, {}), /Split the review/);
  const other = new Jev({ apiKey: 'fixture-key', fetch: async () => Response.json({ error: { message: 'Invalid request parameters', code: 400 } }, { status: 400 }) });
  await assert.rejects(other.evaluate({}, {}), error => error instanceof Error && /HTTP 400/.test(error.message) && !/Invalid request/.test(error.message));
});

test('selects TypeSafe or OpenRouter from the configured credentials', () => {
  assert.deepEqual(jevSettings({ OPENROUTER_API_KEY: 'or-key' }), { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api', model: 'jev-latest', timeoutMs: 45_000 });
  // A TypeSafe key wins when both are present, and keeps the TypeSafe endpoint.
  assert.deepEqual(jevSettings({ TYPESAFE_API_KEY: 'ts-key', OPENROUTER_API_KEY: 'or-key' }), { apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 45_000 });
  assert.equal(jevSettings({ JEV_API_KEY: ' jev-key ', TYPESAFE_API_KEY: 'ts-key' }).apiKey, 'jev-key');
  // OpenRouter's documented setup reuses TYPESAFE_API_KEY with an explicit base URL.
  assert.deepEqual(jevSettings({ TYPESAFE_API_KEY: 'or-key', TYPESAFE_BASE_URL: 'https://openrouter.ai/api', JEV_MODEL: 'jev-1.13', JEV_TIMEOUT_MS: '120000' }),
    { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api', model: 'jev-1.13', timeoutMs: 120_000 });
  assert.deepEqual(providerEnvironment({ OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: '', JEV_TIMEOUT_MS: '5000', HOME: '/home/user' }),
    { OPENROUTER_API_KEY: 'or-key', JEV_TIMEOUT_MS: '5000' });
  for (const value of ['0', '-1', '1.5', '10s', '3600001']) assert.throws(() => jevSettings({ JEV_TIMEOUT_MS: value }), /JEV_TIMEOUT_MS/);
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

async function choiceFixture() {
  const plan = planFor(); const questions = questionsFor(plan.candidates[0]!);
  return { questions, response: await fixtureEvaluator().evaluate({}, questions) };
}

/** A fetch that never answers and rejects with a generic abort once its signal fires, as fetch does. */
const hangingFetch = (onCall: () => void) => (async (_url: unknown, options?: RequestInit) => {
  onCall();
  return new Promise<globalThis.Response>((_, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError'))));
}) as typeof fetch;

test('retries server errors and gives up after three attempts', async () => {
  const { questions, response } = await choiceFixture();
  let count = 0;
  const recovers = new Jev({ apiKey: 'fixture-key', fetch: async () => ++count < 3
    ? new Response('', { status: 503, headers: { 'retry-after': '0' } }) : Response.json(response) });
  await recovers.evaluate({}, questions); assert.equal(count, 3);
  count = 0;
  const failing = new Jev({ apiKey: 'fixture-key', fetch: async () => { count++; return new Response('private', { status: 500, headers: { 'retry-after': '0' } }); } });
  await assert.rejects(failing.evaluate({}, questions), error => error instanceof Error && /HTTP 500/.test(error.message) && !/private/.test(error.message));
  assert.equal(count, 3);
});

test('honors Retry-After as an HTTP date and refuses delays above 10 seconds', async () => {
  const { questions, response } = await choiceFixture();
  const retryAfter = (value: string) => {
    let count = 0;
    const client = new Jev({ apiKey: 'fixture-key', fetch: async () => ++count === 1
      ? new Response('', { status: 429, headers: { 'retry-after': value } }) : Response.json(response) });
    return { run: () => client.evaluate({}, questions), calls: () => count };
  };
  const past = retryAfter(new Date(Date.now() - 60_000).toUTCString());
  await past.run(); assert.equal(past.calls(), 2);
  for (const value of ['11', new Date(Date.now() + 60_000).toUTCString()]) {
    const long = retryAfter(value);
    await assert.rejects(long.run(), /longer retry delay/);
    assert.equal(long.calls(), 1);
  }
});

test('retries network failures and reports them without provider detail', async () => {
  const { questions, response } = await choiceFixture();
  let count = 0;
  const recovers = new Jev({ apiKey: 'fixture-key', fetch: async () => {
    if (++count === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    return Response.json(response);
  } });
  await recovers.evaluate({}, questions); assert.equal(count, 2);
  count = 0;
  const failing = new Jev({ apiKey: 'fixture-key', fetch: async () => { count++; throw new TypeError('fetch failed'); } });
  await assert.rejects(failing.evaluate({}, questions), { message: 'Jev request failed (network error); no successful review was recorded.' });
  assert.equal(count, 3);
});

test('propagates the caller abort reason without retrying', async () => {
  const { questions } = await choiceFixture();
  const reason = new Error('caller stopped');
  let count = 0;
  const inFlight = new AbortController();
  const client = new Jev({ apiKey: 'fixture-key', signal: inFlight.signal, fetch: hangingFetch(() => { count++; setTimeout(() => inFlight.abort(reason), 10); }) });
  await assert.rejects(client.evaluate({}, questions), error => error === reason);
  assert.equal(count, 1);
  // An abort during a retry delay also stops at once with the caller's reason.
  count = 0;
  const waiting = new AbortController();
  const delayed = new Jev({ apiKey: 'fixture-key', signal: waiting.signal, fetch: async () => {
    count++; setTimeout(() => waiting.abort(reason), 10);
    return new Response('', { status: 503, headers: { 'retry-after': '5' } });
  } });
  const started = Date.now();
  await assert.rejects(delayed.evaluate({}, questions), error => error === reason);
  assert.equal(count, 1);
  assert.ok(Date.now() - started < 2_000);
});

test('names the per-request and overall timeouts with their durations', async () => {
  const { questions } = await choiceFixture();
  let count = 0;
  const perRequest = new Jev({ apiKey: 'fixture-key', timeoutMs: 20, fetch: hangingFetch(() => count++) });
  await assert.rejects(perRequest.evaluate({}, questions), /Jev request timed out after 20 ms\. Set JEV_TIMEOUT_MS/);
  assert.equal(count, 1);
  const overall = new Jev({ apiKey: 'fixture-key', signal: deadline(20, 'Review timed out after 20 ms.'), fetch: hangingFetch(() => {}) });
  await assert.rejects(overall.evaluate({}, questions), { message: 'Review timed out after 20 ms.' });
});

test('rejects answers whose probabilities do not sum to one', async () => {
  const { questions, response } = await choiceFixture();
  const client = new Jev({ apiKey: 'fixture-key', fetch: async () => Response.json(response) });
  await client.evaluate({}, questions);
  const answer = response.answers[Object.keys(questions)[0]!]!;
  const [first] = Object.keys(answer.probabilities);
  answer.probabilities[first!] = answer.probabilities[first!]! + 0.05;
  await assert.rejects(client.evaluate({}, questions), /invalid decision/);
});

test('refuses requests over the local size budget before sending', async () => {
  let count = 0;
  const client = new Jev({ apiKey: 'fixture-key', fetch: async () => { count++; throw new Error('Must not send'); } });
  await assert.rejects(client.evaluate({ files: [{ content: 'x'.repeat(180_001) }] }, {}), /180 KB request budget/);
  assert.equal(count, 0);
});
