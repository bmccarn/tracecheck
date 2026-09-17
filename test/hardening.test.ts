import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { collect } from '../src/collector.js';
import { focusSource } from '../src/evidence.js';
import { readSource } from '../src/safety.js';
import { Jev } from '../src/jev.js';
import { createServer } from '../src/mcp.js';
import { qualityEvaluationSchema, qualityQuestions, transformQuality } from '../src/quality.js';
import { reportSchema } from '../src/schema.js';
import { summarize } from '../src/benchmark.js';
import { repository, typedFixture } from './helpers.js';

test('root is part of snapshot identity even for identical cloned commits', async t => {
  const a = await repository(); const b = await repository(); t.after(a.cleanup); t.after(b.cleanup);
  await rm(join(b.root, '.git'), { recursive: true });
  await cp(join(a.root, '.git'), join(b.root, '.git'), { recursive: true });
  assert.equal(a.git('rev-parse', 'HEAD'), b.git('rev-parse', 'HEAD'));
  await writeFile(join(a.root, 'average.ts'), 'export const x = 1;');
  await writeFile(join(b.root, 'average.ts'), 'export const x = 1;');
  assert.notEqual((await collect({ repo: a.root })).snapshot, (await collect({ repo: b.root })).snapshot);
});

test('large Python edits retain original line anchors, callers, tests, and old-line evidence', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await mkdir(join(repo.root, 'src/pkg'), { recursive: true }); await mkdir(join(repo.root, 'tests'));
  const prefix = '# unrelated content padding\n'.repeat(1200);
  await writeFile(join(repo.root, 'src/pkg/decode.py'), prefix + 'def decode(text):\n    if not text:\n        return None\n    return text\n');
  await writeFile(join(repo.root, 'src/pkg/caller.py'), 'from pkg.decode import decode\ndef use(text):\n    return decode(text)\n');
  await writeFile(join(repo.root, 'tests/test_decode.py'), 'from pkg.decode import decode\ndef test_empty():\n    assert decode("") is None\n');
  repo.git('add', '.'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Python fixture');
  await writeFile(join(repo.root, 'src/pkg/decode.py'), prefix + 'def decode(text):\n    return text\n');
  const plan = await collect({ repo: repo.root });
  const source = plan.sources.find(source => source.role === 'changed')!;
  assert.match(source.content, /1201: def decode/); assert.match(source.before!, /return None/);
  assert.ok(source.content.length < 12_000); assert.equal(source.evidence!.totalLines, 1203);
  assert.equal(plan.sources.find(source => source.path.endsWith('caller.py'))!.role, 'caller');
  assert.equal(plan.sources.find(source => source.path.endsWith('test_decode.py'))!.role, 'test');
  assert.match(plan.limitations.join('\n'), /omitted lines/);
  await writeFile(join(repo.root, 'src/pkg/decode.py'), prefix.replace('padding', 'outside excerpt') + 'def decode(text):\n    return text\n');
  assert.notEqual((await collect({ repo: repo.root })).snapshot, plan.snapshot);
});

test('collection supports legitimate dot-prefixed paths but rejects symlink escapes and cancellation', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, '..valid.ts'), 'export const value = 1;');
  const external = await repository(); t.after(external.cleanup);
  await symlink(external.root, join(repo.root, 'escape'));
  await assert.rejects(readSource(repo.root, 'escape/average.ts'), /external path/);
  await symlink(join(external.root, 'average.ts'), join(repo.root, 'linked.ts'));
  await assert.rejects(readSource(repo.root, 'linked.ts'), /external path/);
  const plan = await collect({ repo: repo.root, includeUntracked: true });
  assert.ok(plan.sources.some(source => source.path === '..valid.ts'));
  await assert.rejects(collect({ repo: repo.root, signal: AbortSignal.abort() }), /abort/i);
});

