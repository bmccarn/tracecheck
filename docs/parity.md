# Baseline capability parity

The first Tracecheck build implemented a narrow source-review path and omitted important baseline capabilities. Version 0.2 restores the broad review layer alongside those additions. This is capability parity through a new implementation, not copied source or a wire-compatible replacement for the original tool.

| Baseline capability | Tracecheck implementation | Verification |
| --- | --- | --- |
| Nineteen independent quality dimensions | Complete dimension registry and broad assessment | Exact dimension-set regression test; live 19-dimension responses |
| Fifteen regular and four conditional dimensions | Relevance/evidence Noul for every dimension; conditional guidance for the four specialized dimensions | Registry and applicability tests |
| Jev-native Noul, Score, Choice | Typed request/response union and per-question validation | Provider tests and live full review |
| Independent 1–10 scores and confidence | Per-metric score normalization; no blended grade | Transformation and no-overall-score tests |
| Unsupported context marked unassessed | Explicit applicability, insufficient-context, and uncertain states | Transformation tests |
| Selected weaknesses and improvement suggestions | Independently authored concern catalog per dimension | Priority tests and structured output validation |
| Prioritized concerns | At most five actionable concerns ordered by dimension importance and score | High-score concern preservation test |
| Previous evaluation comparison | Local per-dimension deltas, improvements, regressions, unresolved concerns | Comparison tests and live supplied-context round trips |
| Task, diff, files, repository context inputs | `tracecheck_assess` and CLI `assess` | Input validation and live Python review |
| Language-independent supplied context | No syntax restriction on manual assessment | Live Python fixture |
| Repeated implement/validate/review workflow | `skills/tracecheck/SKILL.md` | Skill validation |
| Stop rules and resistance to score gaming | Skill prioritizes requirements and supported risks | Skill content review |
| Local stdio MCP process; direct Jev API access | MCP v2 server and direct provider client | SDK handshake plus live MCP |
| Key kept in launching environment | `JEV_API_KEY` / `TYPESAFE_API_KEY`; no stored credential | Client boundary tests and live environment use |
| Retry, timeout, provider error handling | Deadline, cancellation, bounded retries, explicit context-limit guidance | Provider tests |
| Standalone runtime distribution | Bundled `dist/plugin.mjs` | Copied outside the repository and launched without dependencies |
| Portable plugin and client adapters | Root `plugin.json` / `mcp.json`, Codex and Claude adapters | Portable discovery; Codex validator; Claude strict validator |
| Manual integration across MCP clients | Shared stdio command and environment configuration | MCP protocol tested; every native app UI has not been exercised |

## Added capabilities retained

- Git-based bounded context collection, baseline source, relative imports, and related tests.
- Parser-derived file/symbol/line anchors for specific hypotheses.
- Independent finding support and impact, with explicit uncertainty.
- Snapshot validation covering code, task, and repository context.
- Session cache, cancellation, and usage accounting.
- Stable candidate identities and cautious finding-history transitions.
- Offline regression tests, synthetic live benchmarks, and recorded validation outcomes.
- The broad questions share the first source-check request instead of uploading identical context twice.

## Intentional differences

- The public tools use Tracecheck names and schemas. Existing callers of `jev_review` must migrate to `tracecheck_assess`; old evaluation JSON is not automatically imported.
- Applicability below 0.8 withholds a score. The original's permissive binary threshold is replaced by explicit uncertainty; these thresholds still require representative calibration.
- Priority is not inferred severity. A high overall dimension score cannot hide a separately supported concern.
- Comparisons require matching scope, model, and rubric. Uncertain metric pairs do not produce confident numeric improvement claims.
- Automatic collection and serialized requests have visible budgets. Scope is never silently truncated.
- Native app installation has not been verified in every client. Portable discovery and native manifest validation do not establish installation in every client.

## Still outside the implemented additions

Cross-language AST findings, complete caller graphs, sandboxed reproductions, verified-fix execution, broader labeled real-PR evaluation, and CI/SARIF exports are future work. They were proposed improvements, not baseline features that the original already implemented.
