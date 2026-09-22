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
  `$snapshot` is replaced with the snapshot from the latest successful preview in the same run. A step `{"run": ["cmd", "arg", ...]}` runs a local command between tool calls in the same server session, for example to edit the fixture after a preview. `--list` records `tools/list`. Each call is saved as `NN-<tool>.json` with its arguments, `isError`, `structuredContent`, and text content; server stderr goes to `server-stderr.log`.

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
| `doctor.mjs` | `node $S/doctor.mjs` | Readiness JSON; exit 1 when not ready |
| `fixture-repo.mjs` | `node $S/fixture-repo.mjs <scenario>` or `--list` | JSON with `root`, `description`, and `changed` |
| `capture.sh` | `$S/capture.sh DIR NAME -- COMMAND...` | `NAME.cmd`, `.stdout`, `.stderr`, `.exit` in `DIR` |
| `mcp-call.mjs` | `node $S/mcp-call.mjs --out DIR [--repo PATH] (--calls FILE \| --list)` | One JSON record per call, a summary on stdout, exit 1 if any call errored |
| `scripts/build.mjs --check` | `node scripts/build.mjs --check` (repository script) | Exit 1 when `dist/plugin.mjs` differs from a fresh build; `dist/` is untouched |
