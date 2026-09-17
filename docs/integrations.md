# Local integrations

For packaged downloads, native Claude/Codex marketplace installation, and npm distribution, see the [publishing guide](publishing.md).

Build with `npm ci && npm run build`. The runtime is `dist/plugin.mjs`; it includes its dependencies. The project supplies portable Agent Plugins 1.0 manifests, a Codex compatibility manifest, a Claude compatibility manifest, and one continuous-review skill.

## Portable installer

The installer inspected during development was `plugins@1.3.4` from vercel-labs/plugins. Local discovery succeeds:

```sh
npx plugins@1.3.4 discover /absolute/path/to/tracecheck
npx plugins@1.3.4 add /absolute/path/to/tracecheck --target codex
```

Choose the client you use (`plugins targets` lists supported installer targets). Installation is a separate user action; this development run validated the package without modifying your installed clients.

The portable runtime path resolves against the plugin root. The agent supplies the reviewed repository to `tracecheck_preview` and `tracecheck_review`. It can call `tracecheck_assess` with supplied context without repository access.

## Manual MCP

For any stdio MCP client, including clients without a portable installer target, configure:

- Command: `node`
- Arguments: `/absolute/path/to/tracecheck/dist/plugin.mjs`, `mcp`
- Environment: forward `TYPESAFE_API_KEY` or `JEV_API_KEY`; optionally `JEV_MODEL`.

Append `--repo`, `/absolute/path/to/reviewed/repository` to bind the process to one repository. Otherwise provide `repo` in collection-tool calls. GUI-launched clients may not inherit interactive shell variables; configure their environment explicitly without committing credentials.

Load the included `skills/tracecheck/SKILL.md` through the client's skill support to get the continuous implement/validate/review workflow. MCP alone exposes the tools but does not impose that cadence.

## Validated boundaries

- Real MCP v2 SDK client/server exchange over stdio, with schemas and stale-snapshot rejection.
- Real Jev calls through the standalone server, all 19 dimensions, source findings, and a cache hit.
- Supplied-context Python assessment and previous-evaluation input through MCP.
- Standalone bundle launch from a directory without dependencies.
- Portable plugin discovery and strict Claude manifest validation.
- Codex plugin validator and skill validator pass.

The native Codex, Cursor, Claude, and OpenCode UIs have not all been installed and exercised. Do not infer that packaging validation is an end-to-end client installation test.

Packaging follows the [official OpenAI plugin packaging guidance](https://developers.openai.com/plugins/build/plugins) and the [Agent Plugins specification](https://agent-plugins.org/specification). Local stdio packaging does not publish a public remote plugin.
