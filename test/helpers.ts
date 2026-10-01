import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Choice, Evaluator, Question, ReviewPlan, TypedAnswer, TypedEvaluator, TypedResponse } from '../src/domain.js';
import { findCandidates } from '../src/checks.js';
import type { createServer } from '../src/mcp.js';

/** A credential-shaped value assembled at runtime so the repository never holds a literal secret. */
export const credential = ['q7Rk', '2vXw', '9LmZ', 'p4Tb', 'N8sd'].join('');

export async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'tracecheck-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Tracecheck test');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'average.ts'), 'export function average(xs: number[]) { if (!xs.length) return 0; return xs.reduce((a,b) => a+b, 0) / xs.length; }\n');
  const commit = (message: string) => { git('add', '.'); git('commit', '-q', '-m', message); };
  commit('Fixture baseline');
  return { root, git, commit, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Writes nine one-line modules under changes/, each exporting its index plus `offset`. */
export async function writeChanges(root: string, offset: number) {
  await mkdir(join(root, 'changes'), { recursive: true });
  for (let index = 0; index < 9; index++) await writeFile(join(root, 'changes', `change-${index}.ts`), `export const value${index} = ${index + offset};\n`);
}

export function planFor(content = 'export function ratio(a: number, b: number) { return a / b; }'): ReviewPlan {
  const sources = [{ path: 'example.ts', content, role: 'changed' as const }];
  const candidates = findCandidates('example.ts', content, [{ start: 1, end: 100 }]);
  return { schemaVersion: 1, root: '/fixture', base: 'base', head: 'head', snapshot: 'a'.repeat(64), sources, candidates,
    packets: [{ id: 'packet-1', changedPaths: ['example.ts'], sourcePaths: ['example.ts'], candidateIds: candidates.map(candidate => candidate.id), limitations: [] }],
    limitations: [], notes: [] };
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

export async function typedFixture(questions: Record<string, Question>): Promise<TypedResponse> {
  const answers: Record<string, TypedAnswer> = {};
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

/** Answers every question with `typedFixture`. */
export const typedEvaluator: TypedEvaluator = { evaluate: async (_state, questions) => typedFixture(questions) };

/** Connects an in-memory MCP client to `server`; both close after the test. */
export async function connect(t: { after: (fn: () => Promise<void>) => void }, server: ReturnType<typeof createServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tracecheck-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}

/** Judges every source-check candidate in `response` not supported, with certainty. */
export function judgeNotSupported(response: TypedResponse): void {
  for (const [id, answer] of Object.entries(response.answers)) {
    if (!id.endsWith('_assessment') || answer.type !== 'choice') continue;
    answer.choice = 'not_supported';
    answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map(key => [key, key === 'not_supported' ? 1 : 0]));
  }
}
