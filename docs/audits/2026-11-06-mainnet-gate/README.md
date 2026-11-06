Mainnet gate for identity-wallet FairCoin receive (ADR 0002, ADR 0021 D5)
==========================================================================

2026-11-06. The owner's decision ("Do everything and open it"): run ADR 0002's
item (1), the security review, and item (4), the testnet canary, and open
mainnet as soon as both pass, without waiting for (2), the legal opinion, or
(3), physical-device verification. The waiver itself is recorded in ADR 0002
("Owner's mainnet waiver"). This folder is the evidence for (1) and (4).

**Result: the gate is NOT opened.** The canary passed. The security review,
after three rounds and the fixes below, signs off **conditional on five written
owner risk acceptances** (listed at the end) that the owner's waiver does not
cover; no code defect blocks it any more. Until the owner accepts them, the gate
stays closed: production keeps `PEABLE_SOCIAL_PAY_NETWORK` unset (testnet;
checked on the running `oxy-peable:248` at the start and `oxy-peable:256` after
the fixes deployed), so the gateway answers `faircoin_network_closed` for a live
order's FairCoin option (`identityNetworkOpen`, `services/faircoin/recipient.ts`).

## (1) Security review

An independent `security-reviewer` agent was given the code (Peable, oxy,
`@fairco.in/core` 0.5.0), not the lead's conclusions, and asked to attack it as
an anonymous payer, a malicious merchant or marketplace, a malicious Oxy app on
the same phone, a departed organization admin and a network attacker.

### Round 1 (Peable `f191892c`, oxy `9c3e1a098`): refused

| ID | Severity | Finding | Fix |
|---|---|---|---|
| F1 | critical | A personal key rotation strands every Peable coin (the HD seed and the social tree both derive from the identity key); Commons said the old phrase "stops working"; open intents kept pre-rotation addresses and settled `succeeded` | oxy#2183 (Commons copy, required "move your Peable funds first" acknowledgement on both rotation paths); #254 (open payments under a replaced key are retired). No path spends from a previous phrase (residual) |
| F2 | high | After an organization replaces its key, payments keep flowing to the replaced key | #254: every address records its key; stale-key payments are retired on every payer surface and by a 60 s sweep; a broadcast one settles stamped `recipient_key_replaced_at` |
| F3 | high | Payments beyond the watch window missed; cursor synced only at unlock; extensions never rescanned | #253: resync on foreground, every 2 min, on push and on Receive; every newly watched index checked on the Explorer and the SPV rescan rewound to it |
| F4 | high | Anyone can push a recipient's cursor without limit; the wallet freezes (`Math.max(...)` spread, Bloom saturation) | #253 (loop maximum, 2,000-index window, HD coins stay spendable); #255 (recycle unpaid addresses, 500 open per recipient, leaks closed) |
| F5 | high | On iOS every Oxy app can read the personal and organization private keys (shared keychain group) | Not fixed in round 1. oxy#2183 adds `docs/identity/ios-keychain-access-groups.md`, which finds it wider: `keychainAccessGroup` is never applied (expo-secure-store reads `accessGroup`), so the recovery phrases share the group too. **Owner chose the split (2026-11-06); shipped in oxy#2186 (ADR 0062; core 7.29.0, services 14.8.0) and this repo's wallet entitlement `[so.oxy.wallet, group.so.oxy.shared]`; closes on devices once the native releases land in the doc's order (wallet before Commons 1.6.0 iOS)** |
| F6 | medium | The DID (and so the key) was cached 60 s by the SDK and `max-age=300` by the route | #254 (Peable reads the DID `no-store`); oxy#2183 (`resolveDid({ fresh: true })`, user DIDs `public, no-cache` + ETag) |
| F7 | medium | The personal wallet compared its key with the cursor's last-recorded key, not the published `#key-1` | #254 (`account_identity_public_key` on the cursor); #253 (compared first) |
| F8 | medium | Coins the wallet can no longer sign for broke every send | #253: excluded from selection, shown as held under a previous key |
| F9 | medium | Nothing re-checked a payment after it succeeded; confirmations defaulted to 1 | #255: mainnet defaults to 6, succeeded payments re-read to 100 confirmations and rewound on a reorg. One Explorer is still trusted (residual) |
| F10 | medium | `expires_in_seconds` unbounded | #255: 86,400 s cap in the contract |
| F11 | low | An empty `PEABLE_SOCIAL_PAY_NETWORK` opened mainnet | #255: empty means testnet |
| F12 | low | Settlement needs a payer-reported txid; split payments cancel as underpaid | Not fixed (recorded) |
| I1–I6 | accepted / theoretical | Departed admins keep the organization phrase; income is publicly linkable from the DID; no exploitable related-key ECDSA oracle; payer trusts the gateway's address; other apps cannot see social coins; no CHECK ties merchant environment to network | oxy#2183 stops exporting `deriveSocialReceiveKey` (a leaked child key plus the public chain code gives the identity key) |

