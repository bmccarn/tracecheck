import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { verify, verificationOutputSchema, type VerificationInput } from '../src/verify.js';
import { createServer } from '../src/mcp.js';
import { repository, typedFixture } from './helpers.js';

const input = (): VerificationInput => ({ hypothesis: 'Malformed JSON escapes the decode boundary.', contract: 'Malformed JSON must return None.',
  evidence: [{ id: 'body', path: 'decode.py', role: 'implementation', startLine: 1, content: 'import json\ndef decode(text):\n    return json.loads(text)' }],
  target: { evidenceId: 'body', start: 3, end: 3, quote: '    return json.loads(text)' } });
const evaluator = { evaluate: async (_state: unknown, questions: Parameters<typeof typedFixture>[0]) => typedFixture(questions) };

test('agent-selected Python concern is verified without a parser or quality-score request', async () => {
  const result = await verify(input(), { async evaluate(state, questions) {
    assert.equal(Object.keys(questions).length, 3);
    assert.match(JSON.stringify(state), /Malformed JSON must return None/);
    assert.match(JSON.stringify(state), /implementation/);
    return typedFixture(questions);
  } });
  assert.equal(result.provenance, 'caller_supplied');
  assert.equal(result.report.decisions[0]!.check, 'agent-hypothesis');
  assert.equal(result.report.decisions[0]!.status, 'supported');
  assert.equal(result.report.quality, undefined);
});

test('bad anchors, duplicates, oversized evidence and secrets fail before inference', async () => {
  const never = { async evaluate(): Promise<never> { throw new Error('Inference must not run'); } };
  const bad = input(); bad.target.quote = 'invented';
  await assert.rejects(verify(bad, never), /quote does not match/);
  const duplicate = input(); duplicate.evidence.push(duplicate.evidence[0]!);
  await assert.rejects(verify(duplicate, never), /unique/);
  const big = input(); big.evidence.push({ id: 'big', path: 'b.py', startLine: 1, role: 'caller', content: 'x'.repeat(60000) });
  await assert.rejects(verify(big, never), /byte budget\. Trim each excerpt/);
  // Assembled at runtime so the repository never contains a literal secret.
  const secret = input(); secret.contract = `apiKey = "${['q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd'].join('')}"`;
  await assert.rejects(verify(secret, never), /credential in field contract/);
});

test('local evidence rejects stale quotes, traversal, and mid-request edits', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const packet = { ...input(), repo: repo.root };
  packet.evidence.push({ id: 'contract', path: 'decode.py', startLine: 4, role: 'contract', content: '# Malformed JSON must return None.' });
  await writeFile(join(repo.root, 'decode.py'), `${packet.evidence[0]!.content}\n${packet.evidence[1]!.content}`);
  assert.equal((await verify(packet, evaluator)).provenance, 'local_files_checked');
  const staleContract = structuredClone(packet);
  staleContract.evidence[1]!.content = '# Malformed JSON must throw.';
  await assert.rejects(verify(staleContract, evaluator), /differs from local source/);
  const traversal = structuredClone(packet); traversal.evidence[0]!.path = '../decode.py';
  await assert.rejects(verify(traversal, evaluator), /repository-relative/);
  await assert.rejects(verify(packet, { async evaluate(_state, questions) {
    await writeFile(join(repo.root, 'decode.py'), 'def decode(text): return None');
    return typedFixture(questions);
  } }), /changed during verification/);
  await assert.rejects(verify(packet, evaluator), /differs from local source/);
});

test('MCP verification uses the bound repository and exposes typed provenance', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'decode.py'), input().evidence[0]!.content);
  const server = createServer(repo.root, () => evaluator);
  const client = new Client({ name: 'verify-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b); await client.connect(a);
  const response = await client.callTool({ name: 'tracecheck_verify', arguments: input() });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.equal(verificationOutputSchema.parse(response.structuredContent).provenance, 'local_files_checked');
});