test('secret screening protects manual contexts before any HTTP request', async () => {
  let calls = 0;
  const client = new Jev({ apiKey: 'fixture', fetch: async () => { calls++; throw new Error('Must not send'); } });
  await assert.rejects(client.evaluate({ files: [{ content: 'const apiKey = "abcdefghijklmnopqrstuvwxyz123456";' }] }, {}), /Potential credential/);
  assert.equal(calls, 0);
});

test('oversized and malformed provider responses fail without echoing source', async () => {
  const client = new Jev({ apiKey: 'fixture', fetch: async () => new Response('x'.repeat(512_001)) });
  await assert.rejects(client.evaluate({}, {}), /response budget/);
  const malformed = new Jev({ apiKey: 'fixture', fetch: async () => new Response('private invalid text') });
  await assert.rejects(malformed.evaluate({}, {}), error => error instanceof Error && /invalid JSON/.test(error.message) && !/private/.test(error.message));
});

test('relevance and missing evidence remain separate and cannot manufacture a score', async () => {
  const response = await typedFixture(qualityQuestions());
  response.answers.quality_security_relevance = { type: 'noul', noul: 0.99 };
  response.answers.quality_security_applicability = { type: 'noul', noul: 0.1 };
  const metric = transformQuality(response, 'scope', 'snapshot').metrics.security!;
  assert.equal(metric.status, 'insufficient_context'); assert.equal(metric.score, undefined);
  assert.equal(metric.relevanceProbability, 0.99); assert.equal(metric.evidenceProbability, 0.1);
});

test('MCP reuses inference when previous assessment changes and rejects mid-review edits', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'average.ts'), 'export const average = (xs: number[]) => xs.length / 0;');
  let calls = 0; let mutate = false;
  const server = createServer(repo.root, () => ({ async evaluate(_state, questions) {
    calls++; if (mutate) await writeFile(join(repo.root, 'average.ts'), 'export const average = () => 5;');
    return typedFixture(questions);
  } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cache-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b); await client.connect(a);
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  const snapshot = z.object({ snapshot: z.string() }).parse(preview.structuredContent).snapshot;
  const first = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } });
  assert.ok(!first.isError, JSON.stringify(first));
  const report = reportSchema.parse(z.object({ report: reportSchema }).parse(first.structuredContent).report);
  const previous = qualityEvaluationSchema.parse(report.quality);
  previous.metrics.readability!.score = 4;
  const second = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot, previousEvaluation: previous } });
  assert.equal(z.object({ cached: z.boolean() }).parse(second.structuredContent).cached, true); assert.equal(calls, 1);
  const compared = reportSchema.parse(z.object({ report: reportSchema }).parse(second.structuredContent).report);
  assert.equal(compared.quality!.comparison.find(row => row.metric === 'readability')!.delta, 4);
  mutate = true;
  const next = await client.callTool({ name: 'tracecheck_preview', arguments: { task: 'new task' } });
  const stale = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: z.object({ snapshot: z.string() }).parse(next.structuredContent).snapshot, task: 'new task' } });
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /changed during review/);
});

test('benchmark counts uncertain defects as misses and leaves undefined precision null', () => {
  const summary = summarize([{ expected: 'supported', actual: 'uncertain', elapsedMs: 10, inputTokens: 1, outputTokens: 1 }]);
  assert.equal(summary.recall, 0); assert.equal(summary.precision, null); assert.equal(summary.missedDefects, 1); assert.equal(summary.coverage, 0);
  assert.equal(summarize([]).recall, null);
});

test('focused excerpts retain a guard above the edited return', () => {
  const source = '# noise\n'.repeat(2000) + 'def ratio(value):\n    if value == 0:\n        return None\n' + '    # context\n'.repeat(20) + '    return 1 / value\n';
  const focused = focusSource(source, [{ start: 2024, end: 2024 }], 2000);
  assert.match(focused.content, /if value == 0/); assert.match(focused.content, /return 1 \/ value/);
});
