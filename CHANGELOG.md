# Changelog

## Unreleased

- Update CI and release workflows to SHA-pinned Node 24 actions, including supported setup-node cache controls, and pin runners to Ubuntu 24.04.

## 0.3.0-rc.2 — 2026-09-17

- Fix the release workflow's npm archive path: an explicit `./release/` prefix prevents npm 11.5.1 from interpreting the archive as a GitHub repository.
- Retain the immutable `v0.3.0-rc.1` tag; its release job failed before npm authentication or publication.

## 0.3.0-rc.1 — 2026-09-17

- Add agent-led hypothesis verification through `tracecheck_verify` and the `verify` CLI, including anchored evidence, counterevidence, and bounded follow-up.
- Replace the default fixed import-index cutoff with repository-wide discovery, configurable resource budgets, and a safely revalidated metadata/edge cache.
- Review all supported, safely readable changed files in bounded evidence packets; remove the global forty-candidate cutoff.
- Preserve independent packet quality assessments and expose packet scope, partial indexing coverage, and collection settings through CLI/MCP.
- Batch Git evidence reads, retaining path safety and per-file baseline limits without spawning Git for every changed file.
- Add regressions for cache freshness, path safety, packet evidence integrity, complete-change coverage, and request accounting.
- Run typechecks, tests, and offline package verification in CI on pushes and pull requests.
- Synchronize release versions and MCP server metadata; publish verified archives through protected tag-triggered npm trusted publishing.
- Separate prerelease npm/GitHub artifacts from the generated stable-only Claude/Codex marketplace.
- Document matching Cursor MCP and skill installation, credential handling, and native-client release gates.
- Exclude local client secrets, release staging files, diagnostics, and generated artifacts from Git and the npm payload.

## 0.2.0 — 2026-09-17

Initial public release.

- Review nineteen independent quality dimensions using Jev's Noul, Score, and Choice judgments.
- Collect bounded Git context and assess parser-anchored JS/TS concerns.
- Compare quality checkpoints and track source-finding history.
- Serve three MCP tools and provide CLI review, assessment, preview, and comparison commands.
- Include Claude Code and Codex plugin catalogs, a review skill, and a standalone npm runtime.
- Validate typed responses, report uncertainty and coverage gaps, and track request usage.

Current limits: source checks cover three JS/TS patterns; broad assessment accepts other languages through supplied context. Real-project calibration, complete caller graphs, and executable fix verification remain future work.
