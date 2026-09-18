# Validation

## Stable 0.3.0 preparation — September 18, 2026

- `npm run release:check` passes all 82 tests, type-checking, builds, synchronized metadata, and offline CLI/four-tool MCP checks for the actual `0.3.0` npm and marketplace archives. The tagged release gate selects `latest`. Workflow lint passes; primary LSP checks confirm all five updated metadata files with no diagnostics.
- The owner requested stable promotion with the previously recorded native-agent authentication and Cursor UI limitations still explicit. Publication must populate the release-only marketplace before its remote native-install commands are usable; preparation checks do not claim that remote publication or installation has already occurred.

## Candidate publication-path repair — September 17, 2026

- The `v0.3.0-rc.1` release failed before npm authentication: npm 11.5.1 parsed `release/bmccarn-tracecheck-0.3.0-rc.1.tgz` as a GitHub repository. The same failure reproduces locally with the pinned npm version and `--dry-run`.
- Prefixing the archive with `./` resolves it as a local file. The repaired workflow's actual publication shell block, run with npm 11.5.1 and a temporary wrapper that appends `--dry-run --json`, selects `@bmccarn/tracecheck@0.3.0-rc.2`, includes all 18 files, and succeeds with the production provenance flag. This verifies path handling, not OIDC authentication or registry publication.
- `npm run release:check` still passes all 82 tests, builds, metadata gates, offline CLI, and four MCP tools. Workflow lint passes; primary LSP checks confirm all six changed workflow/metadata files with no diagnostics.
- The failed `v0.3.0-rc.1` tag is preserved. The repair uses a new `0.3.0-rc.2` candidate; runtime logic is unchanged apart from synchronized version metadata. Temporary smoke fixtures were removed.

## Release preparation and native installation — September 17, 2026

- `npm run release:check` passes: 82 tests, type-checking, builds, synchronized metadata, actual npm/marketplace archives, offline CLI, and all four MCP tools. MCP initialization reports `0.3.0-rc.1`. No Jev request is made by this release check.
- Primary language-server diagnostics confirm zero errors, warnings, information, or hints in all 35 changed source, test, script, JSON, and workflow files. `actionlint` passes both workflows.
- Fresh, isolated Claude Code and Codex profiles install the extracted candidate marketplace and enable Tracecheck `0.3.0-rc.1`. Both installed payloads contain the complete skill and its reference. Claude's native MCP health check connects; an SDK client using Codex's resolved transport connects and enumerates all four tools at the matching version.
- Genuine registry `@bmccarn/tracecheck@0.2.0` upgrades to the candidate through native Claude `plugin update` and Codex `plugin add` in isolated profiles. Claude lists the skill and MCP server; Codex enables the new cached version. The installed runtime exposes four tools and returns actionable missing-key guidance naming both supported environment variables.
- A live synthetic `tracecheck_verify` call through the installed candidate runtime succeeds with caller-supplied provenance and `jev-1.13.0`. The zero-divisor concern remains inconclusive/uncertain, with a supported choice probability of 0.66 but confidence 0.49 and `gather_evidence` as the next action. This proves live integration, not a confirmed defect or accuracy estimate.
- Cursor's documented whole-directory skill copy succeeds twice without nesting a duplicate directory. Cursor editor discovery remains untested. Full native-agent turns in the isolated profiles require authentication: Claude reported not logged in; Codex returned missing bearer/basic authentication. No real client auth was copied or configured. These interactive checks remain stable-promotion gates.
- The workflow's marketplace publication body, with only its Git remote replaced by a disposable local bare repository, handles an empty repository and a repeated publication. The repeated run is a no-op and preserves unrelated content. This does not test GitHub SSH authorization or npm OIDC.
- A marketplace `dist/` ignore rule reproduced a successful publication missing its executable before the force-staging fix. After the fix, the executable is committed, unrelated content survives, and repeating publication creates no extra commit.
- Injected rename failures during preparation and rollback leave all five recovery backups intact, remove temporary `.next` files, and report the recovery filename pattern plus the underlying filesystem error. UUID-qualified staging names avoid reusing a prior process's backups.
- Actual Git-tag fixtures verify that a `0.3.0` stable tag blocks publishing `0.2.1`, permits `0.3.1`, and does not block a prerelease candidate. Prerelease tags do not block older stable versions, and no-tag metadata checks work without a Git repository.
- Ignore checks exclude local credentials, Cursor configuration, release/diagnostic artifacts, and interrupted version-preparation files while retaining distributable manifests, the bundle, the complete skill, and `.env.example`.
- GitHub API checks confirm the protected `release` environment, `v*` tag policy, required owner approval, marketplace repository variable, environment-scoped deploy-key secret, and marketplace-only writable deploy key. The account owner subsequently confirmed npm trusted-publisher setup. No candidate or stable publication occurred during these checks; OIDC remains unverified until the authorized release run.

