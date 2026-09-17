import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Choice, Evaluator, ReviewPlan } from '../src/domain.js';
import { findCandidates } from '../src/checks.js';

export async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'tracecheck-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Tracecheck test');
  git('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(root, 'average.ts'), 'export function average(xs: number[]) { if (!xs.length) return 0; return xs.reduce((a,b) => a+b, 0) / xs.length; }\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture baseline');
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function planFor(content = 'export function ratio(a: number, b: number) { return a / b; }'): ReviewPlan {
  const sources = [{ path: 'example.ts', content, role: 'changed' as const }];
  const candidates = findCandidates('example.ts', content, [{ start: 1, end: 100 }]);
  return { schemaVersion: 1, root: '/fixture', base: 'base', head: 'head', snapshot: 'a'.repeat(64), sources, candidates,
    packets: [{ id: 'packet-1', changedPaths: ['example.ts'], sourcePaths: ['example.ts'], candidateIds: candidates.map(candidate => candidate.id), limitations: [] }],
    limitations: [] };
}

export function fixtureEvaluator(choice = 'supported', confidence = 0.95): Evaluator {
  return { async evaluate(_state: unknown, questions: Record<string, Choice>) {
    return { model: 'offline-fixture-not-jev', usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const selected = id.endsWith('_impact') ? 'medium' : choice;
        const keys = Object.keys(question.criteria);
        return [id, { type: 'choice' as const, choice: selected, confidence,
          probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 0.95 : 0.05 / (keys.length - 1)])) }];
      })) };
  } };
}

export async function typedFixture(questions: Record<string, import('../src/domain.js').Question>): Promise<import('../src/domain.js').TypedResponse> {
  const answers: Record<string, import('../src/domain.js').TypedAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') { answers[id] = { type: 'noul', noul: 0.95 }; continue; }
    if (question.type === 'score') {
      answers[id] = { type: 'score', score: 7, confidence: 0.9,
        legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])),
        probabilities: Object.fromEntries(question.criteria.map((_value, index) => [String(index), index === 7 ? 1 : 0])) };
      continue;
    }
    const choice = id.startsWith('quality_') ? 'none' : id.endsWith('_impact') ? 'medium' : 'supported';
    answers[id] = { type: 'choice', choice, confidence: 0.95,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) };
  }
  return { model: 'fixture-v1', answers, usage: { input_tokens: 100, output_tokens: 50 } };
}
