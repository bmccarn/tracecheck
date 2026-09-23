import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { answerSchema } from './jev.js';
import type { candidateSchema, rangeSchema, reportSchema } from './schema.js';

export const CHECK_VERSION = '1';
export const POLICY_VERSION = '2';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type Source = { path: string; previousPath?: string; content: string; role: 'changed' | 'dependency' | 'caller' | 'test'; before?: string; evidence?: { currentRanges: Range[]; beforeRanges?: Range[]; totalLines: number; complete: boolean; digest: string } };
// Types that saved reports carry are inferred from the schemas that validate them.
export type Range = z.infer<typeof rangeSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type ReviewPacket = {
  id: string; changedPaths: string[]; sourcePaths: string[]; candidateIds: string[]; limitations: string[];
};
export type DiscoveryScope = { scannedFiles: number; deadlineLimited: boolean };
/**
 * `limitations` are coverage gaps: evidence the review could not see. `notes` are permanent caveats, such as heuristic
 * caller discovery; they never change a report's status and are not part of the snapshot.
 * `base` is the commit the working tree is compared against: the merge base of `baseRef`, the requested ref, and HEAD.
 */
export type ReviewPlan = {
  schemaVersion: 1; root: string; base: string; baseRef?: string; head: string; snapshot: string;
  sources: Source[]; candidates: Candidate[]; packets: ReviewPacket[]; limitations: string[]; notes: string[];
  discovery?: DiscoveryScope;
  task?: string; repositoryContext?: string;
};
export type Choice = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Answer = z.infer<typeof answerSchema>;
export type Noul = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };
export type Score = { type: 'score'; instructions: string; criteria: string[] };
export type Question = Choice | Noul | Score;
export type TypedAnswer = Answer | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
export type Response = {
  model: string; answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};
/** An evaluator rejects promptly when `signal` aborts, so a cancelled review stops every request in flight. */
export interface Evaluator {
  evaluate(state: unknown, questions: Record<string, Choice>, signal?: AbortSignal): Promise<Response>;
}
export type TypedResponse = Omit<Response, 'answers'> & { answers: Record<string, TypedAnswer> };
export interface TypedEvaluator { evaluate(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<TypedResponse> }
export type Report = z.infer<typeof reportSchema>;
export type Decision = Report['decisions'][number];
