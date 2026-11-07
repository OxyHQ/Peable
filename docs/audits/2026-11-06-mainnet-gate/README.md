Mainnet gate for identity-wallet FairCoin receive (ADR 0002, ADR 0021 D5)
==========================================================================

2026-11-06. The owner's decision ("Do everything and open it"): run ADR 0002's
item (1), the security review, and item (4), the testnet canary, and open
mainnet as soon as both pass, without waiting for (2), the legal opinion, or
(3), physical-device verification. The waiver itself is recorded in ADR 0002
("Owner's mainnet waiver"). This folder is the evidence for (1) and (4).

**Result: the gate is NOT opened.** The owner decided the five round-3 risks
on 2026-11-06 — *"Fix F5, F1 and D9; accept F9"* (ADR 0002, "Owner's decision
on the round-3 risks") — and they were fixed and F9 accepted. Three further
review rounds (4–6) and their fixes followed; the canary passed on every final
code. The review does not sign off without conditions: R6 findings still to
verify (see "Round 7") and risks that only the owner can accept, listed word
for word at the end. Production keeps `PEABLE_SOCIAL_PAY_NETWORK` unset
(testnet; checked on the running `oxy-peable:264` on 2026-11-06), so a live
order's FairCoin option answers `faircoin_network_closed`
(`identityNetworkOpen`, `services/faircoin/recipient.ts`).

## (1) Security review

An independent `security-reviewer` agent was given the code (Peable, oxy,
`@fairco.in/core` 0.5.0), not the lead's conclusions, and asked to attack it as
an anonymous payer, a malicious merchant or marketplace, a malicious Oxy app on
the same phone, a departed organization admin and a network attacker.

### Round 1 (Peable `f191892c`, oxy `9c3e1a098`): refused

| ID | Severity | Finding | Fix |
|---|---|---|---|
| F1 | critical | A personal key rotation strands every Peable coin (the HD seed and the social tree both derive from the identity key); Commons said the old phrase "stops working"; open intents kept pre-rotation addresses and settled `succeeded` | oxy#2183 (Commons copy, required "move your Peable funds first" acknowledgement on both rotation paths); #254 (open payments under a replaced key are retired). No path spends from a previous phrase (residual). **Update (2026-11-06): the residual is fixed in code** — Commons keeps a replaced key (oxy ADR 0061 D7 as amended); Peable spends from it and offers a one-tap move to the current key (ADR 0002 "previous keys stay spendable"). Pending re-review and device verification |
| F2 | high | After an organization replaces its key, payments keep flowing to the replaced key | #254: every address records its key; stale-key payments are retired on every payer surface and by a 60 s sweep; a broadcast one settles stamped `recipient_key_replaced_at` |
| F3 | high | Payments beyond the watch window missed; cursor synced only at unlock; extensions never rescanned | #253: resync on foreground, every 2 min, on push and on Receive; every newly watched index checked on the Explorer and the SPV rescan rewound to it |
| F4 | high | Anyone can push a recipient's cursor without limit; the wallet freezes (`Math.max(...)` spread, Bloom saturation) | #253 (loop maximum, 2,000-index window, HD coins stay spendable); #255 (recycle unpaid addresses, 500 open per recipient, leaks closed) |
| F5 | high | On iOS every Oxy app can read the personal and organization private keys (shared keychain group) | Not fixed in round 1. oxy#2183 adds `docs/identity/ios-keychain-access-groups.md`, which finds it wider: `keychainAccessGroup` is never applied (expo-secure-store reads `accessGroup`), so the recovery phrases share the group too. **Owner chose the split (2026-11-06); shipped in oxy#2186 (ADR 0062; core 7.29.0, services 14.8.0) and this repo's wallet entitlement `[so.oxy.wallet, group.so.oxy.shared]`; closes on devices once the native releases land in the doc's order (wallet before Commons 1.6.0 iOS)** |
| F6 | medium | The DID (and so the key) was cached 60 s by the SDK and `max-age=300` by the route | #254 (Peable reads the DID `no-store`); oxy#2183 (`resolveDid({ fresh: true })`, user DIDs `public, no-cache` + ETag) |
| F7 | medium | The personal wallet compared its key with the cursor's last-recorded key, not the published `#key-1` | #254 (`account_identity_public_key` on the cursor); #253 (compared first) |
| F8 | medium | Coins the wallet can no longer sign for broke every send | #253: excluded from selection, shown as held under a previous key. **Update (2026-11-06, F1 work):** the exclusion stays for keys this device cannot reach, and the line now says how to reach them (add the previous phrase in Commons); reachable previous keys are signable and in the balance (ADR 0002 "previous keys stay spendable"). Fixed in code, pending device verification |
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

### The owner's decision on round 3 (2026-11-06)

*"Fix F5, F1 and D9; accept F9."* Fixed: F5 by the iOS keychain access-group
split (OxyHQ/oxy#2186, ADR 0062; Peable#268); F1 by keeping replaced keys for
spending (oxy#2187, ADR 0061 D7 amended; Peable#266); both D9 residuals by the
sparse watch set — addresses are never reused and there is no ceiling
(Peable#265, ADR 0021 D9 replaced). F9 accepted in writing (ADR 0002).

### Round 4 (Peable `0a829eb8`, oxy `a5db32590`): sign-off with conditions

Verified: no address can be handed to two payments or to a payment and an
`@username` sender; a retired key can only spend; an added previous phrase must
be this account's; the keychain migration cannot lose a key. Findings (one
blocking):

| ID | Sev | Finding | Fix |
|---|---|---|---|
| R4-1 | high (blocks) | A previous key's index 0 (the default Receive address) never reached the wallet on a new install | Peable#269 |
| R4-2 | medium | Dust made every funded address active; the Bloom set could pass its bound again (F4) | #269: 0.001 FAIR floor, at most 1,000 funded addresses in the filter |
| R4-3 | medium | One Oxy account dusting each address it gets burns a recipient's daily `@username` budget | #269: database-backed 5 per (sender, recipient) per day, half the budget kept for new senders |
| R4-4 | medium | The retired ring was device-only and wiped on "start over" | oxy#2190: carried in the encrypted identity backup |
| R4-5 | medium | Rotations before oxy migration 0235 are not in the key history | Not fixed (see round 6) |
| R4-6/7 | medium | Conflicting/planted shared-group items kept or adopted by the migration | oxy#2190: one-shot migration, marker-proven adoption |
| R4-8 | low-med | A cached BIP39 seed left in the shared group | #269 |
| R4-9…14, I-2 | low | Sync snapshot, Explorer timeouts, IPv6 limiter keying, batched moves, group spellings, `.dev` groups, gateway rows re-derived | #269, #270, oxy#2190 |

### Round 5 (Peable `b6f5eebd`, oxy `224198844`): refused

| ID | Sev | Finding | Fix |
|---|---|---|---|
| R5-1 | high (blocks) | The wallet took its own identity public key from the shared group any Oxy app can write, and showed its index-0 address before the key check | oxy#2192 (`getIdentityPublicKeyForMoney`); Peable#274: the wallet opens only a key the account vouches for, and nothing is receivable until the gateway confirms `#key-1` |
| R5-2 | high (blocks) | On a shared phone the next person could move the previous person's retired-key coins | oxy#2192: ring bound to its owner; Peable#274: one wallet per account (`oxy-user-<id>`), every candidate key history-checked |
| R5-3…R5-7, R5-9 | medium/low | Shared copies dropped on reinstall, another app's group allowed, dev builds moving production secrets, backup losing retired keys, unproven organization pairs, prompts | oxy#2193 (app-preset 6.4.0), oxy#2200 (core 7.36.0, Commons 1.10.0); Peable#279 |
| R5-8, R4-13 rest | low | Re-derivation cost, move plan changing at tap | Peable#274 |

### Round 6 (Peable `e0a2a987`, oxy `7d0914237`): sign-off with conditions

R5-1 and R5-2 verified fixed. New:

| ID | Sev | Finding |
|---|---|---|
| R6-1 | med-high (blocks) | After a rotation, Receive and Settings could offer the REPLACED key's HD address (address rows carried no key) |
| R6-2 | medium | The account that proves the legacy shared wallet database keeps the other account's rows |
| R6-3 | medium (blocks if a Commons 1.6–1.9 build ran on a phone) | A v1 migration record is never revisited |
| R6-4 | medium | A fresh Peable install adopts `fairwallet_*` items planted in the shared group |
| R6-5 | medium (blocks if production shows coins under a pre-0235 key) | Keys replaced before migration 0235 can no longer be claimed |
| R6-6 | medium | One failed ownership proof closes the legacy wallet for good |
| R6-7…R6-16 | low | Namespace-move race, backup kept across old-client rotations, owed-backup flag, key binding without history, fixed move fee, ring fallback, locked keychain read as absent, unbounded planted entries, signed-binary entitlement check, prompting device-session read |

Fixed in Peable#280 (R6-1 per-key address rows and one receive gate for
Receive and Settings; R6-2 only the proving account's rows survive; R6-4
adoption only with sandbox evidence of an earlier install; R6-6, R6-7, R6-11)
and #281 (packages), and oxy#2209 (R6-13, R6-16; core 7.38.0) and oxy#2211
(R6-3 v2 sweep; R6-5 `POST /identity/key-history/claim` and a backfill script;
R6-8 superseded backups; R6-9, R6-10, R6-12, R6-14, R6-15; core 7.39.0,
Commons 1.11.0).

### Round 7 (Peable `732e8a0e`, oxy `ccbd110f2`): sign-off with conditions

R6-1, R6-2, R6-3, R6-5 (in code), R6-9…R6-14 and R6-16 verified fixed; R6-4,
R6-6, R6-7, R6-8, R6-15 partly. New:

| ID | Sev | Finding |
|---|---|---|
| R7-1 | high (blocks) | `POST`/`DELETE /identity/backup` accepted any session bearer (no first-party gate) and an unbounded `version`: a third-party token could delete the only off-device copy of retired keys, or lock out every legitimate re-seal |
| R7-2 | medium (blocks) | A superseded backup could be overwritten without its retired keys being kept |
| R7-3 | medium (blocks) | After the upgrade, a used HD address behind 20 or more unused ones was never bound to the open key (its coin shown stranded) |
| R7-4…R7-12 | low/low-med | "Unavailable" read as "not this key"; global quarantine cap; the legacy move's narrow derivation; unencrypted-restore evidence and PIN adoption; offline open blocked by an unmoved legacy wallet; init not single-flight; owed-backup slot; unbounded organization ids; stale picked address |

Conditions besides code: a production dry-run and run of the R6-5 backfill
(counting pre-0235 keys no signed record proves), and two release facts —
whether Peable wallet 1.2–1.4 reached iOS users, and whether live third-party
OAuth clients or application-token hosts exist (R7-1's exposure).

Fixed in oxy#2212 (R7-1: both routes behind `requireFirstPartyDeviceAccess`,
`version` capped at 2), oxy#2213 (`f70b9c438`: R7-2 — a superseded backup is
replaced only by an upload naming it, and a rotation keeps the carried keys in
the ring first or does not rotate; R7-4, R7-5, R7-10, R7-11, the claim race)
and Peable#282 (`416620bd`: R7-3 — a public-only probe tree covers any gap;
R7-4, R7-6, R7-7, R7-8, R7-9, R7-12). A scoped re-check on those commits found
R7-1, R7-2 and R7-3 fixed and no new blocker.

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

