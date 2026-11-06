Mainnet gate for identity-wallet FairCoin receive (ADR 0002, ADR 0021 D5)
==========================================================================

2026-11-06. The owner's decision ("Do everything and open it"): run ADR 0002's
item (1), the security review, and item (4), the testnet canary, and open
mainnet as soon as both pass, without waiting for (2), the legal opinion, or
(3), physical-device verification. The waiver itself is recorded in ADR 0002
("Owner's mainnet waiver"). This folder is the evidence for (1) and (4).

**Result: the gate is NOT opened.** The canary passed. The security review
refused sign-off twice; the second refusal names two new code defects (being
fixed) and four risks only the owner can accept in writing. Production keeps
`PEABLE_SOCIAL_PAY_NETWORK` unset (testnet; checked on the running
`oxy-peable:248` at the start and `oxy-peable:256` after the fixes deployed), so the gateway still answers
`faircoin_network_closed` for a live order's FairCoin option
(`identityNetworkOpen`, `services/faircoin/recipient.ts`).

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
| F5 | high | On iOS every Oxy app can read the personal and organization private keys (shared keychain group) | Not fixed. oxy#2183 adds `docs/identity/ios-keychain-access-groups.md`, which finds it wider: `keychainAccessGroup` is never applied (expo-secure-store reads `accessGroup`), so the recovery phrases share the group too |
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

N1–N5 are being fixed in a follow-up gateway PR. **Sign-off, per round 2,
additionally needs the owner's written acceptance** of: F5 (iOS keychain, or the
split shipped), F1's residual (no way to spend from a previous phrase in
Peable), F9's residual (one third-party Explorer decides settlement; a rewind
does not revoke fulfilment) and D9's recycled-address late-payer residual. The
owner's waiver of (2) and (3) does not cover these: they are risks the review
found, not prerequisites the owner set aside.

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

Run on Peable `89942340` (every review fix through #255), tip 52 → 60:

| When (UTC) | Step | Evidence |
|---|---|---|
| 06:03:54 | social: `POST /v1/social/canaryperson/next_address` | index 1, `TDZy9KXSNu7qUVHW3ttMeh2vSUYkLaxweo` |
| 06:03:54 | payer pays 25 FAIR | `efc5a1400c05c30481524ccb74c5ed7c017caedd28e14d7473c5abcdb2b22fce` |
| 06:03:59 | EUR 12.50 session (person-owned merchant), confirmed with FairCoin at the live quote (0.4908 USD/FAIR, 1.1224 USD/EUR → 28.58438045 FAIR) | `pi_360e20dcbc412c4a3d20f344`, index 2 on the SAME cursor, `TFjSdJRfMSAYZwkMepMkrUnNAcpieQSChT` |
| 06:03:59 | payer pays | `4593335ca965eb3ffeff7e7d48bacbcb9f3785a73b36918ae64ce86166bf0cc9` |
| 06:04:05 | watcher: `processing` → `succeeded` at 2 confirmations; session `complete` / `paid` | tip 56 |
| 06:04:05 | 15 FAIR session (organization-owned merchant) | `pi_89b2148eaa5450926644c3ca`, organization cursor index 1, `TS4H12P3LtEADM8GoF6uBU5GwqQ7bB7K8Q` |
| 06:04:05 | payer pays | `7d68508c0f40b933ae29c66b0699469ef5fc896a27f650b0e205f5910bb2c0be` |
| 06:04:10 | watcher: `succeeded`; session `complete` / `paid` | tip 58 |
| 06:04:14 | the person's wallet: key `match`, window 0–22, indices checked through 22, rescan sent to 54, spends both coins | `5b1d90757c4a91ca6505056e1821aed494d342aa499cb0a23acb62c98c24ed0c`, confirmed at 59 |
| 06:04:18 | the organization's wallet (`{ accountId }` signing): key `match`, window 0–21, spends its coin | `88865c7c153d0eef066120b0597597b8b3fcb9beb41cb7da434852ab524c2bff`, confirmed at 60 |

The same run had passed on `9e0e1853` (before the fixes) at 03:54–03:57; the
recorded one is the run on the fixed code. Full records: `canary-gateway.json`,
`canary-wallet.json`.

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
