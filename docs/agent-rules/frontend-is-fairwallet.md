<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# `packages/frontend` is FAIRWallet, and upstream is alive

This repo's git history IS FAIRWallet's — the first commit is
`e729ce5 Initial release: FAIRWallet SPV wallet for FairCoin`, and the Oxy
monorepo was built on top. The `fairwallet` remote
(`FairCoinOfficial/FAIRWallet`) still receives work, so a fix made only here is
a fix the other side keeps paying for.

**Before fixing anything under `packages/frontend`, ask: does the change mention
Peable, Oxy, the gateway, a merchant or an intent?** If it does not, it is not
ours.

| Change | Where it belongs |
|---|---|
| Protocol primitives — URIs, addresses, transactions, consensus | `@fairco.in/core`, which both already depend on. No fork sync needed |
| Generic FairCoin wallet — SPV, storage, chain UI | FAIRWallet, then `scripts/fairwallet-pick.sh` (below) |
| Oxy identity, gateway, merchants, intents, checkout | Only here |

**Take upstream commits with `scripts/fairwallet-pick.sh <sha>...`, not a bare
`git cherry-pick`.** Upstream is at the repo root in double-quoted Prettier
style, so a plain pick conflicts on nearly every line and loses the rename. The
script Biome-formats the commit's before and after files under
`packages/frontend/`, commits both as throwaway commits on HEAD and picks the
second, leaving only real divergence. It lists and skips files with no
counterpart here (upstream CI, `bun.lock`, deleted screens). On `c094cf3`: 55
conflicts plain, 11 with it, each a Peable edit to the same lines.

