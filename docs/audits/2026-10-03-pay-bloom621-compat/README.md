# Peable Pay with published Bloom 6.2.1

The unchanged `packages/pay` source at Peable `6f671437` typechecks and builds
against published Bloom 6.2.1. All 130 existing tests pass (10 files). This checks
`PeablePaySheet`'s actual named imports and JSX props, not merely export paths.
The package's strict tsconfig retains its existing `skipLibCheck: true`.

The isolated fixture under `.integration-evidence/pay-bloom621` copies every
tracked pay source/config/script file byte for byte. Only its private package
manifest selects Bloom 6.2.1 instead of 6.3 and admits that version as a peer;
its independent Bun lock and input manifest are preserved here. All 20,940
installed Bloom files match the independently verified registry tarball.

Executed in that fixture:

```sh
bun install --minimum-release-age=0 --ignore-scripts
bun run typecheck
bun run build
bun run test
```

At that fixture checkpoint, no production package manifest or lock changed. This establishes that pay's
current APIs do not require Bloom 6.3 at the type/build boundary. It does not
establish rendered native UI behavior: the existing tests cover payment logic,
pure UI state, and optional-peer barrel isolation without a React Native renderer.
No chain/provider mutation or package publication occurred.

A follow-up can widen the published optional pay peer's lower bound to 6.2.1
while retaining compatible 6.3 consumers, pin its development dependency and
Peable frontend to 6.2.1, and regenerate the real workspace lock. A Services 11.1
host must additionally honor Services' `>=6.2.1 <6.3.0` peer. Final frontend
compilation/tests and any pay package release remain separate reviewed steps.

The subsequent [workspace adoption](workspace-adoption/README.md) records the real manifest/lock change and frontend validation.