Earlier checkpoints below retain their original test counts and measurements.

## Scalable collection and scoped review — September 17, 2026

- `npm run validate`: 73 tests pass; type-checking and compiled/standalone builds pass. Primary language-server checks confirm no diagnostics in the 22 changed source, test, example, and benchmark files.
- Markdown language-server checks returned no findings but could not confirm clean results for six documentation files; these push-only-server results are not counted as confirmed clean.
- `npm run package:check`: the actual npm and marketplace archives pass offline CLI and all four MCP tool checks. This package check makes no Jev requests.
- A disposable repository with 50,065 tracked small TypeScript files and 64 changed files produced eight bounded packets and all 64 candidates, retained a distant caller, and preserved the warm snapshot. The compiled CLI preview also covered all 64 changes. With default collection budgets, the final run took 5,076 ms with a cold import cache and 2,286 ms warm. Before batched Git reads, the same synthetic workload took 45,034 ms cold and 42,118 ms warm. These are individual measurements on one Apple M3 Ultra workstation, not disk-cold or general repository latency guarantees; the final fixture disabled automatic Git maintenance.
- With a deliberately short 25 ms discovery deadline, preview completed a 160-file prefix while an independent warm scan reached 368 files. Pinned recollection retained the original snapshot. Actual live CLI and MCP reviews succeeded across that boundary, and a real source edit still changed the snapshot. An emptied file also received a live assessment using its baseline evidence.
- A live nine-file, two-packet CLI review used two requests, 37,011 input tokens, and 5,167 output tokens; the review stage took 1,086 ms. Five of six labeled synthetic cases matched expectations. The empty-average defect remained uncertain, and none of the three clean counterparts was reported as supported. Thresholds were not relaxed. This verifies integration and preserves the known abstention; it does not estimate real-world accuracy.
- An isolated agent exercised the primary verification loop on a fresh RapidRegs CSV-rendering concern: two live, locally anchored Jev checkpoints plus follow-up investigation and an isolated execution of the exact renderer. The conclusion remained an unresolved conditional risk, not a confirmed defect. A malformed evidence excerpt was rejected before inference. See [the real agent-loop record](agent-evaluation.md#isolated-rapidregs-loop--september-17-2026) for timings, scope, and limitations.

Collection still has explicit coverage gaps: unsupported or unsafe files, bounded excerpts, heuristic import resolution, and soft-deadline omissions. Overall collection/review deadlines fail closed rather than returning an apparently complete result after cancellation. Packet assessments are not averaged into a repository-wide grade. The primary agent-selected verification flow remains agent investigation → Jev assessment → agent follow-up.

The milestone entries below are historical checkpoints, not current test counts.

## Agent-first verification milestone

- 41 tests cover the new language-independent verification path, quote and source validation, stale evidence rejection, bound-repository MCP behavior, and paired benchmark scoring.
- A live RapidRegs verification through the new CLI rejected a known repaired concern with locally checked evidence. This is an integration check, not a fresh accuracy estimate; see [agent evaluation](agent-evaluation.md).
- The standalone runtime now exposes four MCP tools. Published v0.2.0 still exposes the earlier three-tool interface.

## Unreleased evidence milestone — September 17, 2026

- `npm run validate`: 35 tests pass, including bounded collection, original-line anchors, root isolation, cancellation, provider response limits, manual-context secret screening, split evidence gating, cache comparison reuse, and mid-review edit rejection.
- Broad review now asks 76 questions once; the 23-candidate batching test checks 96, 20, and 6 questions.
- The RapidRegs harness checks 24 labels across six families with executable local oracles. A 48-request live run measured both full and function-centered packets; [results and limitations](accuracy.md) include the observed recall regression with smaller packets.
- Actual RapidRegs collection and a live 19-dimension review completed. The review was inconclusive; no automatic Python source checks or credible quality scores were produced.
- RapidRegs remained unmodified. Raw source-bearing records stay in ignored `.tracecheck/`.

The entries below record earlier releases and are not measurements of the current rubric.

---

## Historical Tracecheck 0.2

## Current checks

- `npm run validate`: 26 tests passed; source, examples, and tests type-check; compiled and standalone builds pass.
- All nineteen baseline dimension keys and the four conditional dimensions are regression-tested.
- Noul, Score, and Choice validation, score normalization, uncertainty, high-score concern preservation, comparisons, and locally retained previous evaluations are tested.
- A 23-candidate fixture uses three calls with question counts 77, 20, and 6: the 57 broad questions run once, sharing the first source batch.
- The standalone bundle serves MCP after being copied outside the checkout without `node_modules`.
- Codex plugin validation, skill validation, Claude strict manifest validation, and portable plugin discovery pass.
- `npm pack --dry-run` includes the runtime, skill, and all manifests without credentials or local run records.

## Live combined review

The standalone MCP server returned all 19 dimensions and a parser-anchored finding from jev-1.13.0. Quality and source findings shared **one request**, with 13678 input tokens and 1896 output tokens. The measured review stage was 621 ms. Repeating the call verified a cache hit with the same report ID.

The very small fixture left many dimensions uncertain or unassessed. Receiving 19 well-typed decisions verifies coverage and integration, not the correctness of every judgment. No universal latency or accuracy claim follows from one request.

## Live language-agnostic review

The supplied-context MCP tool assessed synthetic Python before and after a JSON handling repair, without repository access. Both responses contained all 19 dimensions. The previous assessment was accepted for local comparison. Before-repair correctness applicability was uncertain (0.73); after-repair applicability was 0.91, with a score of 8.6 and confidence 0.73. Consequently no numeric correctness improvement was asserted. The comparison math and eligible-pair behavior are covered by deterministic tests.

Live raw records: `.tracecheck/mcp-live-v2.json` and `.tracecheck/quality-live-v2.json` (ignored local files). The earlier six-case source-check benchmark remains a small synthetic smoke benchmark; its accuracy should not be generalized to the new broad layer.

## Boundaries

The package is prepared and validated, but it has not been installed and exercised in every native agent app. Real-PR quality calibration, complete caller graphs, broader parser checks, and executable fix verification remain outstanding improvements.

---

## Historical v0.1 validation — September 17, 2026

## Local checks

`npm run validate` passed: source, tests, and examples type-check; all 14 automated tests pass; production compilation succeeds. The test suite includes a real MCP v2 SDK client/server exchange over stdio.

## Live Jev smoke benchmark

The existing `TYPESAFE_API_KEY` environment variable was used through an interactive zsh session. No credentials were saved in this project. Only synthetic fixture code was transmitted.

`jev-latest` resolved to **jev-1.13.0**. Five of six labeled cases matched expectations. Two of three defects were supported; the empty-average defect was uncertain. All three clean counterparts were not supported. There were no false positives in this six-case sample. These results do not estimate real-world accuracy.

| Fixture | Expected | Observed | Review stage ms |
| --- | --- | --- | --- |
| average-empty | supported | uncertain | 778 |
| average-guarded | not_supported | not_supported | 142 |
| save-swallowed | supported | supported | 146 |
| save-rethrows | not_supported | not_supported | 193 |
| json-boundary | supported | supported | 222 |
| json-throws-by-contract | not_supported | not_supported | 159 |

Thresholds were not relaxed to turn the uncertain result into a pass. This remains an explicit open evaluation case.

## Live MCP path

A compiled Tracecheck MCP server reviewed a temporary Git repository containing a synthetic JSON parsing regression. A real SDK client invoked preview, passed the captured snapshot token to review, received a schema-valid supported finding from Jev, then repeated the request and verified a cache hit with the identical report ID.

The live review stage took 388 ms. The finding retained confidence 0.92 and selected probability 0.94; impact remained unknown because its confidence was only 0.28. This verifies support and impact are handled separately.

Raw local run records are retained under ignored `.tracecheck/benchmark-live.json` and `.tracecheck/mcp-live-smoke.json`. Future benchmark runs also retain per-candidate decisions and raw distributions. Run `npm run benchmark -- --live` and `npm run smoke -- --live` to repeat with synthetic inputs.
