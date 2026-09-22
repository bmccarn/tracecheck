import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, isAbsolute, resolve } from 'node:path';

// Screening is a best-effort guard for common credential shapes, not data-loss prevention.
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PROVIDER_TOKEN = new RegExp([
  String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, // AWS access key ID
  String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}`, // GitHub
  String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b`, // OpenAI-style secret key
  String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}|hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{16,}`, // Slack
  String.raw`\bAIza[A-Za-z0-9_-]{35}|\bGOCSPX-[A-Za-z0-9_-]{28}|\bya29\.[A-Za-z0-9_-]{20,}`, // Google
  String.raw`\b[rs]k_live_[A-Za-z0-9]{16,}`, // Stripe
  String.raw`\bnpm_[A-Za-z0-9]{36}\b`, // npm
].join('|'));
// A credential-named key assigned a quoted value, or an unquoted value that ends the line
// (YAML, TOML, .env, INI). Values are classified separately so identifiers are not flagged.
const ASSIGNMENT = new RegExp(String.raw`(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|passw(?:or)?d)["'\x60]?\s*(?::=|=>|[:=])`
  + String.raw`(?:\s*(["'\x60])([^\s"'\x60\\]{12,})\1|[ \t]*([^\s"'\x60\\#;,(){}\[\]<>=$%*][^\s"'\x60\\#;,(){}\[\]<>]{11,})[ \t]*(?:[#;].*)?$)`, 'gim');
// The scheme length is bounded so runs such as `a.a.a...` cannot cause quadratic backtracking.
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/?#"'`]*:([^\s@/?#"'`]+)@/gi;
const REFERENCE = /^[$%{<[*(]|\$\{|\{\{|<%|\.\.\.|…/;

/**
 * True when a value reads as words: camelCase, PascalCase, snake_case, kebab-case, dotted names,
 * and paths, with short digit runs such as `Utf8` or `ES2015`. Random tokens split into many
 * one- and two-letter fragments, acronym runs, or long consonant runs, so they fail this test.
 */
function identifierShaped(value: string): boolean {
  if (!/^[\w$.\-/:@=+;,~?!#]+$/.test(value)) return false;
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let letterWords = 0, letterChars = 0, digitWords = 0, irregular = 0;
  for (const part of parts) {
    const mixedCase = /[a-z]/.test(part) && /[A-Z]/.test(part);
    for (const word of part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []) {
      if (/^[0-9]/.test(word)) {
        if (word.length > 6) return false;
        digitWords++;
        continue;
      }
      if (word.length > 5 && /[bcdfghjklmnpqrstvwxz]{5}/i.test(word)) return false;
      letterWords++;
      letterChars += word.length;
      if (word.length === 1 || (mixedCase && /^[A-Z]+$/.test(word))) irregular++;
    }
  }
  return letterWords > 0 && letterChars / letterWords >= 3 && irregular <= parts.length && digitWords <= Math.max(1, letterWords / 2);
}

function credentialValue(value: string): boolean {
  if (new Set(value).size < 6 || REFERENCE.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return !identifierShaped(value);
}

function urlPassword(value: string): boolean {
  if (new Set(value).size < 4 || REFERENCE.test(value)) return false;
  // Word-only passwords such as `postgres` or `guest` are usually local defaults or placeholders.
  return /\d/.test(value) || !identifierShaped(value);
}

export function hasSecret(text: string): boolean {
  if (PRIVATE_KEY.test(text) || PROVIDER_TOKEN.test(text)) return true;
  for (const match of text.matchAll(ASSIGNMENT)) if (credentialValue(match[2] ?? match[3]!)) return true;
  for (const match of text.matchAll(URL_PASSWORD)) if (urlPassword(match[1]!)) return true;
  return false;
}

/**
 * Rejects a provider request that carries a credential-shaped string. The error names the
 * input field and, when the field belongs to an object with a `path`, that file path. It
 * never includes the matched value.
 */
export function assertSafeOutbound(value: unknown): void {
  // Test individual strings, so JSON escaping cannot hide assignment boundaries.
  const visit = (item: unknown, field: string, file: string | undefined): void => {
    if (typeof item === 'string') {
      if (!hasSecret(item)) return;
      const location = file === undefined ? `field ${field || 'input'}` : `${file} (field ${field})`;
      throw new Error(`Potential credential in ${location}. Remove it before sending this request.`);
    }
    if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${field}[${index}]`, file));
    else if (item && typeof item === 'object') {
      const path = 'path' in item && typeof item.path === 'string' && !hasSecret(item.path) ? item.path : file;
      for (const [key, entry] of Object.entries(item)) visit(entry, field ? `${field}.${key}` : key, path);
    }
  };
  visit(value, '', undefined);
}

/** The checked physical path of a file and the identity of its last observed state. */
export type FileIdentity = { physical: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };

export async function readSource(root: string, path: string, signal?: AbortSignal, maxBytes = 256_000): Promise<string> {
  return (await readSourceFile(root, path, signal, maxBytes)).content;
}

/**
 * Reads a regular file inside `root` without following symlinks, and rejects it if it changed during the read.
 * Returns the identity the final check observed, so a caller that stat'ed the file earlier need not stat it again.
 */
export async function readSourceFile(root: string, path: string, signal?: AbortSignal, maxBytes = 256_000): Promise<{ content: string; identity: FileIdentity }> {
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
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || await realpath(absolute) !== physical) throw new Error('File changed during collection');
    const current = await lstat(physical);
    if (current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new Error('File changed during collection');
    return { content: buffer.subarray(0, size).toString('utf8'),
      identity: { physical, dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs } };
  } finally { await file.close(); }
}
