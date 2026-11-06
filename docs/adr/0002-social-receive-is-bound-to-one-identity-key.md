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
  **Amended 2026-11-06 ("previous keys stay spendable", below):** coins
  received under a previous key stay spendable from Peable, and the wallet
  offers to move them to the current key.

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
heuristics. *(The first two are superseded for SPENDING by the amendment
"previous keys stay spendable" below: payers are still only ever handed
addresses of the one current key, but the wallet signs for, and offers to
move, what a previous key received. No heuristic was added — every address
names its key.)*

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
- ~~**Rotating an identity key still leaves behind whatever was received under the
  previous one.** Social-receive addresses are a function of the key, so funds
  paid before a rotation are spendable only from the previous recovery phrase.
  Nothing here changes that, and no code pretends otherwise; with no users and
  no funds it is recorded rather than engineered around. When there is money at
  stake the honest fix is to say so before the rotation ("move your funds first,
  keep the previous phrase"), not to silently maintain two trees.~~
  *Superseded 2026-11-06 by "previous keys stay spendable" (below): Commons
  keeps the replaced key and Peable spends from it, then moves it to the
  current key.*

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
  spendable with that key, by whoever still has it (since "previous keys stay
  spendable" below, from the recipient's own Peable wallet whenever Commons
  kept the key or the previous phrase is added there). Withholding
  `succeeded` would leave a completed payment in a state nothing resolves and
  move no coin; canceling it would tell the payer they did not pay. What must
  not happen is saying so silently: the stamp is what lets the merchant decide
  about fulfilment and the recipient recover the funds under the previous key
  (or, for an organization, treat the former key holder as having received
  them — they hold that key too).
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

*Superseded the same day by "a sparse watch set replaces the bounded tree"
below: nothing is recycled any more, and the cap is a daily rate.*

The cursor grows with real payments, not with requests. A payment's address is
recycled from the recipient's own cancelled, chain-unused addresses (still
derived from its current key) before an index is minted, at most 500 of a
recipient's addresses are open at once, and a sender asking again for an
`@username` it has not paid is handed the address it already holds. The
wallet's scan (`reserved_through` plus its window) stays a size it can carry.


## Amendment (2026-11-06): the tree stops where the wallet stops, and a closed gate retires

The security review's second round refused mainnet again (ADR 0021 D9, D10,
amended the same day). Two of its fixes bind this ADR (the first, the ceiling,
superseded the same day by the sparse watch set below; the second stands):

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

## Amendment (2026-11-06): retiring needs the chain's word; dust cannot pause `@username`

The security review's third round (low findings):

- **"Nobody broadcast" was "nobody reported a txid".** Both retire paths above
  — a replaced key and a closed network — canceled a payment with no reported
  txid, though its payer's wallet may have broadcast and not reported yet; the
  coins then reached the recipient while the order went unpaid. Now neither
  retires until the Explorer shows every address of the payment unused
  (`getAddressUsage`, `services/faircoin/keyBinding.ts`). One it shows used is
  left payable, its txid reportable, until it expires as any payment does. On
  mainnet an Explorer that cannot tell — an outage, or a read past its timeout
  (every Explorer read is now bounded) — retires nothing, and the next sweep
  asks again. Testnet's node has no address index and can only answer
  `unknown`, so there the reason alone decides, as for ADR 0021 D10's lost
  broadcast. The residual, recorded: coins someone sends to such an address
  (dust included) keep that payment payable until it expires, at most 24 h.
- **A used index does not cap the wallet** (superseded the same day: with the
  sparse watch set nothing caps the wallet or `@username`). Addresses above the gateway's
  ceiling derive from the public key, so anyone can send dust to index
  1 980–1 999. The wallet's window still reaches a used index (up to the
  bound), but `capped` — which hides `@username` — follows the RESERVED index
  only (`planSocialReceiveWindow`), since the gateway never hands out one at or
  above `SOCIAL_RECEIVE_INDEX_LIMIT`.

## Amendment (2026-11-06): a sparse watch set replaces the bounded tree (ADR 0021 D9)

The owner's decision ("Fix F5, F1 and D9"), closing the two residuals round 3
asked the owner to accept — a late payment to a recycled address settling
another order, and a lifetime budget of 1 979 used addresses per recipient:

