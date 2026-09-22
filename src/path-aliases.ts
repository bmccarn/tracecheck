import { posix } from 'node:path';
import { failureReason, readSource } from './safety.js';

/** Module resolution settings for one file; every path is repository-relative. */
export type PathAliases = { baseUrl?: string; paths?: Record<string, string[]> };

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];
const MAX_CONFIG_BYTES = 64_000;
const MAX_CONFIG_FILES = 256;
const MAX_EXTENDS_DEPTH = 8;
const CONFIG_DIR = '${configDir}';

type Setting<T> = { value: T; directory: string };
type Merged = { baseUrl?: Setting<string>; paths?: Setting<Record<string, string[]>> };
type Parsed = { extends: string[]; own: Merged };

/** Parses JSON with comments and trailing commas, as tsconfig files allow. Never evaluates code. */
export function parseJsonc(text: string): unknown {
  let result = '';
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const closer = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*[}\]]/y;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      result += text.slice(start, ++index);
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('Unterminated comment');
      result += ' ';
      index = end + 2;
    } else {
      // A comma followed only by whitespace, comments, and a closer is trailing.
      closer.lastIndex = index + 1;
      if (char !== ',' || !closer.test(text)) result += char;
      index++;
    }
  }
  return JSON.parse(result);
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const directoryOf = (path: string) => { const directory = posix.dirname(path); return directory === '.' ? '' : directory; };
const outside = (path: string) => path === '..' || path.startsWith('../') || posix.isAbsolute(path);

function parseConfig(path: string, text: string): Parsed {
  const json = parseJsonc(text);
  if (!record(json)) throw new SyntaxError('Config is not an object');
  const directory = directoryOf(path);
  const own: Merged = {};
  const options = record(json.compilerOptions) ? json.compilerOptions : {};
  if (typeof options.baseUrl === 'string') own.baseUrl = { value: options.baseUrl, directory };
  if (record(options.paths)) {
    // TypeScript accepts at most one wildcard in a pattern and in each of its substitutions.
    const single = (value: string) => value.split('*').length <= 2;
    own.paths = {
      directory, value: Object.fromEntries(Object.entries(options.paths).flatMap(([pattern, targets]) => {
        const valid = Array.isArray(targets) ? targets.filter((target): target is string => typeof target === 'string' && single(target)) : [];
        return single(pattern) && valid.length ? [[pattern, valid]] : [];
      }))
    };
  }
  const extendsValue = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
  return { extends: extendsValue.filter((item): item is string => typeof item === 'string'), own };
}

/**
 * Reads the nearest tsconfig.json or jsconfig.json for each file, following
 * `extends` only through relative paths that stay inside the repository.
 * Configuration problems become limitations; discovery continues without the
 * affected aliases.
 */
