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

export function importsFor(path: string, content: string, known: Set<string>): string[] {
  const result = new Set<string>();
  const resolveStem = (stem: string, extensions: string[]) => {
    const normalized = posix.normalize(stem);
    const found = [normalized, ...extensions.map(extension => normalized + extension)].find(item => known.has(item));
    if (found) result.add(found);
  };
  if (path.endsWith('.py')) {
    for (const match of content.matchAll(/^\s*(?:from\s+([.\w]+)\s+import\s+([\w*]+)|import\s+([\w.]+))/gm)) {
      const module = match[1] ?? match[3]!;
      const dots = module.match(/^\.+/)?.[0].length ?? 0;
      const stem = module.slice(dots).replaceAll('.', '/');
      const roots = dots ? [posix.join(posix.dirname(path), ...Array(Math.max(0, dots - 1)).fill('..'))] : ['', 'src'];
      for (const root of roots) {
        resolveStem(posix.join(root, stem), ['.py', '/__init__.py']);
        if (match[2] && match[2] !== '*') resolveStem(posix.join(root, stem, match[2]), ['.py', '/__init__.py']);
      }
    }
  } else {
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (!match[1]!.startsWith('.')) continue;
      const stem = posix.join(posix.dirname(path), match[1]!);
      resolveStem(stem, ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']);
      if (stem.endsWith('.js')) resolveStem(stem.slice(0, -3), ['.ts', '.tsx']);
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
