# Review

Review collects the same scope as preview, sends each nonempty packet to Jev with up to `JEV_CONCURRENCY` requests at once, and returns a report: source-check decisions with status and impact, an independent quality evaluation per packet, limitations, models, and usage. It re-collects after inference and rejects the result if the repository changed. Compare turns two saved reports into a finding history.

## Sub-features

- `review-cli` runs `review` and sets the exit code from the report status.
- `review-decisions` returns a decision per candidate with `status` (`supported`, `not_supported`, `uncertain`, `needs_context`) and `impact`.
- `review-quality` returns `quality` for one packet or `packetQualities` for several.
- `review-previous` compares with a previous single-packet report via `--previous` or `previousEvaluation`. A previous evaluation that cannot be compared adds a `Previous evaluation was not compared because ...` limitation.
- `review-partial` keeps completed results when a request fails after its retries: the report is `inconclusive`, `usage.requests` counts only completed requests, and a `Review incomplete for packet <id> (<paths>): <error> Not evaluated: ...` limitation names the unevaluated source checks and broad review. When every request fails, the command fails with the provider error instead. MCP does not cache an incomplete report.
- `review-mcp` runs `tracecheck_review` with a preview snapshot and caches the report for repeated calls. A cache hit collects once and makes no provider request.
- `review-stale` rejects a snapshot when the repository changed after preview.
- `compare-history` classifies findings across two saved reports with `compare`.

## How to get to it (user POV)

- Run `tracecheck review --repo PATH [--base REF] [--task TEXT] [--context TEXT] [--previous report.json] [--json] [--out report.json]`.
- Call `tracecheck_preview`, then `tracecheck_review` with its `snapshot` and the same collection arguments.
- Run `tracecheck compare --previous old.json --current new.json`.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold, and `doctor.mjs` reports `live: true`.
- A fixture exists: `node $S/fixture-repo.mjs json-regression > "$RUN/fixture.json"` and `ROOT=$(jq -r .root "$RUN/fixture.json")`.

- **CLI review.** Run `$S/capture.sh "$RUN" review -- node dist/plugin.mjs review --repo "$ROOT" --json --out "$RUN/report.json"`. The exit code matches `status`: `1` for `needs_attention`, `3` for `inconclusive`, `0` for `no_findings`. `jq '{status, models, usage, decisions: [.decisions[] | {check, status, impact}], metrics: (.quality.metrics | length)}' "$RUN/report.json"` shows one `unhandled-json` decision and 19 metrics.
- **Human output.** Run `$S/capture.sh "$RUN" review-md -- node dist/plugin.mjs review --repo "$ROOT"`. Stdout is a Markdown report with a quality table and a section per decision.
- **MCP review and cache.** Write `[{"tool":"tracecheck_preview","arguments":{}},{"tool":"tracecheck_review","arguments":{"snapshot":"$snapshot"}},{"tool":"tracecheck_review","arguments":{"snapshot":"$snapshot"}}]` and run it with `mcp-call.mjs --repo "$ROOT"`. The first review has `structuredContent.cached: false`; the second has `cached: true` and the same `report.id`. To count collections, put a `git` wrapper that appends a line to a log first on `PATH` and add `run` steps that append a marker line to the log between calls. Count lines between markers: a miss collects twice (before and after inference), a hit once.
- **Partial failure.** Start `$S/stand-in-provider.mjs --latency-ms 200 --fail-path 'ratio08'` with `hub`, create `node $S/fixture-repo.mjs multi-packet`, and run the CLI review with `TYPESAFE_API_KEY=placeholder` and `TYPESAFE_BASE_URL=http://127.0.0.1:<port>`. Exit `3`; `status` is `inconclusive`, `usage.requests` is `1`, the first packet's eight decisions and `packetQualities` entry remain, and one limitation starts with `Review incomplete for packet`. The stand-in log shows three attempts at the failing packet. Over MCP, start the stand-in with `--fail-times 3` and call `tracecheck_review` three times: the first report is incomplete with `cached: false`, the second reaches the stand-in again and completes with `cached: false`, and the third is `cached: true`.
- **Stale snapshot.** In one calls file, run `tracecheck_preview`, then a step `{"run":["bash","-c","echo '// edit' >> $ROOT/decode.ts"]}`, then `tracecheck_review` with `"$snapshot"`. The review record has `isError: true` with `Repository context changed since preview`. No key is needed; the check runs before inference.
- **Previous evaluation without a quality result.** Use `node $S/fixture-repo.mjs blank-packet`, then run `tracecheck_preview` and `tracecheck_review` with `"$snapshot"` and any saved `report.quality` as `previousEvaluation`. No provider request is made, `report.quality` is absent, and `report.limitations` includes `Previous evaluation was not compared because this review produced no quality result.`
- **Compare.** Save two reports with `--out`, then run `$S/capture.sh "$RUN" compare -- node dist/plugin.mjs compare --previous "$RUN/report-1.json" --current "$RUN/report-2.json"`. Stdout lists each earlier supported finding with a state, then each finding supported only in the current report as `newly_supported`; no state claims a verified fix. Model order does not affect compatibility.

## Gotchas

- The stand-in provider answers every question the same way; use it for timing and failure handling, not for decision quality.
- Each nonempty packet makes at least one provider request, and the 76 quality questions cost roughly 15,000 input tokens per request. Keep fixtures small.
- The MCP cache lasts five minutes per server process. `mcp-call.mjs` starts a new process each run, so cache hits only occur within one calls file.
- `--previous` requires a single-packet plan; multi-packet plans fail before inference.
- Reports contain source excerpts. Keep them inside `$RUN`.
