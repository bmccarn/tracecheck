# Tracecheck design

Tracecheck has a broad quality layer and a source-finding layer. Jev supplies typed judgments; local code owns context collection, evidence locations, validation, policy, transport, and reporting.

## Execution

`tracecheck_assess` accepts explicit task, diff, files, and repository facts. It asks 57 questions in one request: applicability (Noul), quality level (Score), and primary concern (Choice) for each of 19 dimensions. The concern catalog and suggestions are independently authored. Input is language-agnostic and does not cause filesystem access.

`tracecheck_review` collects bounded Git context, considers the same 19 dimensions, and adds source-check candidates. The broad questions and the first ten candidates share one provider call. Additional candidates are processed in batches of ten. Questions are independent; no answer is assumed to be visible to another question in the same request. Aggregate token/request usage counts each call once. The nested quality usage describes the shared first request and must not be added to report totals.

The collector retains current and baseline source, one hop of relative JS/TS imports, and filename-associated tests. Several common source/config/documentation extensions are collected for the broad layer. Babel provides JS/TS syntax analysis; TypeScript 7 supplies compilation, not the old in-process compiler API. No repository code, compiler plugin, or test is executed.

## Quality policy

All 19 dimensions are considered; performance, scalability, compatibility, and observability require evidence of relevance. Applicability >= 0.8 permits a score. Lower values produce unassessed or uncertain states. This is stricter than the baseline's binary 0.5 cutoff and is a deliberate, provisional policy requiring calibration.

A Score is converted from Jev's zero-based ten-level rubric to a 1–10 value. Its confidence is preserved separately from applicability. Scores with confidence below 0.6 remain explicitly uncertain. Concerns require Choice confidence >= 0.6 and selected probability >= 0.8 to become actionable priorities. A high score cannot suppress an actionable concern.

There is no overall grade. Priority importance is not a verified defect severity. Suggested actions are static next steps associated with selected concerns, not model-generated patches. Generic quality concerns are distinguished from source-anchored defect hypotheses.

Previous evaluations are compared locally, never included as current implementation evidence. Comparisons require matching scope, model, and rubric version. Credibly assessed pairs get per-dimension deltas; differences of at least 0.75 are marked improved or regressed. The same actionable concern appearing again remains unresolved. Uncertain pairs do not manufacture improvement claims.

## Source-finding policy

Three candidate families currently exist: division/remainder, catch handlers, and JSON.parse boundaries in changed JS/TS functions. Syntax selects opportunities for review, not proven bugs. Each candidate includes an exact source quote, symbol, and lines. Jev evaluates support and impact separately.

Support or rejection requires selected probability >= 0.8 and confidence >= 0.6. Other decisions remain uncertain or need context. Low-confidence impact becomes unknown. These are provisional thresholds. A parser quote establishes where the hypothesis applies, not a verified witness or complete evidence chain.

Candidate identities use path, symbol, check, normalized expression, and duplicate occurrence. Moving a line retains identity. Changing an expression may change identity. Finding history uses still-present, no-longer-supported, unresolved, and not-reassessed states. No transition claims a verified fix.

## Budgets and omissions

Automatic collection is bounded to 16 files, 24 KB per current file, 60,000 source characters including baselines, and 40 source candidates. Full versions of included files are transmitted. Manual context is not silently truncated; the provider client rejects requests above 180 KB serialized size. Provider token-limit errors ask the caller to split context coherently.

Generated paths, external symlinks, unsupported files, parse failures, unresolved imports, potential secret-bearing source, and budget omissions are visible gaps. Secret pattern checks are not comprehensive DLP. Relative imports and related tests are supported; arbitrary callers, path aliases, CommonJS graphs, and dynamic imports are not fully resolved. Dependency edits do not yet schedule source checks in unchanged callers.

Captured content is hashed with task/context. Collection is not an atomic filesystem transaction. MCP recollects before accepting a preview token and rejects stale snapshots, but cannot stop a user from editing files after capture.

## MCP and provider boundary

The official MCP v2 server uses stdio, Zod 4 input/output schemas, read-only annotations, remote-access hints, and request cancellation. Stdout is reserved for protocol messages. The server can be bound to one repository or accept an explicit repository per collection call. Supplied-context assessment needs neither Git nor a configured repository.

The Jev client handles all three primitives, validates requested answer types/options/ranges, retains the resolved model identifier, applies a request deadline across retries, and honors bounded Retry-After delays. Errors cannot become successful reviews. Credentials are read from the environment and sent directly to TypeSafe.

Repository reviews cache up to 16 reports for five minutes. Keys include source/task/context snapshots, requested model, and prior-evaluation identity. The original report time and cache-hit flag remain visible. A mutable model alias can change upstream; choose an available concrete version for reproducible evaluations.

## Packaging and next work

The runtime is bundled into a standalone ESM file. Portable plugin manifests, client compatibility adapters, and a continuous-review skill accompany it. Packaging validation is distinct from installation inside every client.

Remaining improvements are broader candidate coverage, caller-aware retrieval, real-PR evaluation, calibrated thresholds, sandboxed witness execution, verified-fix tracking, and CI/SARIF export. See the capability parity checklist and recorded validation results.
