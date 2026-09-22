import { verify, verificationInputSchema, verificationOutputSchema } from './verify.js';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { collect } from './collector.js';
import { Jev, jevFromEnv, jevSettings } from './jev.js';
import { applyPreviousEvaluation, reviewAll } from './review.js';
import { ASSESS_TIMEOUT_MS, assess, previousEvaluationSchema, qualityInputSchema, qualityEvaluationSchema } from './quality.js';
import { reportSchema } from './schema.js';
import { type DiscoveryScope, type Report, type TypedEvaluator } from './domain.js';
import { collectionOptionsSchema, reviewTimeoutSchema, VERIFY_TIMEOUT_MS } from './collection-options.js';
import { deadline } from './deadline.js';
import { releaseVersion } from './version.js';

const CACHE_LIMIT = 16;
const CACHE_TTL_MS = 300_000;

/** A bounded map whose entries expire. Insertion order is expiry order, so the first entry is the oldest. */
export class ExpiringCache<V> {
  private readonly entries = new Map<string, { expires: number; value: V }>();
  constructor(private readonly limit: number, private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  /** Purges expired entries, then evicts the oldest live entry only when a new key would exceed the limit. */
  set(key: string, value: V): void {
    const now = this.now();
    for (const [existing, entry] of this.entries) if (entry.expires <= now) this.entries.delete(existing);
    if (!this.entries.delete(key) && this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: now + this.ttlMs, value });
  }
}

export function createServer(repo?: string, evaluatorFactory?: (signal: AbortSignal) => TypedEvaluator) {
  const server = new McpServer({ name: 'tracecheck', version: releaseVersion });
  const cache = new ExpiringCache<Report>(CACHE_LIMIT, CACHE_TTL_MS);
  const previewScopes = new ExpiringCache<DiscoveryScope>(CACHE_LIMIT, CACHE_TTL_MS);
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
    description: `Review caller-supplied task, diff, files, and repository context across 19 independent quality dimensions with Jev. Language-agnostic; no filesystem reads. Optional previousEvaluation is compared locally. Returns scores, confidence, prioritized concerns, and changes. Times out after ${ASSESS_TIMEOUT_MS / 1000} seconds.`,
    inputSchema: qualityInputSchema, outputSchema: qualityEvaluationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal, deadline(ASSESS_TIMEOUT_MS, `Assessment timed out after ${ASSESS_TIMEOUT_MS} ms.`)]);
    const output = await assess(args, evaluatorFactory?.(signal) ?? jevFromEnv(signal), signal);
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
    previewScopes.set(plan.snapshot, plan.discovery);
    const output = { snapshot: plan.snapshot, packets: plan.packets.map(packet => ({ id: packet.id, changedPaths: packet.changedPaths })),
      files: plan.sources.map(source => ({ path: source.path, ...(source.previousPath ? { previousPath: source.previousPath } : {}), role: source.role, characters: source.content.length + (source.before?.length ?? 0) })),
      candidates: plan.candidates.length, limitations: plan.limitations };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  });
  server.registerTool('tracecheck_review', {
    description: 'Review all previewed change packets with bounded evidence and individual packet quality assessments using Jev. Sends collected source and base versions to TypeSafe. Optional previousEvaluation is compared only for a single-packet quality result. Never edits or executes code.',
    inputSchema: z.object({ ...scope, reviewTimeoutMs: reviewTimeoutSchema.describe('Maximum review duration in milliseconds.'), previousEvaluation: previousEvaluationSchema.optional(), snapshot: z.string().length(64).describe('Snapshot returned by tracecheck_preview. A changed snapshot is rejected.') }),
    outputSchema: z.object({ cached: z.boolean(), report: reportSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal,
      deadline(args.reviewTimeoutMs, `Review timed out after ${args.reviewTimeoutMs} ms. Raise reviewTimeoutMs to allow more time.`)]);
    const root = await target(args.repo);
    const discovery = previewScopes.get(args.snapshot);
    if (!discovery) throw new Error('Preview snapshot is unknown or expired. Run tracecheck_preview again.');
    const collectionRequest = { repo: args.repo, base: args.base, includeUntracked: args.includeUntracked,
      task: args.task, repositoryContext: args.repositoryContext, collection: args.collection };
    const plan = await collect({ ...collectionRequest, repo: root, discovery, signal });
    if (plan.snapshot !== args.snapshot) throw new Error('Repository context changed since preview. Run tracecheck_preview again.');
    const settings = jevSettings();
    const key = `${plan.root}:${plan.snapshot}:${settings.baseUrl}:${settings.model}`;
    // A hit needs no second collection: the collection above already matched the preview snapshot.
    let report = cache.get(key);
    const cached = report !== undefined;
    if (!report) {
      report = await reviewAll(plan, evaluatorFactory?.(signal) ?? new Jev({ ...settings, signal }), { signal });
      signal.throwIfAborted();
      const current = await collect({ ...collectionRequest, repo: plan.root, discovery, signal });
      if (current.snapshot !== plan.snapshot) throw new Error('Repository changed during review. Preview and review again.');
      cache.set(key, report);
    }
    const compared = structuredClone(report);
    applyPreviousEvaluation(compared, args.previousEvaluation);
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
