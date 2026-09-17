# Accuracy benchmark and evidence collection

## September 17, 2026 baseline

This benchmark measures **verification of a supplied concern**, not automatic bug discovery or the accuracy of the 19 quality scores. It uses RapidRegs Ingest at commit `b3d8ac8054dd1dc8c5c99ef4b2dbdcf345a28ef5`, Jev `jev-1.13.0`, and the existing support thresholds: confidence ≥ 0.6 and selected probability ≥ 0.8. Thresholds were frozen before inference and were not adjusted to improve the reported results.

There are six defect families: storage error propagation, subprocess shutdown escalation, oversized citation URLs, citation identity, canonical hashes, and URL preference. The first two use historical before/fix pairs; the other four use controlled mutations. Each bug/clean pair has an ordinary and an adversarial-comment variant: **24 cases, but only six independent families**. Four families were assigned to development and two to holdout before inference. The holdout is now observed; future tuning needs a fresh holdout.

Labels are checked by executing selected function definitions with standard-library fakes. The harness does not import the application, contact AWS, launch jobs, or modify the subject repository. This is a trusted-fixture runner, not a sandbox for arbitrary repositories. Runtime review itself still does not execute reviewed code.

## Observed results

Each case was reviewed with full-file evidence and a smaller function-centered packet, alternating request order. There were 48 live requests in one run.

| Measurement | Full-file packets | Function-centered packets |
| --- | ---: | ---: |
| Supported defects | 7 / 12 | 5 / 12 |
| Recall, counting abstentions as misses | 58.3% | 41.7% |
| False positives among clean variants | 0 / 12 | 0 / 12 |
| Abstentions | 5 / 24 | 7 / 24 |
| Decisive coverage | 79.2% | 70.8% |
| Input tokens, total | 61,688 | 29,700 |
| Output tokens, total | 2,756 | 2,758 |
| Review-stage p50 / p95 | 194 / 569 ms | 204 / 520 ms |
| Development recall | 6 / 8 | 2 / 8 |
| Holdout recall | 1 / 4 | 3 / 4 |

Smaller packets used **51.9% fewer input tokens but reduced overall recall**. They did not improve median latency. Zero observed false positives is not evidence of a zero false-positive rate. Comment variants are correlated, and some changed the verdict; this does not establish prompt-injection resistance. A single run cannot separate model variation from context effects or establish stable latency percentiles.

The benchmark packets are explicit function-and-support fixtures, **not the production collector's output**. These results support measuring context selection carefully; they do not establish that the new collector improves accuracy. The collector now retains nearby function bodies when bounded excerpts are needed, but that change needs its own labeled retrieval evaluation.

## Actual repository review

Against the same commit's parent, the focused collector captured all four changed files and eight related test/caller/dependency files within 59,943 source characters. Disabling excerpts in the collector exhausted its total budget before including the fourth changed file, yielding seven files overall. Both runs disclosed their omissions.

A live review of the collected evidence returned all 19 dimensions in one request: 33,298 input tokens, 2,206 output tokens, and an 820 ms review stage. The result was **inconclusive**: 18 dimensions were uncertain and scalability was not applicable. Correctness relevance was 0.92, but evidence sufficiency was only 0.47, so no correctness score was published. There were no parser-derived source candidates because these changes were Python. No correctness or accuracy improvement is inferred from this integration check.

## Reproduce

From a source checkout, with Python 3 and a local RapidRegs repository containing the pinned history:

```sh
# Offline label checks; no API key or external service required.
npm run accuracy -- --repo /path/to/rapidregs-ingest

# Sends the fixture source to TypeSafe and consumes API usage.
npm run accuracy -- --repo /path/to/rapidregs-ingest --live \
  --model jev-1.13.0 --out .tracecheck/accuracy.json
```

Live output retains decisions, distributions, request hashes, resolved model, thresholds, timing, token usage, and split-level summaries. `.tracecheck/` is ignored. Reports include source excerpts and should remain private unless their contents have been reviewed. The fixture generator stays in the GitHub source checkout; it is not bundled into the npm runtime.

## Next accuracy gates

1. Measure agent-led discovery separately from Jev concern verification using the [paired evaluation protocol](agent-evaluation.md).
2. Evaluate agent-selected evidence against required contracts, callers, guards, and tests; count missing evidence explicitly.
3. Expand independent historical bug/fix families and introduce a fresh holdout before tuning thresholds.
4. Calibrate relevance, evidence sufficiency, and support separately. Jev confidence is not empirical accuracy.
5. Repeat runs to measure verdict stability, adversarial-comment sensitivity, latency, and cost before changing defaults.

The typed-state and confidence design follows [TypeSafe state guidance](https://docs.typesafe.ai/concepts/state) and [confidence guidance](https://docs.typesafe.ai/confidence). Smaller context is useful only when it preserves the evidence needed for the decision.
