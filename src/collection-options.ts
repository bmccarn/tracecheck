import { z } from 'zod';

/** Discovery budgets are local resource policies, independent of provider packet limits. */
export const collectionOptionsSchema = z.object({
  maxIndexFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxIndexBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  indexTimeoutMs: z.number().int().positive().max(3_600_000).default(20_000),
  collectionTimeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
}).strict();

export type CollectionOptions = z.input<typeof collectionOptionsSchema>;
export type CollectionSettings = z.output<typeof collectionOptionsSchema>;
export const reviewTimeoutSchema = z.number().int().positive().max(3_600_000).default(300_000);
