import { posix } from 'node:path';
import type { Range } from './domain.js';
import type { PathAliases } from './path-aliases.js';

/** Bounded line excerpts; locations always refer to the original file. */
export function focusSource(content: string, targets: Range[], maxCharacters = 12_000) {
  const lines = content.split('\n');
  if (content.length <= maxCharacters) return { content, ranges: [{ start: 1, end: lines.length }], totalLines: lines.length, complete: true };
  // Keep a nearby function's body when it fits; arbitrary windows can hide guards.
  const expanded = targets.map(target => {
    for (let index = Math.min(target.start - 1, lines.length - 1); index >= Math.max(0, target.start - 120); index--) {
      const line = lines[index]!;
      if (!/^\s*(?:(?:export|async)\s+)*(?:def|function)\s+/.test(line)) continue;
      const indent = line.length - line.trimStart().length;
      let end = Math.min(lines.length, index + 120);
      if (/^\s*(?:async\s+)?def\s+/.test(line)) {
        for (let next = index + 1; next < end; next++) {
          const value = lines[next]!;
          if (value.trim() && value.length - value.trimStart().length <= indent) { end = next; break; }
        }
      }
      if (end >= target.end) return { start: index + 1, end };
      break;
    }
    return target;
  });
  const requested = [{ start: 1, end: Math.min(20, lines.length) }, ...expanded.map(range => ({
    start: Math.max(1, range.start - 12), end: Math.min(lines.length, range.end + 12),
  }))].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of requested) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const ranges: Range[] = []; const parts: string[] = []; let remaining = maxCharacters;
  for (const range of merged) {
    let end = range.start - 1; const selected: string[] = [];
    const header = `[Original lines ${range.start}-${range.end}]\n`;
    remaining -= header.length + 2;
    for (let line = range.start; line <= range.end; line++) {
      const text = `${line}: ${lines[line - 1]}\n`;
      if (text.length > remaining) break;
      selected.push(text); remaining -= text.length; end = line;
    }
    if (end >= range.start) { ranges.push({ start: range.start, end }); parts.push(`[Original lines ${range.start}-${end}]\n${selected.join('')}`); }
  }
  return { content: parts.join('\n'), ranges, totalLines: lines.length, complete: false };
}

/** Files the collector reviews as source; imports of anything else, such as images, add no edge. */
export const isSource = (path: string) => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|h|cpp|cs|rb|php|sh|sql|graphql|json|ya?ml|toml|md|css|html)$/.test(path)
  && !/(^|\/)(?:node_modules|dist|build|vendor|coverage|\.git|\.venv)(\/|$)/.test(path)
  && !/(?:\.min\.js|package-lock\.json|pnpm-lock\.yaml)$/.test(path);

/** Test files, by directory or by file name convention. */
export const isTest = (path: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|\.(?:test|spec)\./.test(path);

/** Files grouped by the reason they were omitted or limited, reported as one limitation per reason. */
export class FileTally {
  private readonly reasons = new Map<string, { count: number; samples: string[] }>();
  /** `namesEvery` selects the reasons whose limitation names every file rather than the first three. */
  constructor(private readonly namesEvery: (reason: string) => boolean = () => false) {}

  add(reason: string, path: string): void {
    const entry = this.reasons.get(reason) ?? { count: 0, samples: [] };
    entry.count++;
    if (entry.samples.length < 3 || this.namesEvery(reason)) entry.samples.push(path);
    this.reasons.set(reason, entry);
  }

  /** One `${lead} N file(s): reason (samples).` limitation per reason, in reason order. */
  limitations(lead: string): string[] {
    return [...this.reasons].sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, { count, samples }]) => `${lead} ${count} file(s): ${reason} (${samples.join(', ')}).`);
  }
}

const PYTHON_TARGETS = ['.py', '/__init__.py'];
// Extensionless specifiers and directory imports, in resolution order.
const SCRIPT_TARGETS = ['.ts', '.tsx', '.js', '.jsx',
  ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map(extension => `/index.${extension}`)];
// NodeNext: an emitted-extension specifier names the TypeScript source that produces it.
const SCRIPT_SOURCES: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** Names in a Python import list: `a.b as x, c`, optionally parenthesized with comments. */
function pythonNames(list: string): string[] {
  return list.replace(/#[^\n]*/g, '').replace(/[()]/g, '').split(',')
    .map(item => item.trim().split(/\s+/)[0]!).filter(name => /^[\w.*]+$/.test(name));
}

/** Stems a non-relative specifier maps to, in TypeScript's order: the best `paths` match, else `baseUrl`. */
function aliasStems(specifier: string, aliases: PathAliases): string[] {
  let best: { prefix: string; captured: string; targets: string[] } | undefined;
  for (const [pattern, targets] of Object.entries(aliases.paths ?? {})) {
    if (pattern === specifier) return targets;
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, captured: specifier.slice(prefix.length, specifier.length - suffix.length), targets };
  }
  if (best) return best.targets.map(target => target.replace('*', best.captured));
  return aliases.baseUrl === undefined ? [] : [posix.join(aliases.baseUrl, specifier)];
}

/**
 * Resolves relative JS/TS and Python imports, plus JS/TS `paths` and `baseUrl`
 * aliases, to known source files; unsupported targets such as images add no edge.
 */
