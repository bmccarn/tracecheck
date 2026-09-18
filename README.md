<div align="center">

# Tracecheck

**Independent evidence checks for coding agents, powered by Jev.**

Your agent investigates the code. Tracecheck checks its hypotheses against the evidence.

[![Powered by Jev](https://img.shields.io/badge/Powered_by-Jev-6D5EF5?style=for-the-badge)](https://typesafe.ai)
[![MCP stdio](https://img.shields.io/badge/MCP-stdio-111827?style=for-the-badge)](#mcp-and-agent-setup)
[![Node.js 22.18+](https://img.shields.io/badge/Node.js-22.18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Agent setup](#mcp-and-agent-setup) · [Quality dimensions](#quality-dimensions) · [Distribution](#distribution) · [Roadmap](#roadmap)

</div>

Tracecheck helps your coding agent challenge suspected defects against source evidence. The agent discovers concerns, follows callers, checks contracts and counterevidence, and decides what to fix. Tracecheck validates references and asks Jev for typed support, impact, and missing-evidence judgments. Optional broad assessments cover 19 quality dimensions and local checkpoint comparisons.

Run it as a **local MCP server** or use the **CLI** directly. Live assessments send code context to TypeSafe using your API key. Tracecheck has no hosted application backend and does not edit or execute the code being reviewed.

> **Status:** Working implementation with automated tests and live Jev/MCP validation. Real-project accuracy calibration, broader source checks, and executable fix verification are in progress or planned. See [validation evidence](docs/validation.md) for what has actually been tested.

## What you get

| Capability | What it provides |
| --- | --- |
| **19 independent quality dimensions** | Separate relevance and evidence sufficiency, 1–10 scores, confidence, selected concerns, and suggested next steps. No blended overall grade. |
| **Agent-selected hypothesis verification** | Any language; exact source quotes, optional local-file validation, and independent support/impact judgments. |
| **Repository context** | Git changes and baseline source, bounded JS/TS and Python import discovery, callers, and related tests. |
| **Checkpoint comparisons** | Eligible quality deltas and finding history, without treating a missing finding as a verified fix. |
| **Explicit uncertainty** | Missing context, uncertain judgments, and omitted files remain visible. |
| **Agent and CLI workflows** | Four MCP tools, a continuous-review skill, readable terminal output, and JSON reports. |
| **Bounded requests** | Context budgets, provider deadlines and retries, usage accounting, and a short-lived MCP review cache. |

## Why Jev

[Jev](https://typesafe.ai) specializes in focused, typed judgments. Tracecheck uses its three [question primitives](https://docs.typesafe.ai/primitives) to turn a review into decisions that code can validate and compare:

| Primitive | Used for |
| --- | --- |
| **Noul** | Whether a quality dimension is relevant and sufficiently supported by the available context. |
| **Score** | An ordered quality assessment, normalized to a 1–10 scale. |
| **Choice** | Selecting a concern or classifying a source finding's support and potential impact. |

Independent questions can share a request and its source context. Tracecheck shares broad and source-check questions when the serialized request fits; otherwise it reduces candidate batches or splits independent broad questions without dropping source evidence. All requests are size-checked before inference begins. Empty evidence triggers no provider request. Typed responses support schema validation, explicit uncertainty, and automated comparisons without parsing a review essay.

The division of work is deliberate: code extracts locations and computes comparisons; Jev supplies semantic judgments; the coding agent decides how to improve the implementation. Jev does not generate patches or prove that a fix works. Its [confidence signals](https://docs.typesafe.ai/confidence) still need calibration against representative review cases.

## Quick start

### Requirements

- **Node.js 22.18 or newer** and npm.
- A Jev API key from the [TypeSafe console](https://console.typesafe.ai) for live assessments.
- Git and a repository with at least one commit for automatic collection. Supplied-context assessment does not require Git.

### Build and configure

Clone and build:

```sh
git clone https://github.com/bmccarn/tracecheck.git
cd tracecheck
npm ci
npm run build

# Set one of these in the environment that launches Tracecheck.
export TYPESAFE_API_KEY="your-key"
# JEV_API_KEY is also supported and takes precedence if both are set.
```

The built `dist/plugin.mjs` includes its runtime dependencies and can run without `node_modules`. You can also use the npm CLI or install the plugin directly from GitHub; see [distribution](#distribution).

Try the scripted example without an API call:

```sh
npm run demo
```

This demo uses simulated decisions to illustrate source-finding output. For a real assessment, review a repository containing changes:

```sh
# Inspect the files and coverage gaps locally. No API key needed.
node dist/plugin.mjs preview --repo /path/to/repo \
  --task 'Return null for invalid JSON while preserving valid-input behavior'

# Send the collected context to Jev and save the report.
node dist/plugin.mjs review --repo /path/to/repo \
  --task 'Return null for invalid JSON while preserving valid-input behavior' \
  --out .tracecheck/before.json
```

Paths to the runtime above are relative to the Tracecheck checkout. `--repo` selects the repository being reviewed; report paths are relative to your current directory.

By default, collection compares **HEAD with the working tree**, including staged and unstaged tracked changes. Use `--base COMMIT` for another baseline and `--include-untracked` to include supported new files. Already committed changes need an earlier baseline to appear in the review.

## How it works

```mermaid
flowchart TD
    A[Agent inspects change and contracts] --> B[Agent records hypothesis and provisional verdict]
    B --> C[Agent gathers supporting and contradicting evidence]
    C --> D[Tracecheck validates references and freshness]
    D --> E[Jev judges support, impact, and missing evidence]
    E --> F[Agent investigates disagreement or uncertainty]
    F --> C
    F --> G[Agent decides, repairs, and runs project checks]
    G --> H[Final findings and remaining uncertainty]
```

1. **Investigate as the agent.** Discover concrete concerns, record a provisional verdict, and gather relevant implementation, contracts, callers, tests, and counterevidence.
2. **Verify a hypothesis.** Use `tracecheck_verify` with exact source excerpts and original line references. Optional local source validation rejects stale or fabricated excerpts. Jev returns an independent judgment, not a patch or proof.
3. **Optionally assess broader quality.** The broad layer considers all 19 dimensions. The source layer evaluates specific parser-derived hypotheses where supported.
4. **Validate and qualify the result.** Responses are checked against their expected types. Scores and findings retain confidence, applicability, and coverage limitations.
5. **Compare locally.** Previous assessments are used for comparison, not sent to Jev as evidence about the current implementation.
6. **Investigate disagreement and act.** Investigate findings, make justified changes, run normal project checks, and review another checkpoint. Avoid changing code solely to raise a score.

For MCP repository reviews, preview produces a snapshot token. Review recollects the context and rejects a mismatched token if code, requirements, or supplied context changed. Repository reviews also recollect after inference and reject changes made during the request. CLI `review` collects its own current context and does not require a prior preview token.

MCP preview tokens belong to the current server process and expire after five minutes or bounded-cache eviction. Repeat preview if the token is unavailable. A time-limited preview pins its completed discovery scope for review and freshness checks, so a faster warm scan cannot masquerade as a repository edit.

## Quality dimensions

These 15 dimensions are considered whenever the supplied evidence permits:

| Dimension | Focus |
| --- | --- |
| Correctness | Requirements, edge cases, invariants, and regressions. |
| Cognitive complexity | Control flow, state, and unnecessary indirection. |
| Readability | Names, intent, expression clarity, and explanation. |
| Modularity | Cohesive responsibilities and useful boundaries. |
| Coupling | Dependency direction, hidden inputs, and exposed internals. |
| Changeability | Scattered decisions and cascading edits. |
| Abstraction and API design | Useful interfaces and appropriate generality. |
| Project structure | Discoverability and placement of related behavior. |
| Duplication and reuse | Repeated knowledge and appropriate sharing. |
| Maintainability | Effort to understand, diagnose, and modify code. |
| Testability and test quality | Meaningful assertions, regression protection, and repeatability. |
| Reliability | Failure handling, cleanup, retries, and concurrency. |
| Security | Relevant trust boundaries and exposure. |
| Consistency | Alignment with established project conventions. |
| Documentation | Contracts, usage, and non-obvious decisions. |

Four additional dimensions depend on the problem's context:

| Dimension | Relevant evidence |
| --- | --- |
| Performance | Workload characteristics and cost-sensitive paths. |
| Scalability | Growth requirements and scaling constraints. |
| Compatibility | Existing consumers and compatibility contracts. |
| Observability | Operational needs and diagnostic behavior. |

Insufficient evidence can leave a dimension unscored; uncertainty is not a failing grade. Each dimension has a selected concern, and up to five actionable concerns are prioritized. A high score does not hide an independently actionable concern. These broad signals are distinct from findings with exact source locations.

## Review workflows

### Verify a specific concern

The primary agent workflow is documented with a complete JSON example in [tool usage](skills/tracecheck/references/tool-usage.md#focused-hypothesis-verification-primary-path). Save the agent-selected hypothesis, contract, evidence, and target quote in `evidence.json`, then run:

```sh
node dist/plugin.mjs verify --input evidence.json --repo /path/to/project \
  --out .tracecheck/verification.json
```

The agent chooses what to investigate. Tracecheck checks exact quotes and original line ranges, optionally matches excerpts to local files before and after inference, and returns a typed decision. Supplied-only evidence is explicitly labeled as such. Missing-evidence categories guide further investigation; they do not retrieve files automatically. Verification accepts any language without a parser rule.

### Compare implementation checkpoints

After addressing a concern, run another review with the same task and baseline:

```sh
node dist/plugin.mjs review --repo /path/to/repo \
  --task 'Return null for invalid JSON while preserving valid-input behavior' \
  --previous .tracecheck/before.json --out .tracecheck/after.json

# Compare source-finding identities separately from quality deltas.
node dist/plugin.mjs compare \
  --previous .tracecheck/before.json --current .tracecheck/after.json
```

Keep the baseline fixed across commits by passing the same commit SHA with `--base` to both reviews. Quality comparisons require matching scope, model, and rubric; uncertain pairs do not produce numeric improvement claims. Source history additionally checks repository, baseline, and policy compatibility.

A single-packet repository review returns `report.quality`. Larger changes return `report.packetQualities`, with the changed paths and assessment for each packet; these scores are not averaged into a repository-wide grade. Previous-quality comparison is supported only for single-packet repository reviews. Source-finding history still uses the combined decisions.

Source findings can be `still_present`, `no_longer_supported`, `unresolved`, or `not_reassessed`. None of these means a fix has been executed and verified.

### Supply context directly

Use `assess` for focused snippets, remote code, non-Git work, or any language. Save this as `context.json`:

```json
{
  "task": "Return null for invalid JSON without changing valid-input behavior.",
  "files": [
    {
      "path": "src/decode.py",
      "content": "import json\n\ndef decode(value):\n    return json.loads(value)\n"
    }
  ],
  "repositoryContext": "The caller expects invalid JSON to produce None rather than an exception.",
  "scope": "example/decode"
}
```

```sh
node dist/plugin.mjs assess --input context.json --out quality-before.json

# After updating the supplied source:
node dist/plugin.mjs assess --input revised-context.json \
  --previous quality-before.json --out quality-after.json
```

A `diff` string is also supported. At least one current context field is required. Use a stable `scope` to identify the same review subject across checkpoints. `assess` evaluates only what you provide and performs no repository reads or parser-based source checks.

### CLI options and exit codes

| Option | Purpose |
| --- | --- |
| `--repo PATH` | Repository to collect; CLI preview/review default to the current directory. |
| `--base REF` | Git baseline; defaults to `HEAD`. |
| `--include-untracked` | Include supported, non-ignored untracked files. |
| `--task TEXT` | Requested behavior or acceptance criteria. |
| `--context TEXT` | Relevant repository facts, contracts, or observed test results. |
| `--json` | Emit full JSON for preview, review, or assess. |
| `--out FILE` | Save a review report or quality assessment as JSON. |
| `--previous FILE` | Previous repository report for review; previous quality assessment for assess. |
| `--index-max-files N` | Optional local import-index file budget; unset by default. |
| `--index-max-bytes N` | Optional local import-index byte budget; unset by default. |
| `--index-timeout-ms N` | Soft discovery deadline; defaults to 20,000 ms and reports partial coverage. |
| `--collection-timeout-ms N` | Collection deadline; defaults to 120,000 ms. |
| `--review-timeout-ms N` | Review deadline; defaults to 300,000 ms. |

Repository `review` uses these exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No actionable concerns in the performed review. |
| `1` | Concerns need investigation. |
| `2` | Execution or input error. |
| `3` | Inconclusive because of uncertainty or coverage gaps. |

A zero exit does not prove correctness. `assess` returns quality signals without a score-based failure gate. Use `--help` for command syntax.

## Install the plugin

After Tracecheck `0.3.0` is published, install the matching skill and four-tool MCP runtime through the stable marketplace:

**Claude Code**

```text
/plugin marketplace add bmccarn/tracecheck-plugins
/plugin install tracecheck@tracecheck-plugins
```

Invoke `/tracecheck:tracecheck` to start the review workflow.

**Codex**

```sh
codex plugin marketplace add bmccarn/tracecheck-plugins
codex plugin add tracecheck@tracecheck-plugins
```

Start a new task and ask to use the Tracecheck skill. Both installations require Node.js 22.18+ and a Jev key in the launching environment. The release-only marketplace becomes available only when the stable `0.3.0` publication has populated it from the verified release artifact. For local-bundle development and prepublication installation, follow the [publishing guide](docs/publishing.md#prerelease-local-bundle-installation).

Existing installations from `bmccarn/tracecheck` remain pinned to historical `v0.2.0`. Re-register against the release-only marketplace after stable `0.3.0` publication to receive the newer runtime and skill together.

## MCP and agent setup

Tracecheck uses the **MCP v2 SDK over stdio** and exposes four tools:

| Tool | Input and behavior |
| --- | --- |
| `tracecheck_verify` | Verify an agent-selected hypothesis, contract, and source evidence; return uncertainty and a missing-evidence category. |
| `tracecheck_preview` | Collect a repository locally and return its manifest, limitations, candidate count, and snapshot token. |
| `tracecheck_review` | Review that snapshot with Jev; optionally compare a supplied `previousEvaluation`. |
| `tracecheck_assess` | Assess caller-supplied context in any language, with optional previous-evaluation comparison. |

Configure your MCP client with:

| Setting | Value |
| --- | --- |
| Command | `node` |
| Arguments | `/absolute/path/to/tracecheck/dist/plugin.mjs`, `mcp` |
| Environment | Forward `TYPESAFE_API_KEY` or `JEV_API_KEY`; optionally `JEV_MODEL`. |

Append `--repo`, `/absolute/path/to/reviewed/repo` to bind the server to one repository. Otherwise, collection-tool calls must provide `repo`. GUI applications may not inherit variables exported in `.zshrc`; use your client's environment configuration.

The package includes portable plugin manifests, Codex and Claude compatibility adapters, and a [continuous-review skill](skills/tracecheck/SKILL.md). The Claude and Codex plugin paths above remain native client installations. [Configure Cursor manually with its MCP entry and a copied complete skill directory](docs/integrations.md#cursor-manual-mcp--skill); npm installation alone registers neither for Cursor. The skill supplies the review cadence; adding the MCP server alone only exposes its tools.

A useful first instruction to your agent:

> Use Tracecheck after meaningful implementation checkpoints. Investigate the code, identify concrete concerns, and collect supporting and contradicting evidence. Verify each material hypothesis, investigate disagreements, and run the project's checks. Report your final judgment and remaining uncertainty.

MCP protocol and packaging have been validated; installation in every native client has not. The standalone bundle needs Node.js, but no separate runtime dependency installation.

## Distribution

Tracecheck packages the MCP server and review skill together for Claude Code and Codex. The same standalone runtime also provides the npm CLI.

```sh
npm run package:check
```

This builds and verifies an npm tarball and a marketplace bundle for both clients in `release/`. The packaged CLI and MCP handshake are tested through offline `npm exec`, outside the checkout.

### Stable target: 0.3.0

After `0.3.0` is published, it is the `latest` npm release and the source for the stable Claude/Codex marketplace payload. Pin its CLI or four-tool MCP runtime:

```sh
npx --yes @bmccarn/tracecheck@0.3.0 --help
npx --yes @bmccarn/tracecheck@0.3.0 mcp
```

Pair that runtime with the complete skill directory from the same `0.3.0` package or release artifact. Native Claude and Codex users should use the marketplace commands above; Cursor uses the [version-matched manual setup](docs/integrations.md#cursor-manual-mcp--skill).

### Historical legacy: 0.2.0

The public `0.2.0` npm package and [v0.2.0 release artifacts](https://github.com/bmccarn/tracecheck/releases/tag/v0.2.0) remain available for existing CLI installations:

```sh
npx --yes @bmccarn/tracecheck@0.2.0 --help
npx --yes @bmccarn/tracecheck@0.2.0 review --repo /path/to/project
```

`0.2.0` predates the four-tool MCP server and matching skill, so it is not a new-installation path for those integrations.

Stable releases generate the marketplace payload in `bmccarn/tracecheck-plugins` from the same verified release artifact. See the [publishing guide](docs/publishing.md) for prepublication local-bundle testing, stable publication, and recovery.


## Configuration and data handling

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Required unless `JEV_API_KEY` is set | TypeSafe authentication. |
| `JEV_API_KEY` | Unset | Alternative key name; takes precedence. |
| `JEV_MODEL` | `jev-latest` | Model selection. Use an available concrete version for repeatable evaluations. |

Tracecheck does not load `.env` files automatically or persist your API key. Review requests are authenticated directly to the [TypeSafe API](https://docs.typesafe.ai/api). The selected source, baseline versions, dependencies, tests, and supplied task/context may leave your machine during live assessment. Local execution is not offline inference.

- `preview` is local. `preview --json` shows the captured source as well as the collection metadata.
- The collector skips generated paths, symlinks, binary files, and some recognizable secret patterns. Known credential patterns are also checked at the provider boundary for manually supplied context. This is not comprehensive secret detection.
- Saved reports contain code excerpts and repository metadata. Treat them as source-bearing artifacts. This checkout ignores `.tracecheck/` and `.env` files.
- Repository review results are cached in the MCP process for up to five minutes, with at most 16 entries. Cache hits retain the original timestamp and include an explicit cache flag. Prior assessments are compared locally without repeating inference. This cache does not apply to CLI runs or supplied-context assessments.

### Collection limits

| Limit | Current value |
| --- | --- |
| Collected files per packet | 16 |
| Current file read limit | 256,000 bytes |
| Baseline file read limit | 8 MiB |
| Primary changed files per packet | Up to 8, with evidence capacity reserved for supporting context |
| Focused source per current/baseline version | Up to 12,000 characters each, reduced further if required to fit |
| Caller/import discovery | Eligible tracked JS/TS/Python files; optional file/byte caps and a soft deadline |
| Source context per packet, including baselines | 60,000 characters and 80,000 serialized bytes |
| Parser-derived source candidates | No global cutoff; evaluated in batches of up to 10 |
| Serialized review request | 160,000-byte preflight; provider client also enforces 180,000 bytes |

Every safely readable, supported changed file is assigned to a packet; later files are not dropped after the first eight. Large files use bounded excerpts with original line anchors, visible omissions, and full-content digests. This covers changed files, not necessarily every changed line: omitted ranges, unsupported files, secrets, and unreadable or oversized files remain coverage gaps.

Repository discovery is separate from model-input size. A bounded in-process cache retains file identities and import edges, not raw source, and rechecks paths, timestamps, inode/device identity, and the known file set before reuse. Each CLI process starts cold; repeated MCP requests and recollection within a CLI review can reuse the index. One-hop JS/TS and Python import discovery remains heuristic: aliases, unresolved imports, and dynamic behavior may be missing even when every eligible file was indexed.

Partial discovery reports successfully indexed versus eligible file counts and bounded omission summaries. Raise discovery deadlines for a large repository without increasing model packet sizes. CLI flags above correspond to MCP's nested `collection` fields `maxIndexFiles`, `maxIndexBytes`, `indexTimeoutMs`, and `collectionTimeoutMs`; use identical collection arguments for preview and review. MCP review accepts `reviewTimeoutMs` separately. Timeouts accept positive integer milliseconds up to one hour. More packets mean more provider requests; preview exposes packet membership before transmission.

## Coverage and validation

The broad assessment accepts code in any language, but that is not a claim of equal accuracy across languages. Automatic collection supports common source, configuration, and documentation extensions. Exact parser-derived findings currently cover **JS/TS division or remainder boundaries, swallowed failures, and JSON parsing boundaries**. A matching syntax pattern is a hypothesis for Jev to assess, not an automatic bug report.

```sh
npm run validate                    # Type checks, tests, and builds
npm run package:check               # Tarball contents and offline CLI/MCP execution
npm run demo                        # Scripted example; no live inference
npm run benchmark -- --live          # Six synthetic source-check cases
npm run smoke -- --live              # Live MCP review and cache verification
npm run quality-smoke -- --live      # Live supplied-context Python assessments
npm run accuracy -- --repo /path/to/rapidregs-ingest # Offline real-project label checks
```

Live commands require credentials and consume API usage. The [validation record](docs/validation.md) documents automated checks, observed live results, and their limits. The small synthetic benchmark is a smoke test, not a general accuracy estimate. Tracecheck does not currently run tests, reproduce failures, or verify fixes by execution.

GitHub Actions runs `npm ci`, `npm run validate`, and `npm run package:check` on pushes and pull requests using Node 22.18.0. These checks need no live inference credentials.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Missing API key | Export a supported variable in the launching process. For GUI clients, configure its environment explicitly. |
| No changed files | The default baseline is `HEAD`. Select an earlier commit for committed changes; opt in to untracked files when needed. |
| Snapshot mismatch | Preview again and use the same repository, baseline, task, and context for review. |
| Missing scores or inconclusive result | Read applicability and coverage limitations. Provide the missing contracts, callers, or tests rather than treating uncertainty as a defect. |
| Comparison skipped or rejected | Keep scope, baseline, model, and rubric/policies consistent; use the correct report type for the command. |
| Context limit error | Narrow the diff or supplied files and remove unrelated context. |

## Roadmap

The `0.3.0` version adds a real-project benchmark, separate relevance/evidence judgments, focused collection with callers and tests, and stronger cache and request boundaries. Its public availability follows the stable publication process above; npm `0.2.0` remains the previous release.

The [accuracy baseline](docs/accuracy.md) reports the tradeoffs: smaller fixture packets cut input tokens by 51.9% but lowered defect recall. The agent-first workflow adds focused hypothesis verification and a [paired evaluation protocol](docs/agent-evaluation.md). Next steps are fresh agent-only versus assisted trials, better evidence selection through the skill, and calibration on independent bug/fix families.

Later work includes broader source checks, incremental reassessment, isolated reproductions and fix verification, and CI/SARIF exports. These are planned capabilities, not current features.

## Development

Run `npm ci` and `npm run validate` before submitting implementation changes. A useful bug report includes a minimal reproducible fixture, expected behavior, actual report, and relevant model/version information; remove credentials and private source first.

| Location | Purpose |
| --- | --- |
| [`src/collector.ts`](src/collector.ts) and [`src/checks.ts`](src/checks.ts) | Git context and parser-derived candidates. |
| [`src/jev.ts`](src/jev.ts) | Typed provider requests, validation, and retry handling. |
| [`src/quality.ts`](src/quality.ts) and [`src/quality/`](src/quality/) | Dimension assessment and quality comparisons. |
| [`src/review.ts`](src/review.ts) and [`src/history.ts`](src/history.ts) | Review orchestration, rendering, and source-finding history. |
| [`src/mcp.ts`](src/mcp.ts) and [`src/cli.ts`](src/cli.ts) | MCP tools and command-line entry points. |
| [`test/`](test/) and [`examples/`](examples/) | Regression tests, demos, and live smoke checks. |

Further reading: [Design](docs/design.md) · [Integrations](docs/integrations.md) · [Validation](docs/validation.md) · [Accuracy benchmark](docs/accuracy.md) · [Agent evaluation](docs/agent-evaluation.md) · [Capability coverage](docs/parity.md)

## License

[MIT](LICENSE).
