import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { createServer, ExpiringCache } from '../src/mcp.js';
import { qualityEvaluationSchema } from '../src/quality.js';
import type { TypedEvaluator } from '../src/domain.js';
import { repository, typedFixture } from './helpers.js';

async function connect(t: { after: (fn: () => Promise<void>) => void }, server: ReturnType<typeof createServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tracecheck-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}

const fixtureEvaluator: TypedEvaluator = { evaluate: async (_state, questions) => typedFixture(questions) };

test('MCP v2 stdio handshake, schemas, preview and stale-snapshot rejection', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(resolve(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.length / 0; }');
  const client = new Client({ name: 'tracecheck-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp', '--repo', repo.root], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['tracecheck_assess', 'tracecheck_preview', 'tracecheck_review', 'tracecheck_verify']);
  assert.ok(tools.every(tool => tool.outputSchema));
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  assert.ok(!preview.isError);
  const data = preview.structuredContent as { snapshot: string; candidates: number; packets: { id: string; changedPaths: string[] }[] };
  assert.equal(data.candidates, 1); assert.equal(data.packets.length, 1);
  const missing = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: '0'.repeat(64) } });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing), /unknown or expired.*tracecheck_preview/i);
  await writeFile(resolve(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.length / 2; }');
  const stale = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: data.snapshot } });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /changed since preview/);
});

test('MCP validates bounded collection settings, pins preview discovery, and reviews every change packet', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await mkdir(join(repo.root, 'changes'), { recursive: true });
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index};\n`);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Packet fixture');
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index + 1};\n`);
  let calls = 0;
  const server = createServer(repo.root, () => ({ async evaluate(_state, questions) { calls++; return typedFixture(questions); } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'packet-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);

  const invalid = await client.callTool({ name: 'tracecheck_preview', arguments: { collection: { maxIndexFiles: 0 } } });
  assert.equal(invalid.isError, true);
  const collection = { maxIndexFiles: 1, maxIndexBytes: 1_000_000, indexTimeoutMs: 10_000, collectionTimeoutMs: 30_000 };
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: { collection } });
  assert.ok(!preview.isError, JSON.stringify(preview));
  const metadata = z.object({
    snapshot: z.string(), packets: z.array(z.object({ id: z.string(), changedPaths: z.array(z.string()) })),
    files: z.array(z.object({ path: z.string(), role: z.string(), characters: z.number() })),
    candidates: z.number(), limitations: z.array(z.string()),
  }).parse(preview.structuredContent);
  assert.equal(metadata.packets.length, 2);
  assert.deepEqual(metadata.packets.flatMap(packet => packet.changedPaths).sort(), Array.from({ length: 9 }, (_, index) => `changes/change-${index}.ts`));

  const mismatch = await client.callTool({ name: 'tracecheck_review', arguments: {
    snapshot: metadata.snapshot, collection: { ...collection, maxIndexFiles: 2 },
  } });
  assert.equal(mismatch.isError, true); assert.match(JSON.stringify(mismatch), /changed since preview/);
  const invalidTimeout = await client.callTool({ name: 'tracecheck_review', arguments: {
    snapshot: metadata.snapshot, collection, reviewTimeoutMs: 0,
  } });
  assert.equal(invalidTimeout.isError, true);
  const review = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: metadata.snapshot, collection } });
  assert.ok(!review.isError, JSON.stringify(review));
  const output = z.object({
    cached: z.boolean(),
    report: z.object({ quality: z.unknown().optional(), limitations: z.array(z.string()),
      packetQualities: z.array(z.object({ packetId: z.string(), changedPaths: z.array(z.string()), evaluation: z.unknown() })).optional() }),
  }).parse(review.structuredContent);
  assert.equal(output.cached, false); assert.equal(output.report.quality, undefined);
  assert.equal(output.report.packetQualities?.length, 2); assert.equal(calls, 2);
  const compared = await client.callTool({ name: 'tracecheck_review', arguments: {
    snapshot: metadata.snapshot, collection, previousEvaluation: output.report.packetQualities![0]!.evaluation,
  } });
  assert.ok(!compared.isError, JSON.stringify(compared));
  const repeated = z.object({ cached: z.boolean(), report: z.object({ limitations: z.array(z.string()) }) }).parse(compared.structuredContent);
  assert.equal(repeated.cached, true); assert.equal(calls, 2);
  assert.match(repeated.report.limitations.join('\n'), /single-packet quality result/);
});

