# Publishing Tracecheck

Tracecheck has two distribution surfaces: a plugin that installs the review skill and MCP wiring, and an npm package that exposes the CLI and MCP server through `npx`. Running `npx` alone does not register the skill with a coding agent.

## Release artifacts

From the checkout:

```sh
npm ci
npm run validate
npm run package:check
```

`package:check` builds the runtime and creates:

- `release/bmccarn-tracecheck-0.2.0.tgz`: npm package, including the standalone runtime, manifests, skill, and documentation.
- `release/tracecheck-marketplace-0.2.0.tgz`: a marketplace directory containing that same plugin payload plus Claude and Codex catalogs.

Filenames follow `package.json` version. The check verifies required files and manifest versions, rejects unwanted package paths, and runs the actual npm tarball through offline `npm exec` from an empty directory/cache. It exercises CLI help and all three MCP tool registrations without calling Jev. Production dependencies are bundled; end users do not need the development dependency tree. Packaging requires `tar` on PATH.

The generated marketplace has this layout:

```text
tracecheck-marketplace/
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
└── plugins/tracecheck/
    ├── plugin.json
    ├── mcp.json
    ├── .codex-plugin/plugin.json
    ├── .claude-plugin/plugin.json
    ├── .mcp.json
    ├── dist/plugin.mjs
    └── skills/tracecheck/
        ├── SKILL.md
        └── references/tool-usage.md
```

## First publication

1. **Choose the public repository and npm package name.** The source currently uses `@bmccarn/tracecheck`; npm scopes are an alternative if the unscoped name is unavailable. A registry lookup does not reserve a name. Keep the CLI binary and plugin name `tracecheck` even if the npm package becomes scoped.
2. **Finalize metadata.** Set `repository.url`, `homepage`, `bugs.url`, and your selected `license` in `package.json`; add the corresponding `LICENSE`. This repository uses MIT and the bmccarn GitHub/npm namespace. Update publisher metadata in the plugin manifests and marketplace generator if needed. Refresh `package-lock.json` after package metadata changes.
3. **Validate the release.** Run `npm run release:check`. It includes the full validation suite, tarball/MCP smoke check, and metadata check. Inspect the package contents and validate both generated catalogs with the target clients.
4. **Publish the source.** Push the reviewed repository, including the built `dist/plugin.mjs`, to the chosen Git host. The tracked bundle lets Git-based plugin installs start without running a build.
5. **Publish npm.** Sign in to the account that owns the selected name, then run `npm publish --access public` from the checkout. `prepublishOnly` runs release checks and `prepack` rebuilds the bundle. Publication requires the account's authentication/2FA flow. This preparation does not publish anything automatically.
6. **Distribute the plugin catalog.** Extract the marketplace archive and publish its contents at the root of a dedicated marketplace Git repository, or distribute the archive for local installation. Users add that marketplace and install `tracecheck` from it. Attach the artifacts to a tagged release if useful.
7. **Test the public paths.** In a clean environment, run the published `npx` command and install the plugin in each supported client. Confirm the skill appears, all three tools connect, and a synthetic live Jev assessment works. Packaging checks alone do not establish native client installation success.

## npm and npx

After `@bmccarn/tracecheck@0.2.0` is actually published, users can run:

```sh
npx --yes @bmccarn/tracecheck@0.2.0 --help
npx --yes @bmccarn/tracecheck@0.2.0 preview --repo /path/to/project
npx --yes @bmccarn/tracecheck@0.2.0 review --repo /path/to/project --task 'Describe the change'
npx --yes @bmccarn/tracecheck@0.2.0 mcp
```

These registry commands are examples of the intended release interface, not a claim that the package is already live. Replace the package spec if a scoped name is chosen. Pin a version for reproducibility; update deliberately after reviewing changes.

Before publication, exercise the tarball directly from a directory outside the checkout:

```sh
npm exec --yes --package=/absolute/path/to/tracecheck/release/bmccarn-tracecheck-0.2.0.tgz -- tracecheck --help
```

For an MCP-only installation after publication, set the client command to `npx` and arguments to `--yes`, `@bmccarn/tracecheck@0.2.0`, `mcp`. Forward the Jev key through the client environment. For the bundled review workflow, install the plugin instead; npm does not install an agent skill merely because it ships inside a package.

## Claude Code plugin

Extract the marketplace archive. In Claude Code:

```text
/plugin marketplace add /absolute/path/to/tracecheck-marketplace
/plugin install tracecheck@tracecheck-plugins
```

For a hosted catalog, replace the path with the actual GitHub `bmccarn/tracecheck`. Invoke `/tracecheck:tracecheck` after installation; follow the client's reload/restart instruction and verify the MCP connection. For source development, `claude --plugin-dir /absolute/path/to/tracecheck` loads the plugin directly.

The generated catalog points to a bundled relative plugin directory. Claude also supports npm-backed marketplace entries, which can be adopted after npm publication. See the [official marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces).

## Codex plugin

Add the extracted marketplace root:

```sh
codex plugin marketplace add /absolute/path/to/tracecheck-marketplace
```

For public Git distribution, use the actual `bmccarn/tracecheck` in place of the path. Open the Plugins directory, select the Tracecheck marketplace, and install Tracecheck. Start a new task and ask to use the Tracecheck skill; verify that the review tools are available.

The portable manifest and root `mcp.json` provide the runtime; `skills/` provides agent instructions. The `.codex-plugin` manifest remains a compatibility adapter. The catalog includes install/authentication policy metadata. This repo does not change your personal plugin configuration during packaging.

A custom marketplace distributes the plugin independently of a universal public directory listing. Workspace publishing and public-directory inclusion are separate processes. See [OpenAI plugin packaging and distribution](https://developers.openai.com/plugins/build/plugins).

## Updates and automated publishing

Bump the npm version and all three plugin manifest versions together, rebuild the artifacts, and update the catalog's bundled plugin. `package:check` rejects version drift. Record user-visible changes before publishing each version; an existing npm version cannot be overwritten.

For automation, prefer [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) through GitHub Actions using OIDC rather than a long-lived publish token. Configure the exact repository and workflow in the npm package settings. Public repositories/packages receive provenance with supported trusted publishing. The repository URL in package metadata must match the publishing source. Configure this once the GitHub/npm ownership is decided; no publishing credentials or guessed account settings are included here.
