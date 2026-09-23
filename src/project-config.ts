import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  DEFAULT_BASE, DEFAULT_COLLECTION_TIMEOUT_MS, DEFAULT_INDEX_TIMEOUT_MS, DEFAULT_MAX_REQUESTS, DEFAULT_REVIEW_TIMEOUT_MS,
  maxRequestsSchema, reviewScopeFields, reviewTimeoutSchema, type CollectionOptions,
} from './collection-options.js';
import { gitEnvironment } from './git-context.js';
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS, modelSchema, requestConcurrencySchema, requestTimeoutSchema, type ConfiguredJevSettings } from './jev.js';
import { hasSecret, readSource } from './safety.js';

const exec = promisify(execFile);
/** Optional configuration file at the repository root. */
export const CONFIG_FILE = '.tracecheck.json';
const MAX_CONFIG_BYTES = 64_000;
/** Words that mark a key name as a credential field. A key matches only when one of its words is in this set. */
const CREDENTIAL_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'bearer', 'auth', 'authorization']);

/** Splits a key name into lowercase words at separators and camelCase boundaries: `OPENROUTER_API_KEY` and `apiKey` both end in `key`. */
const words = (name: string) => name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z\d]+/);
const isCredentialKey = (name: string) => words(name).some(word => CREDENTIAL_WORDS.has(word));

/** Every key is optional. Values use the same schemas as the CLI flags and MCP arguments. */
export const projectConfigSchema = z.object({
  ...reviewScopeFields,
  reviewTimeoutMs: reviewTimeoutSchema,
  model: modelSchema,
  requestTimeoutMs: requestTimeoutSchema,
  requestConcurrency: requestConcurrencySchema,
  maxRequests: maxRequestsSchema,
}).partial().strict();
export type ProjectConfig = z.output<typeof projectConfigSchema>;

/**
 * The file is repository content, so anyone who can commit to the repository controls it, while the reviewer's machine
 * and provider key bear its cost. It may restate or tighten each of these defaults but never go beyond it; `raise` names
 * the reviewer-controlled setting that can.
 */
const FILE_LIMITS: { path: string[]; limit: number | string | boolean; raise: string }[] = [
  { path: ['base'], limit: DEFAULT_BASE, raise: '--base or the MCP base argument' },
  { path: ['includeUntracked'], limit: false, raise: '--include-untracked or the MCP includeUntracked argument' },
  { path: ['collection', 'indexTimeoutMs'], limit: DEFAULT_INDEX_TIMEOUT_MS, raise: '--index-timeout-ms or the MCP collection argument' },
  { path: ['collection', 'collectionTimeoutMs'], limit: DEFAULT_COLLECTION_TIMEOUT_MS, raise: '--collection-timeout-ms or the MCP collection argument' },
  { path: ['reviewTimeoutMs'], limit: DEFAULT_REVIEW_TIMEOUT_MS, raise: '--review-timeout-ms or the MCP reviewTimeoutMs argument' },
  { path: ['requestTimeoutMs'], limit: DEFAULT_TIMEOUT_MS, raise: 'JEV_TIMEOUT_MS' },
  { path: ['requestConcurrency'], limit: DEFAULT_CONCURRENCY, raise: 'JEV_CONCURRENCY' },
  { path: ['maxRequests'], limit: DEFAULT_MAX_REQUESTS, raise: '--max-requests or the MCP maxRequests argument' },
];

function beyondDefaults(config: ProjectConfig): string[] {
  return FILE_LIMITS.flatMap(({ path, limit, raise }) => {
    const value = path.reduce<unknown>((item, key) => (item as Record<string, unknown> | undefined)?.[key], config);
    if (value === undefined || (typeof limit === 'number' ? (value as number) <= limit : value === limit)) return [];
    return [typeof limit === 'number'
      ? `${where(path)} may not exceed the default of ${limit}; use ${raise} to raise it`
      : `${where(path)} may only be the default ${JSON.stringify(limit)}; use ${raise} to change it`];
  });
}

/** Settings from CLI flags or MCP arguments. Each defined value overrides the configuration file. */
export type ExplicitSettings = {
  base?: string; includeUntracked?: boolean; task?: string; repositoryContext?: string;
  collection?: CollectionOptions; reviewTimeoutMs?: number; maxRequests?: number;
};

