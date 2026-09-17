import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, isAbsolute, resolve } from 'node:path';

export function hasSecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+\/-]{20,}["']|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/i.test(text);
}

export function assertSafeOutbound(value: unknown): void {
  // Test individual strings, so JSON escaping cannot hide assignment boundaries.
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && hasSecret(item)) throw new Error('Potential credential in review context. Remove it before sending a review.');
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
}

export async function readSource(root: string, path: string, signal?: AbortSignal, maxBytes = 256_000): Promise<string> {
  signal?.throwIfAborted();
  const absolute = resolve(root, path);
  const physical = await realpath(absolute);
  const inside = relative(root, physical);
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)
    || (await lstat(absolute)).isSymbolicLink()) throw new Error('Symlink or external path');
  // Open the checked physical path without following a final-component symlink.
  const file = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('Nonregular or oversized file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    if (size > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || await realpath(absolute) !== physical) throw new Error('File changed during collection');
    const current = await lstat(physical);
    if (current.ino !== after.ino || current.dev !== after.dev) throw new Error('File changed during collection');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await file.close(); }
}
