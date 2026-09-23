import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createServer } from '../src/mcp.js';
import { jevSettings } from '../src/jev.js';
import { parseProjectConfig, resolveSettings } from '../src/project-config.js';
import { repository, typedFixture } from './helpers.js';

test('configuration file errors name the offending key without quoting values', () => {
  assert.throws(() => parseProjectConfig('{"collection":{"maxIndexFile":5}}'), /unknown key "collection\.maxIndexFile"/);
  assert.throws(() => parseProjectConfig('{"baseUrl":"https://example.invalid"}'), /unknown key "baseUrl"/);
  assert.throws(() => parseProjectConfig('{"includeUntracked":"yes"}'), /"includeUntracked": .*expected boolean/i);
  assert.throws(() => parseProjectConfig('{"collection":{"indexTimeoutMs":0}}'), /"collection\.indexTimeoutMs"/);
  for (const field of ['apiKey', 'apiToken', 'OPENROUTER_API_KEY', 'token', 'secret', 'password', 'authToken']) {
    assert.throws(() => parseProjectConfig(JSON.stringify({ [field]: 'value-that-must-not-leak' })),
      error => error instanceof Error && error.message.includes(`"${field}" looks like a credential`) && !error.message.includes('must-not-leak'));
  }
  assert.throws(() => parseProjectConfig(JSON.stringify({ task: `Use sk-proj-${'a'.repeat(40)}` })), /"task" contains a potential credential/);
  assert.throws(() => parseProjectConfig('{"base": HEAD}'), error => error instanceof Error && error.message === '.tracecheck.json is not valid JSON.');
  // Credential words match whole words and camelCase segments, not substrings.
  for (const field of ['maxTokens', 'keyboardLayout', 'monkey']) {
    assert.throws(() => parseProjectConfig(JSON.stringify({ [field]: 1 })), error => error instanceof Error
      && error.message === `.tracecheck.json: unknown key "${field}".`);
  }
});

test('the configuration file may restate or lower a default but never go beyond one', () => {
  assert.deepEqual(parseProjectConfig(JSON.stringify({ base: 'HEAD', includeUntracked: false, requestConcurrency: 4, maxRequests: 50,
    reviewTimeoutMs: 300_000, requestTimeoutMs: 1_000, collection: { maxIndexFiles: 10_000, indexTimeoutMs: 20_000, collectionTimeoutMs: 1 } })).maxRequests, 50);
  const beyond = { base: 'HEAD~1', includeUntracked: true, requestConcurrency: 16, maxRequests: 51, reviewTimeoutMs: 3_600_000,
    requestTimeoutMs: 45_001, collection: { indexTimeoutMs: 20_001, collectionTimeoutMs: 120_001 } };
  assert.throws(() => parseProjectConfig(JSON.stringify(beyond)), error => {
    assert.ok(error instanceof Error);
    const expected = [
      '"base" may only be the default "HEAD"; use --base or the MCP base argument to change it',
      '"includeUntracked" may only be the default false; use --include-untracked or the MCP includeUntracked argument to change it',
      '"collection.indexTimeoutMs" may not exceed the default of 20000; use --index-timeout-ms or the MCP collection argument to raise it',
      '"collection.collectionTimeoutMs" may not exceed the default of 120000; use --collection-timeout-ms or the MCP collection argument to raise it',
      '"reviewTimeoutMs" may not exceed the default of 300000; use --review-timeout-ms or the MCP reviewTimeoutMs argument to raise it',
      '"requestTimeoutMs" may not exceed the default of 45000; use JEV_TIMEOUT_MS to raise it',
      '"requestConcurrency" may not exceed the default of 4; use JEV_CONCURRENCY to raise it',
      '"maxRequests" may not exceed the default of 50; use --max-requests or the MCP maxRequests argument to raise it',
    ];
    assert.equal(error.message, `.tracecheck.json: ${expected.join('; ')}.`);
    assert.ok(!error.message.includes('HEAD~1'));
    return true;
  });
});