export type EffectiveSettings = {
  root: string;
  /** Options for collect(). The configuration file, when present, is part of the preview snapshot. */
  request: {
    base: string; includeUntracked: boolean; task?: string; repositoryContext?: string;
    collection: CollectionOptions; projectConfig?: ProjectConfig;
  };
  reviewTimeoutMs: number;
  /** Most provider requests the review may plan; a larger plan is refused before any request. */
  maxRequests: number;
  /** Shows the reviewer the task and repository context that the file, not the caller, supplied. */
  settingsFileNotes: string[];
  /** Provider fallbacks for jevSettings; JEV_MODEL, JEV_TIMEOUT_MS, and JEV_CONCURRENCY override them. */
  provider: ConfiguredJevSettings;
};

const where = (path: PropertyKey[]) => path.length ? `"${path.map(String).join('.')}"` : 'the top level';

/**
 * Validates configuration file text. Errors name the offending key and never quote its value. A value beyond a default
 * that the file may only tighten is an error, not silently ignored.
 */
export function parseProjectConfig(text: string): ProjectConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${CONFIG_FILE} is not valid JSON.`); }
  const visit = (item: unknown, path: string[]): void => {
    if (typeof item === 'string' && hasSecret(item)) {
      throw new Error(`${CONFIG_FILE}: ${where(path)} contains a potential credential. Provider keys belong in the environment only.`);
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (isCredentialKey(key)) {
        throw new Error(`${CONFIG_FILE}: ${where([...path, key])} looks like a credential field. Provider keys belong in the environment only.`);
      }
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
  const parsed = projectConfigSchema.safeParse(value);
  const problems = parsed.success ? beyondDefaults(parsed.data) : parsed.error.issues.flatMap(issue => issue.code === 'unrecognized_keys'
    ? issue.keys.map(key => `unknown key ${where([...issue.path, key])}`)
    : [`${where(issue.path)}: ${issue.message}`]);
  if (parsed.success && !problems.length) return parsed.data;
  throw new Error(`${CONFIG_FILE}: ${problems.join('; ')}.`);
}

/** Finds the Git top level for `repo` and reads its configuration file, if one exists. */
export async function loadProjectConfig(repo: string, signal?: AbortSignal): Promise<{ root: string; config?: ProjectConfig }> {
  const { stdout } = await exec('git', ['-C', resolve(repo), 'rev-parse', '--show-toplevel'], { timeout: 10_000, signal, env: gitEnvironment() });
  const root = await realpath(stdout.trim());
  let text: string;
  try {
    text = await readSource(root, CONFIG_FILE, signal, MAX_CONFIG_BYTES);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root };
    throw new Error(`Cannot read ${CONFIG_FILE}: ${error instanceof Error ? error.message : 'unexpected failure'}.`);
  }
  return { root, config: parseProjectConfig(text) };
}

const defined = <T extends object>(value: T | undefined) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined)) as Partial<T>;

/**
 * Resolves effective settings in precedence order: explicit flags or arguments, then the
 * configuration file, then built-in defaults. Provider environment variables are applied by jevSettings.
 */
export async function resolveSettings(repo: string, explicit: ExplicitSettings, signal?: AbortSignal): Promise<EffectiveSettings> {
  const { root, config } = await loadProjectConfig(repo, signal);
  const file = config ?? {};
  const fromFile = (label: string, explicitValue: string | undefined, fileValue: string | undefined) =>
    explicitValue === undefined && fileValue !== undefined ? [`${label} from the repository settings file ${CONFIG_FILE}: ${fileValue}`] : [];
  return {
    root,
    request: {
      base: explicit.base ?? file.base ?? DEFAULT_BASE,
      includeUntracked: explicit.includeUntracked ?? file.includeUntracked ?? false,
      task: explicit.task ?? file.task,
      repositoryContext: explicit.repositoryContext ?? file.repositoryContext,
      collection: { ...file.collection, ...defined(explicit.collection) },
      ...(config ? { projectConfig: config } : {}),
    },
    reviewTimeoutMs: explicit.reviewTimeoutMs ?? file.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxRequests: explicit.maxRequests ?? file.maxRequests ?? DEFAULT_MAX_REQUESTS,
    settingsFileNotes: [...fromFile('Task', explicit.task, file.task), ...fromFile('Repository context', explicit.repositoryContext, file.repositoryContext)],
    provider: { model: file.model, timeoutMs: file.requestTimeoutMs, concurrency: file.requestConcurrency },
  };
}
