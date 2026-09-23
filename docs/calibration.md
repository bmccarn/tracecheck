# Decision-gate calibration

Tracecheck turns Jev's typed answers into decisions through fixed gates. A source-check candidate is `supported` or `not_supported` only when the selected probability is at least 0.80 and the confidence is at least 0.60. A quality dimension gets a score only when relevance and applicability are both at least 0.8, and the score is published as `assessed` only when its confidence is at least 0.6. This document measures those gates against labeled cases and the live model, for [#70](https://github.com/bmccarn/tracecheck/issues/70) (source checks) and [#59](https://github.com/bmccarn/tracecheck/issues/59) (quality dimensions).

**The thresholds in `src/` are unchanged.** A gate decides what counts as a finding, so the maintainer chooses the policy. The [recommendation](#recommendation) below is one input to that choice.

Run: September 23, 2026, model `typesafe/jev-1.13-20260917` through OpenRouter, 36 labeled pairs, 3 reviews of each variant.

## Findings

- The current source-check gates supported 73% of the planted defects in both splits and never supported a clean variant. 16% of decisions were `uncertain`.
- The probability gate decides the outcome. With confidence kept at 0.60, a probability gate of 0.70 supported 93% of development defects and 87% of holdout defects. It supported one clean candidate in one of 90 clean reviews, and no clean candidate in a majority of its reviews.
- The confidence gate at 0.60 is what keeps clean variants out at lower probability gates. With the probability gate at 0.70 and the confidence gate at 0.55, 7% of development clean candidates are supported in a majority of their reviews.
- Relevance answers separate the dimensions labeled relevant from those labeled irrelevant: the medians are 0.92 and 0.12. Scores are missing because of the other two gates. A labeled-relevant dimension has a median applicability of 0.59 and a median score confidence of 0.51, both below the current gates.
- The current quality gates scored 7% of labeled-relevant dimensions on development cases and none on holdout cases. Gates of 0.8, 0.5, and 0.4 (relevance, applicability, score confidence) scored 57% and 46%, scored no labeled-irrelevant dimension, and raised no priority on a clean variant.
- The published scores rank the variants correctly. On every dimension labeled lower-on-defect where both variants of a pair got a score, the clean variant scored higher, by about 6 points on the 1–10 scale.
- The run used 220 provider requests, including a 4-request pilot. They consumed 3,770,854 input tokens, about $0.16 at $0.042 per million input tokens.

## Dataset

`benchmarks/calibration/cases.ts` holds 36 labeled pairs. Each pair is a small project: a module, a caller, and a test, committed as the baseline. The pair's stated contract is the review task. The defect variant changes the working tree in a way that breaks the contract at the site a source-check candidate quotes. The clean variant makes a similar change that keeps the contract.

- **Zero divisor, 10 pairs.** The clean variant keeps or moves the guard, or validates the divisor where it is read. One pair divides `bigint` values.
- **Swallowed failure, 10 pairs.** The clean variant returns an explicit failure, applies the documented fallback, or rethrows conditionally. In the defect variant, a catch handler turns the failure into success or into an outcome the contract forbids.
- **Unhandled JSON, 10 pairs.** The clean variant handles malformed input at the boundary the contract names: a `try` around the callback that parses, a `try` in the calling function, a promise `.catch`, or an Express error handler.
- **Quality only, 6 pairs.** No variant has a source-check candidate. The defect variant adds a test that cannot catch a regression, duplicates a rule that already has one owner, breaks existing callers of an API, allows path traversal, scans quadratically under a stated workload, or reads rates from a hidden global.

Each pair was assigned to development or holdout before any live request. Each source-check family has five development and five holdout pairs, including one JavaScript pair in each split. The quality-only pairs split three and three.

Each case also labels quality dimensions, using the keys in `src/quality/dimensions.ts`. The labels are `relevant`, `irrelevant` (clearly not relevant to the task), and `lowerOnDefect` (a relevant dimension on which the defect variant should score lower). Dimensions without a label count toward neither share. The families supply defaults. For example, every zero-divisor pair labels `correctness` relevant and lower on defect, and labels `performance`, `scalability`, `observability`, and `security` irrelevant. Cases override the defaults where the task changes them. For example, a task that asks for a log line makes `observability` relevant.

| Split | Source-check pairs | Quality-only pairs | JavaScript pairs | Defect candidates | Clean candidates | Completed reviews |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 15 | 3 | 3 | 15 | 15 | 108 |
| Holdout | 15 | 3 | 3 | 15 | 15 | 108 |
| All | 30 | 6 | 6 | 30 | 30 | 216 |

`npm run calibrate -- run` checks the dataset without a provider key. Every variant must collect into exactly one packet. Its candidates must match its labels: one candidate of the pair's family in each source-check variant, and none in a quality-only variant.

## Method

`benchmarks/calibrate.ts` runs the real pipeline in-process:

1. For each variant, it builds a disposable Git repository in the system temp directory. It commits the baseline, writes the variant's files to the working tree, and runs `collect` with the case's task.
2. It reviews the collected plan with `reviewAll` and the real Jev client configured from the environment. A wrapper around the client appends every provider response to `raw.jsonl`. Each row holds every answer, with its probabilities, confidence, noul value, or score legend, and is tagged with the case, variant, repeat, and candidate IDs. Source text and quotes are not recorded.
3. A counting `fetch` counts every HTTP attempt, including provider retries, against `--max-requests`, and sends nothing past it. The harness also refuses to start when the planned requests exceed the cap.
4. Each variant is reviewed three times (`--repeats`). The harness runs every variant once before starting the next repeat, with four requests in flight.

`npm run calibrate -- replay <run directory>` reads only `raw.jsonl`. It recomputes each decision under each gate with the same rules as `decisionsFrom` in `src/review.ts` and `transformQuality` in `src/quality.ts`. It also checks that the current gates reproduce the live reports. For this run they reproduce 180 of 180 source-check decisions and 4,104 of 4,104 quality outcomes (scored or not scored). Replay writes `tables.md` and `summary.json` into the run directory. Every table in this document is copied from that `tables.md`.

The source-check measures are:

- **Recall (majority):** the share of defect candidates that are `supported` in most of their three reviews.
- **False positives (majority):** the share of clean candidates that are `supported` in most of their reviews.
- **Single review:** the same shares counted over every review separately. This is what one user review sees.
- **Flips:** the share of candidates whose status is not the same in all three reviews.
- **Uncertain:** the share of decisions that land on `uncertain`.

The quality measures are:

- **Relevant scored** and **irrelevant scored:** the share of labeled dimensions published as `assessed`.
- **Score spread:** the mean range of one dimension's published scores across the three reviews.
- **Gate agreement:** the share of dimensions scored in all three reviews or in none.
- **Clean above defect:** for dimensions labeled lower-on-defect, the share of pairs in which the clean variant's mean published score is higher than the defect variant's. Only pairs where both variants published a score count.
- **Priority on defect** and **priority on clean:** the share of reviews with at least one actionable concern under the concern gates (confidence ≥ 0.6, probability ≥ 0.8).

The source-check grid covers probability gates from 0.50 to 0.80 and confidence gates from 0.30 to 0.60, in steps of 0.05. The quality grid covers relevance and applicability gates from 0.3 to 0.8 and score-confidence gates from 0.3 to 0.6, in steps of 0.1. `summary.json` holds every point.

Replay chooses the candidate policies on development data, by the rules stated under each table, and then reports them on holdout. The rules break ties toward fewer flips and stricter gates, which change current behavior least.

## Run and cost

| Model | Provider requests | Retried or failed attempts | Failed reviews | Input tokens | Output tokens | Estimated cost | Review p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typesafe/jev-1.13-20260917 | 216 | 0 | 0 | 3,702,378 | 499,580 | $0.1555 | 397 / 676 ms |

Cost counts input tokens at $0.042 per million; output tokens are listed but not priced.

The main run took 24 seconds. Each review was one request carrying 78 questions: 76 quality questions plus 2 for the source-check candidate, or 76 for a quality-only variant. A pilot of 4 requests (2 cases, one repeat, 68,476 input tokens and 9,329 output tokens) checked the harness before the main run. Together the runs used 220 of the 400 requests allowed for this work.

## Baseline: current gates

| Split | Recall (majority) | False positives (majority) | Recall (single review) | False positives (single review) | Flips across repeats | Uncertain | Needs context |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 11/15 (73%) | 0/15 (0%) | 32/45 (71%) | 0/45 (0%) | 1/30 (3%) | 13/90 (14%) | 0/90 (0%) |
| Holdout | 11/15 (73%) | 0/15 (0%) | 33/45 (73%) | 0/45 (0%) | 2/30 (7%) | 15/90 (17%) | 0/90 (0%) |
| All | 22/30 (73%) | 0/30 (0%) | 65/90 (72%) | 0/90 (0%) | 3/60 (5%) | 28/180 (16%) | 0/180 (0%) |

| Family, all splits | Recall (majority) | False positives (majority) | Recall (single review) | False positives (single review) | Flips across repeats | Uncertain | Needs context |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| zero-divisor | 5/10 (50%) | 0/10 (0%) | 15/30 (50%) | 0/30 (0%) | 2/20 (10%) | 12/60 (20%) | 0/60 (0%) |
| swallowed-failure | 10/10 (100%) | 0/10 (0%) | 29/30 (97%) | 0/30 (0%) | 1/20 (5%) | 1/60 (2%) | 0/60 (0%) |
| unhandled-json | 7/10 (70%) | 0/10 (0%) | 21/30 (70%) | 0/30 (0%) | 0/20 (0%) | 15/60 (25%) | 0/60 (0%) |

| Split | Relevant scored | Irrelevant scored | Scored per review | Reviews with a score | Score spread | Gate agreement | Clean above defect | Clean − defect | Priority on defect | Priority on clean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 15/216 (7%) | 0/324 (0%) | 0.4 | 25/108 (23%) | 0.06 | 99% | 2/2 (100%) | 7.23 | 5/54 (9%) | 0/54 (0%) |
| Holdout | 0/198 (0%) | 0/318 (0%) | 0.1 | 11/108 (10%) | 0.05 | 100% | 0/0 (n/a) | n/a | 0/54 (0%) | 0/54 (0%) |
| All | 15/414 (4%) | 0/642 (0%) | 0.3 | 36/216 (17%) | 0.06 | 99% | 2/2 (100%) | 7.23 | 5/108 (5%) | 0/108 (0%) |

The current source-check gates never let a clean variant through, but they miss 8 of the 30 defects, 5 of them in the zero-divisor family. The current quality gates publish almost nothing. On holdout they scored none of the labeled-relevant dimensions. Of the 60 scores they published, 39 are for `readability` and `consistency`, which no case labels.

## Source-check gates

### Where the answers fall

| Label | Decisions | Chose supported | Chose not supported | Chose needs context | Selected probability p10 / p50 / p90 | Confidence p10 / p50 / p90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Defect | 90 | 87/90 (97%) | 3/90 (3%) | 0/90 (0%) | 0.75 / 0.90 / 0.97 | 0.62 / 0.84 / 0.95 |
| Clean | 90 | 6/90 (7%) | 84/90 (93%) | 0/90 (0%) | 0.92 / 0.99 / 1.00 | 0.87 / 0.99 / 1.00 |

| Selected probability | Supported choices | On defects | On clean variants |
| --- | ---: | ---: | ---: |
| 0–0.6 | 3 | 3/3 (100%) | 0/3 (0%) |
| 0.6–0.7 | 7 | 4/7 (57%) | 3/7 (43%) |
| 0.7–0.8 | 18 | 15/18 (83%) | 3/18 (17%) |
| 0.8–0.9 | 22 | 22/22 (100%) | 0/22 (0%) |
| ≥ 0.9 | 43 | 43/43 (100%) | 0/43 (0%) |

Jev chose `supported` for 97% of defect reviews, so the choice itself is rarely the problem. The gates are. A tenth of the correct `supported` choices carry a selected probability below 0.75. When Jev clears a clean variant, it is nearly certain: 90% of clean decisions have a selected probability of at least 0.92. The six wrong `supported` choices all have probabilities between 0.63 and 0.76.

### Grid

Each cell shows majority recall, majority false positives, and flips. Bold cells are the candidate policies.

| Probability \ confidence | ≥ 0.30 | ≥ 0.35 | ≥ 0.40 | ≥ 0.45 | ≥ 0.50 | ≥ 0.55 | ≥ 0.60 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ≥ 0.50 | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 0% · 10% |
| ≥ 0.55 | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 0% · 10% |
| ≥ 0.60 | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 0% · 10% |
| ≥ 0.65 | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 0% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 0% · 10% |
| ≥ 0.70 | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 7% · 3% | 93% · 7% · 3% | **93% · 0% · 10%** |
| ≥ 0.75 | 87% · 0% · 10% | 87% · 0% · 10% | 87% · 0% · 10% | 87% · 0% · 10% | 87% · 0% · 10% | 87% · 0% · 10% | 87% · 0% · 10% |
| ≥ 0.80 | 73% · 0% · 3% | 73% · 0% · 3% | 73% · 0% · 3% | 73% · 0% · 3% | 73% · 0% · 3% | 73% · 0% · 3% | **73% · 0% · 3%** |

The table above is the development split. The holdout split follows.

| Probability \ confidence | ≥ 0.30 | ≥ 0.35 | ≥ 0.40 | ≥ 0.45 | ≥ 0.50 | ≥ 0.55 | ≥ 0.60 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ≥ 0.50 | 100% · 7% · 0% | 100% · 7% · 7% | 93% · 7% · 7% | 87% · 7% · 3% | 87% · 7% · 3% | 87% · 0% · 0% | 87% · 0% · 0% |
| ≥ 0.55 | 100% · 7% · 7% | 100% · 7% · 7% | 93% · 7% · 7% | 87% · 7% · 3% | 87% · 7% · 3% | 87% · 0% · 0% | 87% · 0% · 0% |
| ≥ 0.60 | 93% · 7% · 7% | 93% · 7% · 7% | 93% · 7% · 7% | 87% · 7% · 3% | 87% · 7% · 3% | 87% · 0% · 0% | 87% · 0% · 0% |
| ≥ 0.65 | 87% · 7% · 7% | 87% · 7% · 7% | 87% · 7% · 7% | 87% · 7% · 7% | 87% · 7% · 3% | 87% · 0% · 0% | 87% · 0% · 0% |
| ≥ 0.70 | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | **87% · 0% · 0%** |
| ≥ 0.75 | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% | 87% · 0% · 0% |
| ≥ 0.80 | 73% · 0% · 7% | 73% · 0% · 7% | 73% · 0% · 7% | 73% · 0% · 7% | 73% · 0% · 7% | 73% · 0% · 7% | **73% · 0% · 7%** |

Both splits show the same shape. Below a confidence gate of 0.60, a clean variant gets through by majority on development at every probability gate up to 0.70. On holdout, one gets through at a confidence gate of 0.50 or lower when the probability gate is 0.65 or lower. With confidence at 0.60, every probability gate from 0.50 to 0.70 gives the same result, and 0.80 costs 14 to 20 points of recall. The next table fixes confidence at 0.60 and counts single reviews:

| Probability | Dev recall | Dev false positives | Dev uncertain | Holdout recall | Holdout false positives | Holdout uncertain | Flips, both splits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ≥ 0.50 | 40/45 (89%) | 1/45 (2%) | 4/90 (4%) | 39/45 (87%) | 0/45 (0%) | 9/90 (10%) | 3/60 (5%) |
| ≥ 0.55 | 40/45 (89%) | 1/45 (2%) | 4/90 (4%) | 39/45 (87%) | 0/45 (0%) | 9/90 (10%) | 3/60 (5%) |
| ≥ 0.60 | 40/45 (89%) | 1/45 (2%) | 4/90 (4%) | 39/45 (87%) | 0/45 (0%) | 9/90 (10%) | 3/60 (5%) |
| ≥ 0.65 | 40/45 (89%) | 1/45 (2%) | 4/90 (4%) | 39/45 (87%) | 0/45 (0%) | 9/90 (10%) | 3/60 (5%) |
| ≥ 0.70 | 40/45 (89%) | 1/45 (2%) | 4/90 (4%) | 39/45 (87%) | 0/45 (0%) | 9/90 (10%) | 3/60 (5%) |
| ≥ 0.75 | 39/45 (87%) | 1/45 (2%) | 5/90 (6%) | 39/45 (87%) | 0/45 (0%) | 9/90 (10%) | 3/60 (5%) |
| ≥ 0.80 | 32/45 (71%) | 0/45 (0%) | 13/90 (14%) | 33/45 (73%) | 0/45 (0%) | 15/90 (17%) | 3/60 (5%) |

### Candidate policies

| Policy | Probability | Confidence | Dev recall | Dev false positives | Dev single-review false positives | Dev flips | Holdout recall | Holdout false positives | Holdout single-review recall | Holdout single-review false positives | Holdout flips | Holdout uncertain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current = Strict | ≥ 0.80 | ≥ 0.60 | 11/15 (73%) | 0/15 (0%) | 0/45 (0%) | 1/30 (3%) | 11/15 (73%) | 0/15 (0%) | 33/45 (73%) | 0/45 (0%) | 2/30 (7%) | 15/90 (17%) |
| Balanced | ≥ 0.70 | ≥ 0.60 | 14/15 (93%) | 0/15 (0%) | 1/45 (2%) | 3/30 (10%) | 13/15 (87%) | 0/15 (0%) | 39/45 (87%) | 0/45 (0%) | 0/30 (0%) | 9/90 (10%) |

Strict: the highest development recall with no clean candidate supported in any development review. Balanced: the highest development recall minus false-positive rate. Ties go to fewer flips, then to stricter gates.

| Policy | Family | Recall (majority) | Recall (single review) | False positives (single review) | Flips |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current = Strict | zero-divisor | 5/10 (50%) | 15/30 (50%) | 0/30 (0%) | 2/20 (10%) |
| Current = Strict | swallowed-failure | 10/10 (100%) | 29/30 (97%) | 0/30 (0%) | 1/20 (5%) |
| Current = Strict | unhandled-json | 7/10 (70%) | 21/30 (70%) | 0/30 (0%) | 0/20 (0%) |
| Balanced | zero-divisor | 8/10 (80%) | 24/30 (80%) | 0/30 (0%) | 0/20 (0%) |
| Balanced | swallowed-failure | 10/10 (100%) | 30/30 (100%) | 0/30 (0%) | 0/20 (0%) |
| Balanced | unhandled-json | 9/10 (90%) | 25/30 (83%) | 1/30 (3%) | 3/20 (15%) |

The Strict rule selects the current gates: on development, every probability gate below 0.80 lets at least one clean review through. Balanced trades that one review for 14 to 20 more points of recall. Across both splits it supports 79 of 90 defect reviews instead of 65, and 1 of 90 clean reviews instead of none. Uncertain decisions fall from 16% to 7%. The flip count stays at 3 of 60 candidates, but different candidates flip. Under the current gates, the flips are three defects with one or two reviews between 0.75 and 0.80 in probability. Under Balanced, they are three unhandled-JSON candidates, two defects and one clean, each with one or two reviews below the confidence gate.

Under Balanced, 11 defect reviews and 1 clean review still get the wrong decision:

- **`zd-page-count` (defect).** Jev chose `not_supported` in all three reviews, with probabilities from 0.92 to 0.96. No gate recovers it.
- **`zd-chart-scale` and `uj-resize-jobs` (defects).** Jev chose `supported` with confidence from 0.30 to 0.47. All six reviews stay `uncertain`.
- **`uj-event-import` and `uj-preferences` (defects).** One review of each had a confidence below 0.60 (0.55 and 0.47) and stays `uncertain`. The other four reviews are `supported`.
- **`uj-express-batch` (clean).** Jev chose `supported` in all three reviews, at probabilities from 0.70 to 0.76 and confidences from 0.55 to 0.64. It did not credit the Express error handler that answers malformed JSON with 400. One review passes the Balanced gates. That review is the single false positive.

One more clean pair, `uj-chat-frames`, drew `supported` in all three reviews, with confidences from 0.45 to 0.54. The confidence gate keeps it out under both policies.

The live journey answers in #70 were 0.54/0.69 and 0.67/0.78 (confidence/probability). Under Balanced the second becomes `supported`. The first stays `uncertain`, because its confidence is below 0.60.

## Quality gates

### Where the answers fall

| Dimension label | Answers | Relevance | Applicability | Score confidence | Score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Relevant | 414 | 0.86 / 0.92 / 0.96 | 0.35 / 0.59 / 0.75 | 0.11 / 0.51 / 0.74 | 1.80 / 5.40 / 8.60 |
| Irrelevant | 642 | 0.07 / 0.12 / 0.32 | 0.15 / 0.24 / 0.36 | 0.00 / 0.32 / 0.66 | 3.60 / 6.70 / 8.60 |
| Unlabeled | 3048 | 0.30 / 0.60 / 0.87 | 0.33 / 0.60 / 0.78 | 0.00 / 0.39 / 0.67 | 3.10 / 6.20 / 8.50 |

The columns show the 10th, 50th, and 90th percentiles. Relevance does its job: 90% of labeled-relevant answers are at least 0.86, and 90% of labeled-irrelevant answers are at most 0.32. Applicability does not separate the labels this way. A labeled-relevant dimension has a median applicability of 0.59, about the same as an unlabeled one, even though every case supplies the implementation, a caller, a test, and an explicit contract.

### Grid

Each cell shows labeled-relevant scored, labeled-irrelevant scored, and clean above defect, with relevance fixed at 0.8. Bold cells are the candidate policies. Development comes first.

| Applicability \ score confidence | ≥ 0.3 | ≥ 0.4 | ≥ 0.5 | ≥ 0.6 |
| --- | ---: | ---: | ---: | ---: |
| ≥ 0.8 | 9% · 0% · 100% | 9% · 0% · 100% | 8% · 0% · 100% | **7% · 0% · 100%** |
| ≥ 0.7 | 28% · 0% · 100% | 27% · 0% · 100% | 24% · 0% · 100% | 21% · 0% · 100% |
| ≥ 0.6 | 44% · 0% · 100% | 40% · 0% · 100% | 34% · 0% · 100% | 26% · 0% · 100% |
| ≥ 0.5 | 62% · 0% · 100% | **57% · 0% · 100%** | 47% · 0% · 100% | 36% · 0% · 100% |
| ≥ 0.4 | 71% · 0% · 100% | 67% · 0% · 100% | 54% · 0% · 100% | 42% · 0% · 100% |
| ≥ 0.3 | **81% · 0% · 100%** | 74% · 0% · 100% | 60% · 0% · 100% | 47% · 0% · 100% |

| Applicability \ score confidence | ≥ 0.3 | ≥ 0.4 | ≥ 0.5 | ≥ 0.6 |
| --- | ---: | ---: | ---: | ---: |
| ≥ 0.8 | 0% · 0% · n/a | 0% · 0% · n/a | 0% · 0% · n/a | **0% · 0% · n/a** |
| ≥ 0.7 | 13% · 0% · 100% | 13% · 0% · 100% | 11% · 0% · 100% | 8% · 0% · 100% |
| ≥ 0.6 | 42% · 0% · 100% | 38% · 0% · 100% | 24% · 0% · 100% | 14% · 0% · 100% |
| ≥ 0.5 | 56% · 0% · 100% | **46% · 0% · 100%** | 31% · 0% · 100% | 16% · 0% · 100% |
| ≥ 0.4 | 63% · 0% · 100% | 52% · 0% · 100% | 35% · 0% · 100% | 19% · 0% · 100% |
| ≥ 0.3 | **77% · 0% · 100%** | 62% · 0% · 100% | 42% · 0% · 100% | 21% · 0% · 100% |

The relevance gate changes little between 0.4 and 0.8. It admits labeled-irrelevant dimensions only at 0.3:

| Relevance | Applicability ≥ 0.8, score confidence ≥ 0.6 | Applicability ≥ 0.3, score confidence ≥ 0.3 |
| --- | ---: | ---: |
| ≥ 0.8 | 7% · 0% | 81% · 0% |
| ≥ 0.7 | 7% · 0% | 81% · 0% |
| ≥ 0.6 | 7% · 0% | 81% · 0% |
| ≥ 0.5 | 7% · 0% | 81% · 0% |
| ≥ 0.4 | 7% · 0% | 81% · 0% |
| ≥ 0.3 | 7% · 0% | 81% · 3% |

### Candidate policies

| Policy | Gates (relevance / applicability / score confidence) | Split | Relevant scored | Irrelevant scored | Scored per review | Reviews with a score | Score spread | Gate agreement | Clean above defect | Clean − defect | Priority on defect | Priority on clean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current | 0.8 / 0.8 / 0.6 | Development | 15/216 (7%) | 0/324 (0%) | 0.4 | 25/108 (23%) | 0.06 | 99% | 2/2 (100%) | 7.23 | 5/54 (9%) | 0/54 (0%) |
| Current | 0.8 / 0.8 / 0.6 | Holdout | 0/198 (0%) | 0/318 (0%) | 0.1 | 11/108 (10%) | 0.05 | 100% | 0/0 (n/a) | n/a | 0/54 (0%) | 0/54 (0%) |
| Moderate | 0.8 / 0.5 / 0.4 | Development | 123/216 (57%) | 0/324 (0%) | 3.0 | 92/108 (85%) | 0.11 | 96% | 12/12 (100%) | 6.61 | 30/54 (56%) | 0/54 (0%) |
| Moderate | 0.8 / 0.5 / 0.4 | Holdout | 91/198 (46%) | 0/318 (0%) | 1.7 | 74/108 (69%) | 0.10 | 98% | 10/10 (100%) | 5.94 | 26/54 (48%) | 0/54 (0%) |
| Permissive | 0.8 / 0.3 / 0.3 | Development | 175/216 (81%) | 0/324 (0%) | 4.3 | 108/108 (100%) | 0.12 | 97% | 22/22 (100%) | 6.04 | 48/54 (89%) | 16/54 (30%) |
| Permissive | 0.8 / 0.3 / 0.3 | Holdout | 152/198 (77%) | 0/318 (0%) | 3.4 | 108/108 (100%) | 0.12 | 95% | 23/23 (100%) | 5.58 | 49/54 (91%) | 13/54 (24%) |

Moderate: the strictest gates that score at least half of the labeled-relevant dimensions on development data, with at most 5% of labeled-irrelevant dimensions scored. Permissive: the largest gap between the two shares. Ties go to stricter gates.

In this data, loosening the quality gates does not add noise to the scores. No candidate policy scores a labeled-irrelevant dimension. Repeated reviews publish nearly the same score, with a mean range of 0.1 points. Every pair with scores on both variants ranks the clean variant higher. Loosening does add noise to the priorities, because Permissive attaches concerns to clean variants:

| Dimension | Current | Moderate | Permissive |
| --- | ---: | ---: | ---: |
| correctness | 5 · 0 | 34 · 0 | 39 · 0 |
| changeability | 0 · 0 | 3 · 0 | 3 · 0 |
| testQuality | 0 · 0 | 7 · 0 | 32 · 29 |
| reliability | 0 · 0 | 22 · 0 | 57 · 0 |
| security | 0 · 0 | 3 · 0 | 3 · 0 |
| documentation | 1 · 0 | 15 · 0 | 15 · 0 |
| scalability | 0 · 0 | 0 · 0 | 3 · 0 |

Each cell counts the reviews, of 108 defect and 108 clean, in which the dimension had an actionable concern (confidence ≥ 0.6, probability ≥ 0.8). Dimensions with none are omitted.

Every clean-variant priority under Permissive is a `testQuality` concern: "An important changed behavior has no demonstrated regression protection." Most clean variants change behavior without adding a test for it, so the concern is often accurate, but it is not the defect the pair plants. Under Permissive, a quarter of clean reviews would end `needs_attention` for that reason alone. Moderate keeps `testQuality` below its applicability gate in most reviews, and it raises no priority on a clean variant.

The concern gates are already where they should be. At the Permissive quality gates, lowering the concern probability gate from 0.8 to 0.7 doubles the priorities on clean reviews. On development data:

| Concern probability \ confidence | ≥ 0.3 | ≥ 0.4 | ≥ 0.5 | ≥ 0.6 |
| --- | ---: | ---: | ---: | ---: |
| ≥ 0.8 | 89% · 30% | 89% · 30% | 89% · 30% | 89% · 30% |
| ≥ 0.7 | 96% · 61% | 96% · 61% | 96% · 61% | 94% · 59% |
| ≥ 0.6 | 100% · 78% | 100% · 78% | 100% · 74% | 94% · 59% |
| ≥ 0.5 | 100% · 81% | 100% · 78% | 100% · 74% | 94% · 59% |

Each cell shows priority on defect and priority on clean.

### By dimension

| Dimension | Labeled relevant | Labeled irrelevant | Median relevance | Median applicability | Median score confidence | Scored under Current | Scored under Moderate | Scored under Permissive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| correctness | 216 | 0 | 0.91 | 0.66 | 0.49 | 12/216 (6%) | 134/216 (62%) | 168/216 (78%) |
| cognitiveComplexity | 0 | 0 | 0.61 | 0.77 | 0.35 | 0/216 (0%) | 0/216 (0%) | 0/216 (0%) |
| readability | 0 | 0 | 0.77 | 0.80 | 0.42 | 27/216 (13%) | 53/216 (25%) | 64/216 (30%) |
| modularity | 0 | 0 | 0.41 | 0.61 | 0.46 | 0/216 (0%) | 8/216 (4%) | 8/216 (4%) |
| coupling | 6 | 0 | 0.48 | 0.63 | 0.42 | 0/216 (0%) | 12/216 (6%) | 15/216 (7%) |
| changeability | 6 | 0 | 0.50 | 0.45 | 0.32 | 0/216 (0%) | 3/216 (1%) | 11/216 (5%) |
| abstractionQuality | 0 | 0 | 0.61 | 0.59 | 0.42 | 0/216 (0%) | 12/216 (6%) | 13/216 (6%) |
| projectStructure | 0 | 0 | 0.44 | 0.70 | 0.37 | 0/216 (0%) | 0/216 (0%) | 0/216 (0%) |
| duplication | 6 | 0 | 0.30 | 0.50 | 0.31 | 0/216 (0%) | 6/216 (3%) | 12/216 (6%) |
| maintainability | 6 | 0 | 0.65 | 0.57 | 0.40 | 0/216 (0%) | 18/216 (8%) | 20/216 (9%) |
| testQuality | 6 | 0 | 0.91 | 0.44 | 0.48 | 3/216 (1%) | 41/216 (19%) | 191/216 (88%) |
| reliability | 120 | 0 | 0.91 | 0.32 | 0.49 | 0/216 (0%) | 31/216 (14%) | 103/216 (48%) |
| security | 6 | 138 | 0.20 | 0.27 | 0.38 | 0/216 (0%) | 5/216 (2%) | 6/216 (3%) |
| consistency | 0 | 0 | 0.82 | 0.74 | 0.45 | 12/216 (6%) | 82/216 (38%) | 101/216 (47%) |
| documentation | 0 | 0 | 0.81 | 0.71 | 0.43 | 6/216 (3%) | 70/216 (32%) | 88/216 (41%) |
| performance | 6 | 210 | 0.10 | 0.23 | 0.36 | 0/216 (0%) | 6/216 (3%) | 6/216 (3%) |
| scalability | 6 | 210 | 0.14 | 0.29 | 0.34 | 0/216 (0%) | 0/216 (0%) | 5/216 (2%) |
| compatibility | 6 | 0 | 0.51 | 0.46 | 0.36 | 0/216 (0%) | 6/216 (3%) | 6/216 (3%) |
| observability | 24 | 84 | 0.25 | 0.19 | 0.30 | 0/216 (0%) | 12/216 (6%) | 12/216 (6%) |

Labeled counts are reviews in which the dimension carries that label.

`reliability` shows the applicability problem most clearly. Its median relevance across all reviews is 0.91, but its median applicability is 0.32. Under Moderate it is scored in 14% of reviews.

## Recommendation

For source checks, adopt **Balanced: probability ≥ 0.70, confidence ≥ 0.60**. It raised holdout recall from 73% to 87% with no holdout false positive, and it cut uncertain decisions from 16% to 7%. Its cost in this data was one clean review supported out of 90. Keep the confidence gate at 0.60: it is the gate that stops the clean false positives. Balanced still leaves near misses, including one of the two journey answers in #70. The margin reporting that #70 proposes is worth doing with either policy.

For quality, adopt **Moderate: relevance ≥ 0.8, applicability ≥ 0.5, score confidence ≥ 0.4**. It moves from almost no scores to about half of the relevant dimensions. It scores no labeled-irrelevant dimension, and it raises no priority on a clean variant. Permissive scores more, but a quarter of its clean reviews would end `needs_attention` because of `testQuality` concerns. Keep the relevance gate at 0.8 and the concern gates at 0.6 and 0.8.

Moderate does not guarantee a score on every review: 69% of holdout reviews got at least one. A journey assertion that at least one dimension is scored, as #59 asks, would sometimes fail.

Whichever gates the maintainer adopts, bump `POLICY_VERSION` in `src/domain.ts` for a source-check change and `RUBRIC_VERSION` in `src/quality.ts` for a quality change. `compare` refuses reports whose `policyVersion` differs, and quality comparison requires the same `rubricVersion`. The bumps keep reports made under the old gates from being compared with reports made under the new ones. Also update `CURRENT` in `benchmarks/calibrate.ts`, which replay uses as its baseline.

## Limits of this evidence

- **The cases are synthetic, and one author wrote them.** Every task states the contract outright, and every packet is small and complete. Real reviews often have no task text and larger packets. The recall here is probably higher than in real use. The labels are the author's judgment and no case was executed, although the offline check confirms that each variant produces the candidate its label describes.
- **The sample is small.** Each split has 15 defect and 15 clean candidates. One review moves a single-review rate by about 2 points, and one candidate moves a majority rate by about 7 points. The exact 95% interval for Balanced's single-review recall over both splits (79 of 90) is 79% to 94%. For its false positives (1 of 90) it is 0% to 6%. For the current gates' false positives (0 of 90) it is 0% to 4%.
- **One model version.** All answers came from `typesafe/jev-1.13-20260917` through OpenRouter on one day. `jev-latest` can change. Repeat the calibration when the model changes.
- **The repeats measure short-term variation.** Each variant's three reviews ran within about 25 seconds of each other, with identical requests. The flip rates do not describe variation across days or model deployments.
- **The holdout is not independent of development.** Both splits come from the same author and patterns. The holdout guards against tuning to particular cases, not against the dataset's shared style. It has now been used once, and further tuning needs a fresh holdout.
- **The grid has edges.** Permissive sits at the lowest applicability and score-confidence gates measured (0.3). The data does not show what happens below them.
- **Some quality labels are coarse.** "Clean above defect" counts only pairs in which both variants got a score, so its sample shrinks as the gates tighten. Quality-only pairs are 6 of 36, so the priority rates mostly reflect the source-check families.

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
