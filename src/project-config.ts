import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { DEFAULT_BASE, DEFAULT_REVIEW_TIMEOUT_MS, reviewScopeFields, reviewTimeoutSchema, type CollectionOptions } from './collection-options.js';
import { gitEnvironment } from './git-context.js';
import { modelSchema, requestTimeoutSchema, type ConfiguredJevSettings } from './jev.js';
import { hasSecret, readSource } from './safety.js';

const exec = promisify(execFile);
/** Optional configuration file at the repository root. */
export const CONFIG_FILE = '.tracecheck.json';
const MAX_CONFIG_BYTES = 64_000;
const CREDENTIAL_KEY = /key|token|secret|password|passphrase|credential|bearer|^auth/i;

/** Every key is optional. Values use the same schemas as the CLI flags and MCP arguments. */
export const projectConfigSchema = z.object({
  ...reviewScopeFields,
  reviewTimeoutMs: reviewTimeoutSchema,
  model: modelSchema,
  requestTimeoutMs: requestTimeoutSchema,
}).partial().strict();
export type ProjectConfig = z.output<typeof projectConfigSchema>;

/** Settings from CLI flags or MCP arguments. Each defined value overrides the configuration file. */
export type ExplicitSettings = {
  base?: string; includeUntracked?: boolean; task?: string; repositoryContext?: string;
  collection?: CollectionOptions; reviewTimeoutMs?: number;
};

export type EffectiveSettings = {
  root: string;
  /** Options for collect(). The configuration file, when present, is part of the preview snapshot. */
  request: {
    base: string; includeUntracked: boolean; task?: string; repositoryContext?: string;
    collection: CollectionOptions; projectConfig?: ProjectConfig;
  };
  reviewTimeoutMs: number;
  /** Provider fallbacks for jevSettings; JEV_MODEL and JEV_TIMEOUT_MS override them. */
  provider: ConfiguredJevSettings;
};

const where = (path: PropertyKey[]) => path.length ? `"${path.map(String).join('.')}"` : 'the top level';

/** Validates configuration file text. Errors name the offending key and never quote its value. */
export function parseProjectConfig(text: string): ProjectConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${CONFIG_FILE} is not valid JSON.`); }
  const visit = (item: unknown, path: string[]): void => {
    if (typeof item === 'string' && hasSecret(item)) {
      throw new Error(`${CONFIG_FILE}: ${where(path)} contains a potential credential. Provider keys belong in the environment only.`);
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (CREDENTIAL_KEY.test(key)) {
        throw new Error(`${CONFIG_FILE}: ${where([...path, key])} looks like a credential field. Provider keys belong in the environment only.`);
      }
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
  const parsed = projectConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.flatMap(issue => issue.code === 'unrecognized_keys'
    ? issue.keys.map(key => `unknown key ${where([...issue.path, key])}`)
    : [`${where(issue.path)}: ${issue.message}`]);
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
    provider: { model: file.model, timeoutMs: file.requestTimeoutMs },
  };
}
