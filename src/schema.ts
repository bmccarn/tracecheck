import { z } from 'zod';
import { answerSchema } from './jev.js';
import { qualityEvaluationSchema } from './quality.js';

// domain.ts infers Range, Candidate, Decision, and Report from these schemas, so saved-report validation and the
// types the review builds cannot drift apart.
export const rangeSchema = z.object({ start: z.number().int().positive(), end: z.number().int().positive() });
export const candidateSchema = z.object({
  id: z.string(), check: z.string(), path: z.string(), symbol: z.string(), range: rangeSchema,
  quote: z.string(), hypothesis: z.string(), verification: z.string(),
});
export const reportSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), createdAt: z.string(), snapshot: z.string(), root: z.string(), base: z.string(), head: z.string(),
  // The ref the review was asked to compare against; `base` is its merge base with HEAD. Reports saved by 0.3.x have none.
  baseRef: z.string().optional(),
  checkVersion: z.string(), policyVersion: z.string(), models: z.array(z.string()),
  status: z.enum(['needs_attention', 'inconclusive', 'no_findings']),
  decisions: z.array(candidateSchema.extend({
    status: z.enum(['supported', 'uncertain', 'needs_context', 'not_supported']),
    confidence: z.number().min(0).max(1), probability: z.number().min(0).max(1),
    impact: z.enum(['high', 'medium', 'low', 'unknown']), impactConfidence: z.number().min(0).max(1),
    raw: z.object({ assessment: answerSchema, impact: answerSchema }),
  })),
  // Coverage gaps: any gap keeps a report from `no_findings`.
  limitations: z.array(z.string()),
  // Permanent caveats shown with the report; they never change its status. Reports saved by 0.3.0 and earlier have none.
  notes: z.array(z.string()).default([]),
  quality: qualityEvaluationSchema.optional(),
  packetQualities: z.array(z.object({ packetId: z.string(), changedPaths: z.array(z.string()), evaluation: qualityEvaluationSchema })).optional(),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), requests: z.number().nonnegative(), elapsedMs: z.number().nonnegative() }),
});
