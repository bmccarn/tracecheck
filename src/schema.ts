import { z } from 'zod';
import { qualityEvaluationSchema } from './quality.js';

const answer = z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)) });
export const reportSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), createdAt: z.string(), snapshot: z.string(), root: z.string(), base: z.string(), head: z.string(),
  checkVersion: z.string(), policyVersion: z.string(), models: z.array(z.string()),
  status: z.enum(['needs_attention', 'inconclusive', 'no_findings']),
  decisions: z.array(z.object({
    id: z.string(), check: z.string(), path: z.string(), symbol: z.string(),
    range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
    quote: z.string(), hypothesis: z.string(), verification: z.string(),
    status: z.enum(['supported', 'uncertain', 'needs_context', 'not_supported']),
    confidence: z.number().min(0).max(1), probability: z.number().min(0).max(1),
    impact: z.enum(['high', 'medium', 'low', 'unknown']), impactConfidence: z.number().min(0).max(1),
    raw: z.object({ assessment: answer, impact: answer }),
  })),
  limitations: z.array(z.string()),
  quality: qualityEvaluationSchema.optional(),
  packetQualities: z.array(z.object({ packetId: z.string(), changedPaths: z.array(z.string()), evaluation: qualityEvaluationSchema })).optional(),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), requests: z.number().nonnegative(), elapsedMs: z.number().nonnegative() }),
});