test('expiring cache expires entries, purges them before insert, and evicts a live entry only for a new key', () => {
  let now = 0;
  const cache = new ExpiringCache<string>(2, 100, () => now);
  cache.set('a', 'first'); now = 50; cache.set('b', 'second');
  now = 60; cache.set('a', 'replaced');
  assert.equal(cache.get('b'), 'second', 'replacing an existing key must not evict another live entry');
  assert.equal(cache.get('a'), 'replaced');
  cache.set('c', 'third');
  assert.equal(cache.get('b'), undefined, 'a new key at the limit evicts the oldest live entry');
  assert.deepEqual([cache.get('a'), cache.get('c')], ['replaced', 'third']);
  now = 170;
  assert.equal(cache.get('a'), undefined, 'entries expire after their lifetime');
  cache.set('d', 'fourth'); now = 175; cache.set('e', 'fifth'); now = 180; cache.set('d', 'refreshed');
  assert.deepEqual([cache.get('d'), cache.get('e')], ['refreshed', 'fifth']);
  now = 277;
  cache.set('f', 'sixth');
  assert.equal(cache.get('d'), 'refreshed', 'an expired entry is purged instead of evicting a live one');
  assert.deepEqual([cache.get('e'), cache.get('f')], [undefined, 'sixth']);
});

test('a cached MCP review collects once and still compares the supplied previous evaluation', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 0;');
  const shim = await mkdtemp(join(tmpdir(), 'tracecheck-git-shim-'));
  t.after(() => rm(shim, { recursive: true, force: true }));
  const log = join(shim, 'calls.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(join(shim, 'git'), `#!/bin/sh\necho >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${shim}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const gitCalls = async () => (await readFile(log, 'utf8').catch(() => '')).length;
  let calls = 0;
  const client = await connect(t, createServer(repo.root, () => ({ async evaluate(_state, questions) { calls++; return typedFixture(questions); } })));
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  const snapshot = z.object({ snapshot: z.string() }).parse(preview.structuredContent).snapshot;
  const beforeReview = await gitCalls();
  const first = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } });
  assert.ok(!first.isError, JSON.stringify(first));
  const missCalls = await gitCalls() - beforeReview;
  const previous = qualityEvaluationSchema.parse(z.object({ report: z.object({ quality: z.unknown() }) }).parse(first.structuredContent).report.quality);
  previous.metrics.readability!.score = 4;
  const second = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot, previousEvaluation: previous } });
  assert.ok(!second.isError, JSON.stringify(second));
  const hitCalls = await gitCalls() - beforeReview - missCalls;
  const output = z.object({ cached: z.boolean(), report: z.object({ quality: qualityEvaluationSchema }) }).parse(second.structuredContent);
  assert.equal(output.cached, true); assert.equal(calls, 1);
  assert.ok(hitCalls > 0);
  // Each review first runs one Git call to locate the configuration file.
  assert.equal(missCalls - 1, 2 * (hitCalls - 1), 'a miss collects before and after inference; a hit collects once');
  assert.equal(output.report.quality.comparison.find(row => row.metric === 'readability')!.delta, 4);
});

