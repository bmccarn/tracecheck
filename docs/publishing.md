# Publishing Tracecheck

One version covers the standalone CLI, four-tool MCP server, review skill, and portable/Claude/Codex plugin manifests. `package.json` is canonical. npm installation supplies the files and CLI; marketplace installation registers the skill and MCP wiring. Cursor uses the [manual MCP and skill instructions](integrations.md#cursor-manual-mcp--skill).

## Channels and ownership

| Surface | Release source |
| --- | --- |
| npm `next` | Prereleases such as `0.3.0-rc.2` |
| npm `latest` | Stable versions such as `0.3.0` |
| GitHub releases | The verified npm and marketplace archives for the matching immutable tag |
| `bmccarn/tracecheck-plugins` | Generated stable marketplace payload for Claude and Codex; never release candidates |

Development lives in `bmccarn/tracecheck`. The release-only marketplace repository is updated by the stable release workflow, not by ordinary merges. Before its first stable publication it does not provide an installation catalog; after a successful stable publication it is the canonical Claude/Codex marketplace source. Source-repository catalogs remain pinned to the historical `v0.2.0` release; they do not track development or automatically migrate existing installations.

A prerelease must not move npm's `latest` tag or update the stable marketplace. Published versions and release tags are immutable. The workflow is not a cross-service transaction: npm, GitHub releases, and the marketplace can succeed independently; use the recovery procedure below after a partial publication.

Release versions use `MAJOR.MINOR.PATCH` with an optional prerelease suffix such as `-rc.1`. Build metadata (`+...`) is deliberately rejected so registry identity, channel selection, tags, and archive names agree.

## Prepare a stable release PR

From a checkout containing the intended `0.3.0` changes:

```sh
npm ci
npm run release:prepare -- 0.3.0
```

Preparation validates all metadata before updating `package.json`, the lockfile, and the three plugin manifests together. It neither commits nor publishes. Update the changelog and relevant installation examples, then run:

```sh
npm run release:check
```

This checks source/tests/builds, distribution metadata, synchronized versions, the actual npm archive, and the generated marketplace archive. It launches the npm tarball from an empty directory/cache, verifies CLI behavior, all four MCP tools, and the MCP server version. The standalone bundle includes runtime dependencies. No Jev call is made by this offline release check.

Include the rebuilt tracked `dist/plugin.mjs` in the release PR. Keep generated `release/` archives out of Git. Merge only after CI passes. The workflow rejects a release tag whose version differs from the package or whose commit is not reachable from `origin/main`.

## One-time publishing setup

### GitHub

The source repository needs:

- Public visibility: the credential-free ancestry fetch and public npm provenance assume a public source repository.
- A protected environment named `release`, with an appropriate required reviewer and deployment policy limited to release tags (`v*`).
- Repository variable `MARKETPLACE_REPOSITORY` set to `bmccarn/tracecheck-plugins`.
- Environment secret `MARKETPLACE_DEPLOY_KEY`: an SSH private key whose matching write-enabled deploy key belongs only to the marketplace repository.

These resources were provisioned during this branch's setup. Key values belong only in GitHub's secret storage, never source files, logs, or documentation. Rotate the deploy key by replacing both the marketplace's public deploy key and the source environment's secret.

### npm trusted publishing: account-owner action

Sign in yourself to npm and open `@bmccarn/tracecheck` → Settings → Trusted publishing. Add a GitHub Actions publisher with:

| Field | Value |
| --- | --- |
| Organization or user | `bmccarn` |
| Repository | `tracecheck` |
| Workflow filename | `release.yml` (not the full path) |
| Environment name | `release` |
| Allowed action | Direct `npm publish` |

The workflow file must exist in the repository. New trusted-publisher configurations may enable only staged publishing by default; explicitly allow the direct publication command this workflow uses. Enter passwords and 2FA codes only on npm's website. No npm publishing token is required by the workflow, and it clears token environment overrides before publication.

[Official npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/) requires a supported GitHub-hosted runner, npm 11.5.1 or newer, Node 22.14 or newer, and `id-token: write`. The workflow selects compatible tooling. This publisher requirement is separate from the package's end-user runtime requirements.

The browser account-owner setup and a successful OIDC publication are separate checks. Existing `npm whoami` access does not prove that trusted publishing is configured.

The account owner has confirmed that this trusted publisher is configured. OIDC authentication remains untested until an authorized release run.

## Publish a candidate

After the release PR is merged, tag the exact reviewed commit, replacing `REVIEWED_COMMIT` with its SHA:

```sh
git tag -a v0.3.0-rc.2 REVIEWED_COMMIT -m 'Tracecheck 0.3.0-rc.2'
git push origin v0.3.0-rc.2
```

Approve the protected `release` deployment only after checking the tag, commit, version, and channel. GitHub Actions installs locked dependencies, runs the release checks, retains the verified artifacts, and publishes the exact checked npm tarball to `next`. It attaches the npm and marketplace archives to a GitHub prerelease. The stable marketplace is not modified.

Once the candidate is actually published:

```sh
npx --yes @bmccarn/tracecheck@0.3.0-rc.2 --help
npx --yes @bmccarn/tracecheck@0.3.0-rc.2 mcp
```

Before publication, test the local tarball instead of using a registry version that does not exist:

```sh
npm exec --yes --package=/absolute/path/to/tracecheck/release/bmccarn-tracecheck-0.3.0-rc.2.tgz -- tracecheck --help
```

When publishing a local archive with pinned npm 11.5.1, the path must begin with `./` or be absolute: `release/<file>.tgz` is otherwise interpreted as a GitHub shorthand. A pinned-npm dry-run checks only publication-path handling; it is not proof of OIDC trusted publishing.

```sh
npm exec --yes --package=npm@11.5.1 -- npm publish ./release/bmccarn-tracecheck-0.3.0-rc.2.tgz --dry-run --ignore-scripts --provenance --tag next
```

The historical public `0.2.0` has three tools. Do not pair it with the newer agent-first skill, which calls `tracecheck_verify`.

## Native marketplace installation

After stable `0.3.0` publication has completed and populated `bmccarn/tracecheck-plugins`, this is the primary installation path:

Claude Code:

```text
/plugin marketplace add bmccarn/tracecheck-plugins
/plugin install tracecheck@tracecheck-plugins
```

Codex:

```sh
codex plugin marketplace add bmccarn/tracecheck-plugins
codex plugin add tracecheck@tracecheck-plugins
```

For Cursor, follow the stable version-matched [manual setup](integrations.md#cursor-manual-mcp--skill); npm does not register its MCP entry or skill automatically.

## Prerelease local-bundle installation

This historical candidate workflow remains for local development and prepublication testing; it is not the normal stable client-installation path. Extract the candidate's `tracecheck-marketplace-<version>.tgz`. It contains both catalogs and `plugins/tracecheck/`, copied from the verified npm payload.

Claude Code:

```text
/plugin marketplace add /absolute/path/to/tracecheck-marketplace
/plugin install tracecheck@tracecheck-plugins
```

Codex:

```sh
codex plugin marketplace add /absolute/path/to/tracecheck-marketplace
codex plugin add tracecheck@tracecheck-plugins
```

For Cursor, follow the version-matched [manual setup](integrations.md#cursor-manual-mcp--skill); npm does not register its MCP entry or skill automatically.

In clean client profiles, verify the skill is available, all four MCP tools connect, missing-key guidance is actionable, and one synthetic live hypothesis verification works. Confirm the agent follows the investigate → Jev → follow-up loop. Check upgrading an existing installation as well as a new installation. Use a Jev key in the launching environment; GUI clients may not inherit shell exports. Keep live validation on synthetic input rather than private project source.

Offline package checks and CLI-native installation checks do not by themselves prove every client UI works. Record exactly which surfaces were exercised before approving stable publication.

## Publish stable

Prepare and merge a new release PR using `npm run release:prepare -- 0.3.0`, with the final changelog and rebuilt bundle. Run the release checks again; do not merely relabel a candidate tarball. Tag the reviewed stable commit and submit it for the protected release approval:

```sh
git tag -a v0.3.0 REVIEWED_COMMIT -m 'Tracecheck 0.3.0'
git push origin v0.3.0
```

This workflow supports one forward-moving stable line, not maintenance/backport channels. For a tagged stable release, the gate reads fetched local `v*` tags and rejects any version older than an existing stable release; prerelease tags do not block stable publication. A failed tag lookup also blocks publication. No-tag local metadata checks remain independent of Git history. Every approved stable release moves npm `latest` and replaces the shared marketplace payload. Downgrades belong to the explicit recovery procedure, not ordinary tag publication.

The stable workflow publishes the tested npm archive to `latest`, attaches the archives to a GitHub release, and updates only these generated marketplace paths:

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`
- `plugins/tracecheck/`

It does not force-push or replace unrelated marketplace content. After successful stable publication, users add `bmccarn/tracecheck-plugins` and install `tracecheck@tracecheck-plugins`.

Existing users of the source-repository marketplace must re-register the marketplace against `bmccarn/tracecheck-plugins` after its first stable publication, then update/reinstall Tracecheck. The marketplace name remains `tracecheck-plugins`. Until that migration, the source catalogs remain pinned to `v0.2.0` rather than silently shipping a release candidate.

## Recovery and rollback

If publication partially succeeds, stop and inspect which surfaces completed. Download the retained verified artifacts from the original workflow run; do not casually rebuild and assume the bytes are identical.

- If npm already contains the version, do not rerun its publication or attempt to overwrite it. Complete only the failed GitHub-release or marketplace step with the retained artifacts and the same version.
- If a GitHub release already exists, inspect its attached assets before uploading anything; do not replace an existing artifact with different bytes under the same tag.
- If marketplace publication fails after npm succeeds, its prior stable payload remains the safe default. Repair permissions or the non-fast-forward conflict, then apply the original verified payload to the controlled paths.
- For a defective release, move npm's `latest` channel back to a known-good published version and restore the previous generated marketplace payload through a normal commit. Preserve existing tags and versions. Publish the repair under a new version.

Publication recovery requires maintainer judgment; the workflow deliberately fails rather than treating duplicate publication or missing credentials as success.
