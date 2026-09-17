import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('standalone plugin serves MCP outside its checkout without node_modules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecheck-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(resolve('dist/plugin.mjs'), join(directory, 'plugin.mjs'));
  const client = new Client({ name: 'package-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'plugin.mjs'), 'mcp'], cwd: directory, stderr: 'pipe' }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 3);
  assert.ok(tools.find(tool => tool.name === 'tracecheck_assess')!.outputSchema);
  const invalid = await client.callTool({ name: 'tracecheck_assess', arguments: {} });
  assert.equal(invalid.isError, true);
  const missingRepo = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  assert.equal(missingRepo.isError, true);
  assert.match(JSON.stringify(missingRepo), /Supply repo/);
});
