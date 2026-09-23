import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findCandidates, parseErrorCategory } from './checks.js';
import { collectionSettingsSchema, type CollectionOptions } from './collection-options.js';
import { hash, type DiscoveryScope, type Range, type ReviewPacket, type ReviewPlan, type Source } from './domain.js';
import { gitEnvironment, readGitChangeContext, readGitRecords, type GitChange } from './git-context.js';
import { definedSymbols, FileTally, focusSource, isSource, isTest, symbolRanges } from './evidence.js';
import { buildImportIndex } from './import-index.js';
import { failureReason, hasSecret, readSource } from './safety.js';
import type { ProjectConfig } from './project-config.js';

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

export type CollectOptions = {
  repo: string; base?: string; includeUntracked?: boolean; task?: string; repositoryContext?: string;
  signal?: AbortSignal; collection?: CollectionOptions; discovery?: DiscoveryScope;
  /** Validated content of the repository configuration file, if any; a change to it changes the snapshot. */
  projectConfig?: ProjectConfig;
  /** Called as each collection phase starts, with a short description of the phase. */
  onPhase?: (message: string) => void;
};

type Loaded = { source: Source; names?: string[] };
const sourceChars = (source: Source) => source.content.length + (source.before?.length ?? 0);
const sourceBytes = (source: Source) => Buffer.byteLength(JSON.stringify(source));

