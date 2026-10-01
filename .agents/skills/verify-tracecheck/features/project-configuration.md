# Project configuration

`preview` and `review` on the CLI, and `tracecheck_preview` and `tracecheck_review` over MCP, read optional defaults from `.tracecheck.json` at the root of the repository they collect. The file can set `task`, `repositoryContext`, `collection`, `reviewTimeoutMs`, `model`, `requestTimeoutMs`, `requestConcurrency`, and `maxRequests`. Anyone who can commit to the repository controls the file, so it may only restate or lower a default: `includeUntracked` other than `false`, `base` other than `HEAD`, or a timeout, `requestConcurrency`, or `maxRequests` above its default is rejected with the key named. A flag or MCP argument wins, then `JEV_MODEL`, `JEV_TIMEOUT_MS`, or `JEV_CONCURRENCY` for the provider settings, then the file, then the built-in default. The file is validated with the flag and argument schemas; unknown keys, invalid values, and credential-like fields are rejected with the key named. Its validated content is part of the preview snapshot.

## Driving it

Preconditions:

- The skill's launch steps are done. Only the live review needs a provider key.
- A fixture exists: `node $S/fixture-repo.mjs project-config > "$RUN/fixture.json"` and `ROOT=$(jq -r .root "$RUN/fixture.json")`. Its committed `.tracecheck.json` sets a task and `collection.maxIndexFiles: 1`; the change is committed as `HEAD`, so it is visible with `--base HEAD~1`, and the working tree is clean.

- **File applies.** Run `node dist/plugin.mjs preview --repo "$ROOT" --base HEAD~1 --json > "$RUN/preview-json.stdout" 2> "$RUN/preview-json.stderr"; echo $?`. Expect `task` from the file, `src/stats.ts` changed, the limitation `Import index file limit reached: 1/2 eligible files scanned.`, and the note `Task from the repository settings file .tracecheck.json: ...`. The human preview prints `Settings: .tracecheck.json` and the same labeled task. The same holds with `--repo "$ROOT/src"`.
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