- **No second use of an address, no ceiling.** Every payment and every
  `@username` request takes a fresh index of the recipient's one cursor; a
  cancelled payment's address is never handed out again. The cursor's statement
  no longer carries `SOCIAL_RECEIVE_INDEX_LIMIT`, and
  `@peable.to/contracts/vocabulary/receiveTree` (`SOCIAL_RECEIVE_MAX_WATCHED`,
  `SOCIAL_RECEIVE_GAP_LIMIT`, `SOCIAL_RECEIVE_INDEX_LIMIT`), the error code
  `faircoin_receive_tree_full` and Orbit's "nearly full" warning are removed
  (contracts, shared-types and the SDK 6.0.0).
- **The wallet watches exactly the addresses handed out**, synced from
  `GET /v1/social/me/receive_addresses` — not `0 .. reserved_through + gap`.
  Each address arrives with the key it derives from, and the wallet watches
  (and signs for) those of the key it holds; addresses of another key are kept
  with their key rather than deleted, which is what lets a wallet that holds a
  previous phrase find what that key received (the F1 work). `GET
  /v1/social/me/cursor` keeps answering the keys this ADR compares; its
  `reserved_through` no longer sizes anything.
- **An `@username` address is recorded in the reservation's own
  transaction**, under the recipient's lock and its daily bound (ADR 0021 D9).
  Before, the attribution was written after the cursor had committed, and a
  failed write left an address handed out with no record.

The design, the wallet's tiers and the abuse bound are ADR 0021 D9.

## Amendment (2026-11-06): previous keys stay spendable

The owner's decision (2026-11-06, "Fix F5, F1 and D9", and explicitly for F1:
after a personal key rotation or an organization key replacement, coins
received under the previous key must remain spendable from Peable). It closes
mainnet gate finding F1's residual — "no path in Peable to spend from a
previous phrase; funds not moved before rotating are recoverable only outside
Peable" — and replaces F8's stranded line with a path.

