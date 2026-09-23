import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewAll } from '../src/review.js';
import { toSarif } from '../src/sarif.js';
import type { Decision, Report } from '../src/domain.js';
import { planFor, typedFixture } from './helpers.js';

async function supportedReport(): Promise<{ report: Report; decision: Decision }> {
  const report = await reviewAll(planFor(), { evaluate: async (_state, questions) => typedFixture(questions) });
  const [decision] = report.decisions;
  assert.equal(decision?.status, 'supported');
  return { report, decision: decision! };
}

test('SARIF percent-encodes each path segment and maps high impact to error', async () => {
  const { report, decision } = await supportedReport();
  const findings: Array<[string, Decision['impact']]> = [
    ['src/my file.ts', 'high'], ['src/issue#12.ts', 'medium'], ['src/what?.ts', 'low'], ['src/café/ünïcode.ts', 'unknown']];
  report.decisions = findings.map(([path, impact], index) => ({ ...decision, id: `finding-${index}`, path, impact }));
  const results = toSarif(report).runs[0]!.results;
  assert.deepEqual(results.map(result => [result.locations[0]!.physicalLocation.artifactLocation.uri, result.level]), [
    ['src/my%20file.ts', 'error'],
    ['src/issue%2312.ts', 'warning'],
    ['src/what%3F.ts', 'note'],
    ['src/caf%C3%A9/%C3%BCn%C3%AFcode.ts', 'warning'],
  ]);
  // Each encoded URI resolves under the base to the original path.
  for (const [index, result] of results.entries()) {
    const resolved = new URL(result.locations[0]!.physicalLocation.artifactLocation.uri, 'file:///repo/');
    assert.equal(decodeURIComponent(resolved.pathname), `/repo/${findings[index]![0]}`);
  }
});

test('SARIF declares the repository root as an encoded directory URI for SRCROOT', async () => {
  const { report } = await supportedReport();
  for (const root of ['/work/my repo#1', '/work/my repo#1/']) {
    report.root = root;
    const run = toSarif(report).runs[0]!;
    assert.deepEqual(run.originalUriBaseIds, { SRCROOT: { uri: 'file:///work/my%20repo%231/' } });
    assert.ok(run.results.every(result => result.locations[0]!.physicalLocation.artifactLocation.uriBaseId === 'SRCROOT'));
  }
});
