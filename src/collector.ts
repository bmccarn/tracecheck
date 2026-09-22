import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findCandidates, parseErrorCategory } from './checks.js';
import { collectionOptionsSchema, type CollectionOptions } from './collection-options.js';
import { hash, type DiscoveryScope, type Range, type ReviewPacket, type ReviewPlan, type Source } from './domain.js';
import { readGitChangeContext, type GitChange } from './git-context.js';
import { definedSymbols, focusSource, isSource, symbolRanges } from './evidence.js';
import { buildImportIndex } from './import-index.js';
import { hasSecret, readSource } from './safety.js';

const exec = promisify(execFile);
const MAX_PACKET_CHARS = 60_000;
const MAX_PACKET_BYTES = 80_000;
const MAX_PACKET_FILES = 16;
const MAX_PACKET_CHANGED = 8;
const SOURCE_EXCERPT_CHARS = 12_000;
const hasParser = (path: string) => /\.(?:[cm]?[jt]sx?)$/.test(path);
const PRIMARY_TARGET_CHARS = 30_000;
const PRIMARY_TARGET_BYTES = 40_000;
const isImportable = (path: string) => /\.(?:[cm]?[jt]sx?|py)$/.test(path);
const isTest = (path: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|\.(?:test|spec)\./.test(path);

export type CollectOptions = {
  repo: string; base?: string; includeUntracked?: boolean; task?: string; repositoryContext?: string;
  signal?: AbortSignal; focus?: boolean; collection?: CollectionOptions; discovery?: DiscoveryScope;
};

type Loaded = { source: Source; names?: string[] };
const sourceChars = (source: Source) => source.content.length + (source.before?.length ?? 0);
const sourceBytes = (source: Source) => Buffer.byteLength(JSON.stringify(source));

export async function collect(options: CollectOptions): Promise<ReviewPlan> {
  const settings = collectionOptionsSchema.parse(options.collection ?? {});
  const signal = AbortSignal.any([AbortSignal.timeout(settings.collectionTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  const git = async (root: string, args: string[]) => {
    signal.throwIfAborted();
    return (await exec('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000, signal })).stdout;
  };
  const root = await realpath((await git(resolve(options.repo), ['rev-parse', '--show-toplevel'])).trim());
  const base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${options.base ?? 'HEAD'}^{commit}`])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  // Rename detection runs once here; readGitChangeContext diffs each detected pair with the same default threshold.
  const changed: string[] = [];
  const renames = new Map<string, string>();
  const statusFields = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, '--'])).split('\0');
  if (statusFields.pop() !== '') throw new Error('Git change listing failed');
  for (let index = 0; index < statusFields.length;) {
    const status = statusFields[index++]!;
    const recordPaths = statusFields.slice(index, index += /^[RC]/.test(status) ? 2 : 1);
    if (!status || recordPaths.length !== (/^[RC]/.test(status) ? 2 : 1) || recordPaths.some(path => !path)) throw new Error('Git change listing failed');
    const path = recordPaths.at(-1)!;
    changed.push(path);
    if (status.startsWith('R')) renames.set(path, recordPaths[0]!);
  }
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const tracked = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);

  const known = new Set([...tracked, ...(options.includeUntracked ? untracked : [])]);
  const changePaths = [...new Set([...changed, ...(options.includeUntracked ? untracked : [])])].sort();
  const limitations: string[] = [];
  if (changePaths.length) limitations.push('Import/caller discovery is heuristic; unresolved imports, aliases, dynamic imports, and external contracts may be missing.');
  if (!options.includeUntracked && untracked.length) limitations.push(`${untracked.length} untracked file(s) excluded; use --include-untracked to include supported source files.`);

  const loaded = new Map<string, Loaded>();
  const candidates: ReviewPlan['candidates'] = [];
  const candidateIds = new Set<string>();
  const changedSourcePaths = new Set<string>();
  const omissions = new Map<string, { count: number; samples: string[] }>();
  const sourceIssues = new Map<string, string[]>();
  const recordOmission = (reason: string, path: string) => {
    const entry = omissions.get(reason) ?? { count: 0, samples: [] };
    entry.count++;
    if (entry.samples.length < 3) entry.samples.push(path);
    omissions.set(reason, entry);
  };
  const label = (path: string) => renames.has(path) ? `${renames.get(path)} -> ${path}` : path;
  const noteSource = (path: string, message: string) => {
    const issues = sourceIssues.get(path) ?? [];
    if (!issues.includes(message)) issues.push(message);
    sourceIssues.set(path, issues);
  };

  async function load(path: string, role: Source['role'], targets?: Range[], change?: GitChange, baseline?: string): Promise<Source | undefined> {
    const existing = loaded.get(path);
    if (existing) {
      if (role === 'changed' && existing.source.role !== 'changed') existing.source.role = 'changed';
      return existing.source;
    }
    if (!isSource(path)) {
      recordOmission('Unsupported or generated file', path);
      noteSource(path, `Unsupported or generated file omitted: ${path}`);
      return undefined;
    }
    try {
      const raw = await readSource(root, path, signal);
      if (raw.includes('\0') || hasSecret(raw)) throw new Error('Binary or potential secret-bearing file');
      let before = baseline;
      let ranges = targets ?? [{ start: 1, end: 80 }];
      let beforeRanges = ranges;
      if (role === 'changed') {
        if (change?.error) throw new Error(change.error);
        if (before && hasSecret(before)) throw new Error('Potential secret in base version');
        ranges = untracked.includes(path) ? [{ start: 1, end: raw.split('\n').length }] : change?.ranges ?? [];
        beforeRanges = change?.beforeRanges ?? ranges;
      }
      let excerptBudget = options.focus === false ? Math.floor(MAX_PACKET_CHARS / 2) : SOURCE_EXCERPT_CHARS;
      let current = focusSource(raw, ranges, excerptBudget);
      let old = before === undefined ? undefined : focusSource(before, beforeRanges, excerptBudget);
      const previousPath = role === 'changed' ? renames.get(path) : undefined;
      let source: Source = {
        path, ...(previousPath ? { previousPath } : {}), role, content: current.content, ...(old ? { before: old.content } : {}),
        evidence: { currentRanges: current.ranges, beforeRanges: old?.ranges, totalLines: current.totalLines,
          complete: current.complete && (!old || old.complete), digest: hash([raw, before]) },
      };
      while ((sourceChars(source) > MAX_PACKET_CHARS || sourceBytes(source) > MAX_PACKET_BYTES) && excerptBudget > 1) {
        excerptBudget = Math.max(1, Math.floor(excerptBudget / 2));
        current = focusSource(raw, ranges, excerptBudget);
        old = before === undefined ? undefined : focusSource(before, beforeRanges, excerptBudget);
        source = {
          path, ...(previousPath ? { previousPath } : {}), role, content: current.content, ...(old ? { before: old.content } : {}),
          evidence: { currentRanges: current.ranges, beforeRanges: old?.ranges, totalLines: current.totalLines,
            complete: current.complete && (!old || old.complete), digest: hash([raw, before]) },
        };
      }
      const names = role === 'changed' ? definedSymbols(raw) : undefined;
      loaded.set(path, { source, names });
      if (!source.evidence!.complete) noteSource(path, `Focused excerpts only; omitted lines are not reviewed: ${path}`);
      if (role === 'changed' && !ranges.every(range => current.ranges.some(captured => captured.start <= range.start && captured.end >= range.end))) {
        noteSource(path, `Changed ranges outside captured evidence omitted: ${path}`);
      }
      if (role !== 'changed' && targets?.length && !targets.every(range => current.ranges.some(captured => captured.start <= range.start && captured.end >= range.end))) {
        noteSource(path, `Relevant support ranges outside captured evidence omitted: ${path}`);
      }
      if (role === 'changed') {
        changedSourcePaths.add(path);
        if (hasParser(path)) {
          try {
            const found = findCandidates(path, raw, ranges);
            const covered = found.filter(candidate => current.ranges.some(range => range.start <= candidate.range.start && range.end >= candidate.range.end));
            for (const candidate of covered) if (!candidateIds.has(candidate.id)) { candidateIds.add(candidate.id); candidates.push(candidate); }
            if (covered.length !== found.length) noteSource(path, `Candidates outside captured evidence omitted: ${path}`);
          } catch (error) { noteSource(path, `Source could not be parsed (${parseErrorCategory(error)}); no candidates collected: ${path}`); }
        }
      }
      return source;
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error && /Symlink|external path|oversized|secret|Binary|changed during|Base version unavailable/i.test(error.message) ? error.message : 'Deleted or unreadable file';
      recordOmission(`${message} omitted`, label(path));
      noteSource(path, `${message} omitted: ${path}`);
      return undefined;
    }
  }

  // Safety-check current sources before they become diff pathspecs; baseline bytes stream directly into load.
  const eligibleChanges: string[] = [];
  for (const path of changePaths) {
    if (!isSource(path)) {
      recordOmission('Unsupported or generated file', label(path));
      noteSource(path, `Unsupported or generated file omitted: ${path}`);
      continue;
    }
    try {
      const raw = await readSource(root, path, signal);
      if (raw.includes('\0') || hasSecret(raw)) throw new Error('Binary or potential secret-bearing file');
      eligibleChanges.push(path);
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error && /Symlink|external path|oversized|secret|Binary|changed during|Base version unavailable/i.test(error.message) ? error.message : 'Deleted or unreadable file';
      recordOmission(`${message} omitted`, label(path));
      noteSource(path, `${message} omitted: ${path}`);
    }
  }
  // A rename from an unsupported or generated path keeps that content out of review, so the new path has no baseline.
  const baselineRenames = new Map<string, string>();
  for (const path of eligibleChanges) {
    const from = renames.get(path);
    if (!from) continue;
    if (isSource(from)) baselineRenames.set(path, from);
    else noteSource(path, `Renamed from unsupported or generated path ${from}; reviewed without a baseline: ${path}`);
  }
  await readGitChangeContext({ root, base, paths: eligibleChanges, renames: baselineRenames, signal,
    onBaseline: async (path, change, baseline) => { await load(path, 'changed', undefined, change, baseline); } });

  const indexPaths = tracked.filter(path => isSource(path) && isImportable(path)).sort();
  const index = await buildImportIndex({ root, paths: indexPaths, known, changedPaths: [...changedSourcePaths], signal, limits: settings, discovery: options.discovery });
  limitations.push(...index.limitations);
  const sharedPacketLimitations = [...limitations];

  const conventionalTests = new Map<string, string[]>();
  for (const path of tracked) {
    if (!isTest(path)) continue;
    const match = posix.basename(path).match(/^(?:test_)?(.+?)(?:\.(?:test|spec))?\.[^.]+$/);
    if (!match) continue;
    const entries = conventionalTests.get(match[1]!) ?? [];
    entries.push(path); conventionalTests.set(match[1]!, entries);
  }
  for (const paths of conventionalTests.values()) paths.sort();
  const relatedByChange = new Map<string, Map<string, Exclude<Source['role'], 'changed'>>>();
  const supportNames = new Map<string, Set<string>>();
  for (const path of [...changedSourcePaths].sort()) {
    const related = new Map<string, Exclude<Source['role'], 'changed'>>();
    for (const candidate of index.reverse.get(path) ?? []) if (!changedSourcePaths.has(candidate)) related.set(candidate, isTest(candidate) ? 'test' : 'caller');
    const stem = posix.basename(path).replace(/\.[^.]+$/, '');
    for (const candidate of conventionalTests.get(stem) ?? []) if (!changedSourcePaths.has(candidate)) related.set(candidate, 'test');
    for (const candidate of index.imports.get(path) ?? []) if (!changedSourcePaths.has(candidate) && !related.has(candidate)) related.set(candidate, 'dependency');
    const names = loaded.get(path)?.names ?? [];
    for (const relatedPath of related.keys()) {
      const targetNames = supportNames.get(relatedPath) ?? new Set<string>();
      for (const name of names) targetNames.add(name);
      supportNames.set(relatedPath, targetNames);
    }
    relatedByChange.set(path, related);
  }


  const packets: ReviewPacket[] = [];
  const sourceByPath = new Map([...loaded].map(([path, item]) => [path, item.source]));
  const primaryPaths = [...changedSourcePaths].sort();
  const batches: string[][] = [];
  let batch: string[] = []; let batchChars = 0; let batchBytes = 2;
  for (const path of primaryPaths) {
    const source = sourceByPath.get(path)!;
    const nextChars = batchChars + sourceChars(source);
    const nextBytes = batchBytes + sourceBytes(source) + (batch.length ? 1 : 0);
    if (batch.length && (batch.length >= MAX_PACKET_CHANGED || nextChars > PRIMARY_TARGET_CHARS || nextBytes > PRIMARY_TARGET_BYTES)) {
      batches.push(batch); batch = []; batchChars = 0; batchBytes = 2;
    }
    batch.push(path);
    batchChars += sourceChars(source);
    batchBytes += sourceBytes(source) + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length || !primaryPaths.length) batches.push(batch);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const primary = batches[batchIndex]!;
    const packetLimitations: string[] = [...sharedPacketLimitations];
    const paths: string[] = []; let chars = 0; let bytes = 2;
    const add = (path: string, required: boolean) => {
      const source = sourceByPath.get(path);
      if (!source || paths.includes(path)) return true;
      const nextChars = chars + sourceChars(source);
      const nextBytes = bytes + sourceBytes(source) + (paths.length ? 1 : 0);
      if (nextChars > MAX_PACKET_CHARS || nextBytes > MAX_PACKET_BYTES || paths.length >= MAX_PACKET_FILES) {
        if (required) packetLimitations.push(`Changed excerpt exceeds packet budget: ${path}`);
        else packetLimitations.push(`Context omitted by packet budget: ${path}`);
        return false;
      }
      paths.push(path); chars = nextChars; bytes = nextBytes; return true;
    };
    for (const path of primary) {
      if (!add(path, true)) throw new Error(`Focused changed evidence cannot fit packet: ${path}`);
      packetLimitations.push(...(sourceIssues.get(path) ?? []));
    }
    const relatedRoles = ['test', 'caller', 'dependency'] as const;
    const relatedQueues = primary.map(path => relatedRoles.map(role => [...(relatedByChange.get(path) ?? [])]
      .filter(([, relatedRole]) => relatedRole === role)
      .sort(([left], [right]) => left.localeCompare(right))));
    const related: Array<[string, Exclude<Source['role'], 'changed'>]> = [];
    const queuedRelated = new Set<string>();
    for (let offset = 0;; offset++) {
      let queuedAtOffset = false;
      for (const queues of relatedQueues) for (const queue of queues) {
        const entry = queue[offset];
        if (!entry) continue;
        queuedAtOffset = true;
        if (!queuedRelated.has(entry[0])) {
          queuedRelated.add(entry[0]);
          related.push(entry);
        }
      }
      if (!queuedAtOffset) break;
    }
    let attempted = 0;
    for (const [relatedPath, role] of related) {
      if (paths.length >= MAX_PACKET_FILES || attempted >= MAX_PACKET_FILES) {
        packetLimitations.push('Additional related context omitted by packet file budget.');
        break;
      }
      attempted++;
      let targets: Range[] | undefined;
      try {
        const relatedRaw = await readSource(root, relatedPath, signal);
        if (!relatedRaw.includes('\0') && !hasSecret(relatedRaw)) {
          const ranges = symbolRanges(relatedRaw, [...(supportNames.get(relatedPath) ?? [])]);
          targets = ranges.length ? ranges : undefined;
        }
      } catch { signal.throwIfAborted(); }
      const wasLoaded = loaded.has(relatedPath);
      const source = await load(relatedPath, role, targets);
      if (source) sourceByPath.set(relatedPath, source);
      if (source && add(relatedPath, false)) {
        packetLimitations.push(...(sourceIssues.get(relatedPath) ?? []));
      } else if (source && !wasLoaded) {
        sourceByPath.delete(relatedPath);
        loaded.delete(relatedPath);
        sourceIssues.delete(relatedPath);
      } else if (!source) {
        packetLimitations.push(...(sourceIssues.get(relatedPath) ?? []));
      }
    }
    const packetCandidates = candidates.filter(candidate => primary.includes(candidate.path)).map(candidate => candidate.id);
    packets.push({ id: hash({ primary, paths, packetLimitations }).slice(0, 24), changedPaths: primary, sourcePaths: paths, candidateIds: packetCandidates, limitations: packetLimitations });
  }

  for (const [reason, { count, samples }] of [...omissions].sort(([left], [right]) => left.localeCompare(right))) {
    limitations.push(`Collection omitted ${count} file(s): ${reason} (${samples.join(', ')}).`);
  }
  const sourceIssueCounts = new Map<string, { count: number; samples: string[] }>();
  for (const path of sourceByPath.keys()) {
    for (const issue of sourceIssues.get(path) ?? []) {
      const reason = issue.replace(/: [^:]+$/, '');
      const entry = sourceIssueCounts.get(reason) ?? { count: 0, samples: [] };
      entry.count++;
      if (entry.samples.length < 3) entry.samples.push(path);
      sourceIssueCounts.set(reason, entry);
    }
  }
  for (const [reason, { count, samples }] of [...sourceIssueCounts].sort(([left], [right]) => left.localeCompare(right))) {
    limitations.push(`Collected source limitation for ${count} file(s): ${reason} (${samples.join(', ')}).`);
  }
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== head) throw new Error('Repository HEAD changed during collection; retry the preview.');
  const sources = [...sourceByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const context = { task: options.task, repositoryContext: options.repositoryContext };
  const snapshot = hash({ root, base, head, settings, discovery: index.discovery, sources: sources.map(source => ({ path: source.path, previousPath: source.previousPath, role: source.role, evidence: source.evidence })), candidates, packets, limitations, ...context });
  return { schemaVersion: 1, root, base, head, sources, candidates, packets, limitations, discovery: index.discovery, ...context, snapshot };
}
