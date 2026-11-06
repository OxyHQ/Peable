# ADR 0002: Social receive is bound to ONE identity key, and every side says which

- **Status:** Accepted
- **Date:** 2026-09-16
- **Supersedes nothing.** It writes down finding F-1, which until now existed
  only as three code comments (`src/pay/social-network.ts`,
  `src/pay/profile-route.ts`, `app/(tabs)/[username].tsx`) and had no record
  anywhere in `docs/`.
- **Scope:** pay-by-`@username` (social receive). **Amended by ADR 0021 D5
  (2026-11-06):** merchant and marketplace-seller payments now derive from the
  same identity key and the same cursor — the owning account's Peable wallet —
  and the registered-xpub path is removed, so every rule below binds them too.
  **Amended 2026-11-06 (below):** every address records its key, a payment
  under a replaced key is never offered again, and keys are resolved fresh.

## Context

Paying `@alice` needs an address, and there is no registration step for an
ordinary user: the address is derived from the secp256k1 identity key her Oxy
DID publishes. The payer's gateway resolves that key and derives `addr(i)`;
Alice's wallet derives the same tree from the private half and watches it.

That works exactly as long as both sides mean the SAME key. Three things broke
that, all silently, because an address nobody watches is indistinguishable from
nobody having paid:

1. **A key rotation reached only one of the two slots a device keeps.** Oxy
   stores the identity key in a per-app primary slot and a cross-app SHARED
   slot. `rotateKey` wrote the primary; every money reader — `deriveScopedSeed`,
   which is where this wallet comes from — reads the shared one first. After a
   rotation the DID published one key and the wallet derived from the other.
   This is finding F-1, and it is why `SOCIAL_PAY_NETWORK` was pinned to
   testnet.
2. **The backend recorded only an index.** `social_receive_cursors` said how
   many addresses had been minted and nothing about the key that produced them,
   so no side could detect the disagreement even in principle.
3. **The gate lived in the client.** `decideProfilePayAction` refused mainnet;
   the route accepted `network: "mainnet"` from any authenticated caller.

## Decision

**One key, everywhere, and every side states which one.** No second address
tree, no sweeping funds out of a previous key, no "which key was this?"
heuristics.

- **Oxy** (`@oxy.so/core`): a rotation writes the shared slot too, before the
  primary, so a crash between the two writes leaves the money path on the
  rotated key and the primary stale — which fails loudly at the next signature
  instead of quietly misdirecting funds. `syncSharedIdentity` (renamed from
  `migrateToSharedIdentity`) repairs a shared slot holding a different key, and
  Commons calls it on every boot instead of returning early whenever the slot
  was merely non-empty. `KeyManager.getIdentityKeyState()` reports both slots
  and which key money derives from.
- **Gateway**: `resolveIdentityPublicKey` takes the account's own `#key-1` by
  name rather than whichever secp256k1 method the document listed first.
  `social_receive_cursors.identity_public_key` is NOT NULL and is written on
  every reservation; `GET /v1/social/me/cursor` returns it.
- **Wallet**: the persisted watch window records the key it was derived from and
  is re-derived, not extended, when that key is not the one the device holds.
  The cursor sync compares the backend's key with the device's; on a mismatch
  the device stops — it publishes no social receive address, and `ReceiveSheet`
  stops offering `@username`, because a handle that resolves to a tree this
  wallet cannot see is an invitation to lose money.
- **Network gate**: `PEABLE_SOCIAL_PAY_NETWORK` (default `testnet`) decides
  server-side which network may mint social addresses. A deployment that never
  sets it stays closed, whatever the client does.

## Consequences

- The client flip (`SOCIAL_PAY_NETWORK`) is no longer the only thing standing
  between a payer and mainnet, and it is no longer sufficient on its own: the
  deployment has to say so too.
- Cursors created before the key column are deleted by migration `0009`. A
  cursor is a counter, not money — reservations live in
  `social_send_attributions` — and Peable has no users, so what it clears is
  test counters whose key is not recoverable from anything stored.
