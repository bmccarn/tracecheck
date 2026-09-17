import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePaired } from '../src/paired-benchmark.js';
const stage = (verdict: string) => ({ verdict, elapsedMs: 1, inputTokens: 1, outputTokens: 1 });
const run = () => ({ subjectRevision: 'fixture', agentModel: 'fixture', jevModel: 'fixture', cases: [
  { id: 'defect', expected: 'supported', baselineRecordedAt: '2026-09-17T00:00:00Z', verificationStartedAt: '2026-09-17T00:00:01Z', baseline: stage('uncertain'), jev: stage('supported'), assisted: stage('supported'), discovered: true, evidenceComplete: true },
  { id: 'clean', expected: 'not_supported', baselineRecordedAt: '2026-09-17T00:00:00Z', verificationStartedAt: '2026-09-17T00:00:01Z', baseline: stage('not_supported'), jev: stage('supported'), assisted: stage('supported'), discovered: false, evidenceComplete: false },
] });
test('paired benchmark counts assistance harm as well as benefit', () => {
  const result = summarizePaired(run());
  assert.equal(result.helped, 1); assert.equal(result.harmed, 1);
  assert.equal(result.assisted.falsePositives, 1); assert.equal(result.baseline.missedDefects, 1);
  assert.equal(result.incompleteEvidence, 1);
});
test('paired benchmark rejects post-Jev baselines and duplicate cases', () => {
  const late = run(); late.cases[0]!.baselineRecordedAt = '2026-09-17T00:00:02Z';
  assert.throws(() => summarizePaired(late), /before consulting/);
  const duplicate = run(); duplicate.cases.push(duplicate.cases[0]!);
  assert.throws(() => summarizePaired(duplicate), /unique/);
});
