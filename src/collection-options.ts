import { z } from 'zod';

const timeoutMs = z.number().int().positive().max(3_600_000);

/**
 * Discovery budgets are local resource policies, independent of provider packet limits.
 * Omitted keys fall back to the project configuration file, then to the defaults in collectionSettingsSchema.
 */
export const collectionOptionsSchema = z.object({
  maxIndexFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxIndexBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  indexTimeoutMs: timeoutMs.optional(),
  collectionTimeoutMs: timeoutMs.optional(),
}).strict();
/** Collection options with their built-in defaults applied. */
export const collectionSettingsSchema = collectionOptionsSchema.extend({
  indexTimeoutMs: timeoutMs.default(20_000),
  collectionTimeoutMs: timeoutMs.default(120_000),
});

export type CollectionOptions = z.input<typeof collectionOptionsSchema>;
export type CollectionSettings = z.output<typeof collectionSettingsSchema>;

/** Review scope settings shared by CLI flags, MCP arguments, and the project configuration file. */
export const reviewScopeFields = {
  base: z.string().min(1),
  includeUntracked: z.boolean(),
  task: z.string().min(1),
  repositoryContext: z.string().min(1),
  collection: collectionOptionsSchema,
};
export const DEFAULT_BASE = 'HEAD';
export const reviewTimeoutSchema = timeoutMs;
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
/** Overall deadline for one verification, shared by the CLI and MCP entry points. */
export const VERIFY_TIMEOUT_MS = 90_000;