**Where the key comes from (the oxy half).** Commons keeps a replaced private
key on the device in a per-account ring — the person's, and one per
organization — on a rotation (`oxy.identity.rotateKey`), on an organization
key replacement, and when the person adds a previous recovery phrase
(personal: Backup & recovery → Previous keys; organization: "Add the key you
were given", which accepts a previous phrase too, and only when Oxy's key
history names it as one of the account's retired keys). A retired key never
signs in, publishes, receives a new reservation or rotates. Peable reaches
it exactly as it reaches the current key — by derivation, never by export —
through the `publicKey` selector of `KeyManager.deriveScopedSeed` and
`KeyManager.signSocialReceive`, which answer for the account's key whose
public key that is (current or retired) and `null`, never another key, when
this device cannot reach it. On Android the answer comes from Commons'
identity host (wallet only), on iOS from the keychain group. That half is oxy
ADR 0061 D7 as amended 2026-11-06 and `@oxy.so/core` `crypto/retiredKeys.ts`.

**Which keys.** Every address the gateway handed out records the key it
derives from (`identity_public_key` on `GET /v1/social/me/receive_addresses`,
ADR 0021 D9), and the wallet stores every row with its key. A previous key is
any recorded key, canonicalised (compressed and uncompressed are one key),
that is neither the key this device's wallet derives from nor the account's
published `#key-1`. Commons' own list (`listRetiredIdentityKeys`) is added as
a hint only — it is how a key that only ever received to its HD tree is found
— and never the authority (`packages/frontend/src/wallet/previous-keys.ts`,
`groupPreviousKeys`).

**Reachable keys are spendable, through the one dispatch.** For each previous
key the wallet asks `deriveScopedSeed(PEABLE_SEED_INFO, { accountId?,
publicKey })`. A seed means the key is reachable: it builds that key's HD tree
(the Pocket's account, like the current one) and zeroes the seed at once;
nothing is persisted but the key's public half and its tree's cursors
(`previous_key_trees`). The tree joins the Bloom filter with its gap window;
its social-receive rows join D9's tiers (active, or read through the Explorer
on the doubling schedule). A newly reached tree is first advanced over what
the device already stored, then discovered through the Explorer by gap limit
(a spent-out address counts as used), and the rescan is sent back to its
lowest unspent coin — or, when the Explorer cannot tell (testnet's
index-less node), to the wallet's birthday, which is how a restored HD
wallet discovers. Every send signs input by input with the key that owns it
(`signWalletInput`): the current or a previous tree locally, a social-receive
address by the holder with `{ publicKey }` for a previous key. A transaction
mixing current-HD, previous-HD and previous-social inputs is tested input by
input against the right public key.

**In the balance, named apart.** Reachable previous-key coins are in
`balance` — a send can sign for them, so leaving them out would make Send's
Max exceed the balance shown — and selectable like any other. F8's rule is
unchanged and still enforced: the balance never includes a coin the wallet
cannot sign for. `previousKeyBalance` names the part under a previous key, and
the home screen shows it on its own card with the move.

**Move to the current key: an explicit, prominent prompt, not automatic.**
Whenever previous-key coins exist the home screen says how much, that anyone
else who holds the previous key can spend them too, and — for a rotation done
because the key or phrase may have been exposed — to move them now. One tap,
then a confirmation with the amount and the network fee, moves every
confirmed previous-key coin to a fresh address of the current key in one
transaction with no change (`planPreviousKeyMove`; fee as for any send; what
would not exceed the dust threshold after the fee is refused as not worth
moving). It is not automatic because a move spends a fee the person did not
choose and would surprise them; it is prominent and repeated because after a
compromise it must happen at once. It is refused while this device's key is
not the account's current one (the move would land on a replaced key).

**Unreachable keys keep F8's exclusion, with a path.** Coins under a previous
key this device cannot reach stay out of the balance and are never selected,
and the line now says how to spend them here: add your previous recovery
phrase in Commons (personal) / add the organization's previous phrase in
Commons (organization). The wallet asks again on its refresh interval, on
foreground and on a push, so a key added in Commons is reached within minutes.
No copy says the coins are recoverable only outside Peable.

**What this cannot fix, recorded honestly.** A retained key that was
compromised is also the attacker's. Keeping it makes the coins under it
spendable from Peable again; it cannot make them safe. The move to the current
key races whoever else holds the previous key — for an organization, a
departed admin who kept the phrase — and that race is inherent to a key that
leaked, not something code can win in advance. Also recorded: a previous
key's social-receive row first synced while the wallet is open is watched from
the next open; a previous key's other Pockets are discovered when that Pocket
is opened; the web build has no keys and so nothing to move; and none of this
has been verified on a physical device (item (3) of the gate, waived by the
owner, still undone).

## Amendment (2026-11-06): review round 4 — every previous key's index 0, a checked key list, batched moves

The fourth security review (findings R4-1, R4-13, R4-14, I-2) found the
previous-key work above incomplete in four places, each fixed in the wallet:

- **Every reachable previous key's index 0 is watched (R4-1, blocking).** The
  gateway never hands out index 0, so no row it lists names it, and a phone
  that rotated and was then reinstalled or replaced gave a Commons-listed
  previous key an empty row list: coins at the old key's default address — the
  one its Receive sheet and saved QR codes showed — were in no balance, no
  stranded line and no move, even with the old phrase added.
  `groupPreviousKeys` now gives every group its key's index-0 row (origin
  `default`), and `watchPreviousSocialRows` persists it before reading, so the
  next resync reads it through the Explorer at once. Tested from an empty set.
- **Commons' list is checked against the account (R4-14).** A key Commons lists
  (or a tree stored from one) is opened only when the account's own key history
  names it — the person's `identity.keyHistory()`, the organization's key list
  (`accounts.identityKey.get`); keys the gateway recorded on the account's
  addresses need no check. With no history to ask, such a key waits.
  (`previousKeyCandidates`.)
- **New rows of an open previous key are watched at once (R4-14)**, not on the
  wallet's next open, and **every gateway row is re-derived from its key at
  its index before it is stored**; one that does not reproduce its address is
  dropped and logged (I-2).
- **The one-tap move is batched (R4-13).** One move spends at most 500 inputs
  (about 74 000 bytes; ~670 would pass the 100 000-byte standard size and no
  node would relay it), largest coins first; the prompt stays while coins are
  left.

## Amendment (2026-11-06): review round 5 — the wallet's key is vouched for, each account has its own wallet