- **Rotating an identity key still leaves behind whatever was received under the
  previous one.** Social-receive addresses are a function of the key, so funds
  paid before a rotation are spendable only from the previous recovery phrase.
  Nothing here changes that, and no code pretends otherwise; with no users and
  no funds it is recorded rather than engineered around. When there is money at
  stake the honest fix is to say so before the rotation ("move your funds first,
  keep the previous phrase"), not to silently maintain two trees.

## Amendment (2026-11-06): every address is bound to its key

An independent security review refused mainnet sign-off on three gaps the
cursor key above does not close: after a key rotation (a person's) or a key
replacement (an organization's, whose previous key a departed admin may hold),
open FairCoin payments kept their pre-rotation addresses and settled to
`succeeded` into a key the recipient no longer holds; reservations for up to a
minute after a rotation derived from the old key (the SDK caches the DID
document) and wrote it back onto the cursor; and the wallet could only compare
its key with the cursor's last-recorded one.

- **Every address records its key.** The key a FairCoin address was derived
  from is stored with it: `payment_intent_outputs.identity_public_key` per
  output, `payment_intents.faircoin_identity_public_key` for output 0, and
  `social_send_attributions.identity_public_key` (lowercase hex of the DID's
  `#key-1`, migrations `0099`–`0101`). Rows written before have none.
- **Keys are resolved fresh.** `resolveIdentityPublicKey`
  (`services/socialReceive.ts`) no longer calls `oxy.identity.resolveDid`, whose
  60 s cache the SDK cannot bypass: it fetches `GET /u/:id/did.json` itself
  through Oxy's workload transport, `cache: 'no-store'` and `Cache-Control:
  no-cache`, with the same `#key-1`-by-name rule. Every reservation, the
  settlement check and the sweep read it fresh; only a payer READ may reuse a
  read up to 5 s old (`services/faircoin/keyBinding.ts`).
- **A payment under a replaced key is never offered again.** One module,
  `services/faircoin/keyBinding.ts`, compares each output's recorded key with
  its recipient's current `#key-1`. A payment still waiting for the payer
  (`requires_action`, nothing broadcast) whose key was replaced — or which
  predates recorded keys and so cannot show it is current — is canceled
  through `transitionIntent` with the new closed reason
  **`recipient_key_changed`**. The Checkout Session or invoice wrapping it
  forgets it in the same transaction and stays open (the path ADR 0021 D3 gives
  a lapsed quote), so the payer's next confirm reserves a fresh address from the
  new key. Every payer surface checks before it answers — the session's payer
  routes (read, edit, confirm; a payment link's visits are sessions), the
  invoice's `/pay`, the intent's client-secret read — and a sweep every minute
  (`.unref()`-ed) retires the rest. When Oxy cannot be asked, nothing changes
  and the next sweep looks again.
- **A payment already broadcast under a replaced key settles, and says so.** The
  watcher reads the keys fresh before it ever writes `succeeded` (and waits for
  its next poll while Oxy cannot answer); the sweep checks `processing` ones
  too. Either stamps `faircoin_recipient_key_replaced_at` in a transition's own
  statement, on the wire as `faircoin.recipient_key_replaced_at`, so the
  payment's later events — `payment_intent.succeeded` included — carry it.
  *Why settle rather than hold or cancel:* the payer paid exactly the address
  Peable handed out, the transaction is final, and Peable holds nothing it
  could return. The coins are at an address of the recipient's PREVIOUS key —
  spendable with that key's phrase, by whoever still has it. Withholding
  `succeeded` would leave a completed payment in a state nothing resolves and
  move no coin; canceling it would tell the payer they did not pay. What must
  not happen is saying so silently: the stamp is what lets the merchant decide
  about fulfilment and the recipient recover the funds with the previous phrase
  (or, for an organization, treat the former key holder as having received
  them).
- **The wallet compares against the published key.** `GET /v1/social/me/cursor`
  also answers `account_identity_public_key`: the caller's current `#key-1`, read
  fresh, in the same encoding as `identity_public_key` (which stays the key of
  the LAST reservation). A device compares its key with the new field; a 503
  means Oxy could not be asked, never "keyless".

Residual windows, recorded rather than hidden: a payer who broadcasts in the
seconds between a rotation and the next check pays the previous key (the
stamp above), and one who broadcasts after the payment was retired is refused
by `submit_tx` like any payment that ended, with the coins at the previous
key's address. A subscription checkout whose first payment is retired starts
its subscription again on the next confirm, exactly as a lapsed quote does.

## Amendment (2026-11-06): the tree is bounded (ADR 0021 D9)

The cursor grows with real payments, not with requests. A payment's address is
recycled from the recipient's own cancelled, chain-unused addresses (still
derived from its current key) before an index is minted, at most 500 of a
recipient's addresses are open at once, and a sender asking again for an
`@username` it has not paid is handed the address it already holds. The
wallet's scan (`reserved_through` plus its window) stays a size it can carry.


## Amendment (2026-11-06): the tree stops where the wallet stops, and a closed gate retires

The security review's second round refused mainnet again (ADR 0021 D9, D10,
amended the same day). Two of its fixes bind this ADR:

- **One bound for both sides.** The wallet watches a contiguous window of
  `SOCIAL_RECEIVE_MAX_WATCHED` indices and reaches `SOCIAL_RECEIVE_GAP_LIMIT`
  past the highest reserved; the gateway never mints an index `≥
  SOCIAL_RECEIVE_INDEX_LIMIT` (`MAX_WATCHED − GAP_LIMIT`) — refused in the
  cursor's own statement — so every address handed out, payment or
  `@username`, is one the recipient's wallet watches. The constants live in
  `@peable.to/contracts/vocabulary/receiveTree` and the wallet imports them.
- **Closing the gate retires what it opened.** Setting
  `PEABLE_SOCIAL_PAY_NETWORK` back to `testnet` used to leave open mainnet
  payments payable until they expired (up to 24 h). The retire path above now
  also cancels an identity payment on a network the deployment does not open
  that nobody has broadcast to, with the new closed reason
  **`faircoin_network_closed`** — at every payer surface before it answers and
  in the minute sweep, with no key read — and its order stays open, answering
  `faircoin_network_closed` on the next confirm. A broadcast payment settles.

## Still required before mainnet

Unchanged by this ADR, and none of them are code (the owner waived the second
and third on 2026-11-06 — see the next section):

- the `security-reviewer` sign-off the design spec makes mandatory (§7), on the
  identity key being reused for money;
- the EU crypto/fintech legal opinion (`docs/PEABLE-ROADMAP.md`);
- physical-device verification including a rotation mid-flow, on a device with
  the shared-identity slot and on one without it;
- an end-to-end testnet canary of the social path.

## Owner's mainnet waiver (2026-11-06)

**Who and when.** The product owner (Nate I.), explicitly, on 2026-11-06:
*"Do everything and open it."*

**What.** Run the security review and the end-to-end testnet canary now, and
open mainnet identity receive (`PEABLE_SOCIAL_PAY_NETWORK=mainnet`, which also
opens ADR 0021's merchant, organization and seller receive) as soon as BOTH
pass — **without** waiting for:

- the EU crypto/fintech legal opinion, and
- physical-device verification (including a rotation mid-flow, with and
  without the shared-identity slot).

Those two are waived by the owner, not done. They stay undone, and opening
mainnet without them is the owner's accepted risk: no lawyer has said whether
receiving FairCoin into these wallets needs a licence or registration, and no
one has watched a real phone keep and spend its keys through a rotation. The
waiver does not touch the other two items: the gate opens only on a
`security-reviewer` sign-off and a passing canary.

**Where it stands** (evidence: `docs/audits/2026-11-06-mainnet-gate/`):

- **Canary: passed** — on a private FairCoin testnet, because the public one has
  no chain (the Explorer reports height 0 with no peers; its DNS seeds do not
  resolve). Social, EUR-priced merchant and organization-owned merchant
  payments were reserved, paid, settled by the watcher and spent by the
  recipients' wallets on Peable `0bcb4f5b` (every fix through #262).
- **Security review: signed off conditionally.** Rounds 1 and 2 refused;
  their findings were fixed in #253, #254, #255, #262 and OxyHQ/oxy#2183.
  Round 3 (Peable `0bcb4f5b`) found no blocking code defect and signs off
  **conditional on the owner's written acceptance** of five risks this waiver
  does NOT cover: iOS keychain sharing of identity keys and recovery phrases
  (F5); no path in Peable to spend from a previous phrase after a rotation
  (F1); one third-party Explorer deciding settlement, with a rewind never
  revoking fulfilment (F9); a late payment to a recycled address settling the
  new holder's order (ADR 0021 D9); and a recipient's lifetime budget of 1,979
  used addresses, which an attacker can exhaust cheaply, after which FairCoin is
  permanently unavailable for that recipient (ADR 0021 D9). The exact sentences
  are in the audit record.
- **Gate: closed** until those acceptances are written down here. Production
  leaves `PEABLE_SOCIAL_PAY_NETWORK` unset (testnet), and the wallet's
  `SOCIAL_PAY_NETWORK` stays `testnet`.

