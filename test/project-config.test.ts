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
  for (const field of ['apiKey', 'OPENROUTER_API_KEY', 'token']) {
    assert.throws(() => parseProjectConfig(JSON.stringify({ [field]: 'value-that-must-not-leak' })),
      error => error instanceof Error && error.message.includes(`"${field}" looks like a credential`) && !error.message.includes('must-not-leak'));
  }
  assert.throws(() => parseProjectConfig(JSON.stringify({ task: `Use sk-proj-${'a'.repeat(40)}` })), /"task" contains a potential credential/);
  assert.throws(() => parseProjectConfig('{"base": HEAD}'), error => error instanceof Error && error.message === '.tracecheck.json is not valid JSON.');
});

test('flags override the configuration file per key, and the environment overrides its provider settings', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, '.tracecheck.json'), JSON.stringify({ base: 'main', includeUntracked: true, task: 'File task',
    collection: { maxIndexFiles: 7, indexTimeoutMs: 5_000 }, reviewTimeoutMs: 60_000, model: 'jev-file', requestTimeoutMs: 9_000, requestConcurrency: 2 }));
  const fromFile = await resolveSettings(repo.root, {});
  assert.deepEqual({ ...fromFile.request, projectConfig: undefined }, { base: 'main', includeUntracked: true, task: 'File task',
    repositoryContext: undefined, collection: { maxIndexFiles: 7, indexTimeoutMs: 5_000 }, projectConfig: undefined });
  assert.equal(fromFile.reviewTimeoutMs, 60_000);
  const flagged = await resolveSettings(repo.root, { base: 'HEAD', includeUntracked: false, task: 'Flag task',
    collection: { maxIndexFiles: 2, maxIndexBytes: undefined }, reviewTimeoutMs: 1_000 });
  assert.equal(flagged.request.base, 'HEAD'); assert.equal(flagged.request.includeUntracked, false); assert.equal(flagged.request.task, 'Flag task');
  assert.deepEqual(flagged.request.collection, { maxIndexFiles: 2, indexTimeoutMs: 5_000 });
  assert.equal(flagged.reviewTimeoutMs, 1_000);
  const file = jevSettings({}, fromFile.provider);
  assert.deepEqual([file.model, file.timeoutMs, file.concurrency], ['jev-file', 9_000, 2]);
  const environment = jevSettings({ JEV_MODEL: 'jev-env', JEV_TIMEOUT_MS: '3000', JEV_CONCURRENCY: '6' }, fromFile.provider);
  assert.deepEqual([environment.model, environment.timeoutMs, environment.concurrency], ['jev-env', 3_000, 6]);
});

test('MCP preview applies the bound repository configuration and review rejects a snapshot after the file changes', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }\n');
  repo.git('-c', 'commit.gpgsign=false', 'commit', '-am', 'Drop the empty guard');
  const config = join(repo.root, '.tracecheck.json');
  await writeFile(config, JSON.stringify({ base: 'HEAD~1', task: 'Configured task text' }));
  const states: unknown[] = [];
  const server = createServer(repo.root, () => ({ async evaluate(state, questions) { states.push(state); return typedFixture(questions); } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'config-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const previewSchema = z.object({ snapshot: z.string(), packets: z.array(z.object({ changedPaths: z.array(z.string()) })) });

  const explicit = previewSchema.parse((await client.callTool({ name: 'tracecheck_preview', arguments: { base: 'HEAD' } })).structuredContent);
  assert.deepEqual(explicit.packets.flatMap(packet => packet.changedPaths), []);
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  const configured = previewSchema.parse(preview.structuredContent);
  assert.deepEqual(configured.packets.flatMap(packet => packet.changedPaths), ['average.ts']);

  const review = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: configured.snapshot } });
  assert.ok(!review.isError, JSON.stringify(review));
  assert.ok(states.length > 0 && states.every(state => JSON.stringify(state).includes('Configured task text')));

  await writeFile(config, JSON.stringify({ base: 'HEAD~1', task: 'Configured task text', model: 'jev-other' }));
  const stale = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: configured.snapshot } });
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /changed since preview/);
  await writeFile(config, '{"apiKey":"x"}');
  const rejected = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /\\"apiKey\\" looks like a credential/);
});
