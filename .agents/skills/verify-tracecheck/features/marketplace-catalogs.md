# Marketplace catalogs

Users can add this repository itself as a plugin marketplace. Its two in-repo catalogs (`git ls-files '*marketplace.json'`) list the `tracecheck` plugin with a `source.ref` that pins the latest stable release tag. Stable release preparation moves both refs to the new tag, prerelease preparation leaves them alone, and the release gates fail when a ref does not match.

## Sub-features

- `catalog-prepare-stable`: `node scripts/release-prepare.mjs X.Y.Z` sets both refs to `vX.Y.Z` and prints `Marketplace catalogs now pin vX.Y.Z.`
- `catalog-prepare-prerelease`: `node scripts/release-prepare.mjs X.Y.Z-rc.N` leaves both catalogs byte-identical and prints the refs it kept.
- `catalog-gate-stable`: `node scripts/release-gates.mjs [vX.Y.Z]` exits `1` and names the catalog when a ref is not `vX.Y.Z`.
- `catalog-gate-prerelease`: for a prerelease, the gate exits `1` unless each ref names a stable tag older than the prerelease.
- `catalog-install`: a client that adds this repository as a marketplace installs the plugin from the pinned tag.

## How to get to it (user POV)

- Maintainers run `npm run release:prepare -- <version>` and `npm run release:gates` (CI runs the gates through `npm run release:check`; the release workflow passes the tag).
- Users add `bmccarn/tracecheck`, or a local checkout of it, as a marketplace in a plugin-capable client and install `tracecheck@tracecheck-plugins`.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold. No fixture scenario applies; the recipes use a disposable copy of the checkout.

- **Prepare and gate.** Copy the tracked files: `T=$(mktemp -d /tmp/tracecheck-verify-release-XXXX); git ls-files -z | xargs -0 cp --parents -t "$T"`, then in `$T` run `git init`, commit, and tag the current stable version. Run each script through `$S/capture.sh "$RUN" <name> -- node scripts/release-prepare.mjs <version>` and `... node scripts/release-gates.mjs <tag>`. Record `git diff -- '*marketplace.json'` after each preparation. Edit one ref by hand to see the gate fail, then restore it.
- **Published payload.** Confirm the pinned tag contains the plugin: `gh api "repos/bmccarn/tracecheck/contents/<path>?ref=<tag>"` for both catalogs, both plugin manifests, `.mcp.json`, `dist/plugin.mjs`, and `skills/tracecheck/SKILL.md`.
- **Install.** Give the client an isolated home (`HOME`, the client's own config-directory variable, `XDG_CONFIG_HOME`, and `GIT_CONFIG_GLOBAL` all under one temp directory), add the checkout path as a marketplace, and install `tracecheck@tracecheck-plugins`. The client's plugin list must show the pinned version. For an upgrade, first add a directory holding the base catalogs, install, swap in the new catalogs, then refresh the marketplace and update or reinstall the plugin.
- **Installed runtime.** From the installed plugin directory, run `node <checkout>/$S/mcp-call.mjs --out "$RUN/installed-mcp" --list`; `mcp-call.mjs` launches `dist/plugin.mjs` from its working directory, so this lists the installed bundle's tools.

## Gotchas

- Some clients clone a `github` source over SSH. An isolated home has no `known_hosts`, so the clone fails with a host key error. Rewrite to HTTPS in the isolated config only: `git config --file "$H/.gitconfig" url."https://github.com/".insteadOf "git@github.com:"` with `GIT_CONFIG_GLOBAL=$H/.gitconfig`.
- When `XDG_CONFIG_HOME` is set, `git config --global` writes to `$XDG_CONFIG_HOME/git/config` even if `HOME` points elsewhere. Override `XDG_CONFIG_HOME` too, or use `--file`, so a test never edits the real user configuration.
- After a release PR merges, the catalogs on `main` name a tag that does not exist until it is pushed; an install in that window fails.
