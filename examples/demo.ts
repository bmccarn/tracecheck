import { review, render } from '../src/review.js';
import { cases, casePlan } from './cases.js';

// Deliberately fixed responses demonstrate the report shape, not model quality.
const report = await review(casePlan(cases[0]), {
  async evaluate(_state, questions) {
    return { model: 'OFFLINE_DEMO_NOT_JEV', usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const choice = id.endsWith('_impact') ? 'medium' : 'supported';
        const options = Object.keys(question.criteria);
        return [id, { type: 'choice' as const, choice, confidence: 0.9,
          probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 0.95 : 0.05 / (options.length - 1)])) }];
      })) };
  },
});
console.log('OFFLINE DEMO — scripted responses; no model was called.\n');
console.log(render(report));
