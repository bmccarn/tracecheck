import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Range } from './domain.js';

const MAX_BASELINE_BYTES = 8 * 1024 * 1024;

export type GitChange = { ranges: Range[]; beforeRanges: Range[]; error?: string };
export type GitChangeContext = Map<string, GitChange>;
type BaselineConsumer = (path: string, change: GitChange, before?: string) => Promise<void> | void;

function patchRange(start: string, count: string | undefined): Range {
  const first = Math.max(1, Number(start));
  return { start: first, end: first + Math.max(1, Number(count ?? 1)) - 1 };
}

function pathBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let argumentBytes = 0;
  for (const path of paths) {
    const nextBytes = argumentBytes + Buffer.byteLength(path) + 1;
    if (batch.length && (batch.length >= 512 || nextBytes > 60_000)) {
      batches.push(batch);
      batch = [];
      argumentBytes = 0;
    }
    batch.push(path);
    argumentBytes += Buffer.byteLength(path) + 1;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function streamGit(root: string, args: string[], signal: AbortSignal, onData: (data: Buffer) => Promise<void> | void, input?: Buffer): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', '-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.once('error', () => finish(new Error('Git context command failed')));
    child.stdout.once('error', () => finish(new Error('Git context command failed')));
    child.stderr.once('error', () => finish(new Error('Git context command failed')));
    child.stdout.on('data', (chunk: Buffer) => {
      child.stdout.pause();
      output = output.then(() => onData(chunk)).then(() => { child.stdout.resume(); }).catch(() => {
        finish(signal.aborted && signal.reason instanceof Error ? signal.reason : new Error('Git context command failed'));
      });
    });
    child.stderr.resume();
    child.once('close', code => {
      void output.then(() => finish(code === 0 ? undefined : new Error('Git context command failed'))).catch(() => finish(new Error('Git context command failed')));
    });
    child.stdin.once('error', () => finish(new Error('Git context command failed')));
    child.stdin.end(input);
  });
}

export async function readGitChangeContext({ root, base, paths, signal, onBaseline }: {
  root: string; base: string; paths: string[]; signal: AbortSignal; onBaseline?: BaselineConsumer;
}): Promise<GitChangeContext> {
  const context: GitChangeContext = new Map([...new Set(paths)].map(path => [path, { ranges: [], beforeRanges: [] }]));
  const requested = new Set(context.keys());
  if (!requested.size) return context;


  const pathsByBlob = new Map<string, string[]>();
  let treeBuffer = Buffer.alloc(0);
  for (const batch of pathBatches(paths)) await streamGit(root, ['ls-tree', '-rlz', base, '--', ...batch], signal, chunk => {
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
      const path = record.subarray(tab + 1).toString('utf8');
      if (type !== 'blob' || !blob || !requested.has(path)) continue;
      if (!Number.isSafeInteger(size) || size < 0) {
        context.get(path)!.error = 'Base version unavailable';
        continue;
      }
      if (size > MAX_BASELINE_BYTES) {
        context.get(path)!.error = 'Oversized base version';
        continue;
      }
      const entries = pathsByBlob.get(blob) ?? [];
      entries.push(path);
      pathsByBlob.set(blob, entries);
    }
  });
  if (treeBuffer.length) throw new Error('Git context command failed');
  const pathsForDiff = paths.filter(path => !context.get(path)?.error);
  for (const batch of pathBatches(pathsForDiff)) {
    const rawChanges: Array<{ path: string; status: string }> = [];
    let rawBuffer = Buffer.alloc(0);
    let rawStatus: string | undefined;
    await streamGit(root, ['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--no-renames', base, '--', ...batch], signal, chunk => {
      rawBuffer = Buffer.concat([rawBuffer, chunk]);
      for (;;) {
        const end = rawBuffer.indexOf(0);
        if (end < 0) break;
        const record = rawBuffer.subarray(0, end);
        rawBuffer = rawBuffer.subarray(end + 1);
        if (record[0] === 58) {
          rawStatus = record.toString('ascii').trim().split(/\s+/).at(-1);
        } else if (rawStatus) {
          rawChanges.push({ path: record.toString('utf8'), status: rawStatus });
          rawStatus = undefined;
        } else throw new Error('Git context command failed');
      }
    });
    if (rawBuffer.length || rawStatus) throw new Error('Git context command failed');
    let diffBuffer = '';
    const decoder = new StringDecoder('utf8');
    let rawOffset = 0;
    let lastRaw: { path: string; status: string } | undefined;
    let reusedTypeChange = false;
    let activePath: string | undefined;
    let inHunk = false;
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
        } else throw new Error('Git context command failed');
        if (!requested.has(raw.path)) throw new Error('Git context command failed');
        activePath = raw.path;
        inHunk = false;
        return;
      }
      if (inHunk && (!activePath || !line.startsWith('@@ '))) return;
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk) return;
      inHunk = true;
      if (!activePath) return;
      const entry = context.get(activePath)!;
      entry.beforeRanges.push(patchRange(hunk[1]!, hunk[2]));
      entry.ranges.push(patchRange(hunk[3]!, hunk[4]));
    };
    await streamGit(root, ['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', base, '--', ...batch], signal, chunk => {
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
    if (rawOffset !== rawChanges.length) throw new Error('Git context command failed');
  }

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
