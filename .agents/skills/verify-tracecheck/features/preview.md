# Preview

Preview collects the working-tree change against a base commit without contacting any provider. It reports the snapshot token, change packets, the sources collected for each (changed files with their baselines, dependencies, callers, and tests), syntax-selected source-check candidates, and coverage gaps.

## Sub-features

- `preview-packets` groups every supported changed file into packets and prints a snapshot.
- `preview-sources` collects changed files with baselines plus related dependencies, callers, and tests.
- `preview-candidates` selects division (`/`, `%`, `/=`, `%=`), catch-handler, and `JSON.parse` candidates in changed JS/TS functions, or in the changed top-level statement for module-level code. It skips non-zero literal divisors, catch handlers with a top-level `throw`, and `JSON.parse` inside the protected block of a `try` with a handler.
- `preview-gaps` reports omitted files, parse failures (by file and parser error code), budget limits, and TypeScript configuration that could not be used for path aliases. Every file omitted for a potential credential is named by path, and the value never appears in the output. A changed file whose base version holds a potential credential keeps its screened current text, loses its baseline, and is named in a limitation. Caveats that are not gaps, such as heuristic discovery and the count of excluded untracked files, are `notes` (human output: `Note: ...`) and are not part of the snapshot.
- `preview-options` applies `--base`, `--include-untracked`, and the collection limits, over defaults from `.tracecheck.json` (see [project configuration](./project-configuration.md)).
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
- **No change.** Use the `clean` fixture. Preview exits `0` and reports no packets, no sources, no candidates, and the note `No changes against HEAD; nothing to review.`, so a review makes no provider request.
- **Rename.** Use the `rename` fixture. `new.ts` is `changed` with `previousPath: "old.ts"`, and its `before` is the base content of `old.ts`, including the removed `if (!b) return 0;` guard. The human output lists `changed: new.ts (renamed from old.ts)`, and the MCP `files` entry carries `previousPath`.
- **Pure rename.** Use the `rename-pure` fixture. `quotient.ts` has `previousPath: "ratio.ts"` and a baseline, and `candidates` is empty because a rename without edits has no changed ranges.
- **Rename across eligibility.** Use the `rename-ineligible` fixture. `limitations` include `Unsupported or generated file (notes.ts -> notes.txt)` and `Renamed from unsupported or generated path dist/ratio.ts; reviewed without a baseline (ratio.ts)`; `ratio.ts` has no `before`.
- **Parsing.** Use the `jsx-js` and `decorators` fixtures. Each yields one candidate (`zero-divisor` in `Progress`, `swallowed-failure` in `create`) and no `Source could not be parsed` limitation. The `parse-error` fixture yields `Source could not be parsed (VarRedeclaration); no candidates collected: src/broken.ts`, and no limitation quotes the redeclared identifier.
- **Candidate filters.** Use the `noise` fixture. Expect exactly two candidates in `summarize`: `zero-divisor` on `total /= samples.length` and `swallowed-failure` on the handler with `if (!retry) throw error;`. The unchanged module-level `limits.total / limits.workers`, the literal divisors, the rethrowing handler, and both guarded `JSON.parse` calls are absent.
- **Python imports.** Use the `python-import` fixture. Expect `pkg/report.py` as a `caller` (it uses a parenthesized multi-line import) and `tests/test_calc.py` as a `test`.
- **JS/TS module paths.** Use the `module-paths` fixture. Expect `src/app.tsx` as `changed`, `src/main.ts` as `caller` (imports `./app.jsx`), and `src/lib.mts`, `src/legacy.cts`, `src/widgets/index.tsx`, and `src/app.css` as `dependency` sources. `src/logo.png` is not a source and appears in no limitation.
- **Path aliases.** Use the `path-aliases` fixture. Expect `src/lib/stats.ts` as `changed`, `src/components/Report.tsx` as `caller` and `test/empty-input.test.ts` as `test` (both import `@/lib/stats` through `paths`), and `src/utils/round.ts` as `dependency` (imported as `utils/round` through `baseUrl`); both settings come from `config/tsconfig.base.json` through `extends`. `limitations` include `TypeScript config could not be parsed; its path aliases are ignored (packages/legacy/tsconfig.json).` and `TypeScript config extends targets outside the repository were not followed (tsconfig.json -> ../tracecheck-shared/tsconfig.json, tsconfig.json -> @tsconfig/strictest/tsconfig.json).`
- **Credential screening.** Use the `credentials` fixture and `preview --json`. Expect `src/lexer.ts` as `changed` even though it assigns token-kind names such as `'StringLiteralExpressionToken'`, and `Collection omitted 2 file(s): File with a potential credential omitted (config/app.yml, deploy/env.sh).` in `limitations`. The fixture's credential value does not appear in stdout.
- **Credential in the base version.** Use the `baseline-credential` fixture, where the change removes a committed credential from `src/client.ts`. `preview --json` lists `src/client.ts` as `changed` with no `before` and one `zero-divisor` candidate in `rate`; `limitations` include `Collected source limitation for 1 file(s): Base version with a potential credential omitted; reviewed without a baseline (src/client.ts).` and the packet's `limitations` include `Base version with a potential credential omitted; reviewed without a baseline: src/client.ts`. The MCP `tracecheck_preview` record lists the file and the same limitation. The credential value appears in neither output.
- **Related-file focus.** Use the `symbol-focus` fixture. `src/checkout.ts` is a `caller` with `evidence.complete: false`; its `content` includes line `302:` (the `applyDiscount` call, an `export const` arrow function) and line `453:` (the `$round` call), and `evidence.currentRanges` covers both. Names come from `def`, `function`, and `class` declarations and from `const`, `let`, or `var` bound to an arrow function or function expression.
- **Changes without hunks.** Use the `hunkless` fixture. `limitations` include `File mode changed without a content change; no changed lines to review (mode.ts)` and `Git reported no textual diff (binary or -diff attribute); changed lines are unknown (opaque.ts)`.
- **Colons in paths.** Use the `colon-paths` fixture. `limitations` include `Collected source limitation for 2 file(s): Focused excerpts only; omitted lines are not reviewed (src/a:one.ts, src/b:two.ts).`
- **Large listings.** Use the `large-listing` fixture: about 8.8 MB of `git ls-files -z` output. Preview exits `0` with the division result (`zero-divisor` in `mean`).
- **Git environment.** Create a second fixture and run preview with `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` naming it, for example `env GIT_DIR="$OTHER/.git" GIT_WORK_TREE="$OTHER" GIT_INDEX_FILE="$OTHER/.git/index" node dist/plugin.mjs preview --repo "$ROOT" --json`. `root` and `sources` still come from `$ROOT`. For MCP, pass `--env GIT_DIR --env GIT_WORK_TREE --env GIT_INDEX_FILE` to `mcp-call.mjs`.
- **Working tree changes mid-collection.** Put a `git` wrapper first on `PATH` that runs the real Git and then, for a command containing `--raw`, runs `git checkout -- src/stats.ts` in the `division` fixture. Preview exits `2` with `Working tree changed during collection; retry the preview.`
- **MCP entry.** Write `[{"tool":"tracecheck_preview","arguments":{}}]` to `$RUN/calls.json` and run `node $S/mcp-call.mjs --out "$RUN/mcp" --repo "$ROOT" --calls "$RUN/calls.json"`. The record `01-tracecheck_preview.json` has `isError: false` and `structuredContent.snapshot` equal to the CLI snapshot for the same fixture, settings, and task.

## Gotchas

- The snapshot hashes task and context. Passing `--task` to one run and not the other yields different snapshots by design.
- Git subprocesses drop `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and the other repository-local variables from `git rev-parse --local-env-vars` except the configuration ones, so a caller's hook environment cannot redirect collection.
- Untracked files are ignored unless `--include-untracked` or `includeUntracked: true` is passed.
- `preview --json` prints full source content. Treat the stdout file as source-bearing evidence.
- The MCP server bound with `--repo` rejects a different `repo` argument; an unbound server requires `repo` on every collection call.
