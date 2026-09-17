# Tracecheck design

Tracecheck has a broad quality layer and a source-finding layer. Jev supplies typed judgments; local code owns context collection, evidence locations, validation, policy, transport, and reporting.

## Agent-first verification

The agent owns hypothesis discovery, evidence selection, counterevidence search, and fix verification. `tracecheck_verify` is the primary integration: one agent-selected hypothesis, an explicit contract, exact evidence excerpts with original line references, and declared missing context. Code validates quote alignment and budgets. Optional local repository binding checks excerpts before inference and full source freshness afterward; supplied-only inputs are labeled as such.

Jev receives three independent Choice questions: support, impact, and the most useful missing-evidence category. No broad quality request or parser discovery is required. The agent interprets disagreements and can expand evidence within a bounded investigation loop. TypeSafe's [citation-checking cookbook](https://docs.typesafe.ai/cookbooks/citation_check) illustrates the separation between deterministic reference checks and semantic judgment.

The collector and three JS/TS patterns remain optional compatibility conveniences. Additional language-specific discovery rules are not the main development direction. The [paired evaluation protocol](agent-evaluation.md) measures assistance rather than treating a verifier benchmark as discovery accuracy.

## Execution

`tracecheck_assess` accepts explicit task, diff, files, and repository facts. It asks 76 questions in one request: relevance (Noul), evidence sufficiency (Noul), quality level (Score), and primary concern (Choice) for each of 19 dimensions. The concern catalog and suggestions are independently authored. Input is language-agnostic and does not cause filesystem access.

`tracecheck_review` collects bounded change packets, considers the same 19 dimensions per nonempty packet, and adds source-check candidates. A deterministic planner size-checks all requests before inference. Broad questions share a candidate request when they fit; otherwise independent broad questions are split and candidate batches shrink below their maximum of ten. No source evidence is dropped to fit a request, and packets with no source evidence make no provider calls. Packet references resolve against canonical source/candidate records; each changed source and candidate has exactly one primary packet, while supporting evidence may be shared. Questions are independent; no answer is assumed visible to another question. Aggregate usage counts each call once; nested quality usage counts the shared/split calls supplying its answers and must not be added again to report totals.

The collector retains current and baseline source, one hop of supported JS/TS and Python imports, selected reverse callers, and import- or filename-associated tests. Several common source/config/documentation extensions are collected for the broad layer. Babel provides JS/TS syntax analysis; TypeScript 7 supplies compilation, not the old in-process compiler API. No repository code, compiler plugin, or test is executed.

## Quality policy

All 19 dimensions are considered; performance, scalability, compatibility, and observability require evidence of relevance. Separate relevance and evidence sufficiency judgments must both be >= 0.8 to permit a score. The compatibility applicability field is their minimum, not a product. Rubric version 2 is not numerically compared with version 1. Lower values produce unassessed or uncertain states. This is stricter than the baseline's binary 0.5 cutoff and is a deliberate, provisional policy requiring calibration.

A Score is converted from Jev's zero-based ten-level rubric to a 1–10 value. Its confidence is preserved separately from applicability. Scores with confidence below 0.6 remain explicitly uncertain. Concerns require Choice confidence >= 0.6 and selected probability >= 0.8 to become actionable priorities. A high score cannot suppress an actionable concern.

There is no overall grade. Priority importance is not a verified defect severity. Suggested actions are static next steps associated with selected concerns, not model-generated patches. Generic quality concerns are distinguished from source-anchored defect hypotheses.

One packet produces `report.quality`; multiple packets produce `report.packetQualities`, each with its changed paths and independent evaluation. Packet scores are not averaged. Previous-quality comparisons are limited to single-packet reviews; multi-packet findings still appear in the combined source-decision history.

Previous evaluations are compared locally, never included as current implementation evidence. Comparisons require matching scope, model, and rubric version. Credibly assessed pairs get per-dimension deltas; differences of at least 0.75 are marked improved or regressed. The same actionable concern appearing again remains unresolved. Uncertain pairs do not manufacture improvement claims.

## Source-finding policy

Three candidate families currently exist: division/remainder, catch handlers, and JSON.parse boundaries in changed JS/TS functions. Syntax selects opportunities for review, not proven bugs. Each candidate includes an exact source quote, symbol, and lines. Jev evaluates support and impact separately.

Support or rejection requires selected probability >= 0.8 and confidence >= 0.6. Other decisions remain uncertain or need context. Low-confidence impact becomes unknown. These are provisional thresholds. A parser quote establishes where the hypothesis applies, not a verified witness or complete evidence chain.

