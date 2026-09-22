# Changelog

## Unreleased

- Support Jev served through OpenRouter. Set `OPENROUTER_API_KEY`, or point `TYPESAFE_BASE_URL` at `https://openrouter.ai/api` with an OpenRouter key in `TYPESAFE_API_KEY`. A TypeSafe key still takes precedence.
- Add `TYPESAFE_BASE_URL` to select any System One API base URL. Tracecheck rejects plain-HTTP remote hosts and URLs that contain credentials, a query, or a fragment.
- The MCP review cache now keys reports by endpoint as well as model.
- Recognize the context-limit error that OpenRouter relays from TypeSafe, so over-limit requests get the same "split the review" guidance.
- Link Python callers and tests through parenthesized, comma-separated, and aliased imports.
- Resolve NodeNext module paths (`.mjs` to `.mts`, `.cjs` to `.cts`, `.jsx` to `.tsx`, and directory `index` files), and stop creating edges to unsupported files such as images.
- Point both in-repo marketplace catalogs at the current stable release, update them during release preparation, and fail the release gates when a catalog ref does not match.
- Build only the bundle in `npm run build`, type-check once with `npm run check`, and stop emitting unused JavaScript and declaration files into `dist/`.
- CI now tests on Node 22.18.0 and the current LTS release, fails when the committed bundle differs from a fresh build, runs the offline demo, and cancels superseded pull request runs. `engines.node` now matches the bundled Babel range (`^22.18.0 || >=24.11.0`).
- Parse JSX in `.js`, `.mjs`, and `.cjs` files and decorators in JavaScript and TypeScript, so these files get source checks instead of a parse-failure limitation.
- Skip source-check candidates that cannot be defects (non-zero literal divisors, catch handlers that rethrow, and `JSON.parse` inside a `try` block), stop selecting unchanged module-level code, and flag `/=` and `%=`.
- Retry network failures when calling Jev, and report `Jev request failed (network error)` after the last attempt instead of `fetch failed`.
- Add `JEV_TIMEOUT_MS` for the per-request timeout, and name the limit and its duration when a request, review, or verification times out.
- Keep the baseline of renamed files: a renamed and edited file is reviewed against the old path's content, pure renames produce no changed ranges or candidates, and renames across unsupported paths are reported.
- MCP review cache hits no longer re-collect the repository, cache eviction keeps live entries, and a previous evaluation that cannot be compared always adds a limitation.
- `compare` matches models regardless of order and reports newly supported findings.
- `tracecheck_assess` has a bounded timeout and honors client cancellation, CLI `assess` stops on Ctrl-C, `tracecheck_verify` limits evidence by UTF-8 bytes, and the `previousEvaluation` input schema is smaller.
- Focus related-file excerpts on call sites of `const` and `let` arrow functions and function expressions, and match symbol names that contain `$`.
- Detect more credential shapes (unquoted YAML, TOML, and `.env` values, padded base64, PGP, DSA, and encrypted private keys, common provider tokens, and passwords in URLs), stop flagging identifier-like literals, and name the file or field that triggered screening without its value.
- Read optional project settings from `.tracecheck.json` (base, untracked files, task and context, collection limits, timeouts, and model), below flags, MCP arguments, and environment variables. Unknown keys and credential fields are rejected by name.
- Candidate selection no longer bundles `@babel/types` (the bundle is about 237 KB smaller), walks syntax trees with one ancestor stack, and now checks decorator arguments on TypeScript parameter properties.
- Resolve imports through TypeScript `paths` and `baseUrl` settings from the nearest `tsconfig.json` or `jsconfig.json`, following `extends` only inside the repository, and report configs that cannot be read or parsed.
- Add `review --sarif FILE`, which writes supported findings as SARIF 2.1.0 for code-scanning tools.
- Add `assess --fail-on-priorities`, which exits 1 when the evaluation lists actionable quality priorities.
- `--help` lists every flag and exit code, and `--previous` accepts either a saved review report or an assess evaluation for both `review` and `assess`.

## 0.3.0 — 2026-09-18

- Promote agent-led verification, four-tool MCP integration, and scalable evidence collection to the stable release.
- Distribute the matching skill and bundled runtime through the release-only Claude Code and Codex marketplace for native installation.
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
