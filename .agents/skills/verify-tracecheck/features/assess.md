# Assess

Assess evaluates caller-supplied task text, files, and repository context across 19 quality dimensions in one provider request, without reading the filesystem. Each dimension reports relevance, evidence sufficiency, a score when both are credible, and a concern; a previous evaluation is compared locally.

## Sub-features

- `assess-cli` prints a Markdown quality table, or JSON with `--json`, and can write `--out`.
- `assess-metrics` returns 19 metrics with `status` (`assessed`, `uncertain`, `insufficient_context`, `not_applicable`) and optional scores.
- `assess-priorities` lists actionable concerns.
- `assess-previous` compares with a previous evaluation of the same scope and model.
- `assess-mcp` returns the same evaluation from `tracecheck_assess`.

## How to get to it (user POV)

- Run `tracecheck assess --input context.json [--previous evaluation.json] [--json] [--out evaluation.json]`.
- Call the MCP tool `tracecheck_assess` with `task`, `files`, optional `repositoryContext`, `scope`, and `previousEvaluation`.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold, and `doctor.mjs` reports `live: true`.
- `$RUN/context.json` contains `{"task":"Return the arithmetic mean of a list of numbers. Empty input must return 0.","files":[{"path":"mean.py","content":"def mean(values):\n    return sum(values) / len(values)\n"}]}`.

- **CLI JSON.** Run `$S/capture.sh "$RUN" assess -- node dist/plugin.mjs assess --input "$RUN/context.json" --json --out "$RUN/evaluation.json"`. Exit `0`. `jq '{model, usage, statuses: ([.metrics[].status] | group_by(.) | map({(.[0]): length}) | add), priorities}' "$RUN/evaluation.json"` shows 19 metrics and `usage.requests: 1`.
- **Previous evaluation.** Fix the file (add an empty-input guard), save it as `$RUN/context-2.json`, and run `node dist/plugin.mjs assess --input "$RUN/context-2.json" --previous "$RUN/evaluation.json" --json`. Exit `0`; the output has `comparison`, `improvements`, `regressions`, and `unresolvedWeaknesses`. They stay empty when neither run published comparable scores, which is common for tiny inputs.
- **MCP entry.** Use `[{"tool":"tracecheck_assess","arguments":<context.json>}]` with `mcp-call.mjs` (no `--repo` needed). The record has `isError: false` and 19 metrics in `structuredContent.metrics`.
- **Missing key.** Run the CLI command with `env -i PATH="$PATH" node dist/plugin.mjs assess --input "$RUN/context.json"`. Exit `2` with a message naming the three key variables.

## Gotchas

- `assess` exits `0` whatever the priorities are.
- A comparison needs matching `scope`, model, and rubric version; otherwise it reports the evaluations as incomparable.
- Most metrics are `uncertain` or `not_applicable` for tiny inputs. Assert on structure and counts, not on specific scores.