test('an MCP review left incomplete by a failed request is not cached, so the next call asks the provider again', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  // Nine changed files exceed the eight-file packet limit, so the review has two packets.
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, `ratio${index}.ts`), `export const ratio${index} = (a: number, b: number) => a / b;\n`);
  let fail = true;
  const packets: string[] = [];
  const client = await connect(t, createServer(repo.root, () => ({ async evaluate(state, questions) {
    const packetId = (state as { packetId: string }).packetId;
    packets.push(packetId);
    if (fail && packetId === packets[0]) throw new Error('Jev request failed (HTTP 500); no successful review was recorded.');
    return typedFixture(questions);
  } })));
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: { includeUntracked: true } });
  const snapshot = z.object({ snapshot: z.string(), packets: z.array(z.unknown()).length(2) }).parse(preview.structuredContent).snapshot;
  const output = z.object({ cached: z.boolean(), report: z.object({ status: z.string(), limitations: z.array(z.string()), usage: z.object({ requests: z.number() }) }) });
  const incomplete = output.parse((await client.callTool({ name: 'tracecheck_review', arguments: { snapshot, includeUntracked: true } })).structuredContent);
  assert.equal(incomplete.cached, false); assert.equal(incomplete.report.status, 'inconclusive'); assert.equal(incomplete.report.usage.requests, 1);
  assert.equal(incomplete.report.limitations.filter(value => value.startsWith('Review incomplete for packet')).length, 1);
  fail = false;
  const retried = output.parse((await client.callTool({ name: 'tracecheck_review', arguments: { snapshot, includeUntracked: true } })).structuredContent);
  assert.equal(retried.cached, false); assert.equal(retried.report.usage.requests, 2);
  assert.ok(!retried.report.limitations.some(value => value.startsWith('Review incomplete')));
  const repeated = output.parse((await client.callTool({ name: 'tracecheck_review', arguments: { snapshot, includeUntracked: true } })).structuredContent);
  assert.equal(repeated.cached, true); assert.equal(packets.length, 4);
});

test('MCP assess uses the injected evaluator, keeps the JSON text block, and cancels with the client request', { timeout: 10_000 }, async t => {
  let hang = false;
  let evaluating!: () => void;
  const started = new Promise<void>(done => { evaluating = done; });
  let cancelled!: (reason: unknown) => void;
  const aborted = new Promise<unknown>(done => { cancelled = done; });
  const client = await connect(t, createServer(undefined, signal => ({ async evaluate(state, questions) {
    if (!hang) return fixtureEvaluator.evaluate(state, questions);
    evaluating();
    return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled(signal.reason); reject(signal.reason); }, { once: true }));
  } })));
  const input = { task: 'Return the arithmetic mean.', files: [{ path: 'mean.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }] };
  const done = await client.callTool({ name: 'tracecheck_assess', arguments: input });
  assert.ok(!done.isError, JSON.stringify(done));
  const evaluation = qualityEvaluationSchema.parse(done.structuredContent);
  assert.equal(evaluation.model, 'fixture-v1');
  const text = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(done.content)[0]!.text;
  assert.deepEqual(JSON.parse(text), done.structuredContent);

  hang = true;
  const controller = new AbortController();
  const pending = client.callTool({ name: 'tracecheck_assess', arguments: input }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.ok(await aborted, 'the evaluator observes the cancellation');
});

test('MCP verify rejects multibyte evidence over the byte budget before inference', async t => {
  let calls = 0;
  const client = await connect(t, createServer(undefined, () => ({ async evaluate(state, questions) { calls++; return fixtureEvaluator.evaluate(state, questions); } })));
  // 25,000 characters is within the per-excerpt character limit but is 75,000 UTF-8 bytes.
  const content = `const ratio = total / count;\n// ${'界'.repeat(25_000)}`;
  const response = await client.callTool({ name: 'tracecheck_verify', arguments: {
    hypothesis: 'Division by zero when count is zero.', contract: 'ratio must be finite.',
    evidence: [{ id: 'body', path: 'ratio.ts', startLine: 1, role: 'implementation', content }],
    target: { evidenceId: 'body', start: 1, end: 1, quote: 'const ratio = total / count;' },
  } });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /75\d{3} bytes of UTF-8 and exceeds the 60000-byte budget\. Trim each excerpt/);
  assert.equal(calls, 0);
});

test('previousEvaluation inputs advertise only the fields the comparison reads', async t => {
  const client = await connect(t, createServer(undefined, () => fixtureEvaluator));
  const { tools } = await client.listTools();
  for (const name of ['tracecheck_assess', 'tracecheck_review']) {
    const schema = z.object({ properties: z.object({ previousEvaluation: z.object({ properties: z.record(z.string(), z.unknown()) }) }) })
      .parse(tools.find(tool => tool.name === name)!.inputSchema);
    assert.deepEqual(Object.keys(schema.properties.previousEvaluation.properties).sort(), ['metrics', 'model', 'rubricVersion', 'scope'], name);
  }
});
