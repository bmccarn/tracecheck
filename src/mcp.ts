import { verify, verificationInputSchema, verificationOutputSchema } from './verify.js';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { collect } from './collector.js';
import { Jev, jevFromEnv, jevSettings } from './jev.js';
import { reviewAll } from './review.js';
import { assess, compareQuality, qualityInputSchema, qualityEvaluationSchema } from './quality.js';
import { reportSchema } from './schema.js';
import { type DiscoveryScope, type Report, type TypedEvaluator } from './domain.js';
import { collectionOptionsSchema, reviewTimeoutSchema, VERIFY_TIMEOUT_MS } from './collection-options.js';
import { deadline } from './deadline.js';


declare const __TRACECHECK_VERSION__: string | undefined;

const releaseVersion = typeof __TRACECHECK_VERSION__ === 'string'
  ? __TRACECHECK_VERSION__
  : createRequire(import.meta.url)('../package.json').version;
const CACHE_LIMIT = 16;
const CACHE_TTL_MS = 300_000;

export function createServer(repo?: string, evaluatorFactory?: (signal: AbortSignal) => TypedEvaluator) {
  const server = new McpServer({ name: 'tracecheck', version: releaseVersion });
  const cache = new Map<string, { expires: number; report: Report }>();
  const previewScopes = new Map<string, { expires: number; discovery: DiscoveryScope }>();
  const rememberPreview = (snapshot: string, discovery: DiscoveryScope) => {
    const now = Date.now();
    for (const [key, entry] of previewScopes) if (entry.expires <= now) previewScopes.delete(key);
    if (!previewScopes.has(snapshot) && previewScopes.size >= CACHE_LIMIT) previewScopes.delete(previewScopes.keys().next().value!);
    previewScopes.set(snapshot, { expires: now + CACHE_TTL_MS, discovery });
  };
  const previewScope = (snapshot: string) => {
    const entry = previewScopes.get(snapshot);
    if (!entry || entry.expires <= Date.now()) {
      previewScopes.delete(snapshot);
      throw new Error('Preview snapshot is unknown or expired. Run tracecheck_preview again.');
    }
    return entry.discovery;
  };
  const scope = { repo: z.string().min(1).optional().describe('Repository path; required unless the server was launched with --repo.'),
    base: z.string().min(1).default('HEAD').describe('Git baseline; the working tree is compared against this commit.'),
    includeUntracked: z.boolean().default(false), task: z.string().min(1).optional(), repositoryContext: z.string().min(1).optional(),
    collection: collectionOptionsSchema.optional().describe('Bounded local collection settings. Matching settings are required when reviewing a preview snapshot.') };
  const target = async (requested?: string) => {
    if (repo && requested && await realpath(repo) !== await realpath(requested)) throw new Error('This server is bound to a different repository.');
    if (!repo && !requested) throw new Error('Supply repo or launch the server with --repo.');
    return repo ?? requested!;
  };
  server.registerTool('tracecheck_verify', {
    description: 'Verify one agent-discovered defect hypothesis against agent-selected source, contract, and counterevidence in any language. Validates exact target quotes; optional repo checks every excerpt against local files before and after inference. Returns support, impact, uncertainty, and a missing-evidence category. Does not discover concerns, execute code, or prove a fix.',
    inputSchema: verificationInputSchema, outputSchema: verificationOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal, deadline(VERIFY_TIMEOUT_MS, `Verification timed out after ${VERIFY_TIMEOUT_MS} ms.`)]);
    const selected = repo || args.repo ? await target(args.repo) : undefined;
    const output = await verify({ ...args, repo: selected }, evaluatorFactory?.(signal) ?? jevFromEnv(signal), signal);
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  server.registerTool('tracecheck_assess', {
    description: 'Review caller-supplied task, diff, files, and repository context across 19 independent quality dimensions with Jev. Language-agnostic; no filesystem reads. Optional previousEvaluation is compared locally. Returns scores, confidence, prioritized concerns, and changes.',
    inputSchema: qualityInputSchema, outputSchema: qualityEvaluationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const output = await assess(args, jevFromEnv(ctx.mcpReq.signal));
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  server.registerTool('tracecheck_preview', {
    description: 'Collect bounded evidence for all change packets and source checks. Local only; no Jev request. Returns a snapshot token required by tracecheck_review.',
    inputSchema: z.object(scope),
    outputSchema: z.object({
      snapshot: z.string(),
      packets: z.array(z.object({ id: z.string(), changedPaths: z.array(z.string()) })),
      files: z.array(z.object({ path: z.string(), previousPath: z.string().optional(), role: z.string(), characters: z.number() })),
      candidates: z.number(), limitations: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const plan = await collect({ ...args, repo: await target(args.repo), signal: ctx.mcpReq.signal });
    if (!plan.discovery) throw new Error('Collection did not produce a discovery scope. Run tracecheck_preview again.');
    rememberPreview(plan.snapshot, plan.discovery);
    const output = { snapshot: plan.snapshot, packets: plan.packets.map(packet => ({ id: packet.id, changedPaths: packet.changedPaths })),
      files: plan.sources.map(source => ({ path: source.path, ...(source.previousPath ? { previousPath: source.previousPath } : {}), role: source.role, characters: source.content.length + (source.before?.length ?? 0) })),
      candidates: plan.candidates.length, limitations: plan.limitations };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  server.registerTool('tracecheck_review', {
    description: 'Review all previewed change packets with bounded evidence and individual packet quality assessments using Jev. Sends collected source and base versions to TypeSafe. Optional previousEvaluation is compared only for a single-packet quality result. Never edits or executes code.',
    inputSchema: z.object({ ...scope, reviewTimeoutMs: reviewTimeoutSchema.describe('Maximum review duration in milliseconds.'), previousEvaluation: qualityEvaluationSchema.optional(), snapshot: z.string().length(64).describe('Snapshot returned by tracecheck_preview. A changed snapshot is rejected.') }),
    outputSchema: z.object({ cached: z.boolean(), report: reportSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal,
      deadline(args.reviewTimeoutMs, `Review timed out after ${args.reviewTimeoutMs} ms. Raise reviewTimeoutMs to allow more time.`)]);
    const root = await target(args.repo);
    const discovery = previewScope(args.snapshot);
    const collectionRequest = { repo: args.repo, base: args.base, includeUntracked: args.includeUntracked,
      task: args.task, repositoryContext: args.repositoryContext, collection: args.collection };
    const plan = await collect({ ...collectionRequest, repo: root, discovery, signal });
    if (plan.snapshot !== args.snapshot) throw new Error('Repository context changed since preview. Run tracecheck_preview again.');
    const settings = jevSettings();
    const key = `${plan.root}:${plan.snapshot}:${settings.baseUrl}:${settings.model}`;
    const existing = cache.get(key);
    const cached = Boolean(existing && existing.expires > Date.now());
    const report = cached ? existing!.report : await reviewAll(plan, evaluatorFactory?.(signal) ?? new Jev({ ...settings, signal }), { signal });
    signal.throwIfAborted();
    const current = await collect({ ...collectionRequest, repo: plan.root, discovery, signal });
    if (current.snapshot !== plan.snapshot) throw new Error('Repository changed during review. Preview and review again.');
    if (!cached) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, report });
    }
    const compared = structuredClone(report);
    if (compared.quality) compared.quality = compareQuality(compared.quality, args.previousEvaluation);
    else if (args.previousEvaluation && compared.packetQualities?.length) compared.limitations.push('Previous evaluation comparisons apply only to a single-packet quality result; no repository-wide comparison was performed.');
    const output = { cached, report: compared };
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
