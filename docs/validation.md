# Validation

## Unreleased evidence milestone — September 17, 2026

- `npm run validate`: 35 tests pass, including bounded collection, original-line anchors, root isolation, cancellation, provider response limits, manual-context secret screening, split evidence gating, cache comparison reuse, and mid-review edit rejection.
- Broad review now asks 76 questions once; the 23-candidate batching test checks 96, 20, and 6 questions.
- The RapidRegs harness checks 24 labels across six families with executable local oracles. A 48-request live run measured both full and function-centered packets; [results and limitations](accuracy.md) include the observed recall regression with smaller packets.
- Actual RapidRegs collection and a live 19-dimension review completed. The review was inconclusive; no automatic Python source checks or credible quality scores were produced.
- RapidRegs remained unmodified. Raw source-bearing records stay in ignored `.tracecheck/`.

The entries below record earlier releases and are not measurements of the current rubric.

---

## Historical Tracecheck 0.2

## Current checks

- `npm run validate`: 26 tests passed; source, examples, and tests type-check; compiled and standalone builds pass.
- All nineteen baseline dimension keys and the four conditional dimensions are regression-tested.
- Noul, Score, and Choice validation, score normalization, uncertainty, high-score concern preservation, comparisons, and locally retained previous evaluations are tested.
- A 23-candidate fixture uses three calls with question counts 77, 20, and 6: the 57 broad questions run once, sharing the first source batch.
- The standalone bundle serves MCP after being copied outside the checkout without `node_modules`.
- Codex plugin validation, skill validation, Claude strict manifest validation, and portable plugin discovery pass.
- `npm pack --dry-run` includes the runtime, skill, and all manifests without credentials or local run records.

## Live combined review

The standalone MCP server returned all 19 dimensions and a parser-anchored finding from jev-1.13.0. Quality and source findings shared **one request**, with 13678 input tokens and 1896 output tokens. The measured review stage was 621 ms. Repeating the call verified a cache hit with the same report ID.

The very small fixture left many dimensions uncertain or unassessed. Receiving 19 well-typed decisions verifies coverage and integration, not the correctness of every judgment. No universal latency or accuracy claim follows from one request.

## Live language-agnostic review

The supplied-context MCP tool assessed synthetic Python before and after a JSON handling repair, without repository access. Both responses contained all 19 dimensions. The previous assessment was accepted for local comparison. Before-repair correctness applicability was uncertain (0.73); after-repair applicability was 0.91, with a score of 8.6 and confidence 0.73. Consequently no numeric correctness improvement was asserted. The comparison math and eligible-pair behavior are covered by deterministic tests.

Live raw records: `.tracecheck/mcp-live-v2.json` and `.tracecheck/quality-live-v2.json` (ignored local files). The earlier six-case source-check benchmark remains a small synthetic smoke benchmark; its accuracy should not be generalized to the new broad layer.

## Boundaries

The package is prepared and validated, but it has not been installed and exercised in every native agent app. Real-PR quality calibration, complete caller graphs, broader parser checks, and executable fix verification remain outstanding improvements.

---

## Historical v0.1 validation — September 17, 2026

## Local checks

`npm run validate` passed: source, tests, and examples type-check; all 14 automated tests pass; production compilation succeeds. The test suite includes a real MCP v2 SDK client/server exchange over stdio.

## Live Jev smoke benchmark

The existing `TYPESAFE_API_KEY` environment variable was used through an interactive zsh session. No credentials were saved in this project. Only synthetic fixture code was transmitted.

`jev-latest` resolved to **jev-1.13.0**. Five of six labeled cases matched expectations. Two of three defects were supported; the empty-average defect was uncertain. All three clean counterparts were not supported. There were no false positives in this six-case sample. These results do not estimate real-world accuracy.

| Fixture | Expected | Observed | Review stage ms |
| --- | --- | --- | --- |
| average-empty | supported | uncertain | 778 |
| average-guarded | not_supported | not_supported | 142 |
| save-swallowed | supported | supported | 146 |
| save-rethrows | not_supported | not_supported | 193 |
| json-boundary | supported | supported | 222 |
| json-throws-by-contract | not_supported | not_supported | 159 |

Thresholds were not relaxed to turn the uncertain result into a pass. This remains an explicit open evaluation case.

## Live MCP path

A compiled Tracecheck MCP server reviewed a temporary Git repository containing a synthetic JSON parsing regression. A real SDK client invoked preview, passed the captured snapshot token to review, received a schema-valid supported finding from Jev, then repeated the request and verified a cache hit with the identical report ID.

The live review stage took 388 ms. The finding retained confidence 0.92 and selected probability 0.94; impact remained unknown because its confidence was only 0.28. This verifies support and impact are handled separately.

Raw local run records are retained under ignored `.tracecheck/benchmark-live.json` and `.tracecheck/mcp-live-smoke.json`. Future benchmark runs also retain per-candidate decisions and raw distributions. Run `npm run benchmark -- --live` and `npm run smoke -- --live` to repeat with synthetic inputs.