Candidate identities use path, symbol, check, normalized expression, and duplicate occurrence. Moving a line retains identity. Changing an expression may change identity. Finding history uses still-present, no-longer-supported, unresolved, and not-reassessed states. No transition claims a verified fix.

## Budgets and omissions

Discovery and provider evidence have separate budgets. Import discovery scans eligible tracked JS/TS/Python files by default, with a soft deadline and optional file/byte caps. A bounded in-process cache stores checked file metadata and edges, never raw source; path confinement, inode/device, size, mtime, ctime, and the known path universe govern reuse. The reverse graph is built once rather than scanned for every changed file.

Git evidence uses path-scoped, argument-bounded batches rather than a process per changed file. Current sources pass the existing safe-read gate before entering a diff. Baseline blobs over 8 MiB are omitted before patch generation; accepted baselines stream one at a time into excerpt selection and digesting. NUL-delimited Git identities and literal pathspecs preserve unusual filenames without interpreting source lines as file headers. This is collection plumbing, not semantic review logic.

Every supported, safely readable changed file is assigned to a deterministic packet. Each packet contains at most eight primary changes and sixteen sources, 60,000 source characters including baselines, and 80,000 serialized source bytes. Packing reserves supporting-evidence capacity; related sources are loaded lazily, with shared excerpts focused on the union of relevant symbols. The current-file read limit remains 256,000 bytes. Excerpts retain original-line ranges, nearby function bodies where possible, and full-content digests, with omissions reported. There is no global forty-candidate cutoff. Review requests receive a 160,000-byte preflight before the provider client's 180,000-byte guard; impossible supplied contexts fail visibly rather than being silently truncated.

Generated paths, external symlinks, unsupported files, parse failures, potential secret-bearing source, and budget omissions are visible gaps. Secret pattern checks are not comprehensive DLP. Heuristic import and reverse-caller discovery is incomplete; unresolved references, path aliases, and dynamic imports may be missed. Selection limits and the graph limitation are reported. Dependency edits do not yet schedule source checks in unchanged callers.

Captured content digests and ranges are hashed with canonical repository identity, effective collection settings, completed discovery scope, packet membership, and task/context. Cache hits and elapsed time do not directly affect snapshots. A review revalidates the captured ordered index prefix rather than allowing a warm cache to expand a time-limited preview. Pinned rechecks retain the overall collection/caller deadline and re-read current identities and evidence. Collection is not an atomic filesystem transaction: both repository review entry points recollect after inference and reject changed snapshots, but cannot prevent later edits.

## MCP and provider boundary

The official MCP v2 server uses stdio, Zod 4 input/output schemas, read-only annotations, remote-access hints, and request cancellation. Stdout is reserved for protocol messages. The server can be bound to one repository or accept an explicit repository per collection call. Supplied-context assessment needs neither Git nor a configured repository.

The Jev client handles all three primitives, validates requested answer types/options/ranges, retains the resolved model identifier, applies a request deadline across retries, and honors bounded Retry-After delays. Responses are limited to 512 KB, and malformed response errors do not echo provider bodies. Secret-pattern screening also applies to supplied contexts before transmission. Configurable defaults are 20 seconds for soft import discovery, 120 seconds for collection, and 300 seconds for repository review; cancellation propagates into Git and provider work. CLI's review deadline covers inference and post-review verification; MCP's includes initial recollection too. Errors cannot become successful reviews. Credentials are read from the environment and sent directly to TypeSafe.

Repository reviews cache up to 16 reports for five minutes. Keys include canonical repository identity, source/task/context snapshots, and requested model. Prior evaluations are compared against a cloned report locally and do not invalidate cached inference. The original report time and cache-hit flag remain visible. A mutable model alias can change upstream; choose an available concrete version for reproducible evaluations.

MCP separately retains at most sixteen small preview discovery scopes for five minutes, keyed by snapshot, without caching raw source plans. Review pins both recollections to that preview scope. Unknown, expired, or evicted preview tokens require a new preview.

## Packaging and next work

The runtime is bundled into a standalone ESM file. Portable plugin manifests, client compatibility adapters, and a continuous-review skill accompany it. Packaging validation is distinct from installation inside every client.

Remaining improvements are broader candidate coverage, complete caller retrieval, broader real-PR evaluation, calibrated thresholds, sandboxed witness execution, verified-fix tracking, and CI/SARIF export. See the capability parity checklist and recorded validation results.
