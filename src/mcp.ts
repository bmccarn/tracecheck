import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { resolve } from 'node:path';
import { collect } from './collector.js';
import { Jev } from './jev.js';
import { reviewAll } from './review.js';
import { assess, qualityInputSchema, qualityEvaluationSchema } from './quality.js';
import { reportSchema } from './schema.js';
import { hash, type Report } from './domain.js';

export function createServer(repo?: string) {
  const server = new McpServer({ name: 'tracecheck', version: '0.2.0' });
  const cache = new Map<string, { expires: number; report: Report }>();
  const scope = { repo: z.string().min(1).optional().describe('Repository path; required unless the server was launched with --repo.'),
    base: z.string().min(1).default('HEAD').describe('Git baseline; the working tree is compared against this commit.'), includeUntracked: z.boolean().default(false),
    task: z.string().min(1).optional(), repositoryContext: z.string().min(1).optional() };
  const target = (requested?: string) => {
    if (repo && requested && resolve(repo) !== resolve(requested)) throw new Error('This server is bound to a different repository.');
    if (!repo && !requested) throw new Error('Supply repo or launch the server with --repo.');
    return repo ?? requested!;
  };
  server.registerTool('tracecheck_assess', {
    description: 'Review caller-supplied task, diff, files, and repository context across 19 independent quality dimensions with Jev. Language-agnostic; no filesystem reads. Optional previousEvaluation is compared locally. Returns scores, confidence, prioritized concerns, and changes.',
    inputSchema: qualityInputSchema, outputSchema: qualityEvaluationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const output = await assess(args, new Jev({ apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '', model: process.env.JEV_MODEL, signal: ctx.mcpReq.signal }));
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  server.registerTool('tracecheck_preview', {
    description: 'Collect bounded source context for broad quality review and JS/TS source checks. Local only; no Jev request. Returns a snapshot token required by tracecheck_review.',
    inputSchema: z.object(scope),
    outputSchema: z.object({ snapshot: z.string(), files: z.array(z.object({ path: z.string(), role: z.string(), characters: z.number() })), candidates: z.number(), limitations: z.array(z.string()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    const plan = await collect({ ...args, repo: target(args.repo) });
    const output = { snapshot: plan.snapshot, files: plan.sources.map(source => ({ path: source.path, role: source.role, characters: source.content.length + (source.before?.length ?? 0) })), candidates: plan.candidates.length, limitations: plan.limitations };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  server.registerTool('tracecheck_review', {
    description: 'Review the previewed snapshot across all 19 quality dimensions plus source-anchored checks using Jev. Sends collected source and base versions to TypeSafe. Optional previousEvaluation adds quality deltas. Never edits or executes code.',
    inputSchema: z.object({ ...scope, previousEvaluation: qualityEvaluationSchema.optional(), snapshot: z.string().length(64).describe('Snapshot returned by tracecheck_preview. A changed snapshot is rejected.') }),
    outputSchema: z.object({ cached: z.boolean(), report: reportSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const plan = await collect({ ...args, repo: target(args.repo) });
    if (plan.snapshot !== args.snapshot) throw new Error('Repository context changed since preview. Run tracecheck_preview again.');
    const model = process.env.JEV_MODEL ?? 'jev-latest';
    const key = `${plan.snapshot}:${model}:${hash(args.previousEvaluation ?? null)}`;
    const existing = cache.get(key);
    const cached = Boolean(existing && existing.expires > Date.now());
    const report = cached ? existing!.report : await reviewAll(plan, new Jev({ apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '', model, signal: ctx.mcpReq.signal }), { signal: ctx.mcpReq.signal, previousEvaluation: args.previousEvaluation });
    if (!cached) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: Date.now() + 300_000, report });
    }
    const output = { cached, report };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  return server;
}

export async function serve(repo?: string) {
  const server = createServer(repo);
  await server.connect(new StdioServerTransport());
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
