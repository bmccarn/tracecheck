import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { hash, type Candidate, type Range } from './domain.js';

// Syntax identifies review opportunities, not bugs. Jev judges each hypothesis
// against the surrounding source, guards, and available dependencies.
const checks = {
  'zero-divisor': {
    hypothesis: 'A reachable input can make this divisor zero, producing an unintended non-finite result or a BigInt division error. Account for preceding guards, constants, caller contracts, and deliberately permitted IEEE-754 behavior.',
    verification: 'Exercise the containing operation with an input that makes the divisor zero; assert the intended result or error contract.',
  },
  'swallowed-failure': {
    hypothesis: 'This catch handler turns a failed operation into an apparent success, violating the visible caller or task contract. A documented fallback, best-effort operation, explicit failure return, or rethrow is not a defect.',
    verification: 'Force the caught operation to fail and assert the caller can observe the required failure or documented fallback.',
  },
  'unhandled-json': {
    hypothesis: 'Malformed input can reach this JSON.parse call and its exception escapes a boundary that visibly requires a controlled response. A parser designed to throw, an enclosing handler, a validated input, or a rejecting API contract is not a defect.',
    verification: 'Pass malformed JSON through the public caller and assert its documented failure response.',
  },
} as const;

export function parseSource(path: string, content: string) {
  return parse(content, { sourceType: 'unambiguous', plugins: [
    ...(/\.[cm]?tsx?$/.test(path) ? ['typescript' as const] : []),
    ...(/\.[jt]sx$/.test(path) ? ['jsx' as const] : []),
  ] });
}

export function findCandidates(path: string, content: string, changed: Range[]): Candidate[] {
  const file = parseSource(path, content);
  const candidates: Candidate[] = [];
  const occurrences = new Map<string, number>();
  function visit(node: t.Node, parents: t.Node[]) {
    let check: keyof typeof checks | undefined;
    if (t.isBinaryExpression(node) && ['/', '%'].includes(node.operator)) check = 'zero-divisor';
    if (t.isCatchClause(node)) check = 'swallowed-failure';
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && !node.callee.computed
      && t.isIdentifier(node.callee.object, { name: 'JSON' }) && t.isIdentifier(node.callee.property, { name: 'parse' })) check = 'unhandled-json';
    if (check) {
      const container = [...parents].reverse().find(parent => t.isFunction(parent)) ?? file.program;
      const scope = { start: container.loc!.start.line, end: container.loc!.end.line };
      const owner = parents[parents.indexOf(container) - 1];
      const name = ('id' in container && t.isIdentifier(container.id)) ? container.id.name
        : ('key' in container && t.isIdentifier(container.key)) ? container.key.name
        : owner && t.isVariableDeclarator(owner) && t.isIdentifier(owner.id) ? owner.id.name : '<anonymous-or-module>';
      const symbol = name;
      const quote = content.slice(node.start!, node.end!);
      const key = hash([path, symbol, check, quote.replace(/\s+/g, ' ')]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      if (changed.some(range => range.start <= scope.end && range.end >= scope.start)) {
        candidates.push({ id: hash([key, occurrence]).slice(0, 24), check, path, symbol,
          range: { start: node.loc!.start.line, end: node.loc!.end.line },
          quote, ...checks[check] });
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && 'type' in child) visit(child as t.Node, [...parents, node]);
      }
    }
  }
  visit(file, []);
  return candidates;
}

export function changedRanges(diff: string): Range[] {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(match => {
    const start = Math.max(1, Number(match[1]));
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return { start, end: start + Math.max(1, count) - 1 };
  });
}
