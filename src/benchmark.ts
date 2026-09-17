import type { Decision } from './domain.js';

export type Observation = { expected: 'supported' | 'not_supported'; actual: Decision['status']; elapsedMs: number; inputTokens: number; outputTokens: number };
export function summarize(rows: Observation[]) {
  const positives = rows.filter(row => row.expected === 'supported').length;
  const truePositives = rows.filter(row => row.expected === 'supported' && row.actual === 'supported').length;
  const falsePositives = rows.filter(row => row.expected === 'not_supported' && row.actual === 'supported').length;
  const trueNegatives = rows.filter(row => row.expected === 'not_supported' && row.actual === 'not_supported').length;
  const falseNegatives = rows.filter(row => row.expected === 'supported' && row.actual === 'not_supported').length;
  const abstentions = rows.filter(row => row.actual === 'uncertain' || row.actual === 'needs_context').length;
  const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]! : null;
  return { cases: rows.length, positives, negatives: rows.length - positives, truePositives, falsePositives, trueNegatives, falseNegatives,
    missedDefects: positives - truePositives, abstentions,
    precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    recall: positives ? truePositives / positives : null,
    coverage: rows.length ? (rows.length - abstentions) / rows.length : null,
    p50Ms: percentile(rows.map(row => row.elapsedMs), 0.5), p95Ms: percentile(rows.map(row => row.elapsedMs), 0.95),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0) };
}
