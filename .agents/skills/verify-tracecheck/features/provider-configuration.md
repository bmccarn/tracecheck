# Provider configuration

Every live path resolves its Jev credential, endpoint, model, and per-request timeout from the environment. A TypeSafe key (`JEV_API_KEY`, then `TYPESAFE_API_KEY`) sends requests to TypeSafe; with only `OPENROUTER_API_KEY` set, requests go to OpenRouter's System One API. `TYPESAFE_BASE_URL` overrides the base URL, `JEV_MODEL` selects the model, and `JEV_TIMEOUT_MS` limits each Jev request (default 45000 ms). Rate limits, server errors, and network failures are retried up to three attempts.

## Sub-features

- `provider-typesafe` uses a TypeSafe key against `https://api.typesafe.ai/v1/systemone`.
- `provider-openrouter` uses `OPENROUTER_API_KEY` against `https://openrouter.ai/api/v1/systemone`.
- `provider-base-url` honors `TYPESAFE_BASE_URL`, including the OpenRouter SDK setup with an OpenRouter key in `TYPESAFE_API_KEY`.
- `provider-guard` rejects plain-HTTP remote hosts and base URLs with credentials, a query, or a fragment.
- `provider-model` sends `JEV_MODEL` and records the model the provider returns.
- `provider-errors` reports HTTP failures without echoing provider bodies, and maps context-limit errors to "split the review" guidance.
- `provider-retry` retries network failures (connection refused or reset, DNS, TLS) and reports `Jev request failed (network error)` after the third attempt.
- `provider-timeout` reports `Jev request timed out after N ms` when `JEV_TIMEOUT_MS` fires, and `Review timed out after N ms` when the overall review deadline fires. A malformed `JEV_TIMEOUT_MS` is rejected before any request.

## How to get to it (user POV)

- Set the variables in the environment that launches the CLI or the MCP server, then run any live path from [assess](./assess.md), [review](./review.md), or [verify](./verify.md).

## Driving it with capture.sh and mcp-call.mjs

Preconditions:

- Baseline preconditions from the index hold, and `$RUN/context.json` from the assess recipe exists.

- **Active provider.** Run `doctor.mjs` and read `providerKeys`, `baseUrl`, and `model`.
- **Live model.** Run the assess CLI step. `jq .model` on its output shows the provider's model ID: `jev-…` from TypeSafe, `typesafe/jev-…` from OpenRouter.
- **Guard.** Run `$S/capture.sh "$RUN" guard -- env TYPESAFE_BASE_URL=http://example.com/api node dist/plugin.mjs assess --input "$RUN/context.json"` with a key set. Exit `2`; stderr says the base URL must use HTTPS. No request is made.
- **Endpoint routing without spending.** Run the assess command with `env -i PATH="$PATH" OPENROUTER_API_KEY=invalid node dist/plugin.mjs assess --input "$RUN/context.json"`. Exit `2` with `HTTP 401`, which proves the request reached a real endpoint that rejected the key.
- **Network retry.** Run assess with a placeholder key (`TYPESAFE_API_KEY=placeholder`) and `TYPESAFE_BASE_URL=https://127.0.0.1:1`, where nothing listens. Exit `2` after about 1.5 seconds of backoff; stderr is `Tracecheck: Jev request failed (network error); no successful review was recorded.`
- **Request timeout.** Run assess live with `JEV_TIMEOUT_MS=50`. Exit `2`; stderr is `Tracecheck: Jev request timed out after 50 ms. Set JEV_TIMEOUT_MS to allow more time.` Run review with `--review-timeout-ms 50` for the overall deadline message.
- **Local endpoint.** Start a stand-in server with `hub` (`op: "start"`, a unique name, `ready.port`) on a loopback port, set `TYPESAFE_BASE_URL=http://127.0.0.1:<port>`, and run assess. The server must receive `POST /v1/systemone`. Stop it with `hub` `stop` afterwards.

## Gotchas

- A TypeSafe key wins when both kinds are set, so an OpenRouter test must unset `JEV_API_KEY` and `TYPESAFE_API_KEY` or run under `env -i`.
- A stand-in server that logs request headers sees the key. Use it only with a placeholder key.
- `env -i` also clears `HOME`; pass `HOME="$HOME"` when a command needs it, such as `npx`.
