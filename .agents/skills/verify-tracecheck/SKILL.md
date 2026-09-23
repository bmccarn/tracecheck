---
name: verify-tracecheck
description: Drive the built Tracecheck CLI and MCP stdio server against disposable Git repositories and capture proof. Use to verify a Tracecheck change end to end, reproduce a reported bug, or approve a pull request, locally or against the live Jev provider.
---

# Verify Tracecheck

Tracecheck has two user surfaces, both served by one bundled executable, `dist/plugin.mjs`:

- **CLI**: `node dist/plugin.mjs <preview|review|verify|assess|compare|mcp>`. A finite command; run it with `bash`.
- **MCP stdio server**: `node dist/plugin.mjs mcp [--repo PATH]`, with tools `tracecheck_preview`, `tracecheck_review`, `tracecheck_verify`, and `tracecheck_assess`. Drive it with `scripts/mcp-call.mjs`, which launches its own server process per run.

Proof means the built bundle ran the user's path and the result was observed: command, stdout, stderr, exit code, and any files or JSON the path produced. Unit tests alone are not proof. The feature map in [`features/README.md`](features/README.md) lists every entry point; read the file for the feature under test before driving it.

All paths below are relative to the checkout root. Run every command from there.

## End-user journey

Run the scripted journey before approving any change, and again with `--provider live` before a release:

```sh
npm run journey                       # stand-in provider: deterministic, no key, runs in CI
npm run journey -- --provider live    # real provider from the environment; adds outcome checks on its judgments
npm run journey -- --package @bmccarn/tracecheck@0.3.0   # the same journey against a published release
```

It packs the checkout and installs the tarball offline into a temporary prefix, as a user would, then works in a realistic TypeScript project with path aliases, a committed `.tracecheck.json`, and an uncommitted change that removes a divisor guard, removes JSON error handling, and renames a file. It drives `--help`, `preview`, `review` (JSON, Markdown, SARIF, progress, `--quiet`), a fix followed by `compare`, `verify` against local files, `assess --fail-on-priorities`, the missing-key and plain-HTTP errors, argument and input-file errors, an unwritable `--out`, a write that fails after the report is printed, Ctrl-C during a review, and then the four MCP tools through a real stdio client, including progress notifications, a cached repeat review, and a stale-snapshot rejection. It runs the installed `node_modules/.bin/tracecheck` shim and `npx --offline --package <tarball> tracecheck preview` in the project, and starts the MCP server exactly as `.mcp.json` and `mcp.json` specify, with no `--repo`, to check that a call without `repo` asks for one.

Separate small repositories cover outcomes beyond that path: a change the stand-in judges clean (through `--verdict`), a working tree with nothing to review, an untracked file and a reviewed-file edit made while a CLI review waits on a slow stand-in, an untracked file created between MCP preview and review, a file name and source containing terminal control sequences, a repository-local `core.fsmonitor` command, a settings file that tries to raise limits or enable untracked files, a review over `--max-requests`, and a `--base` branch that has moved on.

Every step has assertions and a kind:

- An **outcome** check asserts a result the user acts on: an exit code, a refusal, or a side effect that must not happen.
- A **plumbing** check shows that the parts connect and the output has the expected shape. The stand-in provider scripts every judgment, so offline these checks say nothing about review quality.
- A **known-issue** check asserts the correct outcome for an open issue and names the issue. Its failure prints `KNOWN` and does not fail the journey. When one passes, make it an outcome check.

With `--provider live`, two more outcome checks assert that both planted defects are supported, with the unfixed one still supported after the JSON fix, and that the review scores at least one quality dimension. Offline they are reported as skipped.

Evidence goes to `.tracecheck/journey/<timestamp>-<provider>/`: `JOURNEY.md` with the passed count per kind and a table of steps, `summary.json`, and one record per CLI command and MCP call. The script exits 1 when any outcome or plumbing check fails. In live mode it also fails if a key value appears in the evidence.

The script packs the current directory. To run the same journey against another commit's bundle, such as the base of a bug fix, extract that commit with `git archive`, run `npm ci` in the copy, and run this checkout's `journey.mjs` from the copy's root with `--out`.

When a change adds or alters a user-visible behavior, extend the journey with a step that asserts it, alongside the targeted proof below. Make it an outcome check when it asserts what the user relies on.

## Launch

1. Install and build the checkout under test: `npm ci && npm run build`. The build writes `dist/plugin.mjs`; source edits have no effect until it runs again.
2. Create the run's evidence directory. Evidence lives under the ignored `.tracecheck/` directory:
   ```sh
   RUN=.tracecheck/verify/$(date +%Y%m%d-%H%M%S)-<feature>
   mkdir -p "$RUN"
   ```
3. Create a disposable repository for any path that collects from Git: `node .agents/skills/verify-tracecheck/scripts/fixture-repo.mjs <scenario> > "$RUN/fixture.json"`. Run it with `--list` for the scenarios. The printed `root` is the repository to pass as `--repo`. Add a scenario to the script when none reproduces the behavior under test.

