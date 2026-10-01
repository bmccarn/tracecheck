# Validation

## Current state — September 23, 2026

- Version 0.4.0 is the current release. The `v0.4.0` release run published it to npm under `latest` through trusted publishing with a provenance attestation, created the GitHub release with the npm and marketplace archives, and published the plugin payload to `bmccarn/tracecheck-plugins`. The candidate `0.4.0-rc.1` remains on npm under `next`.
- The end-user journey against the published `@bmccarn/tracecheck@0.4.0` passes every outcome and plumbing check offline and live through OpenRouter. The live run reports one known issue, #70: a division defect that shares a review packet with a second defect stays `uncertain`.
- In isolated client profiles for both plugin clients, installing from `bmccarn/tracecheck-plugins` gives 0.4.0, and updating from 0.3.0 moves to 0.4.0. The installed MCP server reports version 0.4.0, lists the four tools, and returns the no-repo and missing-key guidance. Adding `bmccarn/tracecheck` itself as a marketplace installs 0.4.0 over HTTPS, since both in-repo catalogs switched to an HTTPS source after the release.
- The decision gates in `src/policy.ts` come from the labeled [calibration](calibration.md).
- Not yet verified: a full agent turn inside a native client, because the isolated profiles have no client login; Cursor's discovery of the MCP server and skill in its editor; and accuracy on real projects beyond the synthetic calibration.

Earlier release-by-release checks are recorded in the [changelog](../CHANGELOG.md) and the repository's version tags.
