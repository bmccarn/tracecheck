import { z } from 'zod';
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

export class Jev implements Evaluator, TypedEvaluator {
  readonly model: string;
  constructor(private options: { apiKey: string; model?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new Error('Set JEV_API_KEY or TYPESAFE_API_KEY before running a live review. Preview and demo do not require a key.');
    this.model = options.model ?? 'jev-latest';
  }

  async evaluate(state: unknown, questions: Record<string, Choice>): Promise<Response>;
  async evaluate(state: unknown, questions: Record<string, Question>): Promise<TypedResponse>;
  async evaluate(state: unknown, questions: Record<string, Question>): Promise<TypedResponse> {
    const body = JSON.stringify({ model: this.model, state, questions });
    if (Buffer.byteLength(body) > 180_000) throw new Error('Review request exceeds the local 180 KB request budget. Reduce the review scope.');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 45_000);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const request = this.options.fetch ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' }, body, signal,
      });
      if (response.ok) {
        const parsed = responseSchema.safeParse(await response.json());
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
        const body: unknown = await response.json().catch(() => null);
        const error = z.object({ detail: z.object({ error_type: z.string() }) }).safeParse(body);
        if (error.success && error.data.detail.error_type === 'max_tokens_exceeded') {
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
