import { z } from 'zod';
import { assertSafeOutbound } from './safety.js';
import type { Choice, Evaluator, Response, Question, TypedResponse, TypedEvaluator } from './domain.js';

const answerSchema = z.object({
  type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const responseSchema = z.object({
  model: z.string().min(1), answers: z.record(z.string(), z.discriminatedUnion('type', [answerSchema,
    z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
    z.object({ type: z.literal('score'), score: z.number().nonnegative(), confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)), legend: z.record(z.string(), z.string()) }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

async function boundedJson(response: globalThis.Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Jev returned an empty response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000) throw new Error('Jev response exceeded the 512 KB response budget.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Jev returned invalid JSON; review is incomplete.'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const DEFAULT_MODEL = 'jev-latest';
/** Environment variables that select the provider, credential, and model. */
export const PROVIDER_ENVIRONMENT = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_BASE_URL', 'JEV_MODEL'] as const;

export type JevSettings = { apiKey: string; baseUrl: string; model: string };

/**
 * Resolves provider settings from the environment. A TypeSafe key takes precedence over an
 * OpenRouter key. OpenRouter serves TypeSafe's System One API, so only the base URL differs.
 * An explicit TYPESAFE_BASE_URL always wins.
 */
export function jevSettings(env: NodeJS.ProcessEnv = process.env): JevSettings {
  const typesafeKey = env.JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim();
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  return {
    apiKey: typesafeKey || openRouterKey || '',
    baseUrl: env.TYPESAFE_BASE_URL?.trim() || (!typesafeKey && openRouterKey ? OPENROUTER_BASE_URL : TYPESAFE_BASE_URL),
    model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export function jevFromEnv(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Jev {
  return new Jev({ ...jevSettings(env), signal });
}

/** The provider variables that are set, for forwarding to a child process. */
export function providerEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(PROVIDER_ENVIRONMENT.flatMap(name => env[name] ? [[name, env[name]]] : []));
}

function systemOneEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('TYPESAFE_BASE_URL must be an absolute URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // The API key travels in a header, so it must never reach a remote host in plain text.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('TYPESAFE_BASE_URL must use HTTPS unless it points to a loopback host.');
  }
  if (url.username || url.password || /[?#]/.test(baseUrl)) {
    throw new Error('TYPESAFE_BASE_URL must not contain credentials, a query, or a fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/v1/systemone`;
}

export class Jev implements Evaluator, TypedEvaluator {
  readonly model: string;
  readonly endpoint: string;
  constructor(private options: { apiKey: string; model?: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new Error('Set JEV_API_KEY, TYPESAFE_API_KEY, or OPENROUTER_API_KEY before running a live review. Preview and demo do not require a key.');
    this.model = options.model ?? DEFAULT_MODEL;
    this.endpoint = systemOneEndpoint(options.baseUrl ?? TYPESAFE_BASE_URL);
  }

  async evaluate(state: unknown, questions: Record<string, Choice>): Promise<Response>;
  async evaluate(state: unknown, questions: Record<string, Question>): Promise<TypedResponse>;
  async evaluate(state: unknown, questions: Record<string, Question>): Promise<TypedResponse> {
    assertSafeOutbound(state);
    const body = JSON.stringify({ model: this.model, state, questions });
    if (Buffer.byteLength(body) > 180_000) throw new Error('Review request exceeds the local 180 KB request budget. Reduce the review scope.');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 45_000);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const request = this.options.fetch ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const response = await request(this.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' }, body, signal,
      });
      if (response.ok) {
        const parsed = responseSchema.safeParse(await boundedJson(response));
        if (!parsed.success) throw new Error('Jev returned an invalid response; review is incomplete.');
        for (const [id, question] of Object.entries(questions)) {
          const answer = parsed.data.answers[id];
          if (!answer || answer.type !== question.type) throw new Error(`Jev returned an incomplete or invalid decision for ${id}; review is incomplete.`);
          if (answer.type === 'noul') continue;
          const keys = Object.keys(question.criteria);
          if ((answer.type === 'choice' && !keys.includes(answer.choice))
            || (answer.type === 'score' && (answer.score > keys.length - 1 || keys.some(key => !answer.legend[key])))
            || keys.some(key => answer.probabilities[key] === undefined)
            || Object.keys(answer.probabilities).some(key => !keys.includes(key))
            || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02) {
            throw new Error(`Jev returned an incomplete or invalid decision for ${id}; review is incomplete.`);
          }
        }
        return parsed.data;
      }
      // Read only a known error code; never surface a remote body that may echo source.
      if (response.status === 400) {
        const body: unknown = await boundedJson(response).catch(() => null);
        const direct = z.object({ detail: z.object({ error_type: z.string() }) }).safeParse(body);
        // OpenRouter forwards TypeSafe's error body as a string inside its own error envelope.
        const relayed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
        if ((direct.success && direct.data.detail.error_type === 'max_tokens_exceeded')
          || (relayed.success && /"error_type"\s*:\s*"max_tokens_exceeded"/.test(relayed.data.error.message))) {
          throw new Error('Jev context limit exceeded. Split the review into coherent slices that retain relevant contracts and callers.');
        }
      } else await response.body?.cancel();
      if (![429, 500, 502, 503, 504, 529].includes(response.status) || attempt === 2) {
        throw new Error(`Jev request failed (HTTP ${response.status}); no successful review was recorded.`);
      }
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const requestedDelay = Number.isFinite(seconds) ? seconds * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
      const delay = Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay) : 500 * 2 ** attempt + Math.random() * 150;
      // Long Retry-After values must not be silently shortened.
      if (delay > 10_000) throw new Error('Jev requested a longer retry delay; try this review again later.');
      await new Promise<void>((done, reject) => {
        signal.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, delay);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Jev retry budget exhausted.');
  }
}
