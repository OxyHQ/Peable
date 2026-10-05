# SDK 0.2.1 published and verified

Published from main `87c62dac93195edd7d588681f393f0d6d39d75de` after
[PR95](https://github.com/OxyHQ/Peable/pull/95) merged the reviewed source.
The complete tree equals reviewed head e4c2917; [CI37105734182](https://github.com/OxyHQ/Peable/actions/runs/37105734182)
passed all 1,496 tests (SDK130), plus the image job. Root paused and restored the
three deployment workflows during merge; no new backend deployment was needed.
Compatible backend TD7 remains the previously verified readiness deployment.

In a fresh worktree, frozen install succeeded, then one shell command ran
`bun run clean && bun run build && bun pm pack && bun publish <absolute fresh tarball> --access public`.
Registry preflight proved 0.2.1 absent and shared-types0.3.0 available. Publication
returned success once. Initial packument reads omitted the version and direct
version reads returned404 during propagation; these probes are retained. No
publication was retried. Fresh registry download verified SHA512 integrity,
SHA1 and SHA256, byte-identical to that command's freshly built archive.

The isolated consumer installs SDK0.2.1 only from the registry, resolving
shared-types0.3.0 transitively without overrides. Node CJS/ESM loading and strict
TypeScript NodeNext pass (skipLibCheck explicit). All99 package files match the
registry distributions both there and in Mercaria's adoption worktree. The
additional file versus0.2.0 is the SDK README. The verifier makes no auth/payment
requests; only dependency installation accesses the network.

Reproduce: `node packages/sdk/scripts/verify-http-parity-published.mjs <registry-sdk.tgz> <fixture-parent>`
from the repository root after install. Consumer calls in check.ts are compiled,
never executed. The optional deadline and operation-key contracts are exercised
by the source's real HTTP tests separately. Mercaria source migration, deployment,
cohort activation and the operator credential remain separate acceptance gates.
Issue87 remains open; no commercial catalogue, MoR, scopes or provider config
changed through publication.
