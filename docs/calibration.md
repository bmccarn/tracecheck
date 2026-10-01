# Decision-gate calibration

Tracecheck turns Jev's typed answers into decisions through fixed gates in `src/policy.ts`. This page summarizes the labeled calibration that set them, for [#70](https://github.com/bmccarn/tracecheck/issues/70) (source checks) and [#59](https://github.com/bmccarn/tracecheck/issues/59) (quality dimensions). `npm run calibrate -- replay` regenerates the full tables and grids from a run's raw answers.

## Adopted gates

- Source checks (policy version 3): a candidate is `supported` or `not_supported` when the selected probability is at least 0.70 and the confidence is at least 0.60.
- Quality (rubric version 3): a dimension is scored when relevance is at least 0.8 and applicability at least 0.5, and the score is `assessed` when its confidence is at least 0.4.
- Concern gates are unchanged: confidence at least 0.6 and probability at least 0.8.

## Results

The run on September 23, 2026 used `typesafe/jev-1.13-20260917` through OpenRouter on 36 synthetic defect/clean pairs (`benchmarks/calibration/cases.ts`), split into development and holdout before any request, with three reviews per variant. It took 220 provider requests and about $0.16 of input tokens.

- The earlier source-check gates (0.80 and 0.60) supported 73% of planted defects in both splits and no clean variant. The adopted gates supported 93% on development and 87% on holdout, with one clean review supported out of 90. Uncertain decisions fell from 16% to 7%.
- The confidence gate at 0.60 is what keeps clean variants out; lowering it lets clean candidates through by majority.
- The earlier quality gates (0.8, 0.8, 0.6) scored 7% of labeled-relevant dimensions on development and none on holdout. The adopted gates scored 57% and 46%, scored no labeled-irrelevant dimension, and raised no priority on a clean variant. Where both variants of a pair got a score, the clean variant always scored higher.
- Looser quality gates (0.8, 0.3, 0.3) would have ended a quarter of clean reviews as `needs_attention` because of `testQuality` concerns.

## Caveats

- One author wrote all cases; every task states its contract and every packet is small, so real-world recall is probably lower.
- Each split has 15 defect and 15 clean candidates, so zero false positives still allows a true rate of up to about 20%.
- One model version on one day; repeat the calibration when the model changes.
- The holdout shares the development set's author and style, and it has now been used once.

When the gates change, bump `POLICY_VERSION` in `src/domain.ts` or `RUBRIC_VERSION` in `src/quality.ts`; replay reads its baseline from `src/policy.ts`.

## Reproduce

These commands run from a source checkout.

```sh
# Build and collect every case and check its labels. No key, no request.
npm run calibrate -- run

# Review every variant three times with the configured provider. About 216 requests.
npm run calibrate -- run --live --repeats 3 --max-requests 400

# Recompute every table from a run's raw answers. No request.
npm run calibrate -- replay .tracecheck/calibration/<timestamp>
```

`run --live` writes `raw.jsonl` to `.tracecheck/calibration/<timestamp>/` and then replays it. To resume an interrupted run, pass that directory with `--out`. The harness skips reviews that already completed and counts earlier requests toward `--max-requests`. Use `--cases` to select case IDs, `--repeats` to change the number of reviews per variant, and `--concurrency` to change the requests in flight. `.tracecheck/` is ignored by Git. Keep raw runs private: they hold provider output about the case source.
