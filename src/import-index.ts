import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { posix } from 'node:path';
import type { CollectionSettings } from './collection-options.js';
import type { DiscoveryScope } from './domain.js';
import { importsFor } from './evidence.js';
import { createPathAliasLoader, type PathAliases } from './path-aliases.js';
import { hasSecret, readSourceFile, type FileIdentity } from './safety.js';

type Fingerprint = FileIdentity;

// `aliases` keys the path alias settings the edges were resolved with.
type Entry = { fingerprint: Fingerprint; aliases: string; edges: string[] };
type Aliases = { key: string; aliases?: PathAliases };
type RootCache = { identity: string; universe: string; known: string; entries: Map<string, Entry> };

const MAX_CACHE_ROOTS = 8;
const MAX_CACHE_ENTRIES = 100_000;
const caches = new Map<string, RootCache>();
const testPath = (path: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|\.(?:test|spec)\./.test(path);

function fingerprintMatches(left: Fingerprint, right: Fingerprint): boolean {
  return left.physical === right.physical && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function inside(root: string, physical: string): boolean {
  const path = relative(root, physical);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}

async function metadata(root: string, path: string, signal?: AbortSignal): Promise<Fingerprint> {
  signal?.throwIfAborted();
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) throw new Error('External path');
  const logical = await lstat(absolute);
  if (logical.isSymbolicLink()) throw new Error('Symlink or external path');
  const physical = await realpath(absolute);
  if (!inside(root, physical)) throw new Error('External path');
  const current = await lstat(physical);
  if (!current.isFile() || current.isSymbolicLink()) throw new Error('Nonregular file');
  return { physical, dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs };
}

function interleave(paths: string[], changedPaths: string[]): string[] {
  const changed = new Set(changedPaths);
  const changedDirectories = new Set(changedPaths.map(path => posix.dirname(path)));
  const changedFirst = paths.filter(path => changed.has(path));
  const application = [
    ...paths.filter(path => !changed.has(path) && changedDirectories.has(posix.dirname(path)) && !testPath(path)),
    ...paths.filter(path => !changed.has(path) && !changedDirectories.has(posix.dirname(path)) && !testPath(path)),
  ];
  const tests = [
    ...paths.filter(path => !changed.has(path) && changedDirectories.has(posix.dirname(path)) && testPath(path)),
    ...paths.filter(path => !changed.has(path) && !changedDirectories.has(posix.dirname(path)) && testPath(path)),
  ];
  const result = [...changedFirst];
  for (let index = 0; index < Math.max(application.length, tests.length); index++) {
    const applicationPath = application[index];
    const test = tests[index];
    if (applicationPath) result.push(applicationPath);
    if (test) result.push(test);
  }
  return result;
}

function boundedCache(root: string, cache: RootCache): void {
  caches.delete(root);
  caches.set(root, cache);
  while (caches.size > MAX_CACHE_ROOTS) caches.delete(caches.keys().next().value!);
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && /Symlink|External path|Nonregular|oversized|credential|Binary|changed during/.test(error.message)) return error.message;
  return 'Unreadable file';
}

type MetadataResult =
  | { kind: 'metadata'; fingerprint: Fingerprint; aliases: Aliases }
  | { kind: 'omitted'; reason: string }
  | { kind: 'interrupted' };
type Indexed =
  | { kind: 'cached'; edges: string[] }
  | { kind: 'indexed'; fingerprint: Fingerprint; aliases: string; edges: string[] }
  | { kind: 'omitted'; reason: string }
  | { kind: 'interrupted' };
type Admission = Indexed | { kind: 'read'; fingerprint: Fingerprint; aliases: Aliases };

const INDEX_IO_CONCURRENCY = 16;

/**
 * Builds a bounded, safe import graph. Cache entries retain only checked file
 * identities and resolved edges; source text is never retained after parsing.
 */
