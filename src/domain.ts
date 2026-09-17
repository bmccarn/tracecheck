import { createHash } from 'node:crypto';

export const CHECK_VERSION = '1';
export const POLICY_VERSION = '2';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type Source = { path: string; content: string; role: 'changed' | 'dependency' | 'caller' | 'test'; before?: string; evidence?: { currentRanges: Range[]; beforeRanges?: Range[]; totalLines: number; complete: boolean; digest: string } };
export type Range = { start: number; end: number };
export type Candidate = {
  id: string; check: string; path: string; symbol: string; range: Range;
  quote: string; hypothesis: string; verification: string;
};
export type ReviewPlan = {
  schemaVersion: 1; root: string; base: string; head: string; snapshot: string;
  sources: Source[]; candidates: Candidate[]; limitations: string[];
  task?: string; repositoryContext?: string;
};
export type Choice = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Answer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type Noul = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };
export type Score = { type: 'score'; instructions: string; criteria: string[] };
export type Question = Choice | Noul | Score;
export type TypedAnswer = Answer | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
export type Response = {
  model: string; answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};
export interface Evaluator {
  evaluate(state: unknown, questions: Record<string, Choice>): Promise<Response>;
}
export type TypedResponse = Omit<Response, 'answers'> & { answers: Record<string, TypedAnswer> };
export interface TypedEvaluator { evaluate(state: unknown, questions: Record<string, Question>): Promise<TypedResponse> }
export type Decision = Candidate & {
  status: 'supported' | 'uncertain' | 'needs_context' | 'not_supported';
  confidence: number; probability: number;
  impact: 'high' | 'medium' | 'low' | 'unknown'; impactConfidence: number;
  raw: { assessment: Answer; impact: Answer };
};
export type Report = {
  schemaVersion: 1; id: string; createdAt: string; snapshot: string;
  root: string; base: string; head: string;
  checkVersion: string; policyVersion: string; models: string[];
  status: 'needs_attention' | 'inconclusive' | 'no_findings';
  decisions: Decision[]; limitations: string[];
  quality?: import('./quality.js').QualityEvaluation;
  usage: { inputTokens: number; outputTokens: number; requests: number; elapsedMs: number };
};
