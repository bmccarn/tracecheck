import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createServer } from '../src/mcp.js';
import { repository, typedFixture } from './helpers.js';

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