### Round 2 (Peable `89942340`, oxy `04f80345f`): refused

Verified F2, F3 (to 2,000 indices), F6, F7, F8, F10, F11 fixed; F1, F4, F9
partially; F5 and F12 not. New:

- **N1 (high, blocks):** the wallet watches indices 0–1,999 and the gateway has
  no matching ceiling, so the 2,001st address of a recipient settles
  `succeeded` where the wallet never looks.
- **N2 (high, blocks):** concurrent confirms all pick the same recycling
  candidate outside the lock and every loser mints, so bursts grow the tree
  ~500 indices at a time; dusting addresses grows it for well under $1 per 2,000.
- N3 (medium): any confirmation-count dip rewinds a settled payment
  (double `succeeded` for integrations). N4 (low): a payment under a different
  txid is cancelled `abandoned`. N5 (low): closing the gate leaves open mainnet
  payments payable for up to 24 h.
- Address recycling: one payment cannot settle two intents; a late payment to a
  recycled address can settle the new holder's order (D9's written residual).

N1–N5 were fixed in #262. **Sign-off, per round 2, additionally needs the
owner's written acceptance** of: F5 (iOS keychain, or the
split shipped), F1's residual (no way to spend from a previous phrase in
Peable), F9's residual (one third-party Explorer decides settlement; a rewind
does not revoke fulfilment) and D9's recycled-address late-payer residual. The
owner's waiver of (2) and (3) does not cover these: they are risks the review
found, not prerequisites the owner set aside.

### Round 3 (Peable `0bcb4f5b`, oxy `c2e96b3df`): sign-off conditional on owner acceptances

N1 fixed: the gateway never mints index 1,980 or above, enforced in the
reservation's own statement (`db/social/receiveCursor.ts`), and every path
(merchant, seller, invoice, raw intent, split outputs, `@username`, recycled
addresses) goes through that cursor, so every address handed out is inside the
wallet's window (0–1,999). N2 fixed: each confirm leases a different recycling
candidate and a loser claims another under the lock before minting. N3, N4, N5
fixed. No code defect blocks mainnet. Three low findings (one dusted index
above the ceiling hides `@username`; the closed-gate retire path can cancel a
payment that was broadcast but not reported; the recycling query lacks an index
filter) plus an Explorer timeout and stale AGENTS.md lines go to a follow-up PR.

## (4) Testnet canary: passed

**The public FairCoin testnet has no chain to pay on.** On 2026-11-06
`explorer.fairco.in/api/stats?network=testnet` answers `blockHeight: 0,
connections: 0`, and `testnet-seed1/2.fairco.in` do not resolve. So the canary
ran its own testnet: the released `faircoind` v3.0.6 (FairCoinOfficial/FairCoin,
linux-x86_64) with `-testnet` — the testnet genesis `00000232cb13…a576e6` that
`@fairco.in/core`'s `TESTNET` names — no peers, `txindex` and `addressindex`
on, coins mined in the PoW phase by the canary's own node wallet. Nothing in it
is a human's key: the recipients' keys were generated for the run and thrown
away.

