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
