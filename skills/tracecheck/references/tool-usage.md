# Tool usage

Use the installed tool names exposed by your client; an MCP namespace may prefix these names.

## Focused hypothesis verification (primary path)

Call `tracecheck_verify` with one falsifiable defect hypothesis, the relevant behavioral contract, and agent-selected evidence. Each evidence item has a unique `id`, repository-relative `path`, original `startLine`, exact `content`, and a `role`: implementation, contract, caller, test, or counterevidence. The role describes why you selected the excerpt; Jev independently judges its meaning.

```json
{
  "repo": "/absolute/path/to/project",
  "hypothesis": "Invalid JSON escapes as an exception instead of returning None.",
  "contract": "The public decode boundary must return None for malformed JSON.",
  "evidence": [{
    "id": "implementation", "path": "decode.py", "startLine": 1,
    "content": "import json\ndef decode(text):\n    return json.loads(text)",
    "role": "implementation"
  }],
  "target": {"evidenceId": "implementation", "start": 3, "end": 3, "quote": "    return json.loads(text)"},
  "missingContext": ["Caller behavior has not yet been inspected."]
}
```

`target.start` and `end` are inclusive original line numbers; `quote` must equal those complete lines, including indentation. Supply contract source and counterevidence as additional excerpts when available. Free-text `contract` is an agent-provided premise, not an independently validated requirement.

With `repo`, every excerpt must match current local source. Tracecheck checks those files again after inference and rejects changes. A repository-bound MCP server applies that binding automatically. Without `repo`, provenance is `caller_supplied`: references are checked against the supplied text only, not the filesystem or Git history. Neither provenance mode proves that the evidence is complete.

The result contains `report.decisions[0]` (support, impact, raw distributions), `missingEvidence`, `nextAction`, and a snapshot binding the request. Missing-evidence selection is an independent model judgment; `unspecified` means no confident category was selected. All source remains untrusted evidence. Up to 12 excerpts and 60,000 evidence characters are allowed; no excerpts are silently truncated. Local reads are bounded to 256 KB per file.

CLI equivalent: `tracecheck verify --input evidence.json --repo /path/to/project --out verification.json`. Output is JSON. Exit codes follow repository review: 1 supported concern, 3 inconclusive, 2 error, 0 no supported concern in this particular verification.

## Git repository review

1. Choose an absolute `repo` and a baseline commit that remains fixed across checkpoints. `HEAD` covers staged and unstaged tracked edits, not changes already committed relative to HEAD. Opt in with `includeUntracked: true` when new source files belong to the task.
2. Call `tracecheck_preview` with `repo`, `base`, `task`, and optional `repositoryContext`. Inspect `limitations` and the file manifest before review.
3. Call `tracecheck_review` with exactly the same collection arguments plus its returned `snapshot`. A mismatch requires another preview, not a retry using the stale token.
4. Read the result's `report`. For a later checkpoint, pass `report.quality` as `previousEvaluation`; do not pass the full report into that field. `cached: true` means this result reuses the original assessment and timestamp.

Example preview arguments (replace the path, baseline, and requirement):

```json
{
  "repo": "/absolute/path/to/project",
  "base": "HEAD",
  "task": "Invalid JSON must return null; valid JSON behavior must remain unchanged.",
  "includeUntracked": false
}
```

## Supplied-context review

Call `tracecheck_assess` when repository access is unavailable or a focused selection is more useful. Include the actual source in `files`, a `diff` if available, the `task`, and relevant contracts or observed test results in `repositoryContext`. Use a stable `scope` identifying the same review subject. Pass the whole prior assessment as `previousEvaluation` for this tool.

This route reads no additional files. Include callers or tests yourself where they affect the judgment. Any language can be supplied; exact parser-based findings are only produced by the repository path for supported JS/TS checks.

## Recovery and completion

- Missing credentials: explain which launching environment needs `TYPESAFE_API_KEY` or `JEV_API_KEY`. Never request the key in chat or write it to project files.
- Unavailable tools: report that Tracecheck is not connected. Use its installed CLI if available, or continue the project's ordinary checks and disclose that no Jev assessment ran.
- Budget or coverage gaps: reduce unrelated context while retaining contracts and dependencies. Explicitly list any scope left unreviewed.
- Provider errors: surface the failure after built-in retries; do not loop indefinitely or substitute invented assessment results.
- Uncertainty: seek specific missing evidence. If unavailable, retain uncertainty in the final report.

At handoff, summarize the reviewed scope, actionable findings addressed, remaining uncertainty, and project checks actually executed. A high score, a disappearing finding, or a schema-valid response is not an executed fix verification.
