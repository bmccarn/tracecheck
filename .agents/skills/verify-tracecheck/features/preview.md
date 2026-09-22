# Preview

Preview collects the working-tree change against a base commit without contacting any provider. It reports the snapshot token, change packets, the sources collected for each (changed files with their baselines, dependencies, callers, and tests), syntax-selected source-check candidates, and coverage gaps.

## Sub-features

- `preview-packets` groups every supported changed file into packets and prints a snapshot.
- `preview-sources` collects changed files with baselines plus related dependencies, callers, and tests.
- `preview-candidates` selects division, catch-handler, and `JSON.parse` candidates in changed JS/TS functions.
- `preview-gaps` reports omitted files, parse failures, budget limits, and heuristic-discovery limitations.
- `preview-options` applies `--base`, `--include-untracked`, and the collection limits.
- `preview-mcp` returns the same scope from `tracecheck_preview` and registers the snapshot for review.

## How to get to it (user POV)

- Run `tracecheck preview --repo PATH [--base REF] [--include-untracked] [--json]`.
- Call the MCP tool `tracecheck_preview` with optional `repo`, `base`, `includeUntracked`, `task`, `repositoryContext`, and `collection`.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold. No provider key is needed.
- A fixture exists: `node $S/fixture-repo.mjs division > "$RUN/fixture.json"` and `ROOT=$(jq -r .root "$RUN/fixture.json")`.

- **Human output.** Run `$S/capture.sh "$RUN" preview -- node dist/plugin.mjs preview --repo "$ROOT"`. Exit `0`; stdout starts with `Tracecheck preview (local only)` and lists `changed: src/stats.ts`.
- **Structured output.** Run `$S/capture.sh "$RUN" preview-json -- node dist/plugin.mjs preview --repo "$ROOT" --json`. Then `jq '{snapshot, packets: [.packets[] | .changedPaths], sources: [.sources[] | {path, role, hasBaseline: (.before != null)}], candidates: [.candidates[] | {check, path, symbol}], limitations}' "$RUN/preview-json.stdout"`. Expect `src/stats.ts` as `changed` with a baseline, `src/report.ts` as `caller`, `test/stats.test.ts` as `test`, and one `zero-divisor` candidate in `mean`.
- **No change.** Use the `clean` fixture. Preview exits `0` and reports one packet with no sources and no candidates, so a review makes no provider request.
- **Rename.** Use the `rename` fixture. `new.ts` is `changed` with `previousPath: "old.ts"`, and its `before` is the base content of `old.ts`, including the removed `if (!b) return 0;` guard. The human output lists `changed: new.ts (renamed from old.ts)`, and the MCP `files` entry carries `previousPath`.
- **Pure rename.** Use the `rename-pure` fixture. `quotient.ts` has `previousPath: "ratio.ts"` and a baseline, and `candidates` is empty because a rename without edits has no changed ranges.
- **Rename across eligibility.** Use the `rename-ineligible` fixture. `limitations` include `Unsupported or generated file (notes.ts -> notes.txt)` and `Renamed from unsupported or generated path dist/ratio.ts; reviewed without a baseline (ratio.ts)`; `ratio.ts` has no `before`.
- **Python imports.** Use the `python-import` fixture. Inspect whether `pkg/report.py` appears as a caller and `tests/test_calc.py` as a test.
- **MCP entry.** Write `[{"tool":"tracecheck_preview","arguments":{}}]` to `$RUN/calls.json` and run `node $S/mcp-call.mjs --out "$RUN/mcp" --repo "$ROOT" --calls "$RUN/calls.json"`. The record `01-tracecheck_preview.json` has `isError: false` and `structuredContent.snapshot` equal to the CLI snapshot for the same fixture, settings, and task.

## Gotchas

- The snapshot hashes task and context. Passing `--task` to one run and not the other yields different snapshots by design.
- Untracked files are ignored unless `--include-untracked` or `includeUntracked: true` is passed.
- `preview --json` prints full source content. Treat the stdout file as source-bearing evidence.
- The MCP server bound with `--repo` rejects a different `repo` argument; an unbound server requires `repo` on every collection call.
