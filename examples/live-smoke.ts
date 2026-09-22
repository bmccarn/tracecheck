import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { reportSchema } from '../src/schema.js';
import { providerEnvironment } from '../src/jev.js';

if (!process.argv.includes('--live')) {
  console.log('Run npm run smoke -- --live to exercise Jev through the actual MCP server on synthetic source.');
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), 'tracecheck-live-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
const client = new Client({ name: 'tracecheck-live-smoke', version: '1.0.0' });
try {
  git('init', '-b', 'main'); git('config', 'user.name', 'Tracecheck fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  const contract = '// Public API: malformed JSON must return null, never throw.\n';
  await writeFile(join(root, 'decode.ts'), contract + 'export function decode(input: string) { try { return JSON.parse(input); } catch { return null; } }');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic baseline');
  await writeFile(join(root, 'decode.ts'), contract + 'export function decode(input: string) { return JSON.parse(input); }\nexport const malformed = decode("{broken");');
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/plugin.mjs'), 'mcp', '--repo', root], stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ...providerEnvironment() } }));
  const preview = await client.callTool({ name: 'tracecheck_preview', arguments: {} });
  assert.ok(!preview.isError, JSON.stringify(preview));
  const snapshot = (preview.structuredContent as { snapshot: string }).snapshot;
  const result = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } });
  assert.ok(!result.isError, JSON.stringify(result));
  const output = result.structuredContent as { report: unknown; cached: boolean };
  const report = reportSchema.parse(output.report);
  assert.equal(report.decisions.length, 1);
  assert.equal(Object.keys(report.quality!.metrics).length, 19);
  assert.equal(report.usage.requests, 1);
  // OpenRouter reports its namespaced ID, for example typesafe/jev-1.13-20260917.
  assert.match(report.models[0] ?? '', /^(?:typesafe\/)?jev-/);
  const repeat = await client.callTool({ name: 'tracecheck_review', arguments: { snapshot } });
  assert.ok(!repeat.isError);
  const repeated = repeat.structuredContent as { report: { id: string }; cached: boolean };
  assert.equal(repeated.cached, true); assert.equal(repeated.report.id, report.id);
  console.log(JSON.stringify({ mcp: '2.0.0', connected: true, liveReview: true, cacheVerified: true,
    report }, null, 2));
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true });
}
