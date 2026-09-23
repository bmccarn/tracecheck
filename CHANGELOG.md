# Changelog

## 0.4.0 — 2026-09-23

- Promote 0.4.0-rc.1 to the stable release. The 0.4.0-rc.1 entry below lists every change and its upgrade notes.
- `npm run journey` now stops when the package fails to install. It reports the install failure, writes its summary, and exits `1` instead of reporting dozens of failures in the steps that need the installed bundle.

## 0.4.0-rc.1 — 2026-09-23

### Upgrade notes

- A review with no supported findings and no coverage gaps now exits `0`. Permanent caveats, such as heuristic import discovery and the count of excluded untracked files, moved from `limitations` to a new `notes` field that never changes the status.
- A CLI review whose reviewed files change while it runs prints the report marked stale and exits `4`. Ctrl-C exits `130`.
- Decision gates changed after a labeled calibration against the live model (see `docs/calibration.md`). A source-check finding needs probability of at least 0.70 (was 0.80) and confidence of at least 0.60. A quality score needs evidence sufficiency of at least 0.5 (was 0.8) and score confidence of at least 0.4 (was 0.6). The policy and rubric versions are now 3, so `compare` and `--previous` do not compare new reports with 0.3.x reports.
- `--base` and the MCP `base` argument compare against the merge base of the named ref and `HEAD`. Reports record the requested ref in `baseRef`.
- A committed `.tracecheck.json` may only tighten defaults. Enabling untracked files, changing `base`, or raising limits, concurrency, or timeouts needs a flag or MCP argument, and the file is rejected with the offending keys named.
- A review refuses to start when preview estimates more than 50 provider requests. Raise the budget with `--max-requests` or the MCP `maxRequests` argument.
- `verify --repo` and `tracecheck_verify` with `repo` require a directory inside a Git working tree.
- `engines.node` is now `^22.18.0 || >=24.11.0`, the range the bundled Babel parser supports.

### Added

- Jev served through OpenRouter: set `OPENROUTER_API_KEY`, or point `TYPESAFE_BASE_URL` at another System One API base URL. A TypeSafe key still takes precedence.
- `review --sarif FILE` writes supported findings as SARIF 2.1.0, and `assess --fail-on-priorities` exits `1` when the evaluation lists actionable quality priorities.
- An optional `.tracecheck.json` project settings file for task, context, and limits below flags, MCP arguments, and environment variables.
- Preview reports an estimate of provider requests and input bytes, and review enforces the request budget before sending anything.
- `JEV_TIMEOUT_MS` sets the per-request timeout, and `JEV_CONCURRENCY` or `requestConcurrency` sets how many independent requests run at once (default 4).
- `tracecheck_review` sends progress notifications when the client supplies a progress token, and CLI `review` prints progress to stderr; `--quiet` silences it.
- Imports resolve through TypeScript `paths` and `baseUrl` settings in the nearest `tsconfig.json` or `jsconfig.json`, following `extends` only inside the repository.
- Markdown reports say which way an uncertain finding leaned and what a decision needs, and quality output states how many of the 19 dimensions were scored.

### Changed

- Independent review requests run concurrently. A five-packet review with one second of provider latency takes about 2.5 seconds instead of 5.5.
- A request that fails after retries yields an inconclusive report that keeps the completed decisions and names what was not evaluated.
- Concurrent identical `tracecheck_review` calls share one in-flight review, cache hits no longer re-collect the repository, and a server bound with `--repo` accepts subdirectories of its repository.
- Source-check selection skips sites that cannot be defects (non-zero literal divisors, catch handlers that rethrow, and `JSON.parse` inside a `try` block), stops selecting unchanged module-level code, and flags `/=` and `%=`.
- Related-file selection prefers callers and tests that use the changed functions, and excerpts focus on call sites of `const` and `let` arrow functions.
- `compare` matches models regardless of order, reports newly supported findings, and follows a finding into a renamed file.
- Partial reports count every packet in the header and list unevaluated work near the top.
- The bundle no longer includes `@babel/types` and is about 237 KB smaller.

### Fixed

- Renamed files keep their baseline, and pure renames produce no candidates.
- JSX in `.js`, `.mjs`, and `.cjs` files and decorators parse instead of producing a parse-failure limitation.
- Python imports written in parentheses, with commas, or with aliases link callers and tests. NodeNext module paths (`.mjs` to `.mts`, `.cjs` to `.cts`, `.jsx` to `.tsx`, directory `index` files) resolve, and unsupported files such as images no longer create import edges.
- Untracked files outside the review no longer invalidate a preview or review.
- Very large repositories collect: Git listings stream instead of buffering, and their timeouts follow the collection budget.
- Network failures calling Jev are retried and reported as `Jev request failed (network error)`, and timeouts name which limit fired.
- The context-limit error that OpenRouter relays is recognized and gives the same "split the review" guidance.
- Unknown refs, shallow clones, repositories with no commits, directories outside Git, and missing or unreadable evidence files give plain errors that name the input, without raw Git command lines or absolute paths.
- The CLI checks the provider key and output paths before collecting, prints the result before writing files, rejects unexpected positional arguments, and prints validation problems one line per field.
- A changed file whose committed version held a potential credential is reviewed without that baseline instead of being omitted.
- Preview notes staged changes that the working tree undoes, and staged renames that Git cannot pair.

### Security

- Collection ignores `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and similar variables that would redirect it to another repository, and every Git command sets `core.fsmonitor=false` and `core.hooksPath=/dev/null`. The README's security model explains which repository-local settings, such as clean filters, still run in a checkout that was not freshly cloned.
- Human-readable output shows control characters from paths, source, provider responses, and errors as visible escapes.
- Secret screening detects more credential shapes, including unquoted YAML, TOML, and `.env` values, padded base64, more private key blocks, common provider tokens, and passwords in URLs. It stops flagging identifier-like literals and names the file or field without the value.
- `TYPESAFE_BASE_URL` must use HTTPS unless it points to a loopback host, and must not contain credentials, a query, or a fragment.

### Development and release

- `npm run journey` installs the packed package and drives every CLI command and MCP tool through a realistic project, separating outcome checks from plumbing checks. CI runs it with a stand-in provider on Node 22.18.0 and 24.x.
- `npm run calibrate` runs a labeled live calibration of the decision gates and replays any threshold offline from recorded answers.
- CI fails when the committed bundle differs from a fresh build, runs the offline demo, and cancels superseded pull request runs. Dependabot keeps GitHub Actions and npm dependencies current. `npm run build` bundles only, and `npm run check` is the single type check.
- Both in-repo marketplace catalogs follow the current stable release, and the release gates fail when a catalog ref does not match.
- The npm package ships only runtime documentation. Babel 8.0.6 and `@types/node` 22.20.4 replace earlier patch versions.

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
