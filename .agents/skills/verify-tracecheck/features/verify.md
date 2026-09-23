# Verify

Verify judges one defect hypothesis the caller selected, against a contract and quoted evidence with original line numbers. It validates the target quote locally, optionally checks every excerpt against files in a repository before and after inference, and returns support, impact, a missing-evidence category, and a next action.

## Sub-features

- `verify-supplied` judges caller-supplied evidence with `provenance: caller_supplied`.
- `verify-local` checks excerpts against a repository and reports `provenance: local_files_checked`.
- `verify-anchor` rejects a target quote or line range that does not match the evidence before any provider call.
- `verify-guards` rejects duplicate IDs, evidence over the UTF-8 byte budget, absolute or `..` paths, and credential-shaped content before inference. A credential error names the evidence path or input field, never the value.
- `verify-read-errors` rejects, before inference, evidence whose file in the bound repository is missing, a directory, a symlink, outside the repository, unreadable, or over 256,000 bytes. The error names the evidence ID and its repository-relative path, never an absolute path or system error text, and is the same through the CLI and MCP.
- `verify-mcp` returns the same output from `tracecheck_verify`.

## How to get to it (user POV)

- Run `tracecheck verify --input evidence.json [--repo PATH] [--out result.json]`.
- Call the MCP tool `tracecheck_verify` with the same fields as `evidence.json`, plus optional `repo`.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold, and `doctor.mjs` reports `live: true` for the live steps.
- `$RUN/evidence.json` contains:
  ```json
  {"hypothesis":"mean() raises ZeroDivisionError for an empty list, violating the contract that empty input returns 0.",
   "contract":"mean(values) returns the arithmetic mean; empty input must return 0.",
   "evidence":[{"id":"impl","path":"mean.py","startLine":1,"role":"implementation","content":"def mean(values):\n    return sum(values) / len(values)\n"}],
   "target":{"evidenceId":"impl","start":2,"end":2,"quote":"    return sum(values) / len(values)"}}
  ```

- **CLI supplied evidence.** Run `$S/capture.sh "$RUN" verify -- node dist/plugin.mjs verify --input "$RUN/evidence.json"`. Stdout JSON has `provenance: "caller_supplied"`, one decision in `report.decisions`, a `nextAction`, and a `missingEvidence` value. The exit code follows `report.status` as in review.
- **Bad anchor.** Change `target.quote` to text absent from the evidence and rerun. Exit `2`, a local validation error, and no provider request.
- **Local files.** Write `mean.py` with the same content into a fixture root, then run with `--repo "$ROOT"`. Output has `provenance: "local_files_checked"`. Editing `mean.py` so the excerpt no longer matches makes the run fail before inference.
- **Unreadable evidence.** With `--repo "$ROOT"`, set an evidence `path` to a file that does not exist, a directory, or a symlink to a file outside the root. Exit `2`, a message such as `Evidence impl (missing.py) was not found in the repository.`, no absolute path, and no provider request. The MCP tool on a server bound with `--repo` returns the same text with `isError: true`.
- **MCP entry.** Wrap the evidence as `[{"tool":"tracecheck_verify","arguments":<evidence.json>}]` and run `mcp-call.mjs`. The record has `isError: false` and the same output fields.

## Gotchas

- `startLine` is the original line number of the excerpt's first line, and `target.start`/`end` are original line numbers, not offsets into the excerpt.
- The evidence budget is 60,000 UTF-8 bytes across all excerpts and at most 12 excerpts. Multibyte text counts every byte: 25,000 CJK characters are 75,000 bytes and fail locally with `Trim each excerpt`, before any provider request.
- With a server bound by `--repo`, a different `repo` argument is rejected.
