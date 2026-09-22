# Project configuration

`preview` and `review` on the CLI, and `tracecheck_preview` and `tracecheck_review` over MCP, read optional defaults from `.tracecheck.json` at the root of the repository they collect. The file can set `base`, `includeUntracked`, `task`, `repositoryContext`, `collection`, `reviewTimeoutMs`, `model`, `requestTimeoutMs`, and `requestConcurrency`. A flag or MCP argument wins, then `JEV_MODEL`, `JEV_TIMEOUT_MS`, or `JEV_CONCURRENCY` for the provider settings, then the file, then the built-in default. The file is validated with the flag and argument schemas; unknown keys, invalid values, and credential-like fields are rejected with the key named. Its validated content is part of the preview snapshot.

## Sub-features

- `config-apply` applies the file when no flag or argument overrides a setting. The human preview prints `Settings: .tracecheck.json`.
- `config-precedence` lets flags and MCP arguments override the file per setting, per key inside `collection`, and `--no-include-untracked` turn off a configured `includeUntracked: true`.
- `config-validation` rejects unknown keys (including `baseUrl`), invalid values, and invalid JSON with an error naming the key and never quoting the value.
- `config-credentials` rejects fields whose names look like a key, token, secret, or password, and values that match a known credential pattern.
- `config-snapshot` makes `tracecheck_review` reject a preview snapshot after the file's settings change.
- `config-provider` supplies the model, per-request timeout, and request concurrency for review when the environment does not.

## How to get to it (user POV)

- Commit `.tracecheck.json` at the repository root, then run `tracecheck preview --repo PATH` or `tracecheck review --repo PATH` with fewer flags.
- Launch `tracecheck mcp --repo PATH`, or pass `repo`, and call `tracecheck_preview` and `tracecheck_review` without the configured arguments.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold. Only the live review needs a provider key.
- A fixture exists: `node $S/fixture-repo.mjs project-config > "$RUN/fixture.json"` and `ROOT=$(jq -r .root "$RUN/fixture.json")`. Its committed `.tracecheck.json` sets `base: "HEAD~1"`, a task, and `collection.maxIndexFiles: 1`; the working tree is clean.

- **File applies.** Run `$S/capture.sh "$RUN" preview-json -- node dist/plugin.mjs preview --repo "$ROOT" --json`. Expect `base` equal to `git -C "$ROOT" rev-parse HEAD~1`, `task` from the file, `src/stats.ts` changed, and the limitation `Import index file limit reached: 1/2 eligible files scanned.` The human preview prints `Settings: .tracecheck.json`. The same holds with `--repo "$ROOT/src"`.
- **Flags win.** Add `--base HEAD --task 'Flag task'`: no changed paths and `task: "Flag task"`. Add only `--index-max-files 50`: `src/report.ts` appears as `caller` and the file-limit limitation is gone, while `base` still comes from the file.
- **Untracked negation.** Add `"includeUntracked": true` to the file and create an untracked `src/extra.ts`. Preview lists it as changed; `--no-include-untracked` excludes it and reports `1 untracked file(s) excluded`.
- **Rejections.** Write each of these to `$ROOT/.tracecheck.json` and run preview: `{"collection":{"maxIndexFile":1}}` exits `2` with `unknown key "collection.maxIndexFile"`; `{"OPENROUTER_API_KEY":"placeholder"}` exits `2` with `"OPENROUTER_API_KEY" looks like a credential field`; `{"baseUrl":"https://example.invalid"}` exits `2` with `unknown key "baseUrl"`; `{"includeUntracked":"yes"}` names `"includeUntracked"`. Restore the file afterwards.
- **MCP.** Calls `tracecheck_preview` with `{"base":"HEAD"}` (no change), with `{"collection":{"maxIndexFiles":50}}` (caller present), and with `{}` (the file applies; its snapshot equals the CLI preview snapshot). Then a `run` step copies an edited file (for example `maxIndexFiles: 2`) over `$ROOT/.tracecheck.json`, and `tracecheck_review` with `$snapshot` fails with `Repository context changed since preview`. Without the edit, the same review passes the snapshot check and, with no key, fails only on the missing key.
- **Live task.** Run `review --repo "$ROOT" --json` with a key. To see the request, point `TYPESAFE_BASE_URL` at a loopback forwarder that records request bodies (never headers); the body contains the configured task text.

## Gotchas

- The file is read from the working tree, so an edited `.tracecheck.json` is itself a changed file under review, and an untracked one is counted in the untracked-file limitation.
- Formatting-only edits keep the snapshot; any change to a parsed value invalidates it, even for settings an explicit argument overrides.
- `verify` and `assess` do not read the file.
- `TYPESAFE_BASE_URL` and keys come only from the environment; the file cannot set them.
