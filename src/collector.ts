import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { changedRanges, findCandidates } from './checks.js';
import { hash, type Source, type ReviewPlan, type Range } from './domain.js';
import { hasSecret, readSource } from './safety.js';
import { focusSource, importsFor, symbolRanges } from './evidence.js';

const exec = promisify(execFile);
const hasParser = (path: string) => /\.(?:[cm]?[jt]sx?)$/.test(path);
const isTest = (path: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|\.(?:test|spec)\./.test(path);
const isSource = (path: string) => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|h|cpp|cs|rb|php|sh|sql|graphql|json|ya?ml|toml|md|css|html)$/.test(path)
  && !/(^|\/)(?:node_modules|dist|build|vendor|coverage|\.git|\.venv)(\/|$)/.test(path)
  && !/(?:\.min\.js|package-lock\.json|pnpm-lock\.yaml)$/.test(path);

export async function collect(options: { repo: string; base?: string; includeUntracked?: boolean; task?: string; repositoryContext?: string; signal?: AbortSignal; focus?: boolean }): Promise<ReviewPlan> {
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  const git = async (root: string, args: string[]) => {
    signal.throwIfAborted();
    return (await exec('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000, signal })).stdout;
  };
  const root = await realpath((await git(resolve(options.repo), ['rev-parse', '--show-toplevel'])).trim());
  const base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${options.base ?? 'HEAD'}^{commit}`])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const changed = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const tracked = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const basePaths = new Set((await git(root, ['ls-tree', '-r', '--name-only', '-z', base])).split('\0'));
  const known = new Set([...tracked, ...(options.includeUntracked ? untracked : [])]);
  const paths = [...new Set([...changed, ...(options.includeUntracked ? untracked : [])])].sort((a, b) => Number(isTest(a)) - Number(isTest(b)) || a.localeCompare(b));
  const limitations: string[] = [];
  if (paths.length) limitations.push('Import/caller discovery is heuristic; unresolved imports, aliases, dynamic imports, and external contracts may be missing.');
  const sources: Source[] = []; const candidates: ReviewPlan['candidates'] = [];
  const originals = new Map<string, string>(); let remaining = 60_000;
  if (!options.includeUntracked && untracked.length) limitations.push(`${untracked.length} untracked file(s) excluded; use --include-untracked to include supported source files.`);
  async function read(path: string) {
    const existing = originals.get(path); if (existing !== undefined) return existing;
    const value = await readSource(root, path, signal);
    if (value.includes('\0') || hasSecret(value)) throw new Error('Binary or potential secret-bearing file');
    originals.set(path, value); return value;
  }
  async function load(path: string, role: Source['role'], targets?: Range[]) {
    if (sources.some(source => source.path === path)) return;
    if (!isSource(path)) { limitations.push(`Unsupported or generated file omitted: ${path}`); return; }
    if (sources.length >= 16 || remaining < 1000) { limitations.push(`Context/file budget exhausted: ${path}`); return; }
    try {
      const content = await read(path);
      let before: string | undefined;
      let ranges = targets ?? [{ start: 1, end: 80 }];
      let beforeRanges = ranges;
      if (role === 'changed') {
        if (basePaths.has(path)) before = await git(root, ['show', '--no-ext-diff', '--no-textconv', `${base}:${path}`]);
        if (before && hasSecret(before)) throw new Error('Potential secret in base version');
        const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, '--', path]);
        ranges = untracked.includes(path) ? [{ start: 1, end: content.split('\n').length }] : changedRanges(diff);
        beforeRanges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)].map(match => ({ start: Math.max(1, Number(match[1])), end: Math.max(1, Number(match[1]) + Number(match[2] ?? 1) - 1) }));
      }
      const budget = Math.min(12_000, Math.floor(remaining / (before === undefined ? 1 : 2)));
      const current = focusSource(content, ranges, options.focus === false ? 60_000 : budget);
      const old = before === undefined ? undefined : focusSource(before, beforeRanges, options.focus === false ? 60_000 : budget);
      const size = current.content.length + (old?.content.length ?? 0);
      if (size > remaining) { limitations.push(`Context budget exhausted: ${path}`); return; }
      const source: Source = { path, role, content: current.content, ...(old ? { before: old.content } : {}),
        evidence: { currentRanges: current.ranges, beforeRanges: old?.ranges, totalLines: current.totalLines, complete: current.complete && (!old || old.complete), digest: hash([content, before]) } };
      sources.push(source); remaining -= size;
      if (!source.evidence!.complete) limitations.push(`Focused excerpts only; omitted lines are not reviewed: ${path}`);
      if (role === 'changed' && hasParser(path)) {
        try {
          const found = findCandidates(path, content, ranges);
          const covered = found.filter(candidate => current.ranges.some(range => range.start <= candidate.range.start && range.end >= candidate.range.end));
          candidates.push(...covered);
          if (covered.length !== found.length) limitations.push(`Candidates outside captured evidence omitted: ${path}`);
        } catch { limitations.push(`Source could not be parsed; no candidates collected: ${path}`); }
      }
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error && /Symlink|external path|oversized|secret|Binary|changed during/.test(error.message) ? error.message : 'Deleted or unreadable file';
      limitations.push(`${message} omitted: ${path}`);
    }
  }
  // Reserve capacity for contracts, callers, and tests instead of filling all slots with edits.
  for (const path of paths.slice(0, 8)) await load(path, 'changed');
  for (const path of paths.slice(8)) limitations.push(`Changed-file budget exhausted: ${path}`);
  const changedSources = [...sources];
  const imports = new Map<string, string[]>();
  const indexable = tracked.filter(path => isSource(path) && (hasParser(path) || path.endsWith('.py')))
    .sort((a, b) => Number(isTest(b)) - Number(isTest(a)) || a.localeCompare(b));
  let indexedBytes = 0;
  for (const path of indexable.slice(0, 200)) {
    if (indexedBytes > 8_000_000) { limitations.push('Caller/import discovery stopped at the 8 MB scan budget.'); break; }
    try { const content = await read(path); indexedBytes += Buffer.byteLength(content); imports.set(path, importsFor(path, content, known)); } catch { signal.throwIfAborted(); }
  }
  if (indexable.length > 200) limitations.push('Caller/import discovery limited to 200 files; the graph is incomplete.');
  for (const source of changedSources) {
    const names = [...(originals.get(source.path) ?? '').matchAll(/(?:def|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]!);
    const reverse = [...imports].filter(([path, dependencies]) => path !== source.path && dependencies.includes(source.path)).map(([path]) => path);
    const stem = posix.basename(source.path).replace(/\.[^.]+$/, '');
    const tests = [...new Set([...reverse.filter(isTest), ...tracked.filter(path => isTest(path) && (posix.basename(path).startsWith(`test_${stem}.`) || posix.basename(path).startsWith(`${stem}.test.`) || posix.basename(path).startsWith(`${stem}.spec.`)))])];
    const related = [...tests.slice(0, 2).map(path => [path, 'test'] as const), ...reverse.filter(path => !isTest(path)).slice(0, 2).map(path => [path, 'caller'] as const),
      ...(imports.get(source.path) ?? importsFor(source.path, originals.get(source.path) ?? '', known)).slice(0, 3).map(path => [path, 'dependency'] as const)];
    if ((imports.get(source.path)?.length ?? 0) > 3) limitations.push(`Dependency selection limited: ${source.path}`);
    if (tests.length > 2 || reverse.filter(path => !isTest(path)).length > 2) limitations.push(`Related test/caller selection limited: ${source.path}`);
    for (const [path, role] of related) {
      let targets: Range[] = [];
      try { targets = symbolRanges(await read(path), names); } catch { signal.throwIfAborted(); }
      await load(path, role, targets.length ? targets : undefined);
    }
  }
  if (candidates.length > 40) limitations.push(`${candidates.length - 40} candidates omitted by the 40-candidate budget.`);
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== head) throw new Error('Repository HEAD changed during collection; retry the preview.');
  const context = { task: options.task, repositoryContext: options.repositoryContext };
  return { schemaVersion: 1, root, base, head, sources, candidates: candidates.slice(0, 40), limitations, ...context,
    snapshot: hash({ root, base, head, sources, candidates: candidates.slice(0, 40), limitations, ...context }) };
}
