import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import type { Range } from './domain.js';

const MAX_BASELINE_BYTES = 8 * 1024 * 1024;
// Git's own list of repository-local variables (`git rev-parse --local-env-vars`) minus the
// configuration ones: each can point Git at a different repository, index, or object store.
const REPOSITORY_ENVIRONMENT = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE']);
const WORKING_TREE_CHANGED = 'Working tree changed during collection; retry the preview.';
// A checkout's own Git configuration can name commands for Git to run. These settings, which take precedence over it,
// turn off the ones read-only commands can start: the file system monitor, and hooks such as post-index-change, which
// fires when `git diff` refreshes the index. Clean filters still run while `git diff` hashes working-tree files; the
// README's security model explains why.
const SAFE_CONFIGURATION = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const execGit = promisify(execFile);

/** `noHunks` records why a changed path has no textual hunks, so its changed lines are unknown. */
export type GitChange = { ranges: Range[]; beforeRanges: Range[]; error?: string; noHunks?: 'mode-only' | 'diff-suppressed' };
export type GitChangeContext = Map<string, GitChange>;
type BaselineConsumer = (path: string, change: GitChange, before?: string) => Promise<void> | void;

function patchRange(start: string, count: string | undefined): Range {
  const first = Math.max(1, Number(start));
  return { start: first, end: first + Math.max(1, Number(count ?? 1)) - 1 };
}

/** Batches pathspecs for argv limits; each group, such as a rename's two paths, stays in one batch. */
function pathBatches(groups: string[][]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let argumentBytes = 0;
  for (const group of groups) {
    const groupBytes = group.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0);
    if (batch.length && (batch.length + group.length > 512 || argumentBytes + groupBytes > 60_000)) {
      batches.push(batch);
      batch = [];
      argumentBytes = 0;
    }
    batch.push(...group);
    argumentBytes += groupBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** The caller's environment without variables that would make Git read another repository than `-C` names. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !REPOSITORY_ENVIRONMENT.has(name)));
}

/** Runs a Git command in `root` with the safe configuration and environment, and returns its standard output. */
export async function gitOutput(root: string, args: string[], options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  return (await execGit('git', [...SAFE_CONFIGURATION, '-C', root, ...args], { ...options, env: gitEnvironment() })).stdout;
}

/** The real path of the working tree that contains `repo`. A path Git cannot open fails with Git's reason, not its command line. */
export async function gitRoot(repo: string, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  let output: string;
  try {
    output = await gitOutput(resolve(repo), ['rev-parse', '--show-toplevel'], options);
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.match(/^fatal: (.+)$/m)?.[1] : undefined;
    if (!reason) throw error;
    throw new Error(`Cannot open ${repo} as a Git working tree: ${reason.replace(/\.$/, '')}.`);
  }
  return realpath(output.trim());
}

async function streamGit(root: string, args: string[], signal: AbortSignal, onData: (data: Buffer) => Promise<void> | void, input?: Buffer, failure = 'Git context command failed'): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', ...SAFE_CONFIGURATION, '-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: gitEnvironment() });
    let settled = false;
    let output = Promise.resolve();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve();
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Git context collection aborted'));
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(new Error(failure)));
    child.stdout.once('error', () => finish(new Error(failure)));
    child.stderr.once('error', () => finish(new Error(failure)));
    child.stdout.on('data', (chunk: Buffer) => {
      child.stdout.pause();
      output = output.then(() => onData(chunk)).then(() => { child.stdout.resume(); }).catch(error => {
        finish(signal.aborted && signal.reason instanceof Error ? signal.reason : error instanceof Error ? error : new Error(failure));
      });
    });
    child.stderr.resume();
    child.once('close', code => {
      void output.then(() => finish(code === 0 ? undefined : new Error(failure))).catch(() => finish(new Error(failure)));
    });
    child.stdin.once('error', () => finish(new Error(failure)));
    child.stdin.end(input);
  });
}

/** Streams a NUL-terminated listing into records, so its size is bounded by the collection budget rather than a buffer. */
export async function readGitRecords(root: string, args: string[], signal: AbortSignal, failure: string): Promise<string[]> {
  const records: string[] = [];
  let pending: Buffer = Buffer.alloc(0);
  await streamGit(root, args, signal, chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(0); end >= 0; end = pending.indexOf(0, start)) {
      records.push(pending.toString('utf8', start, end));
      start = end + 1;
    }
    pending = pending.subarray(start);
  }, undefined, failure);
  if (pending.length) throw new Error(failure);
  return records;
}

/**
 * `renames` maps a requested path to the base path Git paired it with. Those paths take their
 * baseline and changed ranges from the rename source; every other path is diffed without renames.
 */
