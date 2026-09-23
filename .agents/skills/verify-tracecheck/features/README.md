# Tracecheck verification map

This directory is the maintained source for verifying Tracecheck's user-facing behavior. Read this index, then use the matching feature file as the recipe. Keep a feature file current whenever its commands, inputs, or observable results change.

## Baseline preconditions

- The checkout under test is built (`npm ci && npm run build`) and `node .agents/skills/verify-tracecheck/scripts/doctor.mjs` reports `ready: true`.
- `S=.agents/skills/verify-tracecheck/scripts` and `RUN=.tracecheck/verify/<timestamp>-<feature>` are set, and `$RUN` exists.
- Repository-backed paths use a fresh fixture from `node $S/fixture-repo.mjs <scenario>`; `ROOT` is its printed `root`.
- Live paths have a provider key in the environment and `doctor.mjs` reports `live: true`.

## Driving conventions

- Run CLI commands through `$S/capture.sh "$RUN" <name> -- node dist/plugin.mjs ...`.
- Run MCP tools through `node $S/mcp-call.mjs --out "$RUN/mcp" [--repo "$ROOT"] --calls "$RUN/calls.json"`.
- Use `--json` on CLI commands whose assertions read fields. The default output is human-readable Markdown.
- CLI exit codes are part of the contract: `0` no findings or success, `1` needs attention (review findings or quality priorities, a supported verify hypothesis, or assess priorities with `--fail-on-priorities`), `2` error, `3` inconclusive. `node dist/plugin.mjs --help` lists every flag per command.
- Start each recipe from a fresh fixture. Fixtures are disposable; the evidence in `$RUN` is kept.

## Proof and skip reporting

- CLI proof is the `.cmd`, `.stdout`, `.stderr`, and `.exit` files. MCP proof is the `NN-<tool>.json` records plus `server-stderr.log`.
- Record the feature ID and entry point in `$RUN/PROOF.md` with the decisive JSON fields quoted.
- A live path that could not run is reported as unverified, with the attempted command and the reason.
- A CLI proof does not verify the MCP entry point, and the reverse.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, followed by exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with capture.sh and mcp-call.mjs`, and `Gotchas`.

## Journey coverage

`scripts/journey.mjs` drives one realistic path through preview, review, compare, verify, assess, provider errors, and all four MCP tools. It proves those features work together for a typical user. A feature file below is still the recipe for exercising a feature's other entry points and edge cases.

## Features

- [Preview](./preview.md): local collection of change packets, sources, candidates, and coverage gaps. Offline.
- [Review](./review.md): repository review with source-check decisions and per-packet quality, plus report comparison. Live.
- [Verify](./verify.md): verification of one agent-supplied defect hypothesis against quoted evidence. Live.
- [Assess](./assess.md): quality assessment of caller-supplied task and files, with previous-evaluation comparison. Live.
- [Provider configuration](./provider-configuration.md): key, endpoint, model, timeout, and request concurrency for TypeSafe and OpenRouter. Live and offline, including a loopback stand-in provider.
- [Project configuration](./project-configuration.md): `.tracecheck.json` defaults for preview and review, their precedence, validation, and snapshot effect. Offline, plus one live review.
- [Marketplace catalogs](./marketplace-catalogs.md): in-repo catalog refs kept on the stable release tag by release preparation and the release gates, and installation from them. Offline, except that installation clones from GitHub.
