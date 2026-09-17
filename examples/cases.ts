import { findCandidates } from '../src/checks.js';
import { hash, type ReviewPlan } from '../src/domain.js';

export const cases = [
  { id: 'average-empty', expected: 'supported', code: `// Contract: return a finite average; an empty sample returns zero.
export function average(xs: number[]) {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}
export const emptySample = average([]);` },
  { id: 'average-guarded', expected: 'not_supported', code: `// Contract: return a finite average; an empty sample returns zero.
export function average(xs: number[]) {
  if (!xs.length) return 0;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}
export const emptySample = average([]);` },
  { id: 'save-swallowed', expected: 'supported', code: `// Contract: true means the record was persisted. Storage failures must reject.
export async function save(write: () => Promise<void>) {
  try { await write(); } catch (error) { console.error(error); }
  return true;
}
export const result = save(async () => { throw new Error('disk full'); });` },
  { id: 'save-rethrows', expected: 'not_supported', code: `// Contract: true means the record was persisted. Storage failures must reject.
export async function save(write: () => Promise<void>) {
  try { await write(); } catch (error) { throw error; }
  return true;
}
export const result = save(async () => { throw new Error('disk full'); });` },
  { id: 'json-boundary', expected: 'supported', code: `// Public API contract: malformed JSON returns null and never throws.
export function decode(input: string) { return JSON.parse(input); }
export const malformed = decode('{broken');` },
  { id: 'json-throws-by-contract', expected: 'not_supported', code: `// Public API contract: malformed JSON throws SyntaxError to the caller.
export function decode(input: string) { return JSON.parse(input); }` },
] as const;

export function casePlan(fixture: { id: string; code: string }): ReviewPlan {
  const path = `${fixture.id}.ts`;
  return { schemaVersion: 1, root: '/synthetic-benchmark', base: 'synthetic-v1', head: 'synthetic-v1', snapshot: hash(fixture.code),
    sources: [{ path, content: fixture.code, role: 'changed' }],
    candidates: findCandidates(path, fixture.code, [{ start: 1, end: fixture.code.split('\n').length }]), limitations: [] };
}
