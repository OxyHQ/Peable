# ADR 0002: Social receive is bound to ONE identity key, and every side says which

- **Status:** Accepted
- **Date:** 2026-09-16
- **Supersedes nothing.** It writes down finding F-1, which until now existed
  only as three code comments (`src/pay/social-network.ts`,
  `src/pay/profile-route.ts`, `app/(tabs)/[username].tsx`) and had no record
  anywhere in `docs/`.
- **Scope:** pay-by-`@username` (social receive). Merchant payments derive from
  a registered account xpub and are not affected.

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

## Still required before mainnet

Unchanged by this ADR, and none of them are code:

- the `security-reviewer` sign-off the design spec makes mandatory (§7), on the
  identity key being reused for money;
- the EU crypto/fintech legal opinion (`docs/PEABLE-ROADMAP.md`);
- physical-device verification including a rotation mid-flow, on a device with
  the shared-identity slot and on one without it;
- an end-to-end testnet canary of the social path.
