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

## Cursor: manual MCP + skill

Cursor discovers local stdio MCP servers from either project `.cursor/mcp.json` or global `~/.cursor/mcp.json`. Add the `tracecheck` entry inside the existing `mcpServers` object; preserve every other server entry.

Before stable `0.3.0` is published, point Cursor at a built local checkout so the MCP runtime matches the included four-tool skill:

```json
{
  "mcpServers": {
    "tracecheck": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/tracecheck/dist/plugin.mjs", "mcp"],
      "env": {
        "TYPESAFE_API_KEY": "${env:TYPESAFE_API_KEY}"
      }
    }
  }
}
```

After stable `0.3.0` is published to npm, replace only `command` and `args` with the pinned stable runtime:

```json
"command": "npx",
"args": ["--yes", "@bmccarn/tracecheck@0.3.0", "mcp"]
```

Do not pair the new four-tool skill with the public `0.2.0` runtime; that historical release predates this integration. To use `JEV_API_KEY` instead, replace the environment entry with `"JEV_API_KEY": "${env:JEV_API_KEY}"`. Set the chosen variable in the environment that launches Cursor; GUI-launched Cursor may not inherit an interactive shell profile. Keep the secret out of `mcp.json`, repository files, and chat. Installing or running the npm package does **not** register either this MCP server or a Cursor skill.

Copy the complete skill directory—not only `SKILL.md`—from the source matching the configured runtime to one discovered Cursor location. After `0.3.0` is published, unpack that exact npm package and copy its entire skill folder:

```sh
npm pack @bmccarn/tracecheck@0.3.0
mkdir -p /tmp/tracecheck-0.3.0
tar -xzf bmccarn-tracecheck-0.3.0.tgz -C /tmp/tracecheck-0.3.0

# Global on this machine
mkdir -p ~/.cursor/skills/tracecheck
cp -R /tmp/tracecheck-0.3.0/package/skills/tracecheck/. ~/.cursor/skills/tracecheck/

# Or, for this project only
mkdir -p /path/to/project/.cursor/skills/tracecheck
cp -R /tmp/tracecheck-0.3.0/package/skills/tracecheck/. /path/to/project/.cursor/skills/tracecheck/
```

Before publication, copy the complete folder from the matching local checkout instead:

```sh
cp -R /absolute/path/to/tracecheck/skills/tracecheck/. ~/.cursor/skills/tracecheck/
```

The copied directory must retain `SKILL.md` and `references/tool-usage.md`. This is a manual Cursor integration, not a native Cursor marketplace plugin or an automatic client-configuration change.

Restart or reload Cursor. In **Customize**, confirm the Tracecheck server is enabled and that all four tools appear: `tracecheck_verify`, `tracecheck_preview`, `tracecheck_review`, and `tracecheck_assess`; confirm the `tracecheck` skill appears under Skills. Then give the agent a real implementation checkpoint and ask it to investigate a concrete concern with Tracecheck, rather than merely asking whether the tools are listed. A successful tool call and a meaningful agent review are separate checks; this documentation does not claim a Cursor UI end-to-end test.

For a connection failure, check Cursor's **Output** panel → **MCP Logs**, then recheck the JSON entry, the launching environment's credential variable, and the copied skill directory. For Tracecheck request shapes or provider-recovery behavior, use the included [tool usage](../skills/tracecheck/references/tool-usage.md#recovery-and-completion).

## Validated boundaries

- Real MCP v2 SDK client/server exchange over stdio, with schemas and stale-snapshot rejection.
- Real Jev calls through the standalone server, all 19 dimensions, source findings, and a cache hit.
- Supplied-context Python assessment and previous-evaluation input through MCP.
- Standalone bundle launch from a directory without dependencies.
- Portable plugin discovery and strict Claude manifest validation.
- Codex plugin validator and skill validator pass.

The native Codex, Cursor, Claude, and OpenCode UIs have not all been installed and exercised. Do not infer that packaging validation is an end-to-end client installation test.

Packaging follows the [official OpenAI plugin packaging guidance](https://developers.openai.com/plugins/build/plugins) and the [Agent Plugins specification](https://agent-plugins.org/specification). Local stdio packaging does not publish a public remote plugin.
