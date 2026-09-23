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
import { reportSchema } from '../src/schema.js';
import type { TypedEvaluator } from '../src/domain.js';
import { judgeNotSupported, repository, typedFixture } from './helpers.js';

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
  const repeated = z.object({ cached: z.boolean(), report: z.object({ notes: z.array(z.string()) }) }).parse(compared.structuredContent);
  assert.equal(repeated.cached, true); assert.equal(calls, 2);
  assert.match(repeated.report.notes.join('\n'), /single-packet quality result/);
});

test('MCP review sends strictly increasing progress only when the client asks for it', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await mkdir(join(repo.root, 'changes'), { recursive: true });
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index};\n`);
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Packet fixture');
  for (let index = 0; index < 9; index++) await writeFile(join(repo.root, 'changes', `change-${index}.ts`), `export const value${index} = ${index + 1};\n`);
  // The second request fails and the first finishes after it, so completions arrive out of plan order.
  let calls = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const server = createServer(repo.root, () => ({ async evaluate(_state, questions) {
    const call = ++calls;
    if (call === 1) await firstHeld;
    if (call === 2) {
      setImmediate(releaseFirst);
      throw new Error('Stand-in provider failure.');
    }
    return typedFixture(questions);
  } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'progress-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  let notifications = 0;
  const receive = clientTransport.onmessage!;
  clientTransport.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'notifications/progress') notifications++;
    receive(message, extra);
  };
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  const { snapshot } = z.object({ snapshot: z.string() }).parse(preview.structuredContent);

  const updates: { progress: number; total?: number; message?: string }[] = [];
  const review = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } }, { onprogress: update => updates.push(update) });
  assert.ok(!review.isError, JSON.stringify(review));
  const { report } = z.object({ report: z.object({ usage: z.object({ requests: z.number() }) }) }).parse(review.structuredContent);
  assert.equal(calls, 2); assert.equal(report.usage.requests, 1);
  const total = 4 + 1 + 2 + 2;
  assert.deepEqual(updates.map(update => [update.message, update.total]), [
    ['Listing changed files', undefined], ['Reading changed files', undefined], ['Indexing imports', undefined], ['Assembling change packets', undefined],
    ['Sending 2 provider requests', total], ['Completed provider request 1 of 2', total], ['Completed provider request 2 of 2', total],
    ['Checking that the repository did not change', total], ['Review complete', total]]);
  assert.deepEqual(updates.map(update => update.progress), Array.from({ length: total }, (_, index) => index + 1));

  // The failed request left the report incomplete, so this review reaches the evaluator again.
  notifications = 0;
  const quiet = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } });
  assert.ok(!quiet.isError, JSON.stringify(quiet));
  assert.equal(calls, 4);
  assert.equal(notifications, 0, 'no progress notification without a progress token');
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

test('an MCP review cache hit requires the same provider endpoint and model', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 0;');
  const saved = { TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL, JEV_MODEL: process.env.JEV_MODEL };
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  let calls = 0;
  const client = await connect(t, createServer(repo.root, () => ({ async evaluate(_state, questions) { calls++; return typedFixture(questions); } })));
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  const snapshot = z.object({ snapshot: z.string() }).parse(preview.structuredContent).snapshot;
  const review = async (baseUrl: string, model: string) => {
    process.env.TYPESAFE_BASE_URL = baseUrl; process.env.JEV_MODEL = model;
    const result = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } });
    assert.ok(!result.isError, JSON.stringify(result));
    return z.object({ cached: z.boolean() }).parse(result.structuredContent).cached;
  };
  assert.equal(await review('https://one.example.invalid', 'model-a'), false);
  assert.equal(await review('https://one.example.invalid', 'model-a'), true);
  assert.equal(await review('https://one.example.invalid', 'model-b'), false, 'another model must not reuse the cached report');
  assert.equal(await review('https://two.example.invalid', 'model-a'), false, 'another endpoint must not reuse the cached report');
  assert.equal(await review('https://two.example.invalid', 'model-a'), true);
  assert.equal(calls, 3);
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

test('an untracked file outside the review keeps an MCP preview valid, and a clean change has no findings', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export function ratio(a: number, b: number) {\n  return a / b;\n}\n');
  const client = await connect(t, createServer(repo.root, () => ({ async evaluate(_state, questions) {
    const response = await typedFixture(questions);
    judgeNotSupported(response);
    return response;
  } })));
  const previewOutput = z.object({ snapshot: z.string(), notes: z.array(z.string()), limitations: z.array(z.string()) });
  const preview = previewOutput.parse((await client.callTool({ name: 'tracecheck_preview', arguments: {} })).structuredContent);
  assert.deepEqual(preview.limitations, []);
  assert.match(preview.notes.join('\n'), /Import\/caller discovery is heuristic/);

  await writeFile(join(repo.root, 'coverage.json'), '{}\n');
  const review = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: preview.snapshot } });
  assert.ok(!review.isError, JSON.stringify(review));
  const { report } = z.object({ report: z.object({ status: z.string(), limitations: z.array(z.string()), notes: z.array(z.string()) }) })
    .parse(review.structuredContent);
  assert.equal(report.status, 'no_findings');
  assert.deepEqual(report.limitations, []);
  assert.match(report.notes.join('\n'), /1 untracked file\(s\) excluded/);

  // An included untracked source file is reviewed evidence, so a new one changes the snapshot.
  const included = previewOutput.parse((await client.callTool({ name: 'tracecheck_preview', arguments: { includeUntracked: true } })).structuredContent);
  await writeFile(join(repo.root, 'extra.ts'), 'export const extra = 1;\n');
  const changed = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: included.snapshot, includeUntracked: true } });
  assert.equal(changed.isError, true);
  assert.match(JSON.stringify(changed), /changed since preview/);
});

/** A promise and the function that settles it, for holding provider requests until a test releases them. */
function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const reviewOutput = z.object({ cached: z.boolean(), report: reportSchema });

/** Starts a review call; `joined` settles once its progress reports the planned provider requests of the review it waits for. */
function startReview(client: Client, snapshot: string, signal?: AbortSignal) {
  const joined = held();
  const updates: { progress: number; total?: number; message?: string }[] = [];
  const result = client.callTool({ name: 'tracecheck_review', arguments: { snapshot } }, { signal, onprogress: update => {
    updates.push(update);
    if (update.message?.startsWith('Sending')) joined.release();
  } });
  return { result, joined: joined.promise, updates };
}

test('concurrent identical MCP reviews make one provider round and return the same report', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 0;');
  const provider = held();
  let calls = 0;
  const client = await connect(t, createServer(repo.root, () => ({ async evaluate(_state, questions) {
    calls++;
    await provider.promise;
    return typedFixture(questions);
  } })));
  const { snapshot } = z.object({ snapshot: z.string() }).parse((await client.callTool({ name: 'tracecheck_preview', arguments: {} })).structuredContent);
  const reviews = Array.from({ length: 3 }, () => startReview(client, snapshot));
  await Promise.all(reviews.map(review => review.joined));
  provider.release();
  const outputs = await Promise.all(reviews.map(async review => reviewOutput.parse((await review.result).structuredContent)));
  assert.ok(outputs[0]!.report.usage.requests > 0);
  assert.equal(calls, outputs[0]!.report.usage.requests, 'the three calls made the requests of one review');
  assert.deepEqual(outputs.map(output => output.cached).sort(), [false, true, true]);
  for (const output of outputs.slice(1)) assert.deepEqual(output.report, outputs[0]!.report);
  // A call that joined the review in flight still receives its progress, strictly increasing, through completion.
  for (const { updates } of reviews) {
    assert.ok(updates.every((update, index) => index === 0 || update.progress > updates[index - 1]!.progress), JSON.stringify(updates));
    const last = updates.at(-1)!;
    assert.equal(last.message, 'Review complete');
    assert.equal(last.progress, last.total);
  }
});

test('a cancelled call leaves a shared review running for the others, and the review stops when every call is cancelled', { timeout: 10_000 }, async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 0;');
  let provider = held();
  const stopped = held();
  const aborted: unknown[] = [];
  let calls = 0;
  const client = await connect(t, createServer(repo.root, signal => ({ async evaluate(_state, questions) {
    calls++;
    const gate = provider.promise;
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      signal.addEventListener('abort', () => { aborted.push(signal.reason); stopped.release(); reject(signal.reason); }, { once: true });
    });
    return typedFixture(questions);
  } })));
  const preview = async () => z.object({ snapshot: z.string() }).parse((await client.callTool({ name: 'tracecheck_preview', arguments: {} })).structuredContent).snapshot;

  // The first call starts the review, the second joins it, and then the first is cancelled.
  let snapshot = await preview();
  const cancelFirst = new AbortController();
  const first = startReview(client, snapshot, cancelFirst.signal);
  await first.joined;
  const second = startReview(client, snapshot);
  await second.joined;
  cancelFirst.abort();
  await assert.rejects(first.result);
  // The server handles the cancellation notice before it answers this later request.
  await client.listTools();
  assert.deepEqual(aborted, [], 'the review stopped while a call still waited for it');
  provider.release();
  const kept = reviewOutput.parse((await second.result).structuredContent);
  assert.equal(kept.cached, true);
  assert.equal(calls, kept.report.usage.requests);
  assert.ok(!kept.report.limitations.some(item => item.startsWith('Review incomplete')));

  // When every waiting call is cancelled the review stops, and the next identical call starts a new one.
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 2;');
  provider = held();
  snapshot = await preview();
  const before = calls;
  const cancels = [new AbortController(), new AbortController()];
  const waiting: ReturnType<typeof startReview>[] = [];
  for (const cancel of cancels) {
    const call = startReview(client, snapshot, cancel.signal);
    await call.joined;
    waiting.push(call);
  }
  cancels[0]!.abort();
  await assert.rejects(waiting[0]!.result);
  await client.listTools();
  assert.deepEqual(aborted, [], 'the review stopped while a call still waited for it');
  cancels[1]!.abort();
  await assert.rejects(waiting[1]!.result);
  await stopped.promise;
  assert.equal(aborted.length, 1);
  const retry = startReview(client, snapshot);
  await retry.joined;
  provider.release();
  const fresh = reviewOutput.parse((await retry.result).structuredContent);
  assert.equal(fresh.cached, false, 'the retry joined the stopped review');
  assert.equal(calls - before, 2 * fresh.report.usage.requests);
});

test('a bound MCP server accepts any directory in its repository and rejects another repository', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const other = await repository(); t.after(other.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 0;');
  const decode = 'import json\ndef decode(text):\n    return json.loads(text)';
  await mkdir(join(repo.root, 'src'));
  await writeFile(join(repo.root, 'src', 'decode.py'), `${decode}\n`);
  // A repository inside the bound one's directory is still another repository.
  const nested = join(repo.root, 'vendor');
  await mkdir(nested);
  execFileSync('git', ['init', '-q', nested]);
  const client = await connect(t, createServer(repo.root, () => fixtureEvaluator));
  const snapshotOf = (result: Awaited<ReturnType<typeof client.callTool>>) => {
    assert.ok(!result.isError, JSON.stringify(result));
    return z.object({ snapshot: z.string() }).parse(result.structuredContent).snapshot;
  };
  const src = join(repo.root, 'src');
  const snapshot = snapshotOf(await client.callTool({ name: 'tracecheck_preview', arguments: {} }));
  assert.equal(snapshotOf(await client.callTool({ name: 'tracecheck_preview', arguments: { repo: src } })), snapshot);
  const review = await client.callTool({ name: 'tracecheck_review', arguments: { repo: src, snapshot } });
  assert.ok(!review.isError, JSON.stringify(review));
  // verify reads evidence paths relative to the directory the call names, as an unbound server and the CLI do.
  const verified = await client.callTool({ name: 'tracecheck_verify', arguments: { repo: src,
    hypothesis: 'Malformed JSON escapes the decode boundary.', contract: 'Malformed JSON must return None.',
    evidence: [{ id: 'body', path: 'decode.py', role: 'implementation', startLine: 1, content: decode }],
    target: { evidenceId: 'body', start: 3, end: 3, quote: '    return json.loads(text)' } } });
  assert.ok(!verified.isError, JSON.stringify(verified));
  assert.equal(z.object({ provenance: z.string() }).parse(verified.structuredContent).provenance, 'local_files_checked');
  for (const elsewhere of [other.root, nested]) {
    const refused = await client.callTool({ name: 'tracecheck_preview', arguments: { repo: elsewhere } });
    assert.equal(refused.isError, true, elsewhere);
    assert.deepEqual((refused.content as { text: string }[]).map(item => item.text), ['This server is bound to a different repository.']);
  }
});
