import { parse, type ParserPlugin } from '@babel/parser';
import type { Node } from '@babel/types';
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

// Legacy decorators cover TypeScript experimentalDecorators, including parameter
// decorators; standard decorators also allow `export @dec class`.
const decoratorPlugins: ParserPlugin[][] = [['decorators-legacy', 'decoratorAutoAccessors'], ['decorators']];

export function parseSource(path: string, content: string) {
  const language: ParserPlugin[] = /\.[cm]?tsx?$/.test(path) ? ['typescript'] : [];
  // JSX stays off for .ts, .mts, and .cts so `<T>value` type assertions parse.
  if (/\.(?:[jt]sx|[cm]?js)$/.test(path)) language.push('jsx');
  let failure: unknown;
  for (const decorators of decoratorPlugins) {
    try { return parse(content, { sourceType: 'unambiguous', plugins: [...language, ...decorators] }); }
    catch (error) { failure ??= error; }
  }
  throw failure;
}

/** Names a parse failure by its error code; parser messages can quote source text. */
export function parseErrorCategory(error: unknown) {
  const code = (error as { reasonCode?: unknown } | undefined)?.reasonCode;
  return typeof code === 'string' && /^\w+$/.test(code) ? code : 'UnknownError';
}

// Babel's Function alias: the nodes that open a function scope.
const functionTypes: Record<string, true> = {
  FunctionDeclaration: true, FunctionExpression: true, ObjectMethod: true,
  ArrowFunctionExpression: true, ClassMethod: true, ClassPrivateMethod: true,
};
// Parser fields that hold positions or comments rather than syntax children.
const nonChildKeys: Record<string, true> = { loc: true, leadingComments: true, trailingComments: true, innerComments: true, comments: true };

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/**
 * Sites that cannot be defects: a non-zero literal divisor, a catch handler that
 * always rethrows, and a JSON.parse that its enclosing try statement handles.
 */
function isObviousNonIssue(node: Node, ancestors: Node[]) {
  if (node.type === 'BinaryExpression' || node.type === 'AssignmentExpression') {
    return (node.right.type === 'NumericLiteral' && node.right.value !== 0) || (node.right.type === 'BigIntLiteral' && node.right.value !== 0n);
  }
  if (node.type === 'CatchClause') return node.body.body.some(statement => statement.type === 'ThrowStatement');
  // A try block protects only code that runs while it executes, so the search stops at the nearest function.
  let child: Node = node;
  for (let index = ancestors.length - 1; index >= 0 && !functionTypes[ancestors[index]!.type]; index--) {
    const parent = ancestors[index]!;
    if (parent.type === 'TryStatement' && parent.handler && parent.block === child) return true;
    child = parent;
  }
  return false;
}

export function findCandidates(path: string, content: string, changed: Range[]): Candidate[] {
  const file = parseSource(path, content);
  const candidates: Candidate[] = [];
  const occurrences = new Map<string, number>();
  // The visited node's ancestors, outermost first. One stack serves the whole walk.
  const ancestors: Node[] = [];
  function visit(node: Node) {
    let check: keyof typeof checks | undefined;
    if ((node.type === 'BinaryExpression' && (node.operator === '/' || node.operator === '%'))
      || (node.type === 'AssignmentExpression' && (node.operator === '/=' || node.operator === '%='))) check = 'zero-divisor';
    if (node.type === 'CatchClause') check = 'swallowed-failure';
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'JSON'
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'parse') check = 'unhandled-json';
    if (check) {
      let containerIndex = ancestors.length - 1;
      while (containerIndex >= 0 && !functionTypes[ancestors[containerIndex]!.type]) containerIndex--;
      const container = ancestors[containerIndex];
      // Outside any function, the enclosing top-level statement bounds the site; ancestors start [File, Program, statement].
      const bounds = container ?? ancestors[2] ?? node;
      const scope = { start: bounds.loc!.start.line, end: bounds.loc!.end.line };
      const owner = ancestors[containerIndex - 1];
      const name = container === undefined ? '<anonymous-or-module>'
        : ('id' in container && container.id?.type === 'Identifier') ? container.id.name
        : ('key' in container && container.key.type === 'Identifier') ? container.key.name
        : owner?.type === 'VariableDeclarator' && owner.id.type === 'Identifier' ? owner.id.name : '<anonymous-or-module>';
      const symbol = name;
      const quote = content.slice(node.start!, node.end!);
      const key = hash([path, symbol, check, quote.replace(/\s+/g, ' ')]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      // Skipped sites still count as occurrences, so selected sites keep their IDs.
      if (!isObviousNonIssue(node, ancestors) && changed.some(range => range.start <= scope.end && range.end >= scope.start)) {
        candidates.push({ id: hash([key, occurrence]).slice(0, 24), check, path, symbol,
          range: { start: node.loc!.start.line, end: node.loc!.end.line },
          quote, ...checks[check] });
      }
    }
    ancestors.push(node);
    for (const key in node) {
      if (nonChildKeys[key]) continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      } else if (isNode(value)) visit(value);
    }
    ancestors.pop();
  }
  visit(file);
  return candidates;
}