The fifth security review found two blocking defects and three smaller ones in
the wallet (findings R5-1, R5-2, R5-7, R5-8, R5-10, and the remainders of R4-5
and R4-13). Fixed in the wallet:

- **The wallet's key is decided, never read from a shared store (R5-1,
  blocking).** The wallet took its identity public key from
  `KeyManager.getSharedPublicKey`, which on iOS reads the keychain group every
  Oxy app can write, and showed index 0 before the gateway's key check, keeping
  it when the check failed: a malicious or OTA-compromised Oxy app could make
  the Receive QR show its own address. Now `wallet/identity-key.ts` decides the
  key an identity wallet opens with, from what the ACCOUNT vouches for: its
  current `#key-1` as Oxy answers it now; else the key the wallet last opened
  with, stored in its own SQLite file (never a keychain group) and still in the
  account's key history; else the key the device says it holds, only when the
  account's history names it. Possession is proven by the selector: every seed
  derivation and every social-receive signature names its key
  (`deriveScopedSeed` / `signSocialReceive` with `publicKey`), which reaches
  only that key. Offline, only the stored key opens; with none, the wallet does
  not open (`unverified`, retried from the entry screen) rather than open on a
  key nobody vouched for. The device's own read is a hint and nothing more.
- **Nothing is receivable until the gateway confirms the key (R5-1, R5-7).**
  `identityReceiveConfirmed` is true only once the gateway's cursor, read for
  this wallet's account since it opened, names the open key as `#key-1`. Until
  then, and on any mismatch, the Receive sheet shows no `@username`, no
  address, no QR and no address list — for the main Pocket, every other Pocket
  (`confirmPocketReceive`) and organization wallets alike — and the one-tap
  move of previous-key coins is blocked. A confirmation made since the wallet
  opened survives a resync that could not ask; a contradiction never does.
- **Each person's wallet is their account's (R5-2, blocking).** Every person's
  identity wallet on a phone was one SQLite namespace, `oxy-identity`; stored
  previous-key trees opened with no history check and local `social_receive_set`
  keys vouched for themselves, so after A rotated and B signed in on the same
  phone, B could see and move A's old-key coins. The person's wallet is now
  `oxy-user-<accountId>` (organizations stay `oxy-org-<accountId>`), and every
  per-wallet store follows the id: the SQLite files (each Pocket's), the
  social-receive set, the previous-key trees, and the Pockets, active-Pocket and
  notification preferences. A previous key now opens only when the account
  vouches for it: Commons' list, every stored tree and every row the device
  derived itself are checked against the account's key history; the only keys
  that vouch on their own are those on rows the GATEWAY handed out to this
  account (`origin = 'gateway'`, pulled while the session acts as the wallet's
  account). A stored tree records the account that vouched for it
  (`previous_key_trees.vouched_for`) and opens on load only for that account.
- **The legacy namespace moves once, to its proven owner.** On the first open
  for a personal account after the upgrade, `oxy-identity` is moved only if the
  account proves it: the HD addresses the legacy database stores must include
  one derived from a key Oxy names as the account's now (current or in its
  history) and that this device holds. Then each Pocket's database is copied
  whole (`VACUUM INTO`) to `oxy-user-<accountId>`, stripped of every
  social-receive row and previous-key tree under a key the account never had,
  its gateway pull restarted (the full set is read again for the session's
  account) and every stored tree's voucher cleared; the per-wallet preferences
  follow; a kv-store marker (`peable_identity_namespace_v1`, not a wallet key,
  so the keychain move never adopts it) records the move; then the legacy files
  are deleted. A legacy namespace with no wallet data is deleted. One the
  account cannot prove stays closed for that account and is never opened as
  anyone's (another account on the phone may still prove it). The proof needs
  Oxy's answer: offline, the first open after the upgrade waits (`unverified`).
  Coins of another account's HD tree left in the moved file are not spendable
  (no key reaches them) and can show in the stranded line until spent elsewhere.
- **The full re-read derives only what is new (R5-8).** A gateway row already
  stored with the same address, index and key is not derived again
  (`splitKnownRows`); only new or changed rows are verified.