export async function readGitChangeContext({ root, base, paths, renames = new Map(), signal, onBaseline }: {
  root: string; base: string; paths: string[]; renames?: ReadonlyMap<string, string>; signal: AbortSignal; onBaseline?: BaselineConsumer;
}): Promise<GitChangeContext> {
  const context: GitChangeContext = new Map([...new Set(paths)].map(path => [path, { ranges: [], beforeRanges: [] }]));
  const requested = new Set(context.keys());
  if (!requested.size) return context;
  const requestedByBase = new Map<string, string[]>();
  for (const path of requested) {
    const basePath = renames.get(path) ?? path;
    requestedByBase.set(basePath, [...(requestedByBase.get(basePath) ?? []), path]);
  }
  const renameSources = new Set([...requested].flatMap(path => renames.has(path) ? [renames.get(path)!] : []));

  const pathsByBlob = new Map<string, string[]>();
  let treeBuffer = Buffer.alloc(0);
  for (const batch of pathBatches([...requestedByBase.keys()].map(path => [path]))) await streamGit(root, ['ls-tree', '-rlz', base, '--', ...batch], signal, chunk => {
    treeBuffer = Buffer.concat([treeBuffer, chunk]);
    for (;;) {
      const end = treeBuffer.indexOf(0);
      if (end < 0) break;
      const record = treeBuffer.subarray(0, end);
      treeBuffer = treeBuffer.subarray(end + 1);
      const tab = record.indexOf(9);
      if (tab < 0) continue;
      const fields = record.subarray(0, tab).toString('ascii').trim().split(/\s+/);
      const type = fields[1];
      const blob = fields[2];
      const size = Number(fields[3]);
      const targets = requestedByBase.get(record.subarray(tab + 1).toString('utf8'));
      if (type !== 'blob' || !blob || !targets) continue;
      if (!Number.isSafeInteger(size) || size < 0) {
        for (const path of targets) context.get(path)!.error = 'Base version unavailable';
        continue;
      }
      if (size > MAX_BASELINE_BYTES) {
        for (const path of targets) context.get(path)!.error = 'Oversized base version';
        continue;
      }
      const entries = pathsByBlob.get(blob) ?? [];
      entries.push(...targets);
      pathsByBlob.set(blob, entries);
    }
  });
  if (treeBuffer.length) throw new Error('Git context command failed');
  const pathsForDiff = [...requested].filter(path => !context.get(path)?.error);
  const diffBatch = async (batch: string[], renameMode: '--no-renames' | '--find-renames') => {
    // Raw records name the requested path each patch section belongs to; rename sources have none.
    const rawChanges: Array<{ path?: string; status: string }> = [];
    let rawBuffer = Buffer.alloc(0);
    let rawRecord: { status: string; paths: string[] } | undefined;
    const attribute = (status: string, recordPaths: string[]) => {
      const path = recordPaths.at(-1)!;
      if (recordPaths.length === 2) {
        if (!requested.has(path)) throw new Error('Git context command failed');
        if (!status.startsWith('R') || renames.get(path) !== recordPaths[0]) context.get(path)!.error = 'Rename pairing changed during collection';
        rawChanges.push({ path, status });
      } else if (requested.has(path)) {
        if (renames.has(path)) context.get(path)!.error = 'Rename pairing changed during collection';
        rawChanges.push({ path, status });
      } else if (renameSources.has(path)) rawChanges.push({ status });
      else throw new Error('Git context command failed');
    };
    await streamGit(root, ['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', renameMode, base, '--', ...batch], signal, chunk => {
      rawBuffer = Buffer.concat([rawBuffer, chunk]);
      for (;;) {
        const end = rawBuffer.indexOf(0);
        if (end < 0) break;
        const record = rawBuffer.subarray(0, end);
        rawBuffer = rawBuffer.subarray(end + 1);
        if (!rawRecord) {
          if (record[0] !== 58) throw new Error('Git context command failed');
          rawRecord = { status: record.toString('ascii').trim().split(/\s+/).at(-1) ?? '', paths: [] };
          continue;
        }
        rawRecord.paths.push(record.toString('utf8'));
        if (rawRecord.paths.length < (/^[RC]/.test(rawRecord.status) ? 2 : 1)) continue;
        attribute(rawRecord.status, rawRecord.paths);
        rawRecord = undefined;
      }
    });
    if (rawBuffer.length || rawRecord) throw new Error('Git context command failed');
    let diffBuffer = '';
    const decoder = new StringDecoder('utf8');
    let rawOffset = 0;
    let lastRaw: { path?: string; status: string } | undefined;
    let reusedTypeChange = false;
    let activePath: string | undefined;
    let inHunk = false;
    // Headers before a section's first hunk explain a section without hunks.
    const noHunkReasons = new Map<string, NonNullable<GitChange['noHunks']>>();
    const processDiffLine = (line: string) => {
      if (line.startsWith('diff --git ')) {
        let raw = rawChanges[rawOffset];
        if (raw) {
          rawOffset++;
          lastRaw = raw;
          reusedTypeChange = false;
        } else if (lastRaw?.status.startsWith('T') && !reusedTypeChange) {
          raw = lastRaw;
          reusedTypeChange = true;
        } else throw new Error(WORKING_TREE_CHANGED);
        activePath = raw.path;
        inHunk = false;
        return;
      }
      if (inHunk && (!activePath || !line.startsWith('@@ '))) return;
      if (!inHunk && activePath) {
        if (/^Binary files .* differ$/.test(line)) noHunkReasons.set(activePath, 'diff-suppressed');
        else if (/^(?:old|new) mode /.test(line) && !noHunkReasons.has(activePath)) noHunkReasons.set(activePath, 'mode-only');
      }
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk) return;
      inHunk = true;
      if (!activePath) return;
      const entry = context.get(activePath)!;
      entry.beforeRanges.push(patchRange(hunk[1]!, hunk[2]));
      entry.ranges.push(patchRange(hunk[3]!, hunk[4]));
    };
    await streamGit(root, ['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', renameMode, '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', base, '--', ...batch], signal, chunk => {
      diffBuffer += decoder.write(chunk);
      for (;;) {
        const newline = diffBuffer.indexOf('\n');
        if (newline < 0) break;
        processDiffLine(diffBuffer.slice(0, newline));
        diffBuffer = diffBuffer.slice(newline + 1);
      }
    });
    diffBuffer += decoder.end();
    if (diffBuffer) processDiffLine(diffBuffer);
    if (rawOffset !== rawChanges.length) throw new Error(WORKING_TREE_CHANGED);
    for (const [path, reason] of noHunkReasons) {
      const entry = context.get(path)!;
      if (!entry.ranges.length) entry.noHunks = reason;
    }
  };
  for (const batch of pathBatches(pathsForDiff.filter(path => !renames.has(path)).map(path => [path]))) await diffBatch(batch, '--no-renames');
  // Rename detection runs on each pair only, with the default similarity threshold the change listing used.
  for (const batch of pathBatches(pathsForDiff.filter(path => renames.has(path)).map(path => [path, renames.get(path)!]))) await diffBatch(batch, '--find-renames');

  const delivered = new Set<string>();
  const deliver = async (path: string, before?: string) => {
    delivered.add(path);
    if (onBaseline) await onBaseline(path, context.get(path)!, before);
  };
  if (pathsByBlob.size) {
    let blobBuffer = Buffer.alloc(0);
    let pending: { blob: string; size: number; remaining: number; chunks: Buffer[]; oversized: boolean } | undefined;
    const finishBlob = async (item: NonNullable<typeof pending>) => {
      const blobPaths = pathsByBlob.get(item.blob) ?? [];
      if (item.oversized) {
        for (const path of blobPaths) context.get(path)!.error = 'Oversized base version';
        for (const path of blobPaths) await deliver(path);
        return;
      }
      const before = Buffer.concat(item.chunks, item.size).toString('utf8');
      if (before.includes('\0')) for (const path of blobPaths) context.get(path)!.error = 'Binary base version';
      for (const path of blobPaths) await deliver(path, before.includes('\0') ? undefined : before);
    };
    const consumeBlobs = async () => {
      for (;;) {
        if (!pending) {
          const newline = blobBuffer.indexOf(10);
          if (newline < 0) return;
          const headerText = blobBuffer.subarray(0, newline).toString('ascii');
          blobBuffer = blobBuffer.subarray(newline + 1);
          const header = headerText.match(/^([0-9a-f]+) blob (\d+)$/);
          if (!header) {
            const missing = headerText.match(/^([0-9a-f]+) missing$/);
            if (!missing) throw new Error('Git context command failed');
            const missingPaths = pathsByBlob.get(missing[1]!) ?? [];
            for (const path of missingPaths) context.get(path)!.error = 'Base version unavailable';
            for (const path of missingPaths) await deliver(path);
            continue;
          }
          const size = Number(header[2]);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error('Git context command failed');
          pending = { blob: header[1]!, size, remaining: size, chunks: [], oversized: size > MAX_BASELINE_BYTES };
        }
        if (pending.remaining) {
          const available = Math.min(pending.remaining, blobBuffer.length);
          if (!available) return;
          if (!pending.oversized) pending.chunks.push(blobBuffer.subarray(0, available));
          pending.remaining -= available;
          blobBuffer = blobBuffer.subarray(available);
          if (pending.remaining) return;
        }
        if (!blobBuffer.length) return;
        if (blobBuffer[0] !== 10) throw new Error('Git context command failed');
        blobBuffer = blobBuffer.subarray(1);
        await finishBlob(pending);
        pending = undefined;
      }
    };
    const input = Buffer.from([...pathsByBlob.keys()].map(blob => `${blob}\n`).join(''));
    await streamGit(root, ['cat-file', '--batch'], signal, async chunk => {
      blobBuffer = blobBuffer.length ? Buffer.concat([blobBuffer, chunk]) : Buffer.from(chunk);
      await consumeBlobs();
    }, input);
    await consumeBlobs();
    if (pending || blobBuffer.length) throw new Error('Git context command failed');
  }
  for (const path of context.keys()) if (!delivered.has(path)) await deliver(path);
  return context;
}