export async function collect(options: CollectOptions): Promise<ReviewPlan> {
  const settings = collectionSettingsSchema.parse(options.collection ?? {});
  const signal = AbortSignal.any([AbortSignal.timeout(settings.collectionTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  // Every Git command runs under the collection signal, so its timeout is the remaining collection budget.
  const git = async (root: string, args: string[]) => {
    signal.throwIfAborted();
    return (await exec('git', ['-C', root, ...args], { signal, env: gitEnvironment() })).stdout;
  };
  const root = await realpath((await git(resolve(options.repo), ['rev-parse', '--show-toplevel'])).trim());
  const base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${options.base ?? 'HEAD'}^{commit}`])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  // Rename detection runs once here; readGitChangeContext diffs each detected pair with the same default threshold.
  const changed: string[] = [];
  const renames = new Map<string, string>();
  options.onPhase?.('Listing changed files');
  const statusFields = await readGitRecords(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, '--'], signal, 'Git change listing failed');
  for (let index = 0; index < statusFields.length;) {
    const status = statusFields[index++]!;
    const recordPaths = statusFields.slice(index, index += /^[RC]/.test(status) ? 2 : 1);
    if (!status || recordPaths.length !== (/^[RC]/.test(status) ? 2 : 1) || recordPaths.some(path => !path)) throw new Error('Git change listing failed');
    const path = recordPaths.at(-1)!;
    changed.push(path);
    if (status.startsWith('R')) renames.set(path, recordPaths[0]!);
  }
  const untracked = (await readGitRecords(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal, 'Git untracked-file listing failed')).filter(Boolean);
  const tracked = (await readGitRecords(root, ['ls-files', '-z'], signal, 'Git tracked-file listing failed')).filter(Boolean);
  const untrackedPaths = new Set(untracked);

  const known = new Set([...tracked, ...(options.includeUntracked ? untracked : [])]);
  const changePaths = [...new Set([...changed, ...(options.includeUntracked ? untracked : [])])].sort();
  const limitations: string[] = [];
  if (changePaths.length) limitations.push('Import/caller discovery is heuristic; path aliases resolve only through repository tsconfig.json or jsconfig.json files, and unresolved imports, dynamic imports, and external contracts may be missing.');
  if (!options.includeUntracked && untracked.length) limitations.push(`${untracked.length} untracked file(s) excluded; use --include-untracked to include supported source files.`);

  const loaded = new Map<string, Loaded>();
  const candidates: ReviewPlan['candidates'] = [];
  const candidateIds = new Set<string>();
  const changedSourcePaths = new Set<string>();
  // Name every file flagged for a potential credential so each one can be inspected.
  const namesCredential = (reason: string) => reason.includes('potential credential');
  const omissions = new FileTally(namesCredential);
  // Reasons per path; each is reported as `${reason}: ${path}`, and counts group by reason.
  const sourceIssues = new Map<string, string[]>();
  const label = (path: string) => renames.has(path) ? `${renames.get(path)} -> ${path}` : path;
  const noteSource = (path: string, reason: string) => {
    const issues = sourceIssues.get(path) ?? [];
    if (!issues.includes(reason)) issues.push(reason);
    sourceIssues.set(path, issues);
  };
  const issueMessages = (path: string) => (sourceIssues.get(path) ?? []).map(reason => `${reason}: ${path}`);
  // An omitted file is counted under its reason and noted on its path, so every packet that needs it names the gap.
  const omitUnsupported = (path: string, sample: string) => {
    omissions.add('Unsupported or generated file', sample);
    noteSource(path, 'Unsupported or generated file omitted');
  };
  const omitUnreadable = (path: string, error: unknown) => {
    signal.throwIfAborted();
    const reason = `${failureReason(error, 'Deleted or unreadable file')} omitted`;
    omissions.add(reason, label(path));
    noteSource(path, reason);
  };
  // Each file is read and screened at most once per collection. A failure is kept too, so every later use reports it.
  const reads = new Map<string, Promise<string>>();
  const screenedRead = (path: string): Promise<string> => {
    let read = reads.get(path);
    if (!read) {
      read = readSource(root, path, signal).then(raw => {
        if (raw.includes('\0')) throw new Error('Binary file');
        if (hasSecret(raw)) throw new Error('File with a potential credential');
        return raw;
      });
      reads.set(path, read);
    }
    return read;
  };

  async function load(path: string, role: Source['role'], targets?: Range[], change?: GitChange, baseline?: string): Promise<Source | undefined> {
    // Each changed file loads once, before any related file, so a file loaded earlier never has to become a changed source.
    const existing = loaded.get(path);
    if (existing) return existing.source;
    if (!isSource(path)) {
      omitUnsupported(path, path);
      return undefined;
    }
    try {
      const raw = await screenedRead(path);
      let before = baseline;
      let ranges = targets ?? [{ start: 1, end: 80 }];
      let beforeRanges = ranges;
      if (role === 'changed') {
        if (change?.error) throw new Error(change.error);
        // The current text passed screening, so the change is still reviewed, only without the flagged baseline.
        if (before && hasSecret(before)) {
          before = undefined;
          noteSource(path, 'Base version with a potential credential omitted; reviewed without a baseline');
        }
        ranges = untrackedPaths.has(path) ? [{ start: 1, end: raw.split('\n').length }] : change?.ranges ?? [];
        beforeRanges = change?.beforeRanges ?? ranges;
        if (change?.noHunks === 'mode-only') noteSource(path, 'File mode changed without a content change; no changed lines to review');
        if (change?.noHunks === 'diff-suppressed') noteSource(path, 'Git reported no textual diff (binary or -diff attribute); changed lines are unknown');
      }
      let excerptBudget = SOURCE_EXCERPT_CHARS;
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
      // A loaded changed file is never read again, so its full text need not stay in memory.
      if (role === 'changed') reads.delete(path);
      if (!source.evidence!.complete) noteSource(path, 'Focused excerpts only; omitted lines are not reviewed');
      if (role === 'changed' && !ranges.every(range => current.ranges.some(captured => captured.start <= range.start && captured.end >= range.end))) {
        noteSource(path, 'Changed ranges outside captured evidence omitted');
      }
      if (role !== 'changed' && targets?.length && !targets.every(range => current.ranges.some(captured => captured.start <= range.start && captured.end >= range.end))) {
        noteSource(path, 'Relevant support ranges outside captured evidence omitted');
      }
      if (role === 'changed') {
        changedSourcePaths.add(path);
        if (hasParser(path)) {
          try {
            const found = findCandidates(path, raw, ranges);
            const covered = found.filter(candidate => current.ranges.some(range => range.start <= candidate.range.start && range.end >= candidate.range.end));
            for (const candidate of covered) if (!candidateIds.has(candidate.id)) { candidateIds.add(candidate.id); candidates.push(candidate); }
            if (covered.length !== found.length) noteSource(path, 'Candidates outside captured evidence omitted');
          } catch (error) { noteSource(path, `Source could not be parsed (${parseErrorCategory(error)}); no candidates collected`); }
        }
      }
      return source;
    } catch (error) {
      omitUnreadable(path, error);
      return undefined;
    }
  }

  // Safety-check current sources before they become diff pathspecs; baseline bytes stream directly into load.
  options.onPhase?.('Reading changed files');
  const eligibleChanges: string[] = [];
  for (const path of changePaths) {
    if (!isSource(path)) {
      omitUnsupported(path, label(path));
      continue;
    }
    try {
      await screenedRead(path);
      eligibleChanges.push(path);
    } catch (error) {
      omitUnreadable(path, error);
    }
  }
  // A rename from an unsupported or generated path keeps that content out of review, so the new path has no baseline.
  const baselineRenames = new Map<string, string>();
  for (const path of eligibleChanges) {
    const from = renames.get(path);
    if (!from) continue;
    if (isSource(from)) baselineRenames.set(path, from);
    else noteSource(path, `Renamed from unsupported or generated path ${from}; reviewed without a baseline`);
  }
  await readGitChangeContext({ root, base, paths: eligibleChanges, renames: baselineRenames, signal,
    onBaseline: async (path, change, baseline) => { await load(path, 'changed', undefined, change, baseline); } });

  const indexPaths = tracked.filter(path => isSource(path) && isImportable(path)).sort();
  options.onPhase?.('Indexing imports');
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
  const supportTargets = new Map<string, Range[] | undefined>();
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


  options.onPhase?.('Assembling change packets');
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
      packetLimitations.push(...issueMessages(path));
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
      // Support targets depend only on the file and the changed symbols, so each file is parsed once for every packet.
      let targets = supportTargets.get(relatedPath);
      if (!supportTargets.has(relatedPath)) {
        try {
          const ranges = symbolRanges(await screenedRead(relatedPath), [...(supportNames.get(relatedPath) ?? [])]);
          targets = ranges.length ? ranges : undefined;
        } catch { signal.throwIfAborted(); }
        supportTargets.set(relatedPath, targets);
      }
      const wasLoaded = loaded.has(relatedPath);
      const source = await load(relatedPath, role, targets);
      if (source) sourceByPath.set(relatedPath, source);
      if (source && add(relatedPath, false)) {
        packetLimitations.push(...issueMessages(relatedPath));
      } else if (source && !wasLoaded) {
        sourceByPath.delete(relatedPath);
        loaded.delete(relatedPath);
        sourceIssues.delete(relatedPath);
      } else if (!source) {
        packetLimitations.push(...issueMessages(relatedPath));
      }
    }
    const packetCandidates = candidates.filter(candidate => primary.includes(candidate.path)).map(candidate => candidate.id);
    packets.push({ id: hash({ primary, paths, packetLimitations }).slice(0, 24), changedPaths: primary, sourcePaths: paths, candidateIds: packetCandidates, limitations: packetLimitations });
  }

  const sourceIssueCounts = new FileTally(namesCredential);
  for (const path of sourceByPath.keys()) {
    for (const reason of sourceIssues.get(path) ?? []) sourceIssueCounts.add(reason, path);
  }
  limitations.push(...omissions.limitations('Collection omitted'), ...sourceIssueCounts.limitations('Collected source limitation for'));
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== head) throw new Error('Repository HEAD changed during collection; retry the preview.');
  const sources = [...sourceByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const context = { task: options.task, repositoryContext: options.repositoryContext };
  const snapshot = hash({ root, base, head, settings, discovery: index.discovery, sources: sources.map(source => ({ path: source.path, previousPath: source.previousPath, role: source.role, evidence: source.evidence })), candidates, packets, limitations, ...context, ...(options.projectConfig ? { projectConfig: options.projectConfig } : {}) });
  return { schemaVersion: 1, root, base, head, sources, candidates, packets, limitations, discovery: index.discovery, ...context, snapshot };
}