There is no long-running service. The CLI exits on its own, and `mcp-call.mjs` starts and closes its server for each run, so concurrent runs never share an instance.

## Doctor

Run `node .agents/skills/verify-tracecheck/scripts/doctor.mjs` first, and again whenever a result looks wrong. It is read-only and prints JSON:

- `ready: true` means the checkout, Node version, dependencies, Git, and a fresh, runnable bundle are all present. A `bundle-fresh: false` check means `npm run build` is needed; proof from a stale bundle is invalid.
- `live: true` means a provider key is set, so `review`, `verify`, `assess`, and the matching MCP tools can call Jev. It reports which variable names are set, the resolved base URL, and the model, never key values.

## Drive

Offline paths need no key: `preview`, `compare`, the MCP `tracecheck_preview` tool, and every argument or input error. Live paths need one of `JEV_API_KEY`, `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` in the environment. Pass keys only through the environment of the command, never as arguments, and never echo them or dump the environment.

- **CLI**: wrap each command in `capture.sh` so the proof is recorded:
  ```sh
  S=.agents/skills/verify-tracecheck/scripts
  $S/capture.sh "$RUN" preview -- node dist/plugin.mjs preview --repo "$ROOT" --json
  ```
- **MCP**: write the calls as JSON and run them through the real stdio server:
  ```sh
  echo '[{"tool":"tracecheck_preview","arguments":{}},{"tool":"tracecheck_review","arguments":{"snapshot":"$snapshot"}}]' > "$RUN/calls.json"
  node $S/mcp-call.mjs --out "$RUN/mcp" --repo "$ROOT" --calls "$RUN/calls.json"
  ```
  The server receives only `PATH`, `HOME`, provider variables, and variables named with `--env NAME`. `$snapshot` is replaced with the snapshot from the latest successful preview in the same run. A step `{"run": ["cmd", "arg", ...]}` runs a local command between tool calls in the same server session, for example to edit the fixture after a preview. `--list` records `tools/list`. `--progress` sends a progress token with every call and records the notifications under `progress` with their arrival time. Each call is saved as `NN-<tool>.json` with its arguments, `isError`, `structuredContent`, and text content; server stderr goes to `server-stderr.log`.

Drive every entry point the feature map lists for the behavior under test. A CLI run does not prove the MCP path, or the reverse.

## Evidence

A proof for one behavior contains:

- the fixture description (`fixture.json`) or the supplied input file,
- each command's `.cmd`, `.stdout`, `.stderr`, and `.exit` files, or the MCP call records,
- a short `$RUN/PROOF.md` that names the feature ID, the entry point, the expected observable result, and the observed result, quoting the decisive JSON fields.

Assert on observable output: report fields, exit codes, files written, and provider requests made (`usage.requests`, `models`). For a bug fix, run the same proof on the base commit's bundle and on the fix; the base must show the bug and the fix must not. A path that could not run (no key, provider error, missing capability) is reported as unverified with the attempted command and the reason.

## Cleanup

- Remove each fixture repository the run created: `rm -rf "$ROOT"` for the `root` printed in `fixture.json`. Fixtures live under the system temp directory with the prefix `tracecheck-verify-`.
- Keep `$RUN`. It is the proof, and `.tracecheck/` is ignored by Git, so it never enters a commit.

## Helpers

All helpers live in `.agents/skills/verify-tracecheck/scripts/` and are executable:

| Helper | Invocation | Output |
| --- | --- | --- |
| `journey.mjs` | `npm run journey -- [--provider stand-in\|live] [--no-install \| --package SPEC] [--out DIR]` | The end-user journey above; exit 1 when any outcome or plumbing check fails |
| `doctor.mjs` | `node $S/doctor.mjs` | Readiness JSON; exit 1 when not ready |
| `fixture-repo.mjs` | `node $S/fixture-repo.mjs <scenario>` or `--list` | JSON with `root`, `description`, and `changed` |
| `capture.sh` | `$S/capture.sh DIR NAME -- COMMAND...` | `NAME.cmd`, `.stdout`, `.stderr`, `.exit` in `DIR` |
| `stand-in-provider.mjs` | `node $S/stand-in-provider.mjs [--port N] [--latency-ms N] [--fail-path REGEX] [--fail-times N] [--verdict REGEX=STATUS]...`, started with `hub` | A loopback System One stand-in with fixed latency. A review candidate whose path matches the first matching `--verdict` gets STATUS (`supported`, `not_supported`, `needs_context`, or `uncertain`); others are `supported`. One JSON log line per request with its packet, in-flight count, and verdicts; `GET /stats` returns the request count |
| `mcp-call.mjs` | `node $S/mcp-call.mjs --out DIR [--repo PATH] [--env NAME]... [--progress] (--calls FILE \| --list)` | One JSON record per call, a summary on stdout, exit 1 if any call errored; `--progress` records each call's progress notifications |
| `scripts/build.mjs --check` | `node scripts/build.mjs --check` (repository script) | Exit 1 when `dist/plugin.mjs` differs from a fresh build; `dist/` is untouched |