export function createPathAliasLoader(root: string, known: Set<string>, signal?: AbortSignal) {
  const problems = new Map<string, Set<string>>();
  const problem = (reason: string, sample: string) => {
    const samples = problems.get(reason) ?? new Set<string>();
    samples.add(sample);
    problems.set(reason, samples);
  };
  const files = new Map<string, Promise<Parsed | 'missing' | undefined>>();
  const merged = new Map<string, Promise<Merged>>();
  const nearest = new Map<string, string | undefined>();

  const read = (path: string) => {
    let pending = files.get(path);
    if (pending) return pending;
    if (files.size >= MAX_CONFIG_FILES) {
      problem(`TypeScript config limit of ${MAX_CONFIG_FILES} files reached; further configs were not read`, path);
      return Promise.resolve(undefined);
    }
    pending = (async () => {
      let text: string;
      try {
        text = await readSource(root, path, signal, MAX_CONFIG_BYTES);
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing' as const;
        problem(`TypeScript config could not be read (${failureReason(error, 'Unreadable file')}); its path aliases are ignored`, path);
        return undefined;
      }
      try {
        return parseConfig(path, text);
      } catch {
        problem('TypeScript config could not be parsed; its path aliases are ignored', path);
        return undefined;
      }
    })();
    files.set(path, pending);
    return pending;
  };

  const resolveConfig = (path: string, chain: string[]): Promise<Merged> => {
    const cached = merged.get(path);
    if (cached) return cached;
    const pending = (async (): Promise<Merged> => {
      const parsed = await read(path);
      if (!parsed || parsed === 'missing') return {};
      const result: Merged = {};
      for (const specifier of parsed.extends) {
        const sample = `${path} -> ${specifier}`;
        // Package specifiers and absolute paths name configuration outside the repository.
        const target = /^\.\.?(?:\/|$)/.test(specifier) ? posix.join(directoryOf(path), specifier) : undefined;
        if (target === undefined || outside(target)) { problem('TypeScript config extends targets outside the repository were not followed', sample); continue; }
        let base: string | undefined;
        for (const candidate of target.endsWith('.json') ? [target] : [target, `${target}.json`]) {
          if (await read(candidate) !== 'missing') { base = candidate; break; }
        }
        if (base === undefined) { problem('TypeScript config extends target was not found', sample); continue; }
        if (chain.includes(base) || chain.length >= MAX_EXTENDS_DEPTH) {
          problem(`TypeScript config extends chain is circular or deeper than ${MAX_EXTENDS_DEPTH} levels`, sample);
          continue;
        }
        // Later entries in an extends array override earlier ones; each setting keeps the directory that declared it.
        Object.assign(result, await resolveConfig(base, [...chain, base]));
      }
      if (parsed.own.baseUrl) result.baseUrl = parsed.own.baseUrl;
      if (parsed.own.paths) result.paths = parsed.own.paths;
      return result;
    })();
    // Only complete chains are memoized: a result cut short by a cycle depends on where the cycle was entered.
    if (chain.length === 1) merged.set(path, pending);
    return pending;
  };

  const configFor = (path: string): string | undefined => {
    const directory = directoryOf(path);
    if (nearest.has(directory)) return nearest.get(directory);
    const own = CONFIG_NAMES.map(name => directory ? `${directory}/${name}` : name).find(candidate => known.has(candidate));
    const found = own ?? (directory ? configFor(directory) : undefined);
    nearest.set(directory, found);
    return found;
  };

  return {
    /** Aliases for a JS/TS file plus a key that changes whenever its resolution settings do. */
    async forFile(path: string): Promise<{ key: string; aliases?: PathAliases }> {
      const config = configFor(path);
      if (!config) return { key: '' };
      const settings = await resolveConfig(config, [config]);
      const leaf = directoryOf(config);
      const place = (directory: string, value: string) => {
        const resolved = value.startsWith(CONFIG_DIR) ? posix.join(leaf, `.${value.slice(CONFIG_DIR.length)}`) : posix.join(directory, value);
        return outside(resolved) ? undefined : resolved;
      };
      const aliases: PathAliases = {};
      const baseUrl = settings.baseUrl && place(settings.baseUrl.directory, settings.baseUrl.value);
      if (baseUrl !== undefined) aliases.baseUrl = baseUrl;
      if (settings.paths) {
        // Without baseUrl, substitutions are relative to the config that declares them.
        const origin = baseUrl ?? settings.paths.directory;
        aliases.paths = Object.fromEntries(Object.entries(settings.paths.value)
          .map(([pattern, targets]) => [pattern, targets.flatMap(target => place(origin, target) ?? [])]));
      }
      return aliases.baseUrl === undefined && !aliases.paths ? { key: '' } : { key: JSON.stringify(aliases), aliases };
    },
    limitations(): string[] {
      return [...problems].map(([reason, samples]) => {
        const sorted = [...samples].sort();
        const more = sorted.length > 3 ? `, and ${sorted.length - 3} more` : '';
        return `${reason} (${sorted.slice(0, 3).join(', ')}${more}).`;
      });
    },
  };
}
