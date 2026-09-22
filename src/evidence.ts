import { posix } from 'node:path';
import type { Range } from './domain.js';

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

const PYTHON_MODULE = /\.py$/;
const PYTHON_TARGETS = ['.py', '/__init__.py'];
const SCRIPT_MODULE = /\.[cm]?[jt]sx?$/;
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

/** Resolves relative JS/TS and Python imports to known module files; other targets such as assets add no edge. */
export function importsFor(path: string, content: string, known: Set<string>): string[] {
  const result = new Set<string>();
  const resolveFirst = (candidates: string[], module: RegExp) => {
    const found = candidates.map(item => posix.normalize(item)).find(item => module.test(item) && known.has(item));
    if (found) result.add(found);
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
          resolveFirst(PYTHON_TARGETS.map(suffix => base + suffix), PYTHON_MODULE);
          for (const member of members) resolveFirst(PYTHON_TARGETS.map(suffix => posix.join(base, member) + suffix), PYTHON_MODULE);
        }
      }
    }
  } else {
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (!match[1]!.startsWith('.')) continue;
      const stem = posix.join(posix.dirname(path), match[1]!);
      resolveFirst([stem, ...SCRIPT_TARGETS.map(suffix => stem + suffix)], SCRIPT_MODULE);
      const extension = posix.extname(stem);
      const sources = SCRIPT_SOURCES[extension];
      if (sources) resolveFirst(sources.map(suffix => stem.slice(0, -extension.length) + suffix), SCRIPT_MODULE);
    }
  }
  return [...result];
}

export function symbolRanges(content: string, names: string[]): Range[] {
  const lines = content.split('\n');
  const wanted = names.filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
  const ranges: Range[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (wanted.some(name => new RegExp(`\\b${name}\\b`).test(lines[index]!))) ranges.push({ start: index + 1, end: Math.min(lines.length, index + 35) });
    if (ranges.length >= 12) break;
  }
  return ranges;
}
