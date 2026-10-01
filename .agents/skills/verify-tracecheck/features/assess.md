# Assess

Assess evaluates caller-supplied task text, files, and repository context across 19 quality dimensions in one provider request, without reading the filesystem. Each dimension reports relevance, evidence sufficiency, a score when both are credible, and a concern; a previous evaluation is compared locally.

## Driving it

Preconditions:

- The skill's launch steps are done, and a provider key is set.
- `$RUN/context.json` contains `{"task":"Return the arithmetic mean of a list of numbers. Empty input must return 0.","files":[{"path":"mean.py","content":"def mean(values):\n    return sum(values) / len(values)\n"}]}`.

- **CLI JSON.** Run `node dist/plugin.mjs assess --input "$RUN/context.json" --json --out "$RUN/evaluation.json" > "$RUN/assess.stdout" 2> "$RUN/assess.stderr"; echo $?`. Exit `0`. `jq '{model, usage, statuses: ([.metrics[].status] | group_by(.) | map({(.[0]): length}) | add), priorities}' "$RUN/evaluation.json"` shows 19 metrics and `usage.requests: 1`.
- **Previous evaluation.** Fix the file (add an empty-input guard), save it as `$RUN/context-2.json`, and run `node dist/plugin.mjs assess --input "$RUN/context-2.json" --previous "$RUN/evaluation.json" --json`. Exit `0`; the output has `comparison`, `improvements`, `regressions`, and `unresolvedWeaknesses`. They stay empty when neither run published comparable scores, which is common for tiny inputs.
- **Failure gate.** Run the CLI JSON command again with `--fail-on-priorities`. The exit is `1` when the output's `priorities` is not empty and `0` when it is empty. An input with an obvious defect against its task, such as `def mean(values): return sum(values) / len(values) + 1` for a mean, usually produces a correctness priority; a tiny correct function usually produces none.
- **MCP entry.** Use `[{"tool":"tracecheck_assess","arguments":<context.json>}]` with `mcp-call.mjs` (no `--repo` needed). The record has `isError: false` and 19 metrics in `structuredContent.metrics`.
- **Cancellation.** Point `TYPESAFE_BASE_URL` at a local HTTP server that never answers, set a dummy `JEV_API_KEY`, start the CLI assess command, and send `SIGINT` after a second. The command exits `130` with `Tracecheck: interrupted.` instead of being killed by the signal.
- **Missing key.** Run the CLI command with `env -i PATH="$PATH" node dist/plugin.mjs assess --input "$RUN/context.json"`. Exit `2` with a message naming the three key variables.
- **Credential guard.** Supply a file such as `{"path":"config/.env","content":"API_KEY=<random-looking value>\n"}`, built at run time rather than committed. Point `TYPESAFE_BASE_URL` at a loopback HTTP server that counts requests, with any placeholder key. The CLI exits `2` and the MCP record has `isError: true`, both with `Potential credential in config/.env (field files[0].content)`; the server receives no request and the value is absent from the output.

## Gotchas

- `assess` exits `0` whatever the priorities are unless `--fail-on-priorities` is set.
- A comparison needs matching `scope`, model, and rubric version; otherwise it reports the evaluations as incomparable.
- Most metrics are `uncertain` or `not_applicable` for tiny inputs. Assert on structure and counts, not on specific scores.
