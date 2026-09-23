# Project configuration

`preview` and `review` on the CLI, and `tracecheck_preview` and `tracecheck_review` over MCP, read optional defaults from `.tracecheck.json` at the root of the repository they collect. The file can set `task`, `repositoryContext`, `collection`, `reviewTimeoutMs`, `model`, `requestTimeoutMs`, `requestConcurrency`, and `maxRequests`. Anyone who can commit to the repository controls the file, so it may only restate or lower a default: `includeUntracked` other than `false`, `base` other than `HEAD`, or a timeout, `requestConcurrency`, or `maxRequests` above its default is rejected with the key named. A flag or MCP argument wins, then `JEV_MODEL`, `JEV_TIMEOUT_MS`, or `JEV_CONCURRENCY` for the provider settings, then the file, then the built-in default. The file is validated with the flag and argument schemas; unknown keys, invalid values, and credential-like fields are rejected with the key named. Its validated content is part of the preview snapshot.

## Sub-features

- `config-apply` applies the file when no flag or argument overrides a setting. The human preview prints `Settings: .tracecheck.json`.
- `config-labels` shows a task or repository context that came from the file in preview and review output (human and JSON, CLI and MCP) as `Task from the repository settings file .tracecheck.json: ...` and `Repository context from the repository settings file .tracecheck.json: ...`.
- `config-precedence` lets flags and MCP arguments override the file per setting and per key inside `collection`.
- `config-limits` rejects a file that enables untracked files, changes `base`, or raises a timeout, `requestConcurrency`, or `maxRequests` above its default. Each offending key is named with the flag, argument, or environment variable that can raise it.
- `config-validation` rejects unknown keys (including `baseUrl`), invalid values, and invalid JSON with an error naming the key and never quoting the value.
- `config-credentials` rejects fields whose names contain the word key, token, secret, or password (whole words and camelCase segments, so `apiToken` is rejected and `maxTokens` is an unknown key), and values that match a known credential pattern.
- `config-snapshot` makes `tracecheck_review` reject a preview snapshot after the file's settings change.
- `config-provider` supplies the model, per-request timeout, and request concurrency for review when the environment does not.

## How to get to it (user POV)

- Commit `.tracecheck.json` at the repository root, then run `tracecheck preview --repo PATH` or `tracecheck review --repo PATH` with fewer flags.
- Launch `tracecheck mcp --repo PATH`, or pass `repo`, and call `tracecheck_preview` and `tracecheck_review` without the configured arguments.

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold. Only the live review needs a provider key.
- A fixture exists: `node $S/fixture-repo.mjs project-config > "$RUN/fixture.json"` and `ROOT=$(jq -r .root "$RUN/fixture.json")`. Its committed `.tracecheck.json` sets a task and `collection.maxIndexFiles: 1`; the change is committed as `HEAD`, so it is visible with `--base HEAD~1`, and the working tree is clean.

- **File applies.** Run `$S/capture.sh "$RUN" preview-json -- node dist/plugin.mjs preview --repo "$ROOT" --base HEAD~1 --json`. Expect `task` from the file, `src/stats.ts` changed, the limitation `Import index file limit reached: 1/2 eligible files scanned.`, and the note `Task from the repository settings file .tracecheck.json: ...`. The human preview prints `Settings: .tracecheck.json` and the same labeled task. The same holds with `--repo "$ROOT/src"`.
- **Flags win.** Add `--task 'Flag task'`: `task: "Flag task"` and no settings-file label. Add only `--index-max-files 50`: `src/report.ts` appears as `caller` and the file-limit limitation is gone.
- **Limits.** Write `{"includeUntracked":true,"base":"HEAD~1","requestConcurrency":16,"reviewTimeoutMs":3600000,"maxRequests":100,"task":"t"}` to the file. Preview and review exit `2` before collection, and the error names each of `"includeUntracked"`, `"base"`, `"requestConcurrency"`, `"reviewTimeoutMs"`, and `"maxRequests"` with the flag or variable that raises it. The same file with `"maxRequests":1` and no other offending key makes review refuse with `Review would make N provider requests, over the budget of 1`.
- **Rejections.** Write each of these to `$ROOT/.tracecheck.json` and run preview: `{"collection":{"maxIndexFile":1}}` exits `2` with `unknown key "collection.maxIndexFile"`; `{"OPENROUTER_API_KEY":"placeholder"}` exits `2` with `"OPENROUTER_API_KEY" looks like a credential field`; `{"baseUrl":"https://example.invalid"}` exits `2` with `unknown key "baseUrl"`; `{"includeUntracked":"yes"}` names `"includeUntracked"`; `{"apiToken":"placeholder"}` is a credential field, while `{"maxTokens":1}` is `unknown key "maxTokens"`. Restore the file afterwards.
- **MCP.** Calls `tracecheck_preview` with `{}` (no change), with `{"base":"HEAD~1","collection":{"maxIndexFiles":50}}` (caller present), and with `{"base":"HEAD~1"}` (the file applies; its snapshot equals the CLI preview snapshot). Then a `run` step copies an edited file (for example `maxIndexFiles: 2`) over `$ROOT/.tracecheck.json`, and `tracecheck_review` with `$snapshot` and `{"base":"HEAD~1"}` fails with `Repository context changed since preview`. Without the edit, the same review passes the snapshot check and, with no key, fails only on the missing key.
- **Live task.** Run `review --repo "$ROOT" --base HEAD~1 --json` with a key. To see the request, point `TYPESAFE_BASE_URL` at a loopback forwarder that records request bodies (never headers); the body contains the configured task text.

## Gotchas

- The file is read from the working tree, so an edited `.tracecheck.json` is itself a changed file under review, and an untracked one is counted in the untracked-file limitation.
- Formatting-only edits keep the snapshot; any change to a parsed value invalidates it, even for settings an explicit argument overrides.
- `verify` and `assess` do not read the file.
- `TYPESAFE_BASE_URL` and keys come only from the environment; the file cannot set them.
