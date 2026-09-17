import { z } from 'zod';
import { summarize } from './benchmark.js';

const judgment = z.enum(['supported', 'not_supported', 'uncertain', 'needs_context']);
const stage = z.object({ verdict: judgment, elapsedMs: z.number().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() });
export const pairedRunSchema = z.object({
  subjectRevision: z.string().min(1), agentModel: z.string().min(1), jevModel: z.string().min(1),
  cases: z.array(z.object({ id: z.string().min(1), expected: z.enum(['supported', 'not_supported']),
    baselineRecordedAt: z.string().datetime(), verificationStartedAt: z.string().datetime(),
    baseline: stage, jev: stage, assisted: stage,
    discovered: z.boolean(), evidenceComplete: z.boolean(),
  })).min(1),
}).superRefine((run, ctx) => {
  if (new Set(run.cases.map(row => row.id)).size !== run.cases.length) ctx.addIssue({ code: 'custom', message: 'Case IDs must be unique.' });
  for (const row of run.cases) if (Date.parse(row.baselineRecordedAt) >= Date.parse(row.verificationStartedAt)) ctx.addIssue({ code: 'custom', message: 'Record the baseline before consulting Jev.' });
});

export function summarizePaired(raw: unknown) {
  const run = pairedRunSchema.parse(raw);
  const summary = (stage: 'baseline' | 'jev' | 'assisted') => summarize(run.cases.map(row => ({ expected: row.expected, actual: row[stage].verdict, ...row[stage] })));
  const correct = (expected: string, actual: string) => expected === actual;
  return {
    baseline: summary('baseline'), jev: summary('jev'), assisted: summary('assisted'),
    helped: run.cases.filter(row => !correct(row.expected, row.baseline.verdict) && correct(row.expected, row.assisted.verdict)).length,
    harmed: run.cases.filter(row => correct(row.expected, row.baseline.verdict) && !correct(row.expected, row.assisted.verdict)).length,
    discovery: { defects: run.cases.filter(row => row.expected === 'supported').length, discovered: run.cases.filter(row => row.expected === 'supported' && row.discovered).length },
    incompleteEvidence: run.cases.filter(row => !row.evidenceComplete).length,
  };
}