test('flags override the configuration file per key, and the environment overrides its provider settings', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, '.tracecheck.json'), JSON.stringify({ task: 'File task', repositoryContext: 'File context',
    collection: { maxIndexFiles: 7, indexTimeoutMs: 5_000 }, reviewTimeoutMs: 60_000, model: 'jev-file', requestTimeoutMs: 9_000, requestConcurrency: 2, maxRequests: 10 }));
  const fromFile = await resolveSettings(repo.root, {});
  assert.deepEqual({ ...fromFile.request, projectConfig: undefined }, { base: 'HEAD', includeUntracked: false, task: 'File task',
    repositoryContext: 'File context', collection: { maxIndexFiles: 7, indexTimeoutMs: 5_000 }, projectConfig: undefined });
  assert.equal(fromFile.reviewTimeoutMs, 60_000); assert.equal(fromFile.maxRequests, 10);
  assert.deepEqual(fromFile.settingsFileNotes, ['Task from the repository settings file .tracecheck.json: File task',
    'Repository context from the repository settings file .tracecheck.json: File context']);
  const flagged = await resolveSettings(repo.root, { base: 'HEAD~1', includeUntracked: true, task: 'Flag task',
    collection: { maxIndexFiles: 2, maxIndexBytes: undefined }, reviewTimeoutMs: 1_000, maxRequests: 500 });
  assert.equal(flagged.request.base, 'HEAD~1'); assert.equal(flagged.request.includeUntracked, true); assert.equal(flagged.request.task, 'Flag task');
  assert.deepEqual(flagged.request.collection, { maxIndexFiles: 2, indexTimeoutMs: 5_000 });
  assert.equal(flagged.reviewTimeoutMs, 1_000); assert.equal(flagged.maxRequests, 500);
  assert.deepEqual(flagged.settingsFileNotes, ['Repository context from the repository settings file .tracecheck.json: File context']);
  const file = jevSettings({}, fromFile.provider);
  assert.deepEqual([file.model, file.timeoutMs, file.concurrency], ['jev-file', 9_000, 2]);
  const environment = jevSettings({ JEV_MODEL: 'jev-env', JEV_TIMEOUT_MS: '3000', JEV_CONCURRENCY: '6' }, fromFile.provider);
  assert.deepEqual([environment.model, environment.timeoutMs, environment.concurrency], ['jev-env', 3_000, 6]);
});

test('MCP preview applies the bound repository configuration, review enforces its request budget, and rejects a snapshot after the file changes', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  // Eleven divisions are more candidates than one request carries, so the review needs at least two requests.
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }\n'
    + Array.from({ length: 10 }, (_, index) => `export function ratio${index}(a: number, b: number) { return a / b; }\n`).join(''));
  repo.git('-c', 'commit.gpgsign=false', 'commit', '-am', 'Drop the empty guard');
  const config = join(repo.root, '.tracecheck.json');
  await writeFile(config, JSON.stringify({ task: 'Configured task text', collection: { indexTimeoutMs: 10_000 } }));
  const states: unknown[] = [];
  const server = createServer(repo.root, () => ({ async evaluate(state, questions) { states.push(state); return typedFixture(questions); } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'config-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const previewSchema = z.object({ snapshot: z.string(), packets: z.array(z.object({ changedPaths: z.array(z.string()) })),
    estimate: z.object({ requests: z.number(), inputBytes: z.number() }) });

  const unchanged = previewSchema.parse((await client.callTool({ name: 'tracecheck_preview', arguments: {} })).structuredContent);
  assert.deepEqual(unchanged.packets.flatMap(packet => packet.changedPaths), []);
  assert.deepEqual(unchanged.estimate, { requests: 0, inputBytes: 0 });
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: { base: 'HEAD~1' } });
  const configured = previewSchema.parse(preview.structuredContent);
  assert.deepEqual(configured.packets.flatMap(packet => packet.changedPaths), ['average.ts']);
  assert.ok(configured.estimate.requests >= 2 && configured.estimate.inputBytes > 0);

  const overBudget = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: configured.snapshot, base: 'HEAD~1', maxRequests: configured.estimate.requests - 1 } });
  assert.equal(overBudget.isError, true);
  assert.match(JSON.stringify(overBudget), new RegExp(`Review would make ${configured.estimate.requests} provider requests, over the budget of ${configured.estimate.requests - 1}`));
  assert.equal(states.length, 0);

  const review = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: configured.snapshot, base: 'HEAD~1' } });
  assert.ok(!review.isError, JSON.stringify(review));
  assert.equal(states.length, configured.estimate.requests);
  assert.equal(z.object({ report: z.object({ usage: z.object({ requests: z.number() }) }) }).parse(review.structuredContent).report.usage.requests, states.length);
  assert.ok(states.every(state => JSON.stringify(state).includes('Configured task text')));
  // The label is for the reviewer; the provider sees the task only as the task.
  assert.ok(states.every(state => !JSON.stringify(state).includes('repository settings file')));
  const label = 'Task from the repository settings file .tracecheck.json: Configured task text';
  assert.deepEqual(z.object({ notes: z.array(z.string()) }).parse(preview.structuredContent).notes, [label]);
  assert.deepEqual(z.object({ report: z.object({ notes: z.array(z.string()) }) }).parse(review.structuredContent).report.notes, [label]);

  await writeFile(config, JSON.stringify({ task: 'Configured task text', collection: { indexTimeoutMs: 10_000 }, model: 'jev-other' }));
  const stale = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: configured.snapshot, base: 'HEAD~1' } });
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /changed since preview/);
  await writeFile(config, '{"apiKey":"x"}');
  const rejected = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /\\"apiKey\\" looks like a credential/);
  await writeFile(config, '{"includeUntracked":true}');
  const untracked = await client.callTool({ name: 'tracecheck_preview', arguments: { includeUntracked: false } });
  assert.equal(untracked.isError, true); assert.match(JSON.stringify(untracked), /\\"includeUntracked\\" may only be the default false/);
});