What ran for real: the gateway's own code against a real Postgres (social route,
Checkout Session routes, the live quote from the real Explorer price and the
ECB, address reservation, `reportFaircoinBroadcast` — what `submit_tx` calls —
and `SettlementWatcher` reading the chain through `services/explorer.ts`), the
payer's `@peable.to/pay` `sendPayment`, and the wallet's own
`social-receive.ts` / `social-receive-sync.ts` (key verdict, window plan,
per-index Explorer check, `signSocialReceiveInput`) with the holder's signing
done by `@oxy.so/core`'s `signSocialReceiveDigest` (the function the iOS SDK
runs and Commons' identity host reproduces natively). The FairCoin node judged
every transaction.

Stand-ins: the DID read (the recipients are not Oxy accounts, so
`useIdentityKeyResolver` answers their public keys; `#key-1` resolution itself
is covered by the review and `socialReceive.test.ts`); `explorerShim.ts` serves
the Explorer's endpoints from the node (the price endpoint is the real
Explorer's); the device's secure storage (item (3), waived).

Run on Peable `0bcb4f5b` (every review fix through #262), tip 68 → 76:

| When (UTC) | Step | Evidence |
|---|---|---|
| 07:13:23 | social: `POST /v1/social/canaryperson/next_address` | index 1, `TFqLPKpqFHdCeWqCTYPTNtD3prJNkMmY2N` |
| 07:13:23 | payer pays 25 FAIR | `4de6553a12270a0bb65dd2dea9e9c746a11f6d52320a0104121498a4c40bfff1` |
| 07:13:34 | EUR 12.50 session (person-owned merchant), confirmed with FairCoin at the live quote (0.4908 USD/FAIR, 1.1224 USD/EUR → 28.58438045 FAIR) | `pi_c69dbdde3de5a386565a76ed`, index 2 on the SAME cursor, `TKd1gHZg4tYVn3bLNfiidEfDGVqMyU3m8Q` |
| 07:13:34 | payer pays | `31ef87dc9db21908f28a912b323a3e501bff79476f78dd3fda28e28799866b7c` |
| 07:13:41 | watcher: `processing` → `succeeded` at 2 confirmations; session `complete` / `paid` | tip 72 |
| 07:13:41 | 15 FAIR session (organization-owned merchant) | `pi_d9f0cd404d2bc7c87aa5b356`, organization cursor index 1, `TFbFdQXh7QRB53TdbEwneqvpKpqBV7Xx84` |
| 07:13:41 | payer pays | `794a8dcd8169dbf03a009564221cbe1265f5d4aaf07ed21e580189b2e33a08cb` |
| 07:13:43 | watcher: `succeeded`; session `complete` / `paid` | tip 74 |
| 07:13:50 | the person's wallet: key `match`, window 0–22, indices checked through 22, rescan sent to 70, spends both coins | `6e37afa0b480ea878d0d5956e69e865a9e7677f20cb6443700a4a820520dd9ab`, confirmed at 75 |
| 07:13:59 | the organization's wallet (`{ accountId }` signing): key `match`, window 0–21, spends its coin | `df19b6d08897065fb6741a132f91b697020021ed3cc66bf7ca1029d5eacb3e54`, confirmed at 76 |

The same canary also passed on `9e0e1853` (before any fix, 03:54–03:57) and on
`89942340` (after #253–#255, 06:03–06:04); the recorded run is the one on the
final code. Full records: `canary-gateway.json`, `canary-wallet.json`.

What the canary does not prove: the production deployment's path to
`explorer.fairco.in` on testnet (there is no testnet there to read), the DID
read of a real Oxy account, and real device key storage.

To rerun: start a `-testnet` node with `txindex=1`, `addressindex=1`,
`rpcport` and credentials in its `faircoin.conf`; mine past coinbase maturity;
run `CANARY_NODE_CONF=<conf> bun src/__tests__/canary/explorerShim.ts 46480` in
`packages/backend`; then the gateway half
(`EXPLORER_BASE_URL=http://127.0.0.1:46480 CANARY_NODE_CONF=… CANARY_EVIDENCE_OUT=…
CANARY_PERSON_PUBLIC_KEY=… CANARY_ORG_PUBLIC_KEY=… bun test src/__tests__/canary/`
with the usual `TEST_DATABASE_URL`/`DATABASE_URL`) and the wallet half
(`CANARY_NODE_CONF=… CANARY_KEYS=… CANARY_GATEWAY_EVIDENCE=… CANARY_WALLET_EVIDENCE_OUT=…
bun test src/wallet/__canary__/` in `packages/frontend`). Both skip without
their variables, so CI never runs them.

## What the owner must still do

1. **Accept, in writing, the five risks round 3 names** (or have them fixed
   first). Each is one sentence the owner would be signing:
   1. F5 — "On iOS, any Oxy app can read the personal and organization identity
      private keys and recovery phrases that control mainnet FairCoin receive,
      and I accept that for mainnet money." (Alternative: ship the keychain
      split in `oxy/docs/identity/ios-keychain-access-groups.md`.)
   2. F1 — "After a personal key rotation, Peable has no way to spend coins
      received under the previous phrase; funds not moved before rotating are
      recoverable only outside Peable."
   3. F9 — "One third-party Explorer, on a chain with negligible stake weight,
      alone decides whether a payment settled or was reorganised, and a rewind
      never revokes fulfilment already granted."
   4. ADR 0021 D9 (late payer) — "A payer who pays a cancelled quote more than
      about an hour late, after its address was recycled, pays the new holder's
      order, and that holder may claim the transaction as their own payment;
      the coins remain the recipient's."
   5. D9 tree exhaustion — "Each recipient, including Oxy's own organization for
      all first-party products, has a lifetime budget of 1,979 FairCoin
      addresses that were actually used. An attacker can burn it for well under
      1 FAIR (or free with Oxy accounts, or during an Explorer outage), after
      which FairCoin is permanently unavailable for that recipient until a
      sparse watch set ships; cards are unaffected."

   **Update (2026-11-06, later): items 4 and 5 are fixed, not accepted.** The
   owner chose to fix them ("Fix F5, F1 and D9"): addresses are never recycled,
   the tree has no ceiling, and each recipient's wallet watches exactly the
   addresses the gateway handed out (`GET /v1/social/me/receive_addresses`),
   with abuse bounded by a daily per-recipient rate and per-payer limits (ADR
   0021 D9, replaced; ADR 0002's amendment "a sparse watch set replaces the
   bounded tree"). Items 1–3 still need the owner's acceptance or their own
   fixes. The canary records the synced set (`receiveAddresses` in the gateway
   evidence) and the wallet half watches exactly it; it has not been re-run on
   this change.
2. **Before opening**, a read-only production check that no mainnet
   `social_receive_cursors` row exists at or above the ceiling (mainnet minting
   was never open, so none should).
3. **Opening** (once accepted), the supported way: register a new `oxy-peable`
   revision from the RUNNING one with only `PEABLE_SOCIAL_PAY_NETWORK=mainnet`
   added, `update-service`, wait for a steady state and `/health` 200; mirror
   the variable in `oxy-infra` `terraform-uswest2/app-peable.tf`; flip
   `packages/frontend/src/pay/social-network.ts` `SOCIAL_PAY_NETWORK` to
   `mainnet` (web deploy + OTA) so the wallet agrees; then check, read-only,
   that a live order's FairCoin option no longer answers
   `faircoin_network_closed` (for the `oxy`-owned merchants it will answer
   `faircoin_wallet_missing` until an owner creates the organization's wallet in
   Commons).

