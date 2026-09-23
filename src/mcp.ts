import { verify, verificationInputSchema, verificationOutputSchema } from './verify.js';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { collect } from './collector.js';
import { Jev, jevFromEnv, jevSettings } from './jev.js';
import { applyPreviousEvaluation, isIncomplete, reviewAll } from './review.js';
import { ASSESS_TIMEOUT_MS, assess, previousEvaluationSchema, qualityInputSchema, qualityEvaluationSchema } from './quality.js';
import { reportSchema } from './schema.js';
import { type DiscoveryScope, type Report, type TypedEvaluator } from './domain.js';
import { reviewScopeFields, reviewTimeoutSchema, VERIFY_TIMEOUT_MS } from './collection-options.js';
import { CONFIG_FILE, resolveSettings } from './project-config.js';
import { deadline } from './deadline.js';
import { ReviewProgress } from './progress.js';
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

/** A tool result that carries `output` both as structured content and as JSON text. */
function toolResult<T extends Record<string, unknown>>(output: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

/**
 * Review progress for a request that carries a progress token, or undefined without one. Notifications go out in
 * order, and a failed notification never fails the review. `sent` settles once every notification so far was written.
 */
function progressFor(ctx: ServerContext) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let sent = Promise.resolve();
  const progress = new ReviewProgress(update => {
    sent = sent.then(() => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, ...update } })).catch(() => {});
  });
  return { review: progress, sent: () => sent };
}

export function createServer(repo?: string, evaluatorFactory?: (signal: AbortSignal) => TypedEvaluator) {
  const server = new McpServer({ name: 'tracecheck', version: releaseVersion });
  const cache = new ExpiringCache<Report>(CACHE_LIMIT, CACHE_TTL_MS);
  const previewScopes = new ExpiringCache<DiscoveryScope>(CACHE_LIMIT, CACHE_TTL_MS);
  const scope = { repo: z.string().min(1).optional().describe('Repository path; required unless the server was launched with --repo.'),
    base: reviewScopeFields.base.optional().describe(`Git baseline; the working tree is compared against this commit. Defaults to base in the repository's ${CONFIG_FILE}, then HEAD.`),
    includeUntracked: reviewScopeFields.includeUntracked.optional().describe(`Include untracked files. Defaults to ${CONFIG_FILE}, then false.`),
    task: reviewScopeFields.task.optional().describe(`Current task or requirements. Defaults to ${CONFIG_FILE}.`),
    repositoryContext: reviewScopeFields.repositoryContext.optional().describe(`Repository facts for reviewers. Defaults to ${CONFIG_FILE}.`),
    collection: reviewScopeFields.collection.optional().describe(`Bounded local collection settings; each key overrides ${CONFIG_FILE}. Matching settings are required when reviewing a preview snapshot.`) };
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
    return toolResult(output);
  });
  server.registerTool('tracecheck_assess', {
    description: `Review caller-supplied task, diff, files, and repository context across 19 independent quality dimensions with Jev. Language-agnostic; no filesystem reads. Optional previousEvaluation is compared locally. Returns scores, confidence, prioritized concerns, and changes. Times out after ${ASSESS_TIMEOUT_MS / 1000} seconds.`,
    inputSchema: qualityInputSchema, outputSchema: qualityEvaluationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal, deadline(ASSESS_TIMEOUT_MS, `Assessment timed out after ${ASSESS_TIMEOUT_MS} ms.`)]);
    const output = await assess(args, evaluatorFactory?.(signal) ?? jevFromEnv(signal), signal);
    return toolResult(output);
  });
  server.registerTool('tracecheck_preview', {
    description: 'Collect bounded evidence for all change packets and source checks. Local only; no Jev request. Returns a snapshot token required by tracecheck_review.',
    inputSchema: z.object(scope),
    outputSchema: z.object({
      snapshot: z.string(),
      packets: z.array(z.object({ id: z.string(), changedPaths: z.array(z.string()) })),
      files: z.array(z.object({ path: z.string(), previousPath: z.string().optional(), role: z.string(), characters: z.number() })),
      candidates: z.number(), limitations: z.array(z.string()), notes: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const settings = await resolveSettings(await target(args.repo), args, ctx.mcpReq.signal);
    const plan = await collect({ repo: settings.root, ...settings.request, signal: ctx.mcpReq.signal });
    if (!plan.discovery) throw new Error('Collection did not produce a discovery scope. Run tracecheck_preview again.');
    previewScopes.set(plan.snapshot, plan.discovery);
    const output = { snapshot: plan.snapshot, packets: plan.packets.map(packet => ({ id: packet.id, changedPaths: packet.changedPaths })),
      files: plan.sources.map(source => ({ path: source.path, ...(source.previousPath ? { previousPath: source.previousPath } : {}), role: source.role, characters: source.content.length + (source.before?.length ?? 0) })),
      candidates: plan.candidates.length, limitations: plan.limitations, notes: plan.notes };
    return toolResult(output);
  });
  server.registerTool('tracecheck_review', {
    description: 'Review all previewed change packets with bounded evidence and individual packet quality assessments using Jev. Sends collected source and base versions to TypeSafe. Optional previousEvaluation is compared only for a single-packet quality result. Never edits or executes code.',
    inputSchema: z.object({ ...scope, reviewTimeoutMs: reviewTimeoutSchema.optional().describe(`Maximum review duration in milliseconds. Defaults to ${CONFIG_FILE}, then 300000.`), previousEvaluation: previousEvaluationSchema.optional(), snapshot: z.string().length(64).describe('Snapshot returned by tracecheck_preview. A changed snapshot is rejected.') }),
    outputSchema: z.object({ cached: z.boolean(), report: reportSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const progress = progressFor(ctx);
    const effective = await resolveSettings(await target(args.repo), args, ctx.mcpReq.signal);
    const { reviewTimeoutMs, request: collectionRequest } = effective;
    const signal = AbortSignal.any([ctx.mcpReq.signal,
      deadline(reviewTimeoutMs, `Review timed out after ${reviewTimeoutMs} ms. Raise reviewTimeoutMs to allow more time.`)]);
    const discovery = previewScopes.get(args.snapshot);
    if (!discovery) throw new Error('Preview snapshot is unknown or expired. Run tracecheck_preview again.');
    const plan = await collect({ ...collectionRequest, repo: effective.root, discovery, signal, onPhase: progress?.review.phase });
    if (plan.snapshot !== args.snapshot) throw new Error('Repository context changed since preview. Run tracecheck_preview again.');
    const settings = jevSettings(process.env, effective.provider);
    const key = `${plan.root}:${plan.snapshot}:${settings.baseUrl}:${settings.model}`;
    // A hit needs no second collection: the collection above already matched the preview snapshot.
    let report = cache.get(key);
    const cached = report !== undefined;
    if (!report) {
      report = await reviewAll(plan, evaluatorFactory?.(signal) ?? new Jev({ ...settings, signal }),
        { signal, concurrency: settings.concurrency, onProgress: progress?.review.requests });
      signal.throwIfAborted();
      progress?.review.checking();
      const current = await collect({ ...collectionRequest, repo: plan.root, discovery, signal });
      if (current.snapshot !== plan.snapshot) throw new Error('Repository changed during review. Preview and review again.');
      // A retry must reach the provider again rather than replay a review that a failed request left incomplete.
      if (!isIncomplete(report)) cache.set(key, report);
      progress?.review.finished();
    }
    const compared = structuredClone(report);
    applyPreviousEvaluation(compared, args.previousEvaluation);
    const output = { cached, report: compared };
    await progress?.sent();
    return toolResult(output);
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