export async function buildImportIndex(options: {
  root: string;
  paths: string[];
  known: Set<string>;
  changedPaths: string[];
  discovery?: DiscoveryScope;
  signal?: AbortSignal;
  limits: CollectionSettings;
}): Promise<{ imports: Map<string, string[]>; reverse: Map<string, string[]>; limitations: string[]; discovery: DiscoveryScope }> {
  options.signal?.throwIfAborted();
  const physicalRoot = await realpath(options.root);
  const rootStat = await lstat(physicalRoot);
  const rootIdentity = `${physicalRoot}\0${rootStat.dev}\0${rootStat.ino}`;
  const paths = [...new Set(options.paths)].sort();
  const universe = paths.join('\0');
  const known = [...options.known].sort().join('\0');
  let cache = caches.get(physicalRoot);
  if (!cache || cache.identity !== rootIdentity || cache.universe !== universe || cache.known !== known) {
    cache = { identity: rootIdentity, universe, known, entries: new Map() };
  }

  const deadline = options.discovery ? undefined : AbortSignal.timeout(options.limits.indexTimeoutMs);
  const signal = deadline ? (options.signal ? AbortSignal.any([options.signal, deadline]) : deadline) : options.signal;
  const stopped = () => {
    options.signal?.throwIfAborted();
    return deadline?.aborted ?? false;
  };
  const aliasLoader = createPathAliasLoader(physicalRoot, options.known, signal);
  const limitations: string[] = [];
  const omissions = new Map<string, { count: number; samples: string[] }>();
  const omit = (reason: string, path: string) => {
    const entry = omissions.get(reason) ?? { count: 0, samples: [] };
    entry.count++;
    if (entry.samples.length < 3) entry.samples.push(path);
    omissions.set(reason, entry);
  };
  const imports = new Map<string, string[]>();
  const ordered = interleave(paths, options.changedPaths);
  const maxFiles = options.limits.maxIndexFiles ?? Number.POSITIVE_INFINITY;
  const maxBytes = options.limits.maxIndexBytes ?? Number.POSITIVE_INFINITY;
  const requested = options.discovery?.scannedFiles ?? ordered.length;
  const requestedPrefix = Math.min(requested, ordered.length);
  // Apply the file cap before any I/O is scheduled. A pinned prefix still
  // respects the resource policy that created it.
  const candidates = ordered.slice(0, Math.min(requestedPrefix, maxFiles));
  const inspect = async (path: string): Promise<MetadataResult> => {
    try {
      const fingerprint = await metadata(physicalRoot, path, signal);
      const aliases = path.endsWith('.py') ? { key: '' } : await aliasLoader.forFile(path);
      if (stopped()) return { kind: 'interrupted' };
      return { kind: 'metadata', fingerprint, aliases };
    } catch (error) {
      options.signal?.throwIfAborted();
      return deadline?.aborted ? { kind: 'interrupted' } : { kind: 'omitted', reason: errorDetail(error) };
    }
  };
  // Admission runs in path order, so the byte budget, the cache, and a deadline cut apply exactly as in a sequential scan.
  let indexedBytes = 0;
  let halted = false;
  const admit = (path: string, result: MetadataResult): Admission => {
    if (halted || result.kind === 'interrupted') {
      halted = true;
      return { kind: 'interrupted' };
    }
    if (result.kind === 'omitted') return result;
    if (indexedBytes + result.fingerprint.size > maxBytes) return { kind: 'omitted', reason: 'byte limit' };
    indexedBytes += result.fingerprint.size;
    const cached = cache.entries.get(path);
    if (cached && fingerprintMatches(cached.fingerprint, result.fingerprint) && cached.aliases === result.aliases.key) return { kind: 'cached', edges: cached.edges };
    return { kind: 'read', fingerprint: result.fingerprint, aliases: result.aliases };
  };
  const read = async (path: string, fingerprint: Fingerprint, aliases: Aliases): Promise<Indexed> => {
    try {
      const { content, identity } = await readSourceFile(physicalRoot, path, signal);
      if (content.includes('\0')) throw new Error('Binary file');
      if (hasSecret(content)) throw new Error('File with a potential credential');
      if (!fingerprintMatches(fingerprint, identity)) throw new Error('File changed during collection');
      const edges = importsFor(path, content, options.known, aliases.aliases).sort();
      if (stopped()) return { kind: 'interrupted' };
      return { kind: 'indexed', fingerprint: identity, aliases: aliases.key, edges };
    } catch (error) {
      options.signal?.throwIfAborted();
      return deadline?.aborted ? { kind: 'interrupted' } : { kind: 'omitted', reason: errorDetail(error) };
    }
  };
  // Files stream through a fixed pool of workers, so a slow file holds up only its own worker. Each file waits for the
  // admission of the file before it, which has already started, so the wait always ends.
  const slots: Indexed[] = new Array(candidates.length);
  let next = 0;
  let admitted = Promise.resolve();
  const worker = async () => {
    while (!stopped()) {
      const position = next++;
      if (position >= candidates.length) return;
      const path = candidates[position]!;
      const previous = admitted;
      let release!: () => void;
      admitted = new Promise<void>(resolve => { release = resolve; });
      let admission: Admission;
      try {
        const result = await inspect(path);
        await previous;
        admission = admit(path, result);
      } finally { release(); }
      slots[position] = admission.kind === 'read' ? await read(path, admission.fingerprint, admission.aliases) : admission;
    }
  };
  await Promise.all(Array.from({ length: Math.min(INDEX_IO_CONCURRENCY, candidates.length) }, worker));

  let completed = 0;
  let deadlineReached = false;
  for (const [position, path] of candidates.entries()) {
    const slot = slots[position];
    if (!slot || slot.kind === 'interrupted') {
      deadlineReached = true;
      break;
    }
    if (slot.kind === 'omitted') {
      cache.entries.delete(path);
      omit(slot.reason, path);
    } else if (slot.kind === 'cached') {
      imports.set(path, [...slot.edges]);
    } else {
      if (cache.entries.size < MAX_CACHE_ENTRIES || cache.entries.has(path)) {
        cache.entries.set(path, { fingerprint: slot.fingerprint, aliases: slot.aliases, edges: slot.edges });
      }
      imports.set(path, [...slot.edges]);
    }
    completed++;
  }

  const discovery = options.discovery
    ? { scannedFiles: Math.min(completed, requestedPrefix), deadlineLimited: options.discovery.deadlineLimited }
    : { scannedFiles: completed, deadlineLimited: deadlineReached };
  if (completed === candidates.length && candidates.length < ordered.length && !options.discovery?.deadlineLimited) {
    limitations.push(`Import index file limit reached: ${completed}/${ordered.length} eligible files scanned.`);
  }
  if (discovery.deadlineLimited) limitations.push(`Import index deadline reached: ${imports.size}/${ordered.length} eligible files indexed.`);
  for (const [reason, { count, samples }] of [...omissions].sort(([left], [right]) => left.localeCompare(right))) {
    limitations.push(`Import index omitted ${count} file(s): ${reason} (${samples.join(', ')}).`);
  }
  limitations.push(...aliasLoader.limitations());
  const incomplete = [
    { category: 'application', indexed: [...imports.keys()].filter(path => !testPath(path)).length, eligible: paths.filter(path => !testPath(path)).length },
    { category: 'test', indexed: [...imports.keys()].filter(testPath).length, eligible: paths.filter(testPath).length },
  ].filter(entry => entry.indexed < entry.eligible);
  if (incomplete.length) limitations.push(`Import index coverage is partial: ${incomplete.map(entry => `${entry.category} ${entry.indexed}/${entry.eligible} files indexed`).join('; ')}.`);

  const reverse = new Map<string, string[]>();
  for (const [path, dependencies] of imports) {
    for (const dependency of dependencies) {
      const callers = reverse.get(dependency);
      if (callers) callers.push(path);
      else reverse.set(dependency, [path]);
    }
  }
  for (const callers of reverse.values()) callers.sort();
  boundedCache(physicalRoot, cache);
  return { imports, reverse, limitations: limitations.sort(), discovery };
}