### Reruns after the owner's decision (2026-11-06)

A fresh private testnet from the same released `faircoind` v3.0.6 (sha256
`f8bdc4e3…5e758d43` of `faircoin-v3.0.6-linux-x86_64.tar.gz`, genesis
`00000232cb13…a576e6`), new throwaway recipient keys and node credentials,
destroyed after the last run. The wallet half now watches exactly the set the
gateway syncs (`GET /v1/social/me/receive_addresses`, recorded as
`receiveAddresses`), not a window.

| Peable | Covers | Tip | Result |
|---|---|---|---|
| `0a829eb8` | sparse watch set (#265), previous keys (#266), wallet keychain split (#268) | 57 → 65 | passed |
| `b6f5eebd` | round-4 fixes (#269, #270) | 65 → 73 | passed |
| `e0a2a987` | round-5 fixes (#274, #279) | 73 → 81 | passed |
| `732e8a0e` | round-6 fixes (#280, #281; oxy#2209, #2211) | 81 → 89 | passed |

The final run, on `732e8a0e` (UTC, 2026-11-06), recorded in
`canary-gateway-final.json` and `canary-wallet-final.json` (the `e0a2a987` run
is kept as `canary-*-round6.json`):

| When | Step | Evidence |
|---|---|---|
| 23:42:31 | social `@canaryperson`: index 1 reserved, payer pays | `TQE69GkXWWbofrGHXhQBAJgDFZitKYu6KW`, `0d6680b208e53d7a651a30634e26a0dfdb19252c258be35cfef48f4e5ed09792` |
| 23:42:33 | EUR 12.50 session (person-owned), FairCoin at the live quote, index 2 on the same cursor; payer pays | `pi_edd0cd0995f331406f1c1ee8`, `TCLEC5eJxSbc9nM1UcwwAsfrWUaK7Xixbd`, `f8ca0de9dd77b8e1d63621cd0cd1f53d3baf350192757ba6244c584bf32a56b4` |
| 23:42:40 | watcher: `succeeded` at 2 confirmations; session `complete` | tip 85 |
| 23:42:40 | 15 FAIR session (organization-owned), organization cursor index 1; payer pays | `pi_e3a6111b8209be19accba8d9`, `TWqfRRqMMyLXBZNDD7ZRXr2nGehmnhSZG1`, `a8565f504bcf9c78bb6f096e133d4bc90f2e62d802e262246bd5a1bd4dd8b1b3` |
| 23:42:54 | watcher: `succeeded`; session `complete`; receive sets synced | tip 87 |
| 23:42:57 | person's wallet: key `match`, watches exactly {0, 1, 2}, finds both coins, spends them | `0d3a6d278a6b4e5b82f6878c5e7bcabe2bb6cf8e440d975e65a85f846bf05585`, tip 88 |
| 23:43:07 | organization's wallet (`{ accountId }`): key `match`, watches {0, 1}, spends its coin | `ed18c53f679b6d827fd87efa59867f2bc303905b2b801eeb201b20321908350c`, tip 89 |

The same addresses recur across the three reruns because each run starts from
an empty gateway database with the same throwaway keys; each run's wallet
spent that run's coins before the next run began. The canary does not
exercise spending under a retired key (unit-tested in Peable#266/#269/#274 with
every input's signature checked) or the iOS keychain (device-only).

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

The review (rounds 4–7) signs off with no code condition left. What remains is
the owner's alone. F9 is already accepted (ADR 0002). **The gate stays closed
until the owner does all of the following.**

1. **Accept, in writing, each risk below** — the exact sentences the review
   puts to the owner (round 7, final). Each is a property of the design as
   built, not a defect the code can remove:
   1. "Coins under a replaced identity key are spendable from Peable on a new
      phone only through the encrypted identity backup or that key's recovery
      phrase; a key replaced before 2026-11-06 (oxy migration 0235) is
      spendable again only once Oxy's own signed records prove it was this
      account's, through the backfill or Commons' claim, and a key no such
      record proves stays unspendable from Peable."
   2. "A payment to a Peable address more than a week old may take up to 30
      days after the address was last checked to appear in the recipient's
      wallet, a payment under 0.001 FAIR to such an address may never appear,
      and finding either depends on the one Explorer we already trust (F9)."
   3. "Identity keys and recovery phrases created on iOS before the keychain
      split were readable by every Oxy iOS app, and stay readable on any phone
      until Peable wallet 1.5.0 and Commons 1.12.0 are installed and launched
      there; we neither force nor require those identities to rotate."
      (The review's text names Commons 1.11.0; 1.12.0 carries R7-2's Commons
      side, as the review notes.)
   4. "On iOS the Peable wallet holds the personal root key, so the wallet and
      any update shipped through its OTA channel (signed with the shared Oxy
      update key) can rotate a person's identity, not only spend from it."
   5. "An attacker controlling about 300 Oxy accounts can refuse new @username
      senders to one person for a day at a time, and anyone opening 500 unpaid
      FairCoin checkouts a day from enough networks can make FairCoin
      unavailable for one merchant at a time; card payments are unaffected."
   6. "Rotating an identity key uploads a new encrypted backup of that
      identity, including its retired keys, even for a person who had deleted
      their backup."
   7. *Only if Peable wallet 1.2–1.4 reached iOS users:* "On an iPhone where
      Peable wallet 1.2, 1.3 or 1.4 ran, a wallet another Oxy app planted in
      the shared keychain group may be in Peable, and it receives payments only
      after the person confirms it as theirs."
   8. "When two accounts shared a phone's old wallet database, the account that
      proves it keeps the other account's contacts, recent recipients, address
      labels and Pocket names, and a database nobody proves stays on the phone
      unopened until someone removes it in Settings."
2. **Answer two release facts:** did Peable wallet 1.2–1.4 reach iOS users
   (decides sentence 7), and which third-party OAuth clients or
   application-token hosts are live (R7-1's past exposure; the route is gated
   now).
3. **Production, before opening:** dry-run, then `--apply`, oxy's
   `packages/api/scripts/backfill-personal-key-retirements.ts`, and record how
   many retired keys no signed record proves (sentence 1). No read-only path to
   either production database exists from an agent's machine (RDS is private,
   ECS exec is off), so this is the owner's step.
4. **iOS builds, in this order** (no iOS pipeline exists; entitlements are
   native, an OTA cannot ship them): Peable wallet 1.5.0, then Commons 1.12.0;
   run `bunx oxy-check-keychain-entitlements <bundle id> <.xcarchive|.ipa>` on
   each archive before upload. Until they are installed and launched on a
   phone, that phone keeps the pre-split exposure (sentence 3).
5. **Re-run the canary on the commit that opens** (the last run is on
   `732e8a0e`; Peable#282 changed the wallet after it), then **open**, the
   supported way: register a new `oxy-peable` revision from the RUNNING one
   with only `PEABLE_SOCIAL_PAY_NETWORK=mainnet` added, `update-service`, wait
   for a steady state and `/health` 200; mirror the variable in `oxy-infra`
   `terraform-uswest2/app-peable.tf`; flip
   `packages/frontend/src/pay/social-network.ts` `SOCIAL_PAY_NETWORK` to
   `mainnet` (web deploy + OTA) so the wallet agrees; then check, read-only,
   that a live order's FairCoin option no longer answers
   `faircoin_network_closed` (for the `oxy`-owned merchants it will answer
   `faircoin_wallet_missing` until an owner creates the organization's wallet
   in Commons). The tree has no ceiling any more, so round 3's "no mainnet
   cursor at or above the ceiling" check no longer applies.

Still waived, not done (ADR 0002): the legal opinion and physical-device
verification. Every keychain, migration and rotation path above is unit-tested
only; the review lists what only a device can prove.
