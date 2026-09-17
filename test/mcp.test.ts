import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { repository } from './helpers.js';

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
  const data = preview.structuredContent as { snapshot: string; candidates: number };
  assert.equal(data.candidates, 1);
  await writeFile(resolve(repo.root, 'average.ts'), 'export function average(xs: number[]) { return xs.length / 2; }');
  const stale = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot: data.snapshot } });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /changed since preview/);
});
