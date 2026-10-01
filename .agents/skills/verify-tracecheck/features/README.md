# Tracecheck verification map

Each file here is the recipe for verifying one user-facing feature. Launch, driving conventions, and proof requirements are in the [skill](../SKILL.md); `node dist/plugin.mjs --help` lists every flag and exit code. Keep a feature file current whenever its commands, inputs, or observable results change.

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, followed by two H2 sections: `Driving it` and `Gotchas`. The [journey](../SKILL.md#end-user-journey) covers the main path; these recipes cover each feature's other entry points and edge cases.

## Features

- [Preview](./preview.md): local collection of change packets, sources, candidates, and coverage gaps. Offline.
- [Review](./review.md): repository review with source-check decisions and per-packet quality, plus report comparison. Live.
- [Verify](./verify.md): verification of one agent-supplied defect hypothesis against quoted evidence. Live.
- [Assess](./assess.md): quality assessment of caller-supplied task and files, with previous-evaluation comparison. Live.
- [Provider configuration](./provider-configuration.md): key, endpoint, model, timeout, and request concurrency for TypeSafe and OpenRouter. Live and offline, including a loopback stand-in provider.
- [Project configuration](./project-configuration.md): `.tracecheck.json` defaults for preview and review, their precedence, validation, the limits the file may not raise, labeled file-supplied task and context, and snapshot effect. Offline, plus one live review.
- [Marketplace catalogs](./marketplace-catalogs.md): in-repo catalog refs kept on the stable release tag by release preparation and the release gates, and installation from them. Offline, except that installation clones from GitHub.