export function importsFor(path: string, content: string, known: Set<string>, aliases?: PathAliases): string[] {
  const result = new Set<string>();
  const resolveFirst = (candidates: string[]) => {
    const found = candidates.map(item => posix.normalize(item)).find(item => isSource(item) && known.has(item));
    if (found) result.add(found);
    return found !== undefined;
  };
  if (path.endsWith('.py')) {
    const statements = content.replace(/\\\r?\n/g, ' ');
    for (const match of statements.matchAll(/^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import\b[ \t]*(\([^)]*\)|[^\n;#]*)|import[ \t]+([^\n;#]*))/gm)) {
      const [, from, imported, plain] = match;
      const members = from ? pythonNames(imported!).filter(name => /^\w+$/.test(name)) : [];
      for (const module of from ? [from] : pythonNames(plain!)) {
        const dots = module.match(/^\.+/)?.[0].length ?? 0;
        const stem = module.slice(dots).replaceAll('.', '/');
        const roots = dots ? [posix.join(posix.dirname(path), ...Array(Math.max(0, dots - 1)).fill('..'))] : ['', 'src'];
        for (const root of roots) {
          const base = posix.join(root, stem);
          resolveFirst(PYTHON_TARGETS.map(suffix => base + suffix));
          for (const member of members) resolveFirst(PYTHON_TARGETS.map(suffix => posix.join(base, member) + suffix));
        }
      }
    }
  } else {
    const resolveScript = (stem: string) => {
      const direct = resolveFirst([stem, ...SCRIPT_TARGETS.map(suffix => stem + suffix)]);
      const extension = posix.extname(stem);
      const sources = SCRIPT_SOURCES[extension];
      return (sources ? resolveFirst(sources.map(suffix => stem.slice(0, -extension.length) + suffix)) : false) || direct;
    };
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) resolveScript(posix.join(posix.dirname(path), specifier));
      // The first substitution that names a known file wins, as in TypeScript.
      else if (aliases) aliasStems(specifier, aliases).some(resolveScript);
    }
  }
  return [...result];
}

// `def`/`function`/`class` names, and `const`/`let`/`var` bound to a function expression or an arrow function
// (optionally typed, async, or generic; parameter lists may nest one level of parentheses).
const DEFINED_SYMBOL = /(?:def|function|class)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::(?:[^=;]|=>)*?)?=\s*(?:async\b\s*)?(?:function\b|(?:<[^<>]*>\s*)?\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::[^=;]*?)?=>|[A-Za-z_$][\w$]*\s*=>)/g;

/** Names a changed file defines, used to focus its related files on the lines that mention them. */
export function definedSymbols(content: string): string[] {
  return [...new Set(Array.from(content.matchAll(DEFINED_SYMBOL), match => (match[1] ?? match[2])!))];
}

// A name bound on a line: the defined-symbol forms plus plain bindings and type declarations.
const DECLARED_NAME = /\b(?:def|function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
// A class or object method header, such as `async parse(input) {`; control-flow statements share the shape.
const METHOD = /^\s*(?:(?:static|async|public|private|protected|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\([^()]*\)\s*(?::[^{;]*)?\{\s*$/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do']);

/**
 * Names a change touches: names bound on the changed lines, and each definition that encloses a changed line, found by
 * walking back through definitions indented less than the lines inside them. Indentation stands in for a parse, so an
 * earlier nested helper can be named too.
 */
export function changedSymbols(content: string, ranges: Range[]): string[] {
  const lines = content.split('\n');
  const indents = lines.map(line => line.length - line.trimStart().length);
  const definitions: Array<{ line: number; name: string }> = [];
  let line = 0;
  let nextLineStart = lines[0]!.length + 1;
  for (const match of content.matchAll(DEFINED_SYMBOL)) {
    while (line + 1 < lines.length && nextLineStart <= match.index) nextLineStart += lines[++line]!.length + 1;
    definitions.push({ line, name: (match[1] ?? match[2])! });
  }
  lines.forEach((text, index) => {
    const name = text.match(METHOD)?.[1];
    if (name && !NOT_METHODS.has(name)) definitions.push({ line: index, name });
  });
  definitions.sort((left, right) => right.line - left.line);
  const names = new Set<string>();
  for (const range of ranges) {
    const first = Math.max(range.start, 1) - 1;
    const last = Math.min(range.end, lines.length);
    let threshold = Infinity;
    for (let index = first; index < last; index++) {
      for (const match of lines[index]!.matchAll(DECLARED_NAME)) names.add(match[1]!);
      if (lines[index]!.trim()) threshold = Math.min(threshold, indents[index]!);
    }
    for (const definition of definitions) {
      if (threshold === 0 || threshold === Infinity) break;
      if (definition.line >= first || indents[definition.line]! >= threshold) continue;
      names.add(definition.name);
      threshold = indents[definition.line]!;
    }
  }
  return [...names];
}

/** Every name the file binds with a declaration keyword, used to tell whether changed lines use a dependency. */
export function declaredNames(content: string): string[] {
  return [...new Set(Array.from(content.matchAll(DECLARED_NAME), match => match[1]!))];
}

/** A pattern that matches any of `names` as a whole identifier, or undefined when none is a valid identifier. */
export function namePattern(names: string[]): RegExp | undefined {
  const wanted = [...new Set(names.filter(name => /^[A-Za-z_$][\w$]*$/.test(name)))];
  if (!wanted.length) return undefined;
  // `$` is an identifier character, so `\b` cannot delimit names such as `$state`.
  return new RegExp(`(?<![\\w$])(?:${wanted.map(name => name.replaceAll('$', '\\$')).join('|')})(?![\\w$])`);
}


export function symbolRanges(content: string, names: string[]): Range[] {
  const pattern = namePattern(names);
  if (!pattern) return [];
  const lines = content.split('\n');
  const ranges: Range[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (pattern.test(lines[index]!)) ranges.push({ start: index + 1, end: Math.min(lines.length, index + 35) });
    if (ranges.length >= 12) break;
  }
  return ranges;
}