- **The move spends exactly what was confirmed (R4-13).** The confirmation
  dialog captures the plan (inputs, amount, fee, rate); the tap re-plans and is
  refused (`previous-key-move-changed`, "review and confirm again") when the
  coins, amount or fee differ, and the built transaction must pay exactly the
  confirmed fee before anything is signed.
- **R5-10, documented, not changed.** An attacker can create up to 500 open
  payment addresses per day for a recipient (ADR 0021 D9's open bound) and so
  crowd a real recent address out of the Bloom filter's recent slots
  (`SOCIAL_RECEIVE_ACTIVE_MAX`). Prioritising addresses with an open payment
  would not help: the attacker's addresses are open payments too, so the sync
  route gains no field. Nothing is lost — every gateway row is still read
  through the Explorer on D9's schedule, never-read rows first, and a coin found
  there rewinds the scan — the payment is seen later, not missed.
- **R4-5, what remains.** Rotations before oxy migration 0235 are not in the
  account's key history. Such a key is still opened, without the history, when
  the GATEWAY recorded it on one of this account's addresses: the gateway
  recorded each address under the `#key-1` it derived from, and that row
  vouches. Once open, its index 0 and HD tree are watched and discovered like
  any previous key's, so those coins are spendable too — provided this device
  reaches the key (Commons kept it in its retired ring). What stays stranded:
  a pre-0235 key that never received through the gateway (only at its index 0
  or its HD tree) — no history and no row vouch for it — and any pre-0235 key
  this device cannot reach, since Commons accepts a previous phrase only when
  the key history names it. Spending those needs the old phrase in another
  FairCoin wallet.

What this does not change: the oxy side of R5-1 (a core API giving the
wallet's own public key from its restricted keychain group) and R5-2 (an
account-bound retired ring), and R5-3..R5-6 (keychain items, backup), are
fixed in OxyHQ/oxy; Peable names every key it uses, so a planted key in the
shared group is never one it derives from, signs with or shows.

## Amendment (2026-11-07): review round 6 — the receive address is the open key's, nothing is adopted without proof

The sixth security review (Peable `e0a2a987`) found one blocking defect and
five smaller ones in the wallet (findings R6-1, R6-2, R6-4, R6-6, R6-7, R6-11,
and an informational note). Fixed in the wallet; the gate stays closed:

- **The receive address is the open key's (R6-1, blocking).** An identity
  wallet's database outlives its key: after a rotation the same
  `oxy-user-<id>` file opens on the new key, and `getUnusedAddress` took the
  first unused `addresses` row — the REPLACED key's — for the Receive sheet
  (default on non-main Pockets, the address list on the main one) and the
  Settings header, which also skipped the receive gate. After a rotation forced
  by a compromise, that is an address whoever holds the old key can spend
  from. Now every `addresses` row records the identity key it derives from
  (`identity_public_key`, a migration of the wallet's SQLite schema; `null` for
  a BIP39 or watch-only wallet, whose key never changes), and
  `wallet/receive-address.ts` offers a row only when it is recorded under the
  key the wallet opened with AND the open tree derives it (`ownsAddress`).
  Rows written before keys were recorded are bound on open (the open tree's
  get its key; any other stays unbound and is never offered — it still
  advances a previous key's tree when that key is reached). Another key's used
  rows no longer move the open tree's cursor. Every surface that shows a
  receive address goes through ONE gate (`wallet/receive-gate.ts`,
  `useReceiveGate`): the Receive sheet as before, and now the Settings header.
- **A moved legacy namespace keeps only its owner's data (R6-2).** The
  pre-round-5 `oxy-identity` file was every person's on the phone; it went
  whole to the first account that proved one address. Now the move keeps only
  what the proving account's keys derive (current and vouched previous keys
  this device holds, each tree extended over every stored row, on both
  networks): HD addresses, social-receive rows under the account's keys (a
  keyless one only when such a key derives it), previous-key trees, the coins
  at those addresses and the transactions that created or spent them, with
  their notes and labels. Another account's addresses, coins, history and
  labels, and every multisig watch address (nothing proves whose), are
  dropped — the coins are on chain, and a rescan finds whatever was the
  owner's. The stripping happens on a scratch copy before anything reaches the
  account's namespace, so an interrupted move never leaves another account's
  rows there.
