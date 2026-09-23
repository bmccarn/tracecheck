import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('an evidence file that cannot be read fails before inference, naming the evidence ID and repository-relative path', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  const outside = await mkdtemp(join(tmpdir(), 'tracecheck-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const content = input().evidence[0]!.content;
  await writeFile(join(outside, 'decode.py'), content);
  await symlink(join(outside, 'decode.py'), join(repo.root, 'escape.py'));
  await symlink(join(outside, 'gone.py'), join(repo.root, 'dangling.py'));
  await mkdir(join(repo.root, 'pkg'));
  await writeFile(join(repo.root, 'big.py'), `${content}\n${'#'.repeat(256_000)}`);
  const absolute = [repo.root, await realpath(repo.root), outside, await realpath(outside)];
  const never = { async evaluate(): Promise<never> { throw new Error('Inference must not run'); } };
  const failure = async (path: string) => {
    const packet = { ...input(), repo: repo.root };
    packet.evidence[0]!.path = path;
    const error = await verify(packet, never).then(() => assert.fail(`${path} was verified`), (caught: Error) => caught);
    assert.ok(absolute.every(prefix => !error.message.includes(prefix)) && !/ENOENT|EISDIR|realpath/.test(error.message), error.message);
    return error.message;
  };
  const unbind = 'or omit the repository binding to verify caller-supplied evidence.';
  const missing = await failure('src/missing.py');
  assert.equal(missing, `Evidence body (src/missing.py) was not found in the repository. Correct the path, ${unbind}`);
  assert.match(await failure('escape.py'), /^Evidence body \(escape\.py\) is a symlink or resolves outside the repository\./);
  assert.match(await failure('dangling.py'), /^Evidence body \(dangling\.py\) is a symlink or resolves outside the repository\./);
  assert.match(await failure('pkg'), /^Evidence body \(pkg\) is a directory or other non-regular file\./);
  assert.match(await failure('big.py'), /^Evidence body \(big\.py\) is larger than the 256000-byte limit for a local file\./);

  const server = createServer(repo.root, () => never);
  const client = new Client({ name: 'verify-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b); await client.connect(a);
  const unbound = input(); unbound.evidence[0]!.path = 'src/missing.py';
  const response = await client.callTool({ name: 'tracecheck_verify', arguments: unbound });
  assert.ok(response.isError, JSON.stringify(response));
  assert.deepEqual((response.content as { text: string }[]).map(item => item.text), [missing]);
});

test('an evidence file deleted during inference is reported by evidence ID and path', async t => {
  const repo = await repository(); t.after(repo.cleanup);
  await writeFile(join(repo.root, 'decode.py'), input().evidence[0]!.content);
  await assert.rejects(verify({ ...input(), repo: repo.root }, { async evaluate(_state, questions) {
    await unlink(join(repo.root, 'decode.py'));
    return typedFixture(questions);
  } }), { message: 'Evidence body (decode.py) was not found in the repository. Correct the path, or omit the repository binding to verify caller-supplied evidence.' });
});

test('a repository path that does not exist or is outside Git fails before inference, named as given, through verify and MCP', async t => {
  const plain = await mkdtemp(join(tmpdir(), 'tracecheck-plain-')); t.after(() => rm(plain, { recursive: true, force: true }));
  const bound = await repository(); t.after(bound.cleanup);
  const never = { async evaluate(): Promise<never> { throw new Error('Inference must not run'); } };
  const cases: Array<[string, RegExp]> = [[join(plain, 'missing'), /: cannot change to .+: No such file or directory\.$/], [plain, /: not a git repository/]];
  for (const [repo, reason] of cases) {
    const error = await verify({ ...input(), repo }, never).then(() => assert.fail(`${repo} was accepted`), (caught: Error) => caught);
    assert.ok(error.message.startsWith(`Cannot open ${repo} as a Git working tree: `), error.message);
    assert.match(error.message, reason);
    assert.doesNotMatch(error.message, /ENOENT|realpath|Command failed/);
    // An unbound server and one bound to another repository report the same message.
    for (const server of [createServer(undefined, () => never), createServer(bound.root, () => never)]) {
      const client = new Client({ name: 'verify-test', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      t.after(async () => { await client.close(); await server.close(); });
      await server.connect(b); await client.connect(a);
      const response = await client.callTool({ name: 'tracecheck_verify', arguments: { ...input(), repo } });
      assert.equal(response.isError, true, JSON.stringify(response));
      assert.deepEqual((response.content as { text: string }[]).map(item => item.text), [error.message]);
    }
  }
});
