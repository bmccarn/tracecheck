#!/usr/bin/env node
// Drives the built MCP server over stdio the way an agent client does.
// Usage (from the checkout root):
//   node .agents/skills/verify-tracecheck/scripts/mcp-call.mjs --out DIR [--repo PATH] [--timeout-ms N] [--env NAME]... [--progress] --calls FILE
//   node .agents/skills/verify-tracecheck/scripts/mcp-call.mjs --out DIR --list
// FILE is a JSON array of { "tool": "tracecheck_preview", "arguments": { ... } }, or "-" for stdin.
// A step { "run": ["git", "-C", "/path", "..."] } runs a local command between tool calls, in the same
// server session, for example to edit the fixture after a preview.
// The string "$snapshot" anywhere in arguments is replaced with the snapshot from the latest
// successful tracecheck_preview call. Each call is written to DIR/NN-<tool>.json.
// With --progress, every call carries a progress token, and the record lists each progress notification
// received for it under "progress", with the milliseconds since the call started.
// Only PATH, HOME, provider variables, and variables named with --env are forwarded to the server;
// key values are never printed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const PROVIDER_ENVIRONMENT = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_BASE_URL', 'JEV_MODEL', 'JEV_TIMEOUT_MS', 'JEV_CONCURRENCY'];
const { values } = parseArgs({
  options: {
    out: { type: 'string' }, repo: { type: 'string' }, calls: { type: 'string' },
    list: { type: 'boolean', default: false }, 'timeout-ms': { type: 'string', default: '600000' },
    env: { type: 'string', multiple: true, default: [] }, progress: { type: 'boolean', default: false },
  }
});
if (!values.out || (!values.list && !values.calls)) {
  console.error('Usage: mcp-call.mjs --out DIR [--repo PATH] [--timeout-ms N] [--env NAME]... [--progress] (--calls FILE|- | --list)');
  process.exit(2);
}
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
for (const name of [...PROVIDER_ENVIRONMENT, ...values.env]) if (process.env[name]) env[name] = process.env[name];
const args = [resolve('dist/plugin.mjs'), 'mcp', ...(values.repo ? ['--repo', resolve(values.repo)] : [])];
const client = new Client({ name: 'verify-tracecheck', version: '1.0.0' });
const stderr = [];
const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' });
transport.stderr?.on('data', chunk => stderr.push(String(chunk)));
const timeout = Number(values['timeout-ms']);
let failed = false;
try {
  await client.connect(transport);
  if (values.list) {
    const tools = await client.listTools();
    writeFileSync(join(out, 'tools-list.json'), JSON.stringify(tools, null, 2) + '\n');
    console.log(JSON.stringify(tools.tools.map(tool => ({ name: tool.name, annotations: tool.annotations })), null, 2));
  } else {
    const calls = JSON.parse(readFileSync(values.calls === '-' ? 0 : values.calls, 'utf8'));
    let snapshot;
    const summary = [];
    for (const [index, call] of calls.entries()) {
      if (call.run) {
        execFileSync(call.run[0], call.run.slice(1), { stdio: 'pipe' });
        summary.push({ run: call.run.join(' ') });
        continue;
      }
      const argumentsJson = JSON.stringify(call.arguments ?? {}).replaceAll('"$snapshot"', JSON.stringify(snapshot ?? null));
      const started = Date.now();
      const progress = [];
      const onprogress = values.progress ? update => progress.push({ ...update, atMs: Date.now() - started }) : undefined;
      const result = await client.callTool({ name: call.tool, arguments: JSON.parse(argumentsJson) }, { timeout, onprogress });
      const record = {
        tool: call.tool, arguments: JSON.parse(argumentsJson), elapsedMs: Date.now() - started, isError: Boolean(result.isError),
        structuredContent: result.structuredContent ?? null, text: result.content?.filter(item => item.type === 'text').map(item => item.text) ?? [],
        ...(values.progress ? { progress } : {})
      };
      const file = join(out, `${String(index + 1).padStart(2, '0')}-${call.tool}.json`);
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
      if (call.tool === 'tracecheck_preview' && !result.isError) snapshot = result.structuredContent?.snapshot;
      failed ||= record.isError;
      summary.push({
        tool: call.tool, isError: record.isError, elapsedMs: record.elapsedMs, file,
        ...(record.isError ? { error: record.text.join(' ').slice(0, 500) } : {}),
        ...(values.progress ? { progressNotifications: progress.length } : {})
      });
    }
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await client.close().catch(() => { });
  writeFileSync(join(out, 'server-stderr.log'), stderr.join(''));
}
process.exitCode = failed ? 1 : 0;