- **Nothing is adopted from the shared keychain group without proof (R6-4).**
  With no move marker — every fresh install — the keychain move adopted the
  wallet index, the active-wallet pointer, the PIN record and phrases from
  `group.so.oxy.shared`, which every Oxy app can write, and plain reads also
  tried `:auth` copies (Face ID prompts). Now the shared group is a source
  only with this app's own evidence of an earlier install: the wallet
  databases its sandbox held when this build first looked, recorded once in
  the sandbox (`storage/install-evidence.ts`; never a keychain item). No
  evidence, nothing. A cached seed or the pre-multi-wallet phrase, never. The
  index, the active-wallet pointer and every per-wallet key only for a wallet
  with evidence; the PIN record and the other single keys only with some
  evidence. Every shared-group read is the non-prompting native read
  (`OxyIdentity.readKeychainItemWithoutInteraction`, through
  `@oxy.so/protocol`'s `loadKeychainReadWithoutInteraction`, the same reader
  core's `readSharedWithoutInteraction` uses; core does not export it from
  `@oxy.so/core/crypto`); a native build without it never reads the shared
  group. A wallet whose phrase or xpub was taken from the shared group is
  recorded (`peable_keychain_adopted_v1`, own group, before the value is
  copied) and offers nothing to receive into until the person confirms it is
  theirs on the Receive sheet. What is not taken stays where it is. Residual,
  recorded: on a phone that ran a pre-split build, an item another app wrote
  over that build's own copy before the move finished is indistinguishable
  from it; the confirmation covers its phrase.
- **A check is recorded only when it is definite (R6-6).** A candidate whose
  derivation threw was dropped, and one failed check marked the account
  checked for ever. Now a thrown derivation makes the check `indefinite`:
  nothing is recorded and the wallet opens (a key that cannot be asked never
  blocks it); only Oxy's silence still blocks, as before. A definite failure
  is recorded with the fingerprint of the key history and the retired ring it
  was judged against, and is asked again when either changes (a rotation, a
  previous phrase added in Commons). A proof that comes after the account's
  own wallet was already in use MERGES into it (`Database.mergeFrom`, the
  wallet's rows win, a rescan from the lowest merged coin reconciles) rather
  than copying over it. Settings offers "Recover an earlier wallet", the same
  check on demand.
- **One move at a time (R6-7).** The check and move run in the wallet's init
  queue, so two boots (a focus re-run, "Check again", an account switch)
  never copy or delete the same files at once, and no wallet opens beside it.
- **The move's fee is the person's choice (R6-11).** Low, medium, high, or a
  custom whole rate from 1 to 100 units per byte; the confirmation shows the
  fee and the rate, and the move still spends exactly the confirmed plan.
- **The legacy namespace has a bounded life (informational).** When the
  on-demand check says the legacy wallet is not this account's, Settings offers
  to remove it from the phone, with a warning that it may be someone else's
  who can still recover it by signing in here first; removal deletes only this
  phone's copy (no coin moves) and closes the namespace for everyone. It is
  NOT deleted automatically: the wallet cannot enumerate every account that
  ever signed in on this phone, so "every account checked" cannot be known.
  Preferences (Pockets, the active Pocket, the notification subscription)
  follow the proving account, which keeps its own where it has them (Pockets
  are merged by account). Contacts and recent recipients name nobody's keys
  and move with the file — documented, accepted.

Oxy-side round-6 findings (R6-3, R6-5, R6-8 to R6-16) are fixed in OxyHQ/oxy.

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
  **The last two were closed the same day** by the sparse watch set (amendment
  above, ADR 0021 D9): no address is recycled and no recipient has a lifetime
  budget, so they need no acceptance. **F1 was fixed in code the same day**
  ("previous keys stay spendable", above): Peable spends from a previous key
  Commons kept or the person added, and offers to move it to the current key.
  That fix has not been re-reviewed or verified on a device, so whether the
  review still asks for an F1 acceptance is the review's call. F5 and F9 still
  need the owner's acceptance.
- **Gate: closed** until those acceptances are written down here. Production
  leaves `PEABLE_SOCIAL_PAY_NETWORK` unset (testnet), and the wallet's
  `SOCIAL_PAY_NETWORK` stays `testnet`.

