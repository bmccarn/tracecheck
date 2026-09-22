import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { qualityEvaluationSchema } from '../src/quality.js';
import { providerEnvironment } from '../src/jev.js';

if (!process.argv.includes('--live')) { console.log('Run npm run quality-smoke -- --live to review synthetic Python before and after a repair through MCP.'); process.exit(0); }
const client = new Client({ name: 'tracecheck-quality-smoke', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/plugin.mjs'), 'mcp'], stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ...providerEnvironment() } }));
  const task = 'decode accepts arbitrary external JSON text, returns its decoded value, and returns None for malformed JSON. It must not throw for invalid JSON.';
  const beforeInput = { task, scope: 'synthetic-python-decode-v1', files: [{ path: 'decode.py', content: 'import json\n\ndef decode(text: str):\n    """Return decoded JSON, or None when the JSON is malformed."""\n    return json.loads(text)\n' }],
    repositoryContext: 'Small Python library. Its callers supply arbitrary external strings. The source is complete for this operation. No production workload or scale target is established.' };
  const beforeCall = await client.callTool({ name: 'tracecheck_assess', arguments: beforeInput });
  assert.ok(!beforeCall.isError, JSON.stringify(beforeCall));
  const before = qualityEvaluationSchema.parse(beforeCall.structuredContent);
  assert.equal(Object.keys(before.metrics).length, 19);
  const afterCall = await client.callTool({ name: 'tracecheck_assess', arguments: { ...beforeInput,
    files: [{ path: 'decode.py', content: 'import json\n\ndef decode(text: str):\n    """Return decoded JSON, or None when the JSON is malformed."""\n    try:\n        return json.loads(text)\n    except json.JSONDecodeError:\n        return None\n' },
      { path: 'test_decode.py', content: 'from decode import decode\n\ndef test_invalid_json():\n    assert decode("{broken") is None\n\ndef test_valid_json():\n    assert decode("{\\"ok\\":true}") == {"ok": True}\n' }], previousEvaluation: before } });
  assert.ok(!afterCall.isError, JSON.stringify(afterCall));
  const after = qualityEvaluationSchema.parse(afterCall.structuredContent);
  assert.equal(Object.keys(after.metrics).length, 19);
  assert.equal(after.warnings.length, 0);
  console.log(JSON.stringify({ suppliedContextMcp: true, language: 'Python', before, after }, null, 2));
} finally { await client.close(); }
