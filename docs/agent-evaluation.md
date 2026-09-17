# Evaluating agent assistance

The product question is whether a coding agent reviews better with Tracecheck. The earlier [RapidRegs benchmark](accuracy.md) measured supplied-concern verification; it cannot answer that question. Its cases are now exposed and should not be treated as a fresh holdout.

## Paired protocol

1. Curate fresh historical bug/fix pairs and clean changes. Keep labels, oracle results, and defect locations outside the reviewing agent's context. Pin subject revision, agent model, Jev model, skill version, and budgets. Include the entire task set, including cases where the agent discovers nothing.
2. Give the agent the change and requirements with its normal repository tools. Before any Jev call, save its candidate hypotheses, selected evidence, provisional findings, costs, and baseline timestamp to an append-only run record. Freeze a digest of that record independently. The reviewer must not see the answer key.
3. Continue the same investigation with the Tracecheck skill. Record verification inputs, outputs, evidence expansions, and elapsed time. Save the agent's final verdict separately from Jev's verdict; blindly replacing the baseline with Jev is not agent assistance.
4. Have an evaluator map both sets of findings to the withheld defects and audit evidence completeness against required contracts/callers. Include unmatched findings as clean negative rows to measure false positives. Count undiscovered defects as misses. Use a zero-cost uncertain Jev stage when no hypothesis was submitted, rather than dropping that case.
5. Join labels after review and score the complete ledger. Report discovery, evidence completeness, baseline versus assisted recall/precision/abstention, assistance that helped or harmed, and total cost. Repeat on fresh cases; do not tune on observed holdout outcomes.

A paired continuation also gives the agent additional investigation time. To isolate Jev's incremental value, run an agent-only continuation with the same time/token budget in independent fresh sessions and randomize condition order across cases. Record extra investigation and inference costs. Neither timestamp validation nor a file format proves blinding; retain the frozen baseline and transcripts for audit.

## Scoring

```sh
npm run accuracy:paired -- --input .tracecheck/paired-run.json
```

The ledger has `subjectRevision`, `agentModel`, `jevModel`, and a `cases` array. Each case contains:

| Field | Meaning |
| --- | --- |
| `id` | Unique matched defect or unmatched finding identifier. |
| `expected` | `supported` for a labeled defect, `not_supported` for clean behavior. Added after review. |
| `baselineRecordedAt`, `verificationStartedAt` | ISO UTC timestamps; baseline must precede verification. |
| `baseline`, `jev`, `assisted` | Each has `verdict`, `elapsedMs`, `inputTokens`, `outputTokens`. Verdict is supported, not_supported, uncertain, or needs_context. |
| `discovered` | Whether the agent independently identified the labeled concern before Jev. |
| `evidenceComplete` | Evaluator-audited sufficiency of the submitted evidence, not Jev's confidence. |

`baseline` cost covers the initial review. `jev` covers only verification requests. `assisted` is cumulative baseline + further agent work + Jev, so the totals are compared, not added again. Allocate shared review costs once across case rows; avoid charging a whole-task request to every finding.

The scorer rejects duplicate IDs and post-verification baseline timestamps. It counts abstentions as missed defects for recall, reports helped/harmed verdict transitions, and keeps discovery and evidence omissions separate. It does not invent agent baselines or automatically judge whether two differently worded findings describe the same defect.

## Current evidence

The scorer and verification workflow have deterministic regression tests. A live check of the repaired RapidRegs S3 existence function through the new CLI returned `not_supported` for the old AccessDenied-swallowing concern, with local source validation, Jev `jev-1.13.0`, confidence 0.96, selected probability 0.97, 1,686 input tokens, 175 output tokens, and a 376 ms review stage. The missing-evidence category remained `unspecified`.

That check used a known, previously inspected case. It proves the new path runs; it does not establish incremental accuracy. **No fresh, blinded agent-only versus agent-assisted study has been completed.**

## Isolated RapidRegs loop — September 17, 2026

An isolated agent investigated `src/rapidregs_ingest/jobs/daily.py::render_issues_csv` in disposable `git clone --no-hardlinks` copies pinned to `b3d8ac8054dd1dc8c5c99ef4b2dbdcf345a28ef5`. This was a fresh case outside the exposed benchmark families. The original checkout remained unchanged, and both temporary clones were removed.

The agent's initial hypothesis was conditional CSV formula injection. Its pre-Jev judgment was not to report a defect without establishing spreadsheet consumption and input reachability. It selected the renderer, issue boundary, callers, documentation, and test evidence; the actual compiled `verify` CLI checked those excerpts against local files.

| Checkpoint | Jev result | Confidence | Input/output tokens | Jev stage | CLI wall time |
| --- | --- | --- | --- | --- | --- |
| Initial evidence | `needs_context` | 0.68 | 1,982 / 171 | 789 ms | 0.89 s |
| Expanded evidence and counterevidence | `uncertain` | 0.23 | 2,368 / 174 | 382 ms | 0.46 s |

The agent followed up by tracing issue construction and the documented JSONL retry workflow, adding that workflow as counterevidence and explicitly retaining the missing spreadsheet-consumption contract. Both successful checkpoints reported `local_files_checked` provenance. There were two provider requests; agent investigation time was not separately instrumented.

There was real workflow friction: an intermediate CLI attempt rejected a README excerpt because the agent had appended a closing Markdown fence that was not present at that location. The rejection occurred before inference, in 0.08 seconds. The agent re-read the range, corrected the excerpt, and successfully repeated verification. This demonstrates mechanical evidence validation rather than code making the semantic judgment.

For behavior proof, the agent AST-extracted the exact renderer function and its field-list literal, then executed the unmodified function body with its standard-library globals and a boundary object implementing `model_dump(mode="json")`. A supplied `publication_title` of `=1+1` remained unchanged in the emitted CSV. This exercises the isolated real function, not the entire application or a spreadsheet. A direct application-level attempt was blocked by dependencies unavailable under the offline/no-network constraint.

The final agent conclusion remained **unresolved conditional risk**, not a confirmed vulnerability: the probe establishes formatter behavior, but the evidence does not establish a formula-evaluating consumer or production reachability. Jev highlighted missing context; it did not establish or refute the defect, and it did not change the agent's cautious initial reporting decision. This validates the agent → Jev → agent refinement loop, not incremental accuracy or a blinded benchmark.
