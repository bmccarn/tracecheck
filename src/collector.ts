import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, posix } from 'node:path';
import * as t from '@babel/types';
import { changedRanges, findCandidates, parseSource } from './checks.js';
import { hash, type Source, type ReviewPlan } from './domain.js';

const exec = promisify(execFile);
const hasParser = (path: string) => /\.(?:[cm]?[jt]sx?)$/.test(path);
const isSource = (path: string) => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|h|cpp|cs|rb|php|sh|sql|graphql|json|ya?ml|toml|md|css|html)$/.test(path)
  && !/(^|\/)(?:node_modules|dist|build|vendor|coverage|\.git)(\/|$)/.test(path)
  && !/(?:\.min\.js|package-lock\.json|pnpm-lock\.yaml)$/.test(path);
const git = async (root: string, args: string[]) => (await exec('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*['"][A-Za-z0-9_+\/-]{20,}['"]/i;

export async function collect(options: { repo: string; base?: string; includeUntracked?: boolean; task?: string; repositoryContext?: string }): Promise<ReviewPlan> {
  const root = await realpath((await git(resolve(options.repo), ['rev-parse', '--show-toplevel'])).trim());
  // Resolve user input before using it in subsequent Git operations.
  const base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${options.base ?? 'HEAD'}^{commit}`])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const changed = (await git(root, ['diff', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const paths = [...new Set([...changed, ...(options.includeUntracked ? untracked : [])])].sort();
  const tracked = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const known = new Set([...tracked, ...(options.includeUntracked ? untracked : [])]);
  const limitations: string[] = [];
  if (!options.includeUntracked && untracked.length) limitations.push(`${untracked.length} untracked file(s) excluded; use --include-untracked to include supported source files.`);
  const sources: Source[] = [];
  let remaining = 60_000;
  async function load(path: string, role: Source['role']): Promise<Source | undefined> {
    if (sources.some(source => source.path === path)) return;
    if (!isSource(path)) { limitations.push(`Unsupported or generated file omitted: ${path}`); return; }
    if (sources.length >= 16) { limitations.push(`File budget exhausted: ${path}`); return; }
    const absolute = resolve(root, path);
    try {
      const stat = await lstat(absolute);
      const physical = await realpath(absolute);
      const within = relative(root, physical);
      if (stat.isSymbolicLink() || within.startsWith('..') || within.startsWith('/')) {
        limitations.push(`Symlink or external path omitted: ${path}`); return;
      }
      if (!stat.isFile() || stat.size > 24_000) { limitations.push(`Nonregular or oversized file omitted: ${path}`); return; }
      const content = await readFile(absolute, 'utf8');
      if (content.includes('\0') || secretPattern.test(content)) { limitations.push(`Binary or potential secret-bearing file omitted: ${path}`); return; }
      let before: string | undefined;
      if (role === 'changed') {
        try { before = await git(root, ['show', `${base}:${path}`]); } catch { /* New file. */ }
        if (before && secretPattern.test(before)) { limitations.push(`Potential secret in base version; file omitted: ${path}`); return; }
      }
      const size = content.length + (before?.length ?? 0);
      if (size > remaining) { limitations.push(`Context budget exhausted: ${path}`); return; }
      remaining -= size;
      const source = { path, content, role, ...(before === undefined ? {} : { before }) };
      sources.push(source);
      return source;
    } catch { limitations.push(`Deleted or unreadable file omitted: ${path}`); return; }
  }
  const candidates: ReviewPlan['candidates'] = [];
  for (const path of paths) {
    const source = await load(path, 'changed');
    if (!source) continue;
    const ranges = untracked.includes(path) ? [{ start: 1, end: source.content.split('\n').length }]
      : changedRanges(await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, '--', path]));
    try { if (hasParser(path)) candidates.push(...findCandidates(path, source.content, ranges)); }
    catch { limitations.push(`Source could not be parsed; no candidates collected: ${path}`); }
  }
  // One hop only: no package execution, compiler plugins, or recursive crawling.
  for (const source of [...sources]) {
    if (!hasParser(source.path)) continue;
    let parsed;
    try { parsed = parseSource(source.path, source.content); } catch { continue; }
    for (const statement of parsed.program.body) {
      if (!t.isImportDeclaration(statement)) continue;
      const specifier = statement.source.value;
      if (!specifier.startsWith('.')) continue;
      const stem = posix.normalize(posix.join(posix.dirname(source.path), specifier));
      const candidates = [stem, stem.replace(/\.js$/, '.ts'), ...['.ts', '.tsx', '.js', '/index.ts', '/index.js'].map(ext => stem + ext)];
      const dependency = candidates.find(path => known.has(path));
      if (dependency) await load(dependency, 'dependency');
      else limitations.push(`Relative import not resolved: ${source.path} → ${specifier}`);
    }
    const stem = source.path.replace(/\.[^.]+$/, '');
    const basename = posix.basename(stem);
    for (const path of tracked.filter(path => path !== source.path && (path.startsWith(`${stem}.test.`) || path.startsWith(`${stem}.spec.`) || path.endsWith(`/${basename}.test.ts`) || path.endsWith(`/${basename}.spec.ts`))).slice(0, 2)) await load(path, 'test');
  }
  if (candidates.length > 40) limitations.push(`${candidates.length - 40} candidates omitted by the 40-candidate budget.`);
  const context = { task: options.task, repositoryContext: options.repositoryContext };
  return { schemaVersion: 1, root, base, head, sources, candidates: candidates.slice(0, 40), limitations, ...context,
    snapshot: hash({ base, head, sources, candidates: candidates.slice(0, 40), limitations, ...context }) };
}
